/**
 * 知识点标注存储层。
 * - dataDir/knowledge/annotations.jsonl：追加写的源真相（每行一题一个来源的完整快照）
 * - problem_keypoints 表：启动时从 JSONL 幂等重建的查询索引
 * 重跑语义：rule / ai 标注可被新版本管线覆盖；manual 永不覆盖（人工校正置顶）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.ts';
import type {
  KnowledgeAnnotation,
  KnowledgeCoverage,
  KnowledgePointEntry,
  KnowledgeSource,
} from '../../../shared/src/index.ts';
import { loadTaxonomy, nameOfCode } from './taxonomy.ts';
import { rulesVersion } from './ruleEngine.ts';

/**
 * 统计端默认置信度阈值。
 * 取 0.6 而非 0.5：规则表最低置信度为 0.6、AI 标注下限已降到 0.35，
 * 阈值 0.5 会让「置信度闸门」在默认配置下拦不住任何一条标注（闸门形同虚设）。
 * 用户可在设置页调整。
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
const THRESHOLD_SETTING_KEY = 'knowledge.minConfidence';

/** JSONL 行在 shared KnowledgeAnnotation 基础上带 writeSource：该行是题目某一来源的完整快照 */
export interface JsonlLine extends KnowledgeAnnotation {
  writeSource: KnowledgeSource;
  /** 标注当时的题目标题：标题被修复后据此判定标注陈旧，重跑才有的放矢 */
  annotatedTitle?: string;
}

/** 生成某来源的清除快照（重跑不再命中 / 人工校正覆盖时，防止 JSONL 重放复活旧标注） */
export function tombstoneLine(platform: string, problemKey: string, source: KnowledgeSource): JsonlLine {
  return {
    platform: platform as JsonlLine['platform'],
    problemKey,
    knowledgePoints: [],
    taxonomyVersion: loadTaxonomy().version,
    pipelineVersion: CURRENT_PIPELINE_VERSION,
    annotatedAt: new Date().toISOString(),
    writeSource: source,
  };
}

/**
 * 同 code 冲突时的来源优先级（必须两两不同）。
 *
 * `problem_keypoints` 主键是 `(platform, problem_key, code)` —— **不含 source**，
 * 同一 code 只允许一行。因此写入路径必须按本表**显式让位**，而不是依赖调用顺序：
 * 高优先级来源可以接管低优先级来源占用的 code，反之则放弃该 code。
 * 读路径（`loadAnnotationsIntoDb` 从 JSONL 重建）用同一张表，保证「库内视图」与
 * 「源真相重放结果」一致。
 */
export const SOURCE_PRECEDENCE: Record<KnowledgeSource, number> = { manual: 4, ai: 3, rule: 2, tag: 1 };

/** 一次管线写入（同源一组知识点） */
export interface AnnotationWrite {
  platform: string;
  problemKey: string;
  source: KnowledgeSource;
  points: Array<{ code: string; confidence: number; method: string }>;
  /** 标注依据的题目标题（记入 annotated_title，供标题变更后判定陈旧），AI 通道可能缺失 */
  title?: string;
}

// ---------- dataDir 解析（模块级默认 + 调用方显式覆盖） ----------

let defaultDataDir: string | null = null;

/** 服务启动时调用一次：设定 JSONL 落盘目录（测试可不设 = 仅写库模式） */
export function initKnowledgeStore(dataDir: string | null): void {
  defaultDataDir = dataDir;
}

function resolveDataDir(dataDir?: string | null): string | null {
  return dataDir ?? defaultDataDir;
}

/** 调用方未显式传 dataDir 时回退到模块级默认（initKnowledgeStore 设定） */
export function effectiveDataDir(dataDir?: string | null): string | null {
  return resolveDataDir(dataDir);
}

export function annotationsPath(dataDir: string): string {
  return path.join(dataDir, 'knowledge', 'annotations.jsonl');
}

// ---------- 置信度阈值（设置页可调） ----------

export function getConfidenceThreshold(db: Db): number {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(THRESHOLD_SETTING_KEY) as
    | { value: string }
    | undefined;
  const v = row === undefined ? NaN : Number(row.value);
  if (!Number.isFinite(v) || v < 0 || v > 1) return DEFAULT_CONFIDENCE_THRESHOLD;
  return v;
}

export function setConfidenceThreshold(db: Db, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`置信度阈值须在 [0,1] 内: ${value}`);
  }
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(THRESHOLD_SETTING_KEY, String(value));
}

// ---------- JSONL 读写 ----------

/** 追加写 JSONL（源真相）。须在 DB 事务 COMMIT 前调用：崩溃时 JSONL 多出的行会在下次启动重放自愈 */
export function appendAnnotations(dataDir: string, lines: JsonlLine[]): void {
  if (lines.length === 0) return;
  const file = annotationsPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

/**
 * 启动时幂等重建：解析 JSONL，按（题目 × 来源）取最后一行快照，各来源并集落库；
 * 同 code 冲突时按 SOURCE_PRECEDENCE 取高优先级来源。
 * taxonomy 中不存在的 code 丢弃并计数（幻觉/废弃 code 拦截）。
 */
export function loadAnnotationsIntoDb(
  db: Db,
  dataDir: string,
): { lines: number; problems: number; inserted: number; skippedUnknownCode: number } {
  const file = annotationsPath(dataDir);
  if (!fs.existsSync(file)) return { lines: 0, problems: 0, inserted: 0, skippedUnknownCode: 0 };
  const raw = fs.readFileSync(file, 'utf8');
  const latest = new Map<string, JsonlLine>(); // key: platform|key|source
  let lines = 0;
  for (const text of raw.split('\n')) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    lines += 1;
    let line: JsonlLine;
    try {
      line = JSON.parse(trimmed) as JsonlLine;
    } catch {
      continue; // 半行（崩溃截断）跳过
    }
    const source = line.writeSource ?? line.knowledgePoints?.[0]?.source;
    if (!source) continue;
    latest.set(`${line.platform}|${line.problemKey}|${source}`, line);
  }

  // 按题目并集各来源快照；同 code 取高优先级来源（见 SOURCE_PRECEDENCE）
  const byProblem = new Map<string, Map<string, { point: JsonlLine['knowledgePoints'][number]; prio: number }>>();
  for (const line of latest.values()) {
    const problemId = `${line.platform}|${line.problemKey}`;
    let codes = byProblem.get(problemId);
    if (!codes) {
      codes = new Map();
      byProblem.set(problemId, codes);
    }
    for (const point of line.knowledgePoints ?? []) {
      const prio = SOURCE_PRECEDENCE[point.source] ?? 0;
      const existing = codes.get(point.code);
      if (!existing || prio >= existing.prio) codes.set(point.code, { point, prio });
    }
  }

  const insert = db.prepare(
    `INSERT INTO problem_keypoints
       (platform, problem_key, code, name, confidence, source, method, taxonomy_version, pipeline_version, annotated_title, annotated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  let skippedUnknownCode = 0;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM problem_keypoints');
    for (const [problemId, codes] of byProblem) {
      const [platform, problemKey] = splitProblemId(problemId);
      for (const { point } of codes.values()) {
        const name = nameOfCode(point.code);
        if (name === null) {
          skippedUnknownCode += 1;
          continue;
        }
        insert.run(
          platform,
          problemKey,
          point.code,
          name,
          point.confidence,
          point.source,
          point.method,
          lineVersion(latest, problemId, point.source, 'taxonomy'),
          lineVersion(latest, problemId, point.source, 'pipeline'),
          lineAnnotatedTitle(latest, problemId, point.source),
          lineAnnotatedAt(latest, problemId, point.source),
        );
        inserted += 1;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { lines, problems: byProblem.size, inserted, skippedUnknownCode };
}

function splitProblemId(id: string): [string, string] {
  const idx = id.indexOf('|');
  return [id.slice(0, idx), id.slice(idx + 1)];
}

function lineVersion(
  latest: Map<string, JsonlLine>,
  problemId: string,
  source: KnowledgeSource,
  kind: 'taxonomy' | 'pipeline',
): number {
  const line = latest.get(`${problemId}|${source}`);
  return kind === 'taxonomy' ? (line?.taxonomyVersion ?? 0) : (line?.pipelineVersion ?? 0);
}

function lineAnnotatedAt(latest: Map<string, JsonlLine>, problemId: string, source: KnowledgeSource): string {
  return latest.get(`${problemId}|${source}`)?.annotatedAt ?? new Date().toISOString();
}

function lineAnnotatedTitle(
  latest: Map<string, JsonlLine>,
  problemId: string,
  source: KnowledgeSource,
): string | null {
  return latest.get(`${problemId}|${source}`)?.annotatedTitle ?? null;
}

// ---------- 写入（管线 / 人工校正共用） ----------

/**
 * 批量写入标注（同源）。manual 保护：题目已有 manual 标注时整题跳过（人工校正置顶）。
 * 同来源旧行整体替换（重跑语义）。
 * 同 code 跨来源冲突按 SOURCE_PRECEDENCE 让位（见该常量注释），因此**调用顺序不影响结果**：
 * 高优先级来源接管低优先级的同 code 行，低优先级来源遇到高优先级占位则跳过该 code。
 * 返回各题目的 JSONL 行（调用方在 COMMIT 前 appendAnnotations）。
 */
export function writeAnnotationsToDb(
  db: Db,
  writes: AnnotationWrite[],
): { lines: JsonlLine[]; written: number; skippedManual: number } {
  const taxonomyVersion = loadTaxonomy().version;
  const hasManual = db.prepare(
    "SELECT 1 FROM problem_keypoints WHERE platform = ? AND problem_key = ? AND source = 'manual' LIMIT 1",
  );
  const delSameSource = db.prepare(
    'DELETE FROM problem_keypoints WHERE platform = ? AND problem_key = ? AND source = ?',
  );
  // 主键 (platform, problem_key, code) 不含 source：同 code 只能一行，写入前必须查占位者
  const holderOfCode = db.prepare(
    'SELECT source FROM problem_keypoints WHERE platform = ? AND problem_key = ? AND code = ? LIMIT 1',
  );
  const delCode = db.prepare('DELETE FROM problem_keypoints WHERE platform = ? AND problem_key = ? AND code = ?');
  const insert = db.prepare(
    `INSERT INTO problem_keypoints
       (platform, problem_key, code, name, confidence, source, method, taxonomy_version, pipeline_version, annotated_title, annotated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const lines: JsonlLine[] = [];
  let written = 0;
  let skippedManual = 0;
  const now = new Date().toISOString();
  for (const w of writes) {
    if (w.source !== 'manual' && hasManual.get(w.platform, w.problemKey)) {
      skippedManual += 1;
      continue;
    }
    delSameSource.run(w.platform, w.problemKey, w.source);
    const points: JsonlLine['knowledgePoints'] = [];
    for (const p of w.points) {
      const name = nameOfCode(p.code);
      if (name === null) continue; // 幻觉 / 废弃 code 拦截
      // 同 code 被别的来源占位时按优先级让位：优先级更高 → 删掉占位行后接管；
      // 更低 → 放弃该 code（不写库、也不进本条 JSONL 快照，保持「快照 = 本来源实际持有」）。
      // 这样 rule 想接管 tag 已占用的 code 时不会再撞主键、把整批事务打回。
      const holder = holderOfCode.get(w.platform, w.problemKey, p.code) as { source: KnowledgeSource } | undefined;
      if (holder && SOURCE_PRECEDENCE[holder.source] > SOURCE_PRECEDENCE[w.source]) continue;
      if (holder) delCode.run(w.platform, w.problemKey, p.code);
      insert.run(
        w.platform,
        w.problemKey,
        p.code,
        name,
        p.confidence,
        w.source,
        p.method,
        taxonomyVersion,
        CURRENT_PIPELINE_VERSION,
        w.title ?? null,
        now,
      );
      points.push({ code: p.code, confidence: p.confidence, source: w.source, method: p.method });
    }
    lines.push({
      platform: w.platform as JsonlLine['platform'],
      problemKey: w.problemKey,
      knowledgePoints: points,
      taxonomyVersion,
      pipelineVersion: CURRENT_PIPELINE_VERSION,
      annotatedAt: now,
      writeSource: w.source,
      ...(w.title !== undefined ? { annotatedTitle: w.title } : {}),
    });
    written += 1;
  }
  return { lines, written, skippedManual };
}

/** 由 pipeline.ts 在模块加载时设定（避免循环依赖） */
let CURRENT_PIPELINE_VERSION = 1;
export function setCurrentPipelineVersion(v: number): void {
  CURRENT_PIPELINE_VERSION = v;
}

/** L3 人工校正：整题覆盖写 source=manual（重跑管线不覆盖 manual） */
export function setManualKeypoints(
  db: Db,
  platform: string,
  problemKey: string,
  codes: string[],
  opts: { dataDir?: string | null } = {},
): { lines: JsonlLine[] } {
  const points = codes.map((code) => {
    if (nameOfCode(code) === null) throw new Error(`未知知识点 code: ${code}`);
    return { code, confidence: 1, method: 'manual' };
  });
  // 人工校正清除该题全部旧来源标注后写 manual（校正即定论）；
  // rule/ai 各补一行清除快照，防止 JSONL 重放时复活旧来源标注
  db.prepare('DELETE FROM problem_keypoints WHERE platform = ? AND problem_key = ?').run(platform, problemKey);
  const result = writeAnnotationsToDb(db, [{ platform, problemKey, source: 'manual', points }]);
  const dataDir = resolveDataDir(opts.dataDir);
  if (dataDir) {
    appendAnnotations(dataDir, [
      tombstoneLine(platform, problemKey, 'rule'),
      tombstoneLine(platform, problemKey, 'ai'),
      ...result.lines,
    ]);
  }
  return { lines: result.lines };
}

// ---------- 查询接口 ----------

export function keypointsOfProblem(db: Db, platform: string, problemKey: string): KnowledgePointEntry[] {
  const rows = db
    .prepare(
      'SELECT code, name, confidence, source, method FROM problem_keypoints WHERE platform = ? AND problem_key = ? ORDER BY confidence DESC',
    )
    .all(platform, problemKey) as unknown as KnowledgePointEntry[];
  return rows;
}

/**
 * 统计端读取路径：优先知识点标注（≥阈值），其次旧版 problem_topics（v1 遗留，见 topics/pipeline.ts），
 * 最后回退题源 tags（写入时已净化，见 import/problemWritePolicy.ts）。
 * 注意：这是这条三级回退链的**唯一实现**，调用处的题目表别名必须是 p。
 */
export function knowledgeTagsSql(db: Db): string {
  const t = getConfidenceThreshold(db);
  return (
    'CASE WHEN EXISTS (SELECT 1 FROM problem_keypoints pk WHERE pk.platform = p.platform AND pk.problem_key = p.problem_key AND pk.confidence >= ' + t + ') ' +
    'THEN (SELECT json_group_array(pk2.name) FROM problem_keypoints pk2 WHERE pk2.platform = p.platform AND pk2.problem_key = p.problem_key AND pk2.confidence >= ' + t + ') ' +
    'WHEN EXISTS (SELECT 1 FROM problem_topics pt WHERE pt.problem_id = p.id) ' +
    'THEN (SELECT json_group_array(ptx.topic_id) FROM problem_topics ptx WHERE ptx.problem_id = p.id) ' +
    'ELSE p.tags END AS tags'
  );
}

/**
 * 与 knowledgeTagsSql 同一三级回退口径的 CTE 版本（调用处需在同一条 SQL 里 WITH 之）。
 *
 * knowledgeTagsSql 是单列标量子查询表达式，嵌入 SELECT 时 SQLite 对**每一行**都要重跑
 * 2 个子查询；题库 2 万题时这是列表页最重的一笔开销。本函数把标注侧预先聚合成按
 * (platform, problem_key) 一行的小派生表，再由调用方 LEFT JOIN，聚合只做一次。
 *
 * - `pk` CTE：≥阈值的标注按题聚合（json_group_array 复用 knowledgeTagsSql 的数组语义）
 * - `pt` CTE：v1 遗留的 problem_topics 回退层，按 problem_id 聚合
 * - 返回的 `tags` 列选择顺序与 knowledgeTagsSql 完全一致：知识点 → v1 主题 → 题源 tags
 *
 * 用法：`WITH ${problemKeypointsCte(db)} SELECT ... ${knowledgeTagsJoinSql()} FROM problems p LEFT JOIN pk ON ...`
 */
export function problemKeypointsCte(db: Db): string {
  const t = getConfidenceThreshold(db);
  return (
    'pk AS (SELECT platform, problem_key, json_group_array(name) AS tags FROM problem_keypoints ' +
    `WHERE confidence >= ${t} GROUP BY platform, problem_key), ` +
    'pt AS (SELECT problem_id, json_group_array(topic_id) AS tags FROM problem_topics GROUP BY problem_id)'
  );
}

/**
 * problemKeypointsCte 对应的 FROM 附加子句与 tags 列表达式（成对使用）。
 * LEFT JOIN 而非 EXISTS：未标注题同样只有一行（NULL），语义与三级回退一致。
 */
export function knowledgeTagsJoinSql(): string {
  return (
    'LEFT JOIN pk ON pk.platform = p.platform AND pk.problem_key = p.problem_key ' +
    'LEFT JOIN pt ON pt.problem_id = p.id'
  );
}

/** 三级回退的 tags 列（配合 knowledgeTagsJoinSql 使用），别名必须为 p */
export function knowledgeTagsCoalesceSql(): string {
  return `${knowledgeTagsExpr()} AS tags`;
}

/** 同上但**不带 AS 别名**：供 json_each(...) 等需要表达式的场景使用 */
export function knowledgeTagsExpr(): string {
  return 'COALESCE(pk.tags, pt.tags, p.tags)';
}

export function getCoverage(db: Db): KnowledgeCoverage {
  const t = getConfidenceThreshold(db);
  const total = (db.prepare('SELECT COUNT(*) AS c FROM problems').get() as { c: number }).c;
  const annotated = (
    db
      .prepare('SELECT COUNT(*) AS c FROM (SELECT 1 FROM problem_keypoints WHERE confidence >= ? GROUP BY platform, problem_key)')
      .get(t) as { c: number }
  ).c;
  const withAny = (
    db
      .prepare('SELECT COUNT(*) AS c FROM (SELECT 1 FROM problem_keypoints GROUP BY platform, problem_key)')
      .get() as { c: number }
  ).c;
  const pending = (
    db.prepare("SELECT COUNT(*) AS c FROM knowledge_queue WHERE status = 'pending'").get() as { c: number }
  ).c;
  // 重试中（pending 且已失败过至少一次）与已放弃（attempts 超限转 failed）：两者此前都不可见，
  // 用户只看到 pending 数字不降却不知道是「排着队」还是「反复失败」
  const retrying = (
    db.prepare("SELECT COUNT(*) AS c FROM knowledge_queue WHERE status = 'pending' AND attempts > 0").get() as { c: number }
  ).c;
  const failed = (
    db.prepare("SELECT COUNT(*) AS c FROM knowledge_queue WHERE status = 'failed'").get() as { c: number }
  ).c;
  const bySourceRows = db
    .prepare('SELECT source, COUNT(DISTINCT platform || char(31) || problem_key) AS c FROM problem_keypoints GROUP BY source')
    .all() as Array<{ source: KnowledgeSource; c: number }>;
  const bySource: Record<KnowledgeSource, number> = { tag: 0, rule: 0, ai: 0, manual: 0 };
  for (const row of bySourceRows) bySource[row.source] = row.c;
  return {
    total,
    annotated,
    coverage: total === 0 ? 0 : Math.round((annotated / total) * 1000) / 10,
    pending,
    retrying,
    failed,
    lowConfidenceOnly: withAny - annotated,
    bySource,
    uncovered: total - annotated,
    taxonomyVersion: loadTaxonomy().version,
    pipelineVersion: CURRENT_PIPELINE_VERSION,
    rulesVersion: rulesVersion(),
    threshold: t,
  };
}

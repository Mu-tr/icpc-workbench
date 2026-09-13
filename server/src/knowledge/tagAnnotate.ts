/**
 * 题源标签 → 知识点 code（source='tag'）。
 *
 * 与 L1 规则层并列：规则读标题（确定性），本层读题源标签（人工维护、含噪）。
 * 两者都只产出**题目属性**，多 code 是正常态，不再压缩为单一标签
 * （见 docs/superpowers/specs/2026-09-13-knowledge-cleaning-redesign.md §1）。
 *
 * 注意：本层不做任何「可信度」判断。题源标签的膨胀问题（低难度题 40% 标贪心）
 * 由 knowledge_concept_stats 的信息量权重在下游处理，不在此处过滤。
 */
import type { Db } from '../db/index.ts';
import { codeOfTag } from '../../../shared/src/index.ts';
import { isValidCode } from './taxonomy.ts';
import {
  appendAnnotations,
  effectiveDataDir,
  writeAnnotationsToDb,
  type AnnotationWrite,
  type JsonlLine,
} from './store.ts';

export interface TagRow {
  platform: string;
  problemKey: string;
  /** problems.tags 的 JSON 数组字符串 */
  tags: string;
}

/** 原始标签数组 → 去重且保序的合法 code 列表 */
export function tagsToCodes(rawTags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of rawTags) {
    const code = codeOfTag(tag);
    if (code === undefined || !isValidCode(code)) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/** 标签是否映射不到任何可用 code：无同义组，或组的 code 不在当前 taxonomy 内 */
function isUnmappedTag(tag: string): boolean {
  const code = codeOfTag(tag);
  return code === undefined || !isValidCode(code);
}

export interface TagAnnotateResult {
  /** 参与扫描的题数（含本层已覆盖、无需再写的题） */
  scanned: number;
  /** 本层实际写库的题数 */
  annotated: number;
  /** 本批无法映射到任何 code 的原始标签（去重） */
  unmappedTags: string[];
  /** `problems.tags` 不是合法 JSON 数组的题数（系统性脏列据此可观测，与「本来就没标签」区分开） */
  malformedTags: number;
  /**
   * 本批写入的 JSONL 行。
   * 调用方显式传 `dataDir: null`（L1 钩子即如此：JSONL 由外层统一在 COMMIT 前追加，
   * 避免同一事务窗口内追加两次）时，必须自行把本字段一并追加，否则 tag 标注
   * 只存在于库里、不在源真相里，下次启动重建即整体丢失。
   */
  lines: JsonlLine[];
}

/** 解析 problems.tags（JSON 数组字符串）；返回 null 表示不是合法 JSON 数组（脏数据） */
function parseTags(tags: string): string[] | null {
  try {
    const parsed = JSON.parse(tags) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    return null;
  }
  return null;
}

/**
 * 批量为题目写入 tag 来源标注。
 *
 * 跳过规则：
 * - 已有人工标注（source='manual'）的题整题跳过（人工校正置顶）；
 * - 本层「应持有的 code 全都已在库」的题跳过（增量语义：不重复写、不重复追加 JSONL）；
 * - 同一 `(platform, problemKey)` 在一批里出现多次时只处理一次（取最后一次出现的 `tags`，
 *   见下方去重说明）—— 否则重复写库、重复追加同一条 JSONL 行，计数也会算成 N。
 *
 * 主键让位：`problem_keypoints` 主键是 `(platform, problem_key, code)`，不含 source，
 * 同一 code 只能一行。本层优先级最低（见 store.ts 的 SOURCE_PRECEDENCE），
 * 因此被 rule/ai/manual 占用的 code 一律不写（`writeAnnotationsToDb` 按优先级兜底），
 * 而**空缺的** code 一律补齐 —— 后者的必要性：规则命中会随时间变化（标题修复 / rules.json
 * 改版），某 code 被 rule 占着时本层不能重复写，但等 rule 那行被清除（差量重跑的清除快照）后，
 * 本层必须能把它重新认领回来，否则这道题会永久丢掉一个可映射的 code。
 *
 * 事务：本函数自带事务（BEGIN → 写库 → append JSONL → COMMIT，异常 ROLLBACK）。
 * 若调用方已持有事务（L1 钩子），改用 SAVEPOINT 参与外层事务，不自行提交。
 * `opts.dataDir` 语义：`undefined` = 回退模块级默认目录（同 `effectiveDataDir`）；
 * **显式 `null` = 本函数不追加 JSONL**（由调用方用返回的 `lines` 自行追加）。
 */
export function annotateProblemsFromTags(
  db: Db,
  rows: TagRow[],
  opts: { dataDir?: string | null } = {},
): TagAnnotateResult {
  const hasManual = db.prepare(
    "SELECT 1 FROM problem_keypoints WHERE platform = ? AND problem_key = ? AND source = 'manual' LIMIT 1",
  );
  const existingRows = db.prepare(
    'SELECT code, source FROM problem_keypoints WHERE platform = ? AND problem_key = ?',
  );

  const writes: AnnotationWrite[] = [];
  const unmapped = new Set<string>();
  let scanned = 0;
  let malformedTags = 0;

  // 同一题可能在一批里出现多次：importService 按**提交**逐条推入 newProblems，
  // 一题多条提交（如先 WA 后 AC）就会把同一 (platform, problemKey) 传进来 N 次。
  // 增量判定读的是**写入前**的库内状态（写入在循环之后统一 flush），所以不去重的话
  // 第二次仍看不到刚写的 tag 行 → 重复写库、重复追加同一条 JSONL 行，并把计数算成 N。
  // 去重取值取**最后一次**出现（Map.set 对已存在的键保留首次出现的位置）：
  // 导入路径每次都是回读库内落定值，后一次反映的是更晚写入的标签，取最后 = 用最新标签映射。
  const deduped = new Map<string, TagRow>();
  for (const row of rows) deduped.set(`${row.platform}\u001f${row.problemKey}`, row);

  for (const row of deduped.values()) {
    if (hasManual.get(row.platform, row.problemKey)) continue;
    scanned += 1;

    const raw = parseTags(row.tags);
    if (raw === null) {
      malformedTags += 1;
      continue;
    }
    for (const t of raw) if (isUnmappedTag(t)) unmapped.add(t);

    const codes = tagsToCodes(raw);
    if (codes.length === 0) continue;

    // 本层应持有的 code：映射出来的、且没有被**更高优先级**来源占用的
    const holders = new Map(
      (existingRows.all(row.platform, row.problemKey) as Array<{ code: string; source: string }>).map((r) => [
        r.code,
        r.source,
      ]),
    );
    const wanted = codes.filter((code) => holders.get(code) === undefined || holders.get(code) === 'tag');
    if (wanted.length === 0) continue; // 全被高优先级来源占用：本层既不写也不动旧行
    // 增量：应持有的 code 都已在库 → 跳过（不重复写库、不重复追加 JSONL）
    if (wanted.every((code) => holders.get(code) === 'tag')) continue;

    // 落库 confidence 固定 1：本字段已降级为「来源内排序权重」，不再是可信度
    writes.push({
      platform: row.platform,
      problemKey: row.problemKey,
      source: 'tag',
      points: wanted.map((code) => ({ code, confidence: 1, method: 'tag' })),
    });
  }

  const nested = db.isTransaction;
  if (nested) db.exec('SAVEPOINT tag_annotate');
  else db.exec('BEGIN');
  try {
    const result = writeAnnotationsToDb(db, writes);
    // 显式 null = 本函数不追加（外层统一追加）；undefined 才回退模块级默认目录
    const dataDir = opts.dataDir === null ? null : effectiveDataDir(opts.dataDir);
    // 源真相：JSONL 追加必须先于 COMMIT
    if (dataDir) appendAnnotations(dataDir, result.lines);
    if (nested) db.exec('RELEASE tag_annotate');
    else db.exec('COMMIT');
    return { scanned, annotated: result.written, unmappedTags: [...unmapped], malformedTags, lines: result.lines };
  } catch (e) {
    if (nested) {
      db.exec('ROLLBACK TO tag_annotate');
      db.exec('RELEASE tag_annotate');
    } else {
      db.exec('ROLLBACK');
    }
    throw e;
  }
}

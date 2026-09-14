/**
 * 知识点管线编排：L1 规则批跑 + 增量入队 + 断点续跑 + 版本差量重跑。
 * 红线：L2 的 AI 特征只有 platform / problemKey / title / difficulty（绝不给题源 tags）；
 * 与 AI 并列的 tag 来源标注不走模型，直接读 problems.tags 做确定性映射（见 tagAnnotate.ts）。
 * 事务与文件顺序：DB 写入与 JSONL 追加在同一事务窗口内（先 append 后 COMMIT），
 * 崩溃时 JSONL 多出的行由下次启动重放自愈，不会丢标注。
 */
import type { Db } from '../db/index.ts';
import { codeOfTag } from '../../../shared/src/index.ts';
import { loadTaxonomy } from './taxonomy.ts';
import { classifyTitle, rulesVersion } from './ruleEngine.ts';
import {
  appendAnnotations,
  effectiveDataDir,
  setCurrentPipelineVersion,
  tombstoneLine,
  writeAnnotationsToDb,
  type AnnotationWrite,
  type JsonlLine,
} from './store.ts';
import { annotateProblemsFromTags } from './tagAnnotate.ts';

/**
 * 管线代码版本：仅当 pipeline.ts / ruleEngine.ts 的**匹配逻辑**改动时才 bump。
 * 单纯改规则内容（rules.json）不必动这里，见下方复合版本。
 */
export const PIPELINE_CODE_VERSION = 4;
/**
 * 管线版本 = 代码版本 × 1000 + rules.json 版本。
 * 把 rules.json 的 version 真正接入差量重跑依据，消灭「改了规则忘了 bump 版本 → 静默不重跑」，
 * 同时让此前零引用的 rulesVersion() 有了唯一消费方。
 * 例：代码版本 4、rules.json version 1 → 4001。
 *
 * ⚠️ 必须是**函数**，不能在模块加载期算成常量 —— 这是踩过的坑（nightly af38ae8 启动即崩）：
 * SEA 单文件 exe 把 rules.json **内嵌**在 exe 里、磁盘上没有该文件，由 `sea.ts` 调用
 * `setRulesJson()` 注入；而模块加载（import 求值）必然早于 `sea.ts` 里的注入语句。
 * 若在加载期调用 `rulesVersion()`，它只能去读磁盘 → `ENOENT: ...\rules.json` → 程序起不来。
 * 决策点：谁在加载期求值，谁就要为之付出「磁盘上必须存在」的代价。
 * 改成函数后，求值推迟到真正用到时（写标注 / 跑管线），那时注入早已完成。
 */
export function pipelineVersion(): number {
  return PIPELINE_CODE_VERSION * 1000 + rulesVersion();
}
setCurrentPipelineVersion(pipelineVersion);

export interface L1RunResult {
  scanned: number;
  /** 规则命中落库的题数 */
  annotated: number;
  /** tag 来源映射落库的题数（与 rule 并列的独立来源） */
  tagAnnotated: number;
  /** 未命中进入 L2 队列的题数 */
  enqueued: number;
  /** 有人工校正标注而跳过的题数 */
  skippedManual: number;
}

interface ProblemRow {
  platform: string;
  problem_key: string;
  title: string;
  /** 题源标签 JSON（tag 来源标注用；缺省视为无标签） */
  tags?: string;
}

/**
 * 对给定题目集合跑 L1（导入/拉题库钩子与全量批跑共用）。
 * - 已有 manual 标注的题跳过（人工校正置顶）
 * - 已有任意标注的题跳过（增量语义），force 时重跑（覆盖 rule 来源旧标注）
 * - 命中落库 source=rule；未命中入 L2 队列（幂等）
 * - 同时并联 tag 来源（题源标签 → 知识点 code，落库 source=tag，见 tagAnnotate.ts），
 *   两者同处一个事务窗口，JSONL 在本函数内统一追加
 */
export function annotateProblemsL1(
  db: Db,
  rows: Array<{ platform: string; problemKey: string; title: string; tags?: string }>,
  opts: { dataDir?: string | null; force?: boolean } = {},
): L1RunResult {
  const hasManual = db.prepare(
    "SELECT 1 FROM problem_keypoints WHERE platform = ? AND problem_key = ? AND source = 'manual' LIMIT 1",
  );
  const hasAny = db.prepare(
    'SELECT 1 FROM problem_keypoints WHERE platform = ? AND problem_key = ? LIMIT 1',
  );
  const enqueue = db.prepare(
    `INSERT INTO knowledge_queue (platform, problem_key, status) VALUES (?, ?, 'pending')
     ON CONFLICT(platform, problem_key) DO NOTHING`,
  );

  const writes: AnnotationWrite[] = [];
  const tombstones: JsonlLine[] = [];
  let enqueued = 0;
  let skippedManual = 0;
  let scanned = 0;

  db.exec('BEGIN');
  try {
    for (const row of rows) {
      if (hasManual.get(row.platform, row.problemKey)) {
        skippedManual += 1;
        continue;
      }
      if (!opts.force && hasAny.get(row.platform, row.problemKey)) continue;
      scanned += 1;
      const hits = classifyTitle(row.title);
      if (opts.force && hits.length === 0) {
        // 差量重跑且不再命中：清除该题过期的 rule 标注（ai/manual 不受影响），重新入 L2 队列；
        // JSONL 补清除快照，防止重放复活
        db.prepare(
          "DELETE FROM problem_keypoints WHERE platform = ? AND problem_key = ? AND source = 'rule'",
        ).run(row.platform, row.problemKey);
        tombstones.push(tombstoneLine(row.platform, row.problemKey, 'rule'));
      }
      if (hits.length > 0) {
        writes.push({
          platform: row.platform,
          problemKey: row.problemKey,
          source: 'rule',
          points: hits.map((h) => ({ code: h.code, confidence: h.confidence, method: h.method })),
          // 标题指纹：记录标注当时的标题，标题被修复后据此判定标注陈旧并触发重跑
          title: row.title,
        });
        // 规则命中后若此前在 L2 队列里，标记出队
        db.prepare(
          "UPDATE knowledge_queue SET status = 'done', updated_at = datetime('now') WHERE platform = ? AND problem_key = ? AND status = 'pending'",
        ).run(row.platform, row.problemKey);
      } else {
        enqueue.run(row.platform, row.problemKey);
        enqueued += 1;
      }
    }
    const result = writeAnnotationsToDb(db, writes);
    // tag 来源与 rule 来源并联：两者互相独立（rule 已有标注的题仍可能有 tag 标注）。
    // 与 rule 的先后顺序不影响结果：同 code 跨来源冲突由 writeAnnotationsToDb 按
    // SOURCE_PRECEDENCE 显式让位（rule 接管 tag 占用的 code，tag 遇 rule 占位则让开）。
    // tags 的解析口径归 tagAnnotate 一处所有，这里只筛「有没有 tags 字段」。
    const tagWrites = rows
      .filter((r) => r.tags !== undefined)
      .map((r) => ({ platform: r.platform, problemKey: r.problemKey, tags: r.tags! }));
    // dataDir 显式传 null：本函数统一追加 JSONL（把 tagResult.lines 一并带上），
    // 避免同一事务窗口内追加两次（tagAnnotate 对显式 null 的语义见其文档注释）
    const tagResult = annotateProblemsFromTags(db, tagWrites, { dataDir: null });
    if (tagResult.malformedTags > 0) {
      console.warn(`[knowledge] ${tagResult.malformedTags} 题的 problems.tags 不是合法 JSON 数组，已按无标签处理`);
    }
    const dataDir = effectiveDataDir(opts.dataDir);
    if (dataDir) appendAnnotations(dataDir, [...result.lines, ...tagResult.lines, ...tombstones]);
    db.exec('COMMIT');
    return {
      scanned,
      annotated: result.written,
      tagAnnotated: tagResult.annotated,
      enqueued,
      skippedManual,
    };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * 标题变更导致的 AI 标注失效 → 重新入队 L2。
 * 只在问题有**标题指纹**且与当前标题不符时触发：旧版 AI 标注（annotated_title 为 NULL）
 * 无法判定是否陈旧，故不在这里动它们——避免升级后一次性重跑全量 AI（真实花费）。
 * 需要全量重标时走「知识点管线 → 清空 AI 标注后重跑」的显式入口。
 */
export function requeueStaleAiByTitle(db: Db): number {
  const info = db
    .prepare(
      `UPDATE knowledge_queue
       SET status = 'pending', attempts = 0, last_error = NULL, updated_at = datetime('now')
       WHERE status != 'pending' AND EXISTS (
         SELECT 1 FROM problem_keypoints k
         JOIN problems p ON p.platform = k.platform AND p.problem_key = k.problem_key
         WHERE k.platform = knowledge_queue.platform AND k.problem_key = knowledge_queue.problem_key
           AND k.source = 'ai'
           AND k.annotated_title IS NOT NULL AND k.annotated_title != p.title
       )`,
    )
    .run();
  return Number(info.changes ?? 0);
}

/**
 * 全量 / 差量 L1 批跑。
 * - 默认：只扫无任何标注的题（增量）
 * - rerun：重跑 rule 来源中「管线/规则/taxonomy 版本落后」或「标题已变更」的题（差量重跑）
 */
export function runRulePass(
  db: Db,
  opts: { dataDir?: string | null; limit?: number; rerun?: boolean } = {},
): L1RunResult {
  if (opts.rerun) {
    const requeued = requeueStaleAiByTitle(db);
    if (requeued > 0) {
      // 标题被修复后 AI 标注同样陈旧：仅重新入队（不直接调用 AI，无 Key 时也能安全跑完 L1）
      console.info(`[knowledge] 标题变更导致 ${requeued} 题的 AI 标注失效，已重新排入 L2 队列`);
    }
  }
  const taxonomyVersion = loadTaxonomy().version;
  const limit = opts.limit ?? 20000;
  const rows = opts.rerun
    ? (db
        .prepare(
          `SELECT p.platform, p.problem_key, p.title, p.tags FROM problems p
           WHERE EXISTS (
             SELECT 1 FROM problem_keypoints k
             WHERE k.platform = p.platform AND k.problem_key = p.problem_key
               AND k.source = 'rule'
               AND (
                 k.pipeline_version < ? OR k.taxonomy_version < ?
                 OR k.annotated_title IS NOT p.title
               )
           )
           ORDER BY p.id LIMIT ?`,
        )
        .all(pipelineVersion(), taxonomyVersion, limit) as unknown as ProblemRow[])
    : (db
        .prepare(
          `SELECT p.platform, p.problem_key, p.title, p.tags FROM problems p
           WHERE NOT EXISTS (
             SELECT 1 FROM problem_keypoints k
             WHERE k.platform = p.platform AND k.problem_key = p.problem_key
           )
           ORDER BY p.id LIMIT ?`,
        )
        .all(limit) as unknown as ProblemRow[]);
  return annotateProblemsL1(
    db,
    rows.map((r) => ({ platform: r.platform, problemKey: r.problem_key, title: r.title, tags: r.tags })),
    { dataDir: opts.dataDir, force: opts.rerun === true },
  );
}

// ---------- 词表缺口报告（替代原「待 AI 标注队列」的用途） ----------

/**
 * 词表缺口报告（替代原「待 AI 标注队列」的用途）。
 *
 * AI 退出清洗模块后，未覆盖的题不再等待模型，而是成为**词表缺口**：
 * 这些题的题源标签存在，但映射不到任何 taxonomy code。
 * 补齐 shared/src/tags.ts 的同义组是唯一能真正提升覆盖率的手段（零 AI 成本）。
 */
export interface GapReport {
  /** 无法映射的原始标签 → 影响的题数（降序） */
  gaps: Array<{ tag: string; problems: number }>;
  /** 完全没有可用 code 的题数（题源标签也映射不上、规则也未命中） */
  uncovered: number;
}

export function gapReport(db: Db, opts: { limit?: number } = {}): GapReport {
  const limit = opts.limit ?? 100;

  // 未覆盖题的全部原始标签拉回内存聚合（用 codeOfTag 判定是否可映射）
  const rows = db
    .prepare(
      `SELECT p.tags AS tags FROM problems p
        WHERE NOT EXISTS (
          SELECT 1 FROM problem_keypoints k
           WHERE k.platform = p.platform AND k.problem_key = p.problem_key
             AND k.source IN ('tag','rule','manual')
        )`,
    )
    .all() as unknown as Array<{ tags: string }>;

  const byTag = new Map<string, number>();
  let uncovered = 0;
  for (const r of rows) {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(r.tags) as unknown;
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
    } catch {
      tags = [];
    }
    if (!tags.some((t) => codeOfTag(t) !== undefined)) uncovered += 1;
    for (const t of new Set(tags)) {
      if (codeOfTag(t) !== undefined) continue;
      byTag.set(t, (byTag.get(t) ?? 0) + 1);
    }
  }

  const gaps = [...byTag.entries()]
    .map(([tag, problems]) => ({ tag, problems }))
    .sort((a, b) => b.problems - a.problems || a.tag.localeCompare(b.tag))
    .slice(0, limit);

  return { gaps, uncovered };
}

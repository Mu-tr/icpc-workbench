/**
 * 知识点管线编排：L1 规则批跑 + 增量入队 + 断点续跑 + 版本差量重跑。
 * 红线：L2 的 AI 特征只有 platform / problemKey / title / difficulty（绝不给题源 tags）；
 * 与 AI 并列的 tag 来源标注不走模型，直接读 problems.tags 做确定性映射（见 tagAnnotate.ts）。
 * 事务与文件顺序：DB 写入与 JSONL 追加在同一事务窗口内（先 append 后 COMMIT），
 * 崩溃时 JSONL 多出的行由下次启动重放自愈，不会丢标注。
 */
import type { Db } from '../db/index.ts';
import type { KnowledgeSource } from '../../../shared/src/index.ts';
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
 */
export const PIPELINE_VERSION = PIPELINE_CODE_VERSION * 1000 + rulesVersion();
setCurrentPipelineVersion(PIPELINE_VERSION);

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
    // 必须在 rule 写入**之后**调用：同一 (platform, problem_key, code) 在表里只有一行，
    // tag 层据此跳过已被 rule/manual/ai 认领的 code；反过来先写 tag 会让 rule 的插入
    // 撞主键（UNIQUE constraint）而回滚整批。
    const tagWrites = rows
      .filter((r) => r.tags !== undefined && r.tags !== '[]')
      .map((r) => ({ platform: r.platform, problemKey: r.problemKey, tags: r.tags! }));
    // dataDir 传 null：JSONL 由本函数统一追加（把 tagResult.lines 一并带上），
    // 避免同一事务窗口内追加两次
    const tagResult = annotateProblemsFromTags(db, tagWrites, { dataDir: null });
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
        .all(PIPELINE_VERSION, taxonomyVersion, limit) as unknown as ProblemRow[])
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

// ---------- L2 队列（断点续跑） ----------

export function pendingAiCount(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM knowledge_queue WHERE status = 'pending'").get() as { c: number }).c;
}

/** 取一批待 AI 标注的题（联查标题与难度——AI 输入只有这两个特征，绝不给题源 tag） */
export function fetchAiBatch(
  db: Db,
  limit: number,
): Array<{ platform: string; problemKey: string; title: string; difficulty: number | null }> {
  return db
    .prepare(
      `SELECT q.platform, q.problem_key AS problemKey, p.title, p.difficulty
       FROM knowledge_queue q JOIN problems p ON p.platform = q.platform AND p.problem_key = q.problem_key
       WHERE q.status = 'pending'
       ORDER BY q.enqueued_at LIMIT ?`,
    )
    .all(limit) as unknown as Array<{ platform: string; problemKey: string; title: string; difficulty: number | null }>;
}

export function markQueueStatus(
  db: Db,
  platform: string,
  problemKey: string,
  status: 'done' | 'uncertain' | 'failed' | 'pending',
  error?: string,
): void {
  db.prepare(
    `UPDATE knowledge_queue SET status = ?, attempts = attempts + ?, last_error = ?, updated_at = datetime('now')
     WHERE platform = ? AND problem_key = ?`,
  ).run(status, status === 'failed' ? 1 : 0, error ?? null, platform, problemKey);
}

/** 批次重试上限：同一题累计失败达到该次数即转为 failed 出队，避免毒批永久占用队首 */
export const MAX_ATTEMPTS = 3;

/**
 * 批跑失败：整批记一次失败。
 * - 未达上限的题 `attempts+1` 并把 `enqueued_at` 推到队尾（关键：否则每轮都从队首重取同一批 25 题，
 *   一旦这批里有毒数据，后面的题永远排不上）
 * - 已达上限的题转 `failed` 出队，可用 retryFailedQueue 显式捞回
 */
export function markBatchRetry(
  db: Db,
  batch: Array<{ platform: string; problemKey: string }>,
  error: string,
  maxAttempts: number = MAX_ATTEMPTS,
): { retried: number; failed: number } {
  const readAttempts = db.prepare(
    'SELECT attempts FROM knowledge_queue WHERE platform = ? AND problem_key = ? AND status = ?',
  );
  const retry = db.prepare(
    `UPDATE knowledge_queue
     SET attempts = attempts + 1, last_error = ?, enqueued_at = datetime('now'), updated_at = datetime('now')
     WHERE platform = ? AND problem_key = ? AND status = 'pending'`,
  );
  const giveUp = db.prepare(
    `UPDATE knowledge_queue
     SET attempts = attempts + 1, last_error = ?, status = 'failed', updated_at = datetime('now')
     WHERE platform = ? AND problem_key = ? AND status = 'pending'`,
  );
  let retried = 0;
  let failed = 0;
  db.exec('BEGIN');
  try {
    for (const b of batch) {
      const row = readAttempts.get(b.platform, b.problemKey, 'pending') as { attempts: number } | undefined;
      if (!row) continue; // 已被同轮其它路径出队：跳过
      if (row.attempts + 1 >= maxAttempts) {
        giveUp.run(error, b.platform, b.problemKey);
        failed += 1;
      } else {
        retry.run(error, b.platform, b.problemKey);
        retried += 1;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { retried, failed };
}

/** 把 failed 的题捞回 pending（attempts 清零），供「重试失败题」按钮使用 */
export function retryFailedQueue(db: Db): number {
  const info = db
    .prepare(
      `UPDATE knowledge_queue SET status = 'pending', attempts = 0, last_error = NULL, updated_at = datetime('now')
       WHERE status = 'failed'`,
    )
    .run();
  return Number(info.changes ?? 0);
}

/** failed 队列计数（coverage 之外的排查入口） */
export function failedAiCount(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM knowledge_queue WHERE status = 'failed'").get() as { c: number }).c;
}

/** AI 标注写库 + 队列出队（同事务窗口，先 JSONL 后 COMMIT） */
export function commitAiAnnotations(
  db: Db,
  writes: AnnotationWrite[],
  uncertain: Array<{ platform: string; problemKey: string }>,
  opts: { dataDir?: string | null } = {},
): { written: number; skippedManual: number } {
  db.exec('BEGIN');
  try {
    const result = writeAnnotationsToDb(db, writes);
    const done = db.prepare(
      "UPDATE knowledge_queue SET status = 'done', updated_at = datetime('now') WHERE platform = ? AND problem_key = ?",
    );
    const uncertainStmt = db.prepare(
      "UPDATE knowledge_queue SET status = 'uncertain', updated_at = datetime('now') WHERE platform = ? AND problem_key = ?",
    );
    const writtenKeys = new Set(writes.map((w) => `${w.platform}|${w.problemKey}`));
    for (const key of writtenKeys) {
      const [platform, problemKey] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
      done.run(platform, problemKey);
    }
    for (const u of uncertain) uncertainStmt.run(u.platform, u.problemKey);
    const dataDir = effectiveDataDir(opts.dataDir);
    if (dataDir) appendAnnotations(dataDir, result.lines);
    db.exec('COMMIT');
    return { written: result.written, skippedManual: result.skippedManual };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

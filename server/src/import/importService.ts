import type { NormalizedSubmission, PlatformId } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { annotateProblemsL1 } from '../knowledge/pipeline.ts';
import { problemUpsertSql, purifyTags } from './problemWritePolicy.ts';

export interface InsertResult {
  imported: number;
  skipped: number;
}

/**
 * 将统一 Submission 结构写入数据库（单事务）：
 * - problems 按 (platform, problem_key) upsert（标题/难度/链接/tags 更新）
 * - submissions 按 (user_id, platform, external_id) INSERT OR IGNORE 去重
 * - opts.clearPlatform：先删除该平台旧提交再插入（换账号场景，保证原子性）
 * 供平台同步与手动导入共用。
 *
 * 难度与标签的统一策略见 problemWritePolicy.ts：
 * - 难度按来源优先级（manual > backfill > sync > bank）覆盖，手动导入(manual:)标记为 manual 来源
 * - 标签**写入即净化**（噪声过滤 + 同义词归并），non-empty 覆盖空值；适配器拿不到标签时保留库内已有
 */
export function insertNormalized(
  db: Db,
  userId: number,
  subs: NormalizedSubmission[],
  opts: { clearPlatform?: PlatformId } = {},
): InsertResult {
  const upsertSync = db.prepare(problemUpsertSql('sync'));
  const upsertManual = db.prepare(problemUpsertSql('manual'));
  const insertSub = db.prepare(
    `INSERT OR IGNORE INTO submissions
       (user_id, platform, problem_id, verdict, language, submitted_at, external_id)
     VALUES (?, ?, (SELECT id FROM problems WHERE platform = ? AND problem_key = ?), ?, ?, ?, ?)`,
  );
  const findProblem = db.prepare('SELECT id, title FROM problems WHERE platform = ? AND problem_key = ?');
  // 手动导入（externalId 以 manual: 开头）与平台同步数据协调：
  // 同平台同题同结果已存在（无论来源是同步还是手动）→ 跳过，避免重复计数
  const manualDup = db.prepare(
    `SELECT 1 FROM submissions s JOIN problems p ON s.problem_id = p.id
     WHERE s.user_id = ? AND s.platform = ? AND p.problem_key = ? AND s.verdict = ?
     LIMIT 1`,
  );

  let imported = 0;
  let skipped = 0;
  const newProblems: Array<{ platform: string; problemKey: string; title: string }> = [];
  db.exec('BEGIN');
  try {
    if (opts.clearPlatform) {
      db.prepare('DELETE FROM submissions WHERE user_id = ? AND platform = ?').run(
        userId,
        opts.clearPlatform,
      );
    }
    for (const s of subs) {
      const isManual = String(s.externalId).startsWith('manual:');
      const source = isManual ? 'manual' : 'sync';
      (isManual ? upsertManual : upsertSync).run(
        s.problem.platform,
        s.problem.problemKey,
        s.problem.title,
        s.problem.difficulty ?? null,
        s.problem.url ?? null,
        JSON.stringify(purifyTags(s.problem.tags)),
        source,
      );
      const problem = findProblem.get(s.problem.platform, s.problem.problemKey) as { id: number; title: string };
      newProblems.push({ platform: s.problem.platform, problemKey: s.problem.problemKey, title: problem.title });
      // 手动导入协调：同题同结果已存在 → 跳过（不再重复计入）
      if (isManual) {
        const dup = manualDup.get(
          userId,
          s.problem.platform,
          s.problem.problemKey,
          s.verdict,
        );
        if (dup) {
          skipped += 1;
          continue;
        }
      }
      const r = insertSub.run(
        userId,
        s.problem.platform,
        s.problem.platform,
        s.problem.problemKey,
        s.verdict,
        s.language ?? null,
        s.submittedAt,
        s.externalId,
      );
      if (r.changes > 0) imported += 1;
      else skipped += 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // 知识点管线增量：新题跑 L1 规则标注（未命中入 L2 队列）；标注失败不影响导入结果
  try {
    annotateProblemsL1(db, newProblems);
  } catch (e) {
    console.error(`[knowledge] 导入后 L1 标注失败（不影响导入）: ${(e as Error).message}`);
  }
  return { imported, skipped };
}

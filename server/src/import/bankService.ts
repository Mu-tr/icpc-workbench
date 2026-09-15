import type { PlatformId } from '../../../shared/src/index.ts';
import type { DifficultyScale } from '../../../shared/src/difficulty.ts';
import type { Db } from '../db/index.ts';
import { annotateProblemsL1 } from '../knowledge/pipeline.ts';
import { problemUpsertSql, purifyTags } from './problemWritePolicy.ts';

/** 纯题目批量入库结果 */
export interface BankImportResult {
  platform: PlatformId;
  /** 新入库题数（此前库中不存在） */
  inserted: number;
  /** 已存在被更新的题数 */
  updated: number;
}

/**
 * 将公开题库题目批量写入 problems 表（不产生 submissions，不污染刷题统计）。
 * - 按 (platform, problem_key) upsert：已有题（含手动导入/同步得来的）只更新元信息
 * - 难度按来源优先级覆盖（见 problemWritePolicy.ts）：题库来源 bank(1) 优先级最低，
 *   不会覆盖同步(2)/回填(3)/手动(4)得到的难度，与 importService 共用同一段 SQL
 * - tags 写入即净化（噪声过滤 + 同义词归并），非空才覆盖
 * 注：SQLite ON CONFLICT DO UPDATE 的 changes 恒为 1，无法区分新增/更新，
 * 故先按平台统计库内已有 key 数，upsert 后用差值计算。
 */
export function upsertBankProblems(
  db: Db,
  rows: Array<{
    platform: PlatformId;
    problemKey: string;
    title: string;
    difficulty: number | null;
    /** 平台原生难度原文（未知为 null；不覆盖已落定的非空值） */
    nativeDifficulty: string | null;
    /** 原生难度所属标度（见 shared/src/difficulty.ts 的 DifficultyScale）；无难度语义为 null */
    difficultyScale: DifficultyScale | null;
    url: string | null;
    tags: string[];
  }>,
): BankImportResult[] {
  const byPlatform = new Map<PlatformId, string[]>();
  for (const r of rows) {
    const keys = byPlatform.get(r.platform) ?? [];
    keys.push(r.problemKey);
    byPlatform.set(r.platform, keys);
  }

  const stmt = db.prepare(problemUpsertSql('bank'));
  const findProblem = db.prepare('SELECT id, title, tags FROM problems WHERE platform = ? AND problem_key = ?');

  db.exec('BEGIN');
  try {
    // 库内已存在的 key 数（在写入前统计，作为 inserted/updated 的基准）
    const existedByPlatform = new Map<PlatformId, number>();
    const countExisting = db.prepare(
      'SELECT COUNT(*) AS c FROM problems WHERE platform = ? AND problem_key = ?',
    );
    for (const [platform, keys] of byPlatform) {
      let existed = 0;
      for (const key of keys) {
        if ((countExisting.get(platform, key) as { c: number }).c > 0) existed += 1;
      }
      existedByPlatform.set(platform, existed);
    }
    const newProblems: Array<{ platform: string; problemKey: string; title: string; tags: string }> = [];
    for (const r of rows) {
      stmt.run(
        r.platform,
        r.problemKey,
        r.title || r.problemKey,
        r.difficulty,
        r.url,
        JSON.stringify(purifyTags(r.tags ?? [])),
        'bank',
        r.nativeDifficulty,
        r.difficultyScale,
      );
      // tags 取**库内落定值**（写入即净化；非空才覆盖，故可能与本次入参不同）——
      // tag 来源标注必须按实际落库的标签做映射
      const problem = findProblem.get(r.platform, r.problemKey) as { id: number; title: string; tags: string };
      newProblems.push({
        platform: r.platform,
        problemKey: r.problemKey,
        title: problem.title,
        tags: problem.tags,
      });
    }
    db.exec('COMMIT');
    // 知识点管线增量：新题跑 L1 规则标注（未命中入 L2 队列）；标注失败不影响入库结果
    try {
      annotateProblemsL1(db, newProblems);
    } catch (e) {
      console.error(`[knowledge] 题库入库后 L1 标注失败（不影响入库）: ${(e as Error).message}`);
    }
    return [...byPlatform.entries()].map(([platform, keys]) => {
      const existed = existedByPlatform.get(platform) ?? 0;
      // 同批内重复 key 只算一次存在
      const uniqueKeys = new Set(keys).size;
      const inserted = Math.max(0, uniqueKeys - existed);
      return { platform, inserted, updated: uniqueKeys - inserted };
    });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

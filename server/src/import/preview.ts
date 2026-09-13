import type { NormalizedSubmission } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';

/**
 * 导入变更预览：不写库，按 insertNormalized 的去重规则对每行做分类，
 * 供客户端在真正导入前展示「新增 / 跳过 / 题目变化 / 非法行」。
 */
export interface ImportPreview {
  /** 将新增的提交记录数（external_id 未见过，且不命中手动协调跳过规则） */
  newSubmissions: number;
  /** external_id 已存在 → 插入被唯一键拦截，跳过 */
  duplicateSkips: number;
  /** manual: 前缀行且「同平台同题同结果」已存在 → 协调规则跳过 */
  manualSkips: number;
  /** 将新创建的题目数 */
  problemCreates: number;
  /** 已存在、导入时会补充/更新元信息的题目数 */
  problemUpdates: number;
}

export function previewImport(db: Db, userId: number, subs: NormalizedSubmission[]): ImportPreview {
  const externalIdExists = db.prepare(
    'SELECT 1 FROM submissions WHERE user_id = ? AND platform = ? AND external_id = ? LIMIT 1',
  );
  // 与 insertNormalized 的 manualDup 同一规则：同平台同题同结果已存在 → 跳过
  const manualDup = db.prepare(
    `SELECT 1 FROM submissions s JOIN problems p ON s.problem_id = p.id
     WHERE s.user_id = ? AND s.platform = ? AND p.problem_key = ? AND s.verdict = ?
     LIMIT 1`,
  );
  const problemOf = db.prepare(
    'SELECT id, title, difficulty, url FROM problems WHERE platform = ? AND problem_key = ?',
  );

  const preview: ImportPreview = {
    newSubmissions: 0,
    duplicateSkips: 0,
    manualSkips: 0,
    problemCreates: 0,
    problemUpdates: 0,
  };
  const problemSeen = new Set<string>();

  for (const s of subs) {
    // 题目级分类（每题只统计一次）
    const pKey = `${s.problem.platform}:${s.problem.problemKey}`;
    if (!problemSeen.has(pKey)) {
      problemSeen.add(pKey);
      if (problemOf.get(s.problem.platform, s.problem.problemKey)) preview.problemUpdates += 1;
      else preview.problemCreates += 1;
    }

    // 提交级分类
    if (externalIdExists.get(userId, s.problem.platform, s.externalId)) {
      preview.duplicateSkips += 1;
      continue;
    }
    if (String(s.externalId).startsWith('manual:')) {
      const dup = manualDup.get(userId, s.problem.platform, s.problem.problemKey, s.verdict);
      if (dup) {
        preview.manualSkips += 1;
        continue;
      }
    }
    preview.newSubmissions += 1;
  }
  return preview;
}

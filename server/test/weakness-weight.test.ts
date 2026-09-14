import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import { computeWeakness } from '../src/analysis/weakness.ts';
import {
  recomputeConceptStats,
  INFORMATIVENESS_FLOOR,
} from '../src/knowledge/conceptStats.ts';
import { nameOfCode } from '../src/knowledge/taxonomy.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});
afterEach(() => {
  db.close();
});

/** 造 n 道同难度题，每题一个 code；前 acCount 道提交为 AC，其余为 WA。 */
function seed(n: number, code: string, acCount: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)",
  ).run();
  const insP = db.prepare(
    "INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES ('codeforces',?,? ,1500,'[]')",
  );
  const displayName = nameOfCode(code);
  if (!displayName) throw new Error(`unknown code: ${code}`);
  const insK = db.prepare(
    `INSERT INTO problem_keypoints
      (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
     VALUES ('codeforces',? ,? ,?,1,'tag','tag',1,1,'2026-01-01')`,
  );
  const insS = db.prepare(
    'INSERT INTO submissions (user_id,platform,problem_id,verdict,submitted_at) VALUES (1,\'codeforces\',?,?,?)',
  );
  for (let i = 0; i < n; i += 1) {
    const key = `${code}-${i}`;
    insP.run(key, `T ${key}`);
    const row = db
      .prepare('SELECT id FROM problems WHERE problem_key = ?')
      .get(key) as { id: number };
    insK.run(key, code, displayName);
    const verdict = i < acCount ? 'AC' : 'WA';
    insS.run(row.id, verdict, `2026-01-0${(i % 9) + 1}T00:00:00.000Z`);
  }
}

test('低信息量概念即使 gap 相同也排在细粒度概念之后', () => {
  // 粗类（覆盖 30 题中的 20 题 → 占比高 → 低信息量），全 WA
  seed(20, 'math.general', 0);
  // 细类（覆盖 5 题 → 低占比 → 高信息量），全 WA
  seed(5, 'math.number-theory', 0);
  // 另造一批 AC 撑起总体 AC 率，避免所有 gap  collapses to 0
  seed(5, 'dp.general', 5);

  recomputeConceptStats(db);

  const profile = computeWeakness(db, 1, { minAttempts: 3, topN: 10 });
  const coarse = profile.items.find((i) => i.tag === '数学（综合）');
  const fine = profile.items.find((i) => i.tag === '数论');
  assert.ok(
    coarse && fine,
    `两个概念都应在结果里，实得 ${profile.items.map((i) => i.tag).join(',')}`,
  );
  // gap 仍报告原始可观测差值，不被权重改写
  assert.equal(typeof coarse.gap, 'number');
  assert.equal(coarse.gap, fine.gap, 'gap 应相等，这样排序差异只能来自权重');
  assert.ok(
    coarse.rank < fine.rank,
    `粗类 rank(${coarse.rank}) 应低于细类 rank(${fine.rank})`,
  );

  const rawCoarse = db
    .prepare(
      'SELECT informativeness FROM knowledge_concept_stats WHERE code = ? AND bucket = ?',
    )
    .get('math.general', '1400-1599') as { informativeness: number } | undefined;
  const rawFine = db
    .prepare(
      'SELECT informativeness FROM knowledge_concept_stats WHERE code = ? AND bucket = ?',
    )
    .get('math.number-theory', '1400-1599') as { informativeness: number } | undefined;
  assert.ok(
    rawCoarse !== undefined && rawCoarse.informativeness < INFORMATIVENESS_FLOOR,
    `粗类原始信息量应低于 FLOOR，实得 ${rawCoarse?.informativeness}`,
  );
  assert.ok(
    rawFine !== undefined && rawFine.informativeness > INFORMATIVENESS_FLOOR,
    `细类原始信息量应高于 FLOOR，实得 ${rawFine?.informativeness}`,
  );
});

test('低信息量概念不会被完全静默（受 FLOOR 保护仍有正 rank）', () => {
  // 17 道粗类 WA + 8 道 dp.general AC：总体 AC 率 8/25=32%，gap=32；
  // share=17/25=0.68 的原始信息量低于 FLOOR，因此实际权重被提升到 FLOOR。
  seed(17, 'math.general', 0);
  seed(8, 'dp.general', 8);
  recomputeConceptStats(db);

  const profile = computeWeakness(db, 1, { minAttempts: 3, topN: 10 });
  const coarse = profile.items.find((i) => i.tag === '数学（综合）');
  assert.ok(coarse, '粗类概念应仍出现在列表里');
  assert.ok(coarse.gap > 0, 'gap 应大于 0 才能验证权重');

  const raw = db
    .prepare(
      'SELECT informativeness FROM knowledge_concept_stats WHERE code = ? AND bucket = ?',
    )
    .get('math.general', '1400-1599') as { informativeness: number } | undefined;
  assert.ok(
    raw !== undefined && raw.informativeness < INFORMATIVENESS_FLOOR,
    `原始信息量应低于 FLOOR，实得 ${raw?.informativeness}`,
  );
  assert.ok(
    coarse.rank / coarse.gap >= INFORMATIVENESS_FLOOR,
    `应用权重应不低于 FLOOR，实得 ${coarse.rank / coarse.gap}`,
  );
});

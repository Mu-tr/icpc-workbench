import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import { gapReport } from '../src/knowledge/pipeline.ts';

let db: Db;
beforeEach(() => { db = createDb(':memory:'); });
afterEach(() => { db.close(); });

test('gapReport: 聚合无法映射的原始标签，按影响题数降序', () => {
  db.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  const ins = db.prepare('INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES (?,?,?,1500,?)');
  // 未收录标签甲 影响 2 题；乙 影响 1 题；已收录的「贪心」不应出现
  ins.run('codeforces', 'A', 'T', JSON.stringify(['未收录甲', '贪心']));
  ins.run('codeforces', 'B', 'T', JSON.stringify(['未收录甲']));
  ins.run('codeforces', 'C', 'T', JSON.stringify(['未收录乙']));

  const r = gapReport(db);
  assert.deepEqual(r.gaps.map((g) => g.tag), ['未收录甲', '未收录乙']);
  assert.equal(r.gaps[0].problems, 2);
  assert.equal(r.gaps[1].problems, 1);
});

test('gapReport: 已收录标签即使占比很低也不进缺口清单', () => {
  db.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  db.prepare('INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES (?,?,?,1500,?)')
    .run('codeforces', 'A', 'T', JSON.stringify(['数学', '数论']));
  const r = gapReport(db);
  assert.deepEqual(r.gaps, [], '全是已收录标签时不应有缺口');
});

test('gapReport: manual 标注题不被算作 uncovered', () => {
  db.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  db.prepare('INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES (?,?,?,1500,?)')
    .run('codeforces', 'A', 'T', JSON.stringify(['未收录甲']));
  db.prepare(`INSERT INTO problem_keypoints
    (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
    VALUES ('codeforces','A','misc.sorting','排序',1,'manual','manual',1,1,'2026-01-01')`).run();
  const r = gapReport(db);
  assert.equal(r.uncovered, 0, '仅有 manual 标注的题应视为已覆盖');
});

test('gapReport: uncovered 统计完全无 code 的题数', () => {
  db.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  db.prepare('INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES (?,?,?,1500,?)')
    .run('codeforces', 'A', 'T', JSON.stringify(['未收录甲']));
  db.prepare('INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES (?,?,?,1500,?)')
    .run('codeforces', 'B', 'T', JSON.stringify(['贪心']));
  const r = gapReport(db);
  assert.equal(r.uncovered, 1, '只有 A 无任何可映射 code');
});

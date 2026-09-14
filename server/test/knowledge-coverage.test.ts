import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import { getCoverage } from '../src/knowledge/store.ts';

let db: Db;
beforeEach(() => { db = createDb(':memory:'); });
afterEach(() => { db.close(); });

test('getCoverage: 不计入 ai 标注（AI 已退出清洗模块）', () => {
  db.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  db.prepare("INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES ('codeforces','A','T',1500,'[]')").run();
  db.prepare("INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES ('codeforces','B','T',1500,'[]')").run();
  const ins = db.prepare(`INSERT INTO problem_keypoints
    (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
    VALUES ('codeforces',?,?,'n',1,?,'x',1,1,'2026-01-01')`);
  ins.run('A', 'basic.greedy', 'tag');
  ins.run('B', 'basic.greedy', 'ai');   // 不应计入
  const cov = getCoverage(db);
  assert.equal(cov.total, 2);
  assert.equal(cov.annotated, 1, '只有 tag 那题算已标注');
  assert.equal(cov.bySource.ai ?? 0, 0);
  assert.equal(cov.bySource.tag, 1);
});

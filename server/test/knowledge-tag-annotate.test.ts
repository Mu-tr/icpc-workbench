import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, type Db } from '../src/db/index.ts';
import { tagsToCodes, annotateProblemsFromTags } from '../src/knowledge/tagAnnotate.ts';
import {
  annotationsPath,
  initKnowledgeStore,
  keypointsOfProblem,
  loadAnnotationsIntoDb,
} from '../src/knowledge/store.ts';
import { runRulePass } from '../src/knowledge/pipeline.ts';

let db: Db;
beforeEach(() => { db = createDb(':memory:'); });
afterEach(() => { db.close(); });

test('tagsToCodes: 映射已知标签、归并别名、跳过无法映射的噪声', () => {
  assert.deepEqual(tagsToCodes(['二分查找']), ['basic.binary-search']);
  // dp 与 动态规划 归并到同一 code，去重后只留一个
  assert.deepEqual(tagsToCodes(['dp', '动态规划']), ['dp.general']);
  // 无法映射的标签被跳过，但不影响其它标签
  assert.deepEqual(tagsToCodes(['数学', '某不存在的标签']), ['math.general']);
  assert.deepEqual(tagsToCodes([]), []);
});

test('tagsToCodes: 多标签全部保留（不压缩为单一标签）', () => {
  const codes = tagsToCodes(['贪心', '动态规划', '排序']);
  assert.equal(codes.length, 3);
  assert.ok(codes.includes('basic.greedy'));
  assert.ok(codes.includes('dp.general'));
  assert.ok(codes.includes('misc.sorting'));
});

test('annotateProblemsFromTags: 落库为 source=tag，且不改写已有 rule 标注', () => {
  db.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  db.prepare("INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES ('codeforces','1A','T',1500,'[]')").run();
  const r = annotateProblemsFromTags(db, [
    { platform: 'codeforces', problemKey: '1A', tags: JSON.stringify(['贪心', '排序']) },
  ], { dataDir: null });
  assert.equal(r.scanned, 1);
  assert.equal(r.annotated, 1);
  const rows = db.prepare(
    "SELECT code, source FROM problem_keypoints WHERE platform='codeforces' AND problem_key='1A' ORDER BY code",
  ).all() as Array<{ code: string; source: string }>;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.source === 'tag'));
});

test('annotateProblemsFromTags: 无法映射的标签进 unmappedTags 供缺口报告', () => {
  db.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  db.prepare("INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES ('codeforces','2B','T',1500,'[]')").run();
  const r = annotateProblemsFromTags(db, [
    { platform: 'codeforces', problemKey: '2B', tags: JSON.stringify(['这是未收录标签']) },
  ], { dataDir: null });
  assert.equal(r.annotated, 0);
  assert.deepEqual(r.unmappedTags, ['这是未收录标签']);
});

// ---------- 主键约束 / 增量 / 事务 ----------

function insertProblem(key: string, title: string, tags: string): void {
  db.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  db.prepare('INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES (?,?,?,1500,?)').run(
    'codeforces',
    key,
    title,
    tags,
  );
}

function rowsOf(key: string): string[] {
  const rows = db
    .prepare("SELECT code, source, confidence FROM problem_keypoints WHERE platform='codeforces' AND problem_key=? ORDER BY code")
    .all(key) as Array<{ code: string; source: string; confidence: number }>;
  // node:sqlite 返回 null 原型对象，deepEqual 前先降为普通值
  return rows.map((x) => `${x.code}:${x.source}:${x.confidence}`);
}

test('annotateProblemsFromTags: 已被 rule 占用的 code 留给 rule（主键不含 source，不可重复写）', () => {
  insertProblem('3C', '线段树与贪心', '[]');
  db.prepare(
    `INSERT INTO problem_keypoints (platform, problem_key, code, name, confidence, source, method, taxonomy_version, pipeline_version, annotated_at)
     VALUES ('codeforces','3C','ds.segtree','线段树',0.9,'rule','rule#r001',1,1,'2026-01-01T00:00:00Z')`,
  ).run();

  const r = annotateProblemsFromTags(
    db,
    [{ platform: 'codeforces', problemKey: '3C', tags: JSON.stringify(['线段树', '贪心']) }],
    { dataDir: null },
  );

  assert.equal(r.annotated, 1);
  assert.deepEqual(rowsOf('3C'), ['basic.greedy:tag:1', 'ds.segtree:rule:0.9']);
});

test('annotateProblemsFromTags: 增量幂等（二次调用不重复写、不新增行）', () => {
  insertProblem('3D', 'T', '[]');
  const rows = [{ platform: 'codeforces', problemKey: '3D', tags: JSON.stringify(['贪心']) }];
  const first = annotateProblemsFromTags(db, rows, { dataDir: null });
  const second = annotateProblemsFromTags(db, rows, { dataDir: null });
  assert.equal(first.annotated, 1);
  assert.equal(second.scanned, 0);
  assert.equal(second.annotated, 0);
  assert.equal(rowsOf('3D').length, 1);
});

test('annotateProblemsFromTags: 在外层事务内调用不自行提交（回滚外层即整体回滚）', () => {
  insertProblem('3E', 'T', '[]');
  db.exec('BEGIN');
  const r = annotateProblemsFromTags(
    db,
    [{ platform: 'codeforces', problemKey: '3E', tags: JSON.stringify(['数学']) }],
    { dataDir: null },
  );
  assert.equal(r.annotated, 1);
  assert.equal(rowsOf('3E').length, 1); // 事务内可见
  db.exec('ROLLBACK');
  assert.equal(rowsOf('3E').length, 0); // 未自行提交，随外层一起回滚
});

test('L1 钩子：tag 与 rule 并联落库，JSONL 记两个来源且可重建', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-tag-test-'));
  initKnowledgeStore(dataDir);
  const db1 = createDb(':memory:');
  try {
    db1
      .prepare("INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES ('codeforces','7A','【模板】线段树 1',1500,?)")
      .run(JSON.stringify(['线段树', '贪心']));
    const r = runRulePass(db1);
    assert.equal(r.annotated, 1); // rule 命中线段树
    assert.equal(r.tagAnnotated, 1); // tag 补上 rule 未占用的贪心

    const before = db1
      .prepare('SELECT * FROM problem_keypoints ORDER BY platform, problem_key, code')
      .all();
    assert.deepEqual(
      (before as Array<{ code: string; source: string }>).map((x) => `${x.code}:${x.source}`),
      ['basic.greedy:tag', 'ds.segtree:rule'],
    );

    const lines = fs
      .readFileSync(annotationsPath(dataDir), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { writeSource: string });
    assert.deepEqual([...new Set(lines.map((l) => l.writeSource))].sort(), ['rule', 'tag']);

    // 源真相可重建：全新库从 JSONL 重放后行集与直写一致
    const db2 = createDb(':memory:');
    try {
      loadAnnotationsIntoDb(db2, dataDir);
      const after = db2
        .prepare('SELECT * FROM problem_keypoints ORDER BY platform, problem_key, code')
        .all();
      assert.deepEqual(
        after.map((x) => JSON.stringify(x)),
        before.map((x) => JSON.stringify(x)),
      );
    } finally {
      db2.close();
    }
  } finally {
    db1.close();
    initKnowledgeStore(null);
  }
});

test('annotateProblemsFromTags: 非 JSON / 非数组的 tags 视为无标签，不抛错', () => {
  insertProblem('3F', 'T', '[]');
  const r = annotateProblemsFromTags(
    db,
    [{ platform: 'codeforces', problemKey: '3F', tags: '{不是数组' }],
    { dataDir: null },
  );
  assert.equal(r.annotated, 0);
  assert.deepEqual(r.unmappedTags, []);
  assert.equal(rowsOf('3F').length, 0);
});

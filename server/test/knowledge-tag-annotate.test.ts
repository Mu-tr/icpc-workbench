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
  setManualKeypoints,
} from '../src/knowledge/store.ts';
import { runRulePass } from '../src/knowledge/pipeline.ts';
import { parseManualRow } from '../src/import/rows.ts';
import { insertNormalized } from '../src/import/importService.ts';
import { upsertBankProblems } from '../src/import/bankService.ts';

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

/** 只看 code:source（规则表 confidence 属于 rules.json 的口径，不在此断言）；可指定自带 dataDir 的用例的连接 */
function codeSourcesOf(key: string, target: Db = db): string[] {
  const rows = target
    .prepare("SELECT code, source FROM problem_keypoints WHERE platform='codeforces' AND problem_key=? ORDER BY code")
    .all(key) as Array<{ code: string; source: string }>;
  return rows.map((x) => `${x.code}:${x.source}`);
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

test('annotateProblemsFromTags: 增量幂等（二次调用不重复写库、不重复追加 JSONL）', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-tag-idem-'));
  insertProblem('3D', 'T', '[]');
  const rows = [{ platform: 'codeforces', problemKey: '3D', tags: JSON.stringify(['贪心']) }];
  const first = annotateProblemsFromTags(db, rows, { dataDir });
  const jsonlAfterFirst = fs.readFileSync(annotationsPath(dataDir), 'utf8').trim().split('\n').length;
  const second = annotateProblemsFromTags(db, rows, { dataDir });
  assert.equal(first.annotated, 1);
  assert.equal(second.annotated, 0, '应持有的 code 都已在库 → 不重复写');
  assert.equal(second.scanned, 1, 'scanned 统计参与扫描的题（含已覆盖而跳过的）');
  assert.deepEqual(rowsOf('3D'), ['basic.greedy:tag:1'], '行集不变');
  assert.equal(
    fs.readFileSync(annotationsPath(dataDir), 'utf8').trim().split('\n').length,
    jsonlAfterFirst,
    '幂等重跑不得重复追加 JSONL',
  );
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

test('L1 钩子：tag 与 rule 并联落库，JSONL 恰好两行且可重建', () => {
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
      .map((l) => JSON.parse(l) as { writeSource: string; knowledgePoints: Array<{ code: string }> });
    // 精确断言行数与来源：每个来源每道题只追加一行（内层 dataDir:null + 外层统一追加，
    // 不得出现重复的 tag 行）
    assert.equal(lines.length, 2, `JSONL 应恰好两行，实得 ${JSON.stringify(lines.map((l) => l.writeSource))}`);
    assert.deepEqual([...lines.map((l) => l.writeSource)].sort(), ['rule', 'tag']);
    assert.deepEqual(
      lines.find((l) => l.writeSource === 'tag')!.knowledgePoints.map((p) => p.code),
      ['basic.greedy'],
    );

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

test('L1 钩子：rule 想接管 tag 已占用的 code 时不撞主键（标题修复 + 差量重跑）', () => {
  // 场景即评审 C1：先由 tag 占住 basic.greedy，随后标题修复让 rule 也命中同一 code
  insertProblem('7B', 'A. 线段树', JSON.stringify(['贪心']));
  const first = runRulePass(db);
  assert.equal(first.tagAnnotated, 1);
  assert.ok(codeSourcesOf('7B').includes('basic.greedy:tag'));
  assert.ok(codeSourcesOf('7B').includes('ds.segtree:rule'));

  db.prepare("UPDATE problems SET title = 'A. 贪心' WHERE platform='codeforces' AND problem_key='7B'").run();
  const rerun = runRulePass(db, { rerun: true }); // 修复前：UNIQUE constraint failed → 整批回滚
  assert.equal(rerun.scanned, 1);
  assert.deepEqual(codeSourcesOf('7B'), ['basic.greedy:rule'], 'rule 按优先级接管该 code，tag 行让位');
});

test('L1 钩子：rule 行被清除后 tag 层重新认领回来（否则该题永久丢 code）', () => {
  // 评审 M9：tags[线段树,排序] 中 线段树 被 rule 占着（tag 只写了 排序，于是该题有了 tag 行）；
  // 标题修复后 rule 不再命中，清除快照删掉 rule 行 —— 若「已有 tag 行就整题跳过」，
  // 线段树 这个可映射的 code 就永久丢了
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-tag-reclaim-'));
  initKnowledgeStore(dataDir);
  const db1 = createDb(':memory:');
  try {
    db1
      .prepare("INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES ('codeforces','7C','A. 线段树',1500,?)")
      .run(JSON.stringify(['线段树', '排序']));
    const first = runRulePass(db1);
    assert.equal(first.tagAnnotated, 1);
    assert.deepEqual(
      codeSourcesOf('7C', db1),
      ['ds.segtree:rule', 'misc.sorting:tag'],
      'rule 占位时 tag 只写空缺',
    );

    db1.prepare("UPDATE problems SET title = 'A. 无信息题' WHERE platform='codeforces' AND problem_key='7C'").run();
    runRulePass(db1, { rerun: true });
    assert.deepEqual(
      codeSourcesOf('7C', db1),
      ['ds.segtree:tag', 'misc.sorting:tag'],
      'rule 行被清除后由 tag 接管，题目不失去覆盖',
    );

    // 清除快照（rule 墓碑）+ tag 重新认领 必须能重放：源真相重建后行集一致
    const before = db1.prepare('SELECT * FROM problem_keypoints ORDER BY platform, problem_key, code').all();
    const db2 = createDb(':memory:');
    try {
      loadAnnotationsIntoDb(db2, dataDir);
      const after = db2.prepare('SELECT * FROM problem_keypoints ORDER BY platform, problem_key, code').all();
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

test('annotateProblemsFromTags: 部分未映射的标签同样进 unmappedTags', () => {
  insertProblem('3G', 'T', '[]');
  const r = annotateProblemsFromTags(
    db,
    [{ platform: 'codeforces', problemKey: '3G', tags: JSON.stringify(['贪心', '某不存在的标签']) }],
    { dataDir: null },
  );
  assert.equal(r.annotated, 1);
  assert.deepEqual(r.unmappedTags, ['某不存在的标签']);
});

test('annotateProblemsFromTags: 非 JSON / 非数组的 tags 视为无标签，不抛错且计入 malformedTags', () => {
  insertProblem('3F', 'T', '[]');
  const broken = annotateProblemsFromTags(
    db,
    [{ platform: 'codeforces', problemKey: '3F', tags: '{不是数组' }],
    { dataDir: null },
  );
  assert.equal(broken.annotated, 0);
  assert.deepEqual(broken.unmappedTags, []);
  assert.equal(broken.malformedTags, 1);
  assert.equal(rowsOf('3F').length, 0);

  const empty = annotateProblemsFromTags(
    db,
    [{ platform: 'codeforces', problemKey: '3F', tags: '[]' }],
    { dataDir: null },
  );
  assert.equal(empty.malformedTags, 0, "'[]' 是合法空标签，不算脏数据");
});

// ---------- 下游入口：人工校正 / 导入路径 ----------

test('人工校正后重启重建：该题不得复活任何 tag 行（清除快照须含 tag）', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-tag-manual-'));
  initKnowledgeStore(dataDir);
  const db1 = createDb(':memory:');
  try {
    db1
      .prepare("INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES ('codeforces','8A','A. 线段树',1500,?)")
      .run(JSON.stringify(['贪心']));
    runRulePass(db1);
    assert.deepEqual(codeSourcesOf('8A', db1), ['basic.greedy:tag', 'ds.segtree:rule']);

    setManualKeypoints(db1, 'codeforces', '8A', ['dp.general']);
    assert.deepEqual(codeSourcesOf('8A', db1), ['dp.general:manual']);

    // 源真相重放：tag 层不会重访 manual 题，若清除快照漏了 tag，这里会复活基本贪心
    const db2 = createDb(':memory:');
    try {
      loadAnnotationsIntoDb(db2, dataDir);
      assert.deepEqual(
        keypointsOfProblem(db2, 'codeforces', '8A').map((k) => `${k.code}:${k.source}`),
        ['dp.general:manual'],
        '人工校正后 tag 行不得从 JSONL 重放复活',
      );
    } finally {
      db2.close();
    }
  } finally {
    db1.close();
    initKnowledgeStore(null);
  }
});

test('导入路径：新导入题在同一批里落库 source=tag', () => {
  // 标题不命中规则，行集纯粹由 tag 层产生（修复前：callers 不传 tags → 该题连一行都没有）
  insertNormalized(db, 1, [
    parseManualRow('codeforces', { problemKey: '9A', title: 'A. 无信息题', verdict: 'AC', tags: ['贪心', '排序'] }, 0),
  ]);
  assert.deepEqual(codeSourcesOf('9A'), ['basic.greedy:tag', 'misc.sorting:tag']);
});

test('题库路径：新入库题并联 tag 标注，且按库内落定标签（空标签不覆盖旧值）', () => {
  // 库内已有标签、但还没有任何标注：入库时传空标签（不覆盖旧值），
  // tag 标注必须按**落库后的** ['贪心'] 映射，而不是本次入参的 []
  db.prepare("INSERT INTO problems (platform,problem_key,title,tags) VALUES ('codeforces','9B','A. 题','[\"贪心\"]')").run();
  upsertBankProblems(db, [
    { platform: 'codeforces', problemKey: '9B', title: 'A. 题', difficulty: null, url: null, tags: [] },
  ]);
  assert.deepEqual(codeSourcesOf('9B'), ['basic.greedy:tag']);
});


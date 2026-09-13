import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../src/db/index.ts';
import {
  getConfidenceThreshold,
  getCoverage,
  initKnowledgeStore,
  keypointsOfProblem,
  knowledgeTagsCoalesceSql,
  knowledgeTagsJoinSql,
  knowledgeTagsSql,
  loadAnnotationsIntoDb,
  problemKeypointsCte,
  setConfidenceThreshold,
  setManualKeypoints,
} from '../src/knowledge/store.ts';
import { annotateProblemsL1, pendingAiCount, runRulePass } from '../src/knowledge/pipeline.ts';

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-test-'));
}

function insertProblem(db: ReturnType<typeof createDb>, platform: string, key: string, title: string, tags = '[]'): void {
  db.prepare('INSERT INTO problems (platform, problem_key, title, tags) VALUES (?, ?, ?, ?)').run(platform, key, title, tags);
}

test('L1 标注落库 + JSONL 重建索引 diff 为空（可重建）', () => {
  const dataDir = tempDataDir();
  initKnowledgeStore(dataDir);
  const db = createDb(':memory:');
  try {
    insertProblem(db, 'codeforces', '1A', 'Binary Search on Answers');
    insertProblem(db, 'luogu', 'P3372', '【模板】线段树 1');
    const r = annotateProblemsL1(db, [
      { platform: 'codeforces', problemKey: '1A', title: 'Binary Search on Answers' },
      { platform: 'luogu', problemKey: 'P3372', title: '【模板】线段树 1' },
    ]);
    assert.equal(r.annotated, 2);

    const before = db.prepare('SELECT * FROM problem_keypoints ORDER BY platform, problem_key, code').all();
    assert.ok(before.length >= 2);

    // 全新库从 JSONL 重建：与直接写入完全一致
    const db2 = createDb(':memory:');
    try {
      const loaded = loadAnnotationsIntoDb(db2, dataDir);
      assert.ok(loaded.lines >= 2);
      const after = db2.prepare('SELECT * FROM problem_keypoints ORDER BY platform, problem_key, code').all();
      assert.deepEqual(
        after.map((r) => JSON.stringify(r)),
        before.map((r) => JSON.stringify(r)),
      );
    } finally {
      db2.close();
    }
  } finally {
    db.close();
    initKnowledgeStore(null);
  }
});

test('幂等重跑：二次 L1 不产生重复标注，结果一致', () => {
  const dataDir = tempDataDir();
  initKnowledgeStore(dataDir);
  const db = createDb(':memory:');
  try {
    insertProblem(db, 'codeforces', '2A', 'Dijkstra shortest path');
    const r1 = runRulePass(db);
    const r2 = runRulePass(db);
    assert.equal(r1.annotated, 1);
    assert.equal(r2.annotated, 0); // 已标注跳过
    assert.equal(r2.scanned, 0);
    const rows = db.prepare('SELECT code, source, method FROM problem_keypoints').all() as Array<{ code: string }>;
    // 一题多知识点：dijkstra 与最短路（综合）多命中，如实皆兵
    assert.ok(rows.map((r) => r.code).includes('graph.dijkstra'));
    assert.equal(rows.length, 2);
  } finally {
    db.close();
    initKnowledgeStore(null);
  }
});

test('未命中题入 L2 队列；命中后自动出队；manual 永不覆盖', () => {
  const dataDir = tempDataDir();
  initKnowledgeStore(dataDir);
  const db = createDb(':memory:');
  try {
    insertProblem(db, 'codeforces', '3A', 'A. 神奇的题');
    insertProblem(db, 'codeforces', '3B', '【模板】并查集');
    const r = annotateProblemsL1(db, [
      { platform: 'codeforces', problemKey: '3A', title: 'A. 神奇的题' },
      { platform: 'codeforces', problemKey: '3B', title: '【模板】并查集' },
    ]);
    assert.equal(r.enqueued, 1);
    assert.equal(pendingAiCount(db), 1);

    // 人工校正 3A：之后管线重跑不得覆盖
    setManualKeypoints(db, 'codeforces', '3A', ['dp.general']);
    const rerun = annotateProblemsL1(db, [{ platform: 'codeforces', problemKey: '3A', title: '线段树再临' }], { force: true });
    assert.equal(rerun.skippedManual, 1);
    const manual = keypointsOfProblem(db, 'codeforces', '3A');
    assert.deepEqual(manual.map((k) => `${k.code}:${k.source}`), ['dp.general:manual']);

    // JSONL 重放：rule/ai 墓碑 + manual 快照 → 重建后仍只有 manual
    const db2 = createDb(':memory:');
    try {
      loadAnnotationsIntoDb(db2, dataDir);
      const replayed = keypointsOfProblem(db2, 'codeforces', '3A');
      assert.deepEqual(replayed.map((k) => `${k.code}:${k.source}`), ['dp.general:manual']);
    } finally {
      db2.close();
    }
  } finally {
    db.close();
    initKnowledgeStore(null);
  }
});

test('统计读取路径：标注优先且不再受阈值过滤，无标注回退题源 tags', () => {
  const db = createDb(':memory:');
  try {
    insertProblem(db, 'codeforces', '4A', '题A', '["greedy"]');
    insertProblem(db, 'codeforces', '4B', '题B', '["greedy"]');
    insertProblem(db, 'codeforces', '4C', '题C', '["greedy"]');
    const ins = db.prepare(
      `INSERT INTO problem_keypoints (platform, problem_key, code, name, confidence, source, method, taxonomy_version, pipeline_version, annotated_at)
       VALUES ('codeforces', ?, ?, ?, ?, 'rule', 'rule#r002', 1, 1, '2026-01-01T00:00:00Z')`,
    );
    ins.run('4A', 'basic.binary-search', '二分查找', 0.9);
    // 低于历史默认阈值 0.6 的标注：confidence 已降级为「来源内排序权重」，
    // 不再充当读取路径的可信度门槛（见 knowledge/store.ts 二来源注释）
    ins.run('4B', 'basic.greedy', '贪心', 0.3);
    const tagsOf = (key: string): string[] => {
      const row = db.prepare(`SELECT ${knowledgeTagsSql(db)} FROM problems p WHERE p.problem_key = ?`).get(key) as {
        tags: string;
      };
      return JSON.parse(row.tags) as string[];
    };
    assert.deepEqual(tagsOf('4A'), ['二分查找']);
    assert.deepEqual(tagsOf('4B'), ['贪心']); // 0.3 的标注照读，不被阈值滤掉
    assert.deepEqual(tagsOf('4C'), ['greedy']); // 无标注 → 回退题源 tags

    // 阈值设置本身仍可用（设置页与覆盖率报告仍在读它），但它不再影响本读取路径
    setConfidenceThreshold(db, 0.95);
    assert.deepEqual(tagsOf('4B'), ['贪心']);
    assert.equal(getConfidenceThreshold(db), 0.95);
    assert.throws(() => setConfidenceThreshold(db, 1.5));
  } finally {
    db.close();
  }
});

test('覆盖率报告：bySource / 低置信 / 待标注统计正确', () => {
  const dataDir = tempDataDir();
  initKnowledgeStore(dataDir);
  const db = createDb(':memory:');
  try {
    insertProblem(db, 'codeforces', '5A', '【模板】线段树 1');
    insertProblem(db, 'codeforces', '5B', 'B. 无信息题');
    annotateProblemsL1(db, [
      { platform: 'codeforces', problemKey: '5A', title: '【模板】线段树 1' },
      { platform: 'codeforces', problemKey: '5B', title: 'B. 无信息题' },
    ]);
    setManualKeypoints(db, 'codeforces', '5B', ['misc.sorting']);
    const cov = getCoverage(db);
    assert.equal(cov.total, 2);
    assert.equal(cov.annotated, 2);
    assert.equal(cov.coverage, 100);
    assert.equal(cov.bySource.rule, 1);
    assert.equal(cov.bySource.manual, 1);
    assert.equal(cov.uncovered, 0);
  } finally {
    db.close();
    initKnowledgeStore(null);
  }
});

test('读取路径只认 tag/rule/manual，忽略 ai 与 v1 problem_topics', () => {
  const db = createDb(':memory:');
  try {
    db.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
    db.prepare("INSERT INTO problems (id,platform,problem_key,title,difficulty,tags) VALUES (1,'codeforces','1A','T',1500,'[\"题源标签\"]')").run();
    // v1 遗留层有数据，但不得再被读取
    db.prepare("INSERT INTO problem_topics (problem_id,topic_id,confidence,method,pipeline_version) VALUES (1,'v1主题',1,'manual','x')").run();
    // ai 标注存在，也不得再被读取
    db.prepare(`INSERT INTO problem_keypoints
      (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
      VALUES ('codeforces','1A','basic.greedy','贪心',1,'ai','ai',1,1,'2026-01-01')`).run();
    const row = db.prepare(`SELECT ${knowledgeTagsSql(db)} FROM problems p WHERE p.id = 1`).get() as { tags: string };
    // 无 tag/rule/manual 标注 → 回退到题源 tags（既不是 v1 主题，也不是 ai 标注）
    assert.deepEqual(JSON.parse(row.tags), ['题源标签']);
  } finally {
    db.close();
  }
});

test('tag 与 rule 标注并存时全部返回（多 code 不压缩）', () => {
  const db = createDb(':memory:');
  try {
    db.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
    db.prepare("INSERT INTO problems (id,platform,problem_key,title,difficulty,tags) VALUES (2,'codeforces','2B','T',1500,'[]')").run();
    const ins = db.prepare(`INSERT INTO problem_keypoints
      (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
      VALUES ('codeforces','2B',?,?,1,?,'x',1,1,'2026-01-01')`);
    ins.run('basic.greedy', '贪心', 'tag');
    ins.run('dp.general', '动态规划', 'rule');
    const row = db.prepare(`SELECT ${knowledgeTagsSql(db)} FROM problems p WHERE p.id = 2`).get() as { tags: string };
    // 读取路径回传的是标注的展示名（既有契约：pk.tags 是 name 数组，见现有 4A 用例）
    assert.deepEqual((JSON.parse(row.tags) as string[]).sort(), ['贪心', '动态规划'].sort());
  } finally {
    db.close();
  }
});

test('manual 标注必须被读取：人工校正不被原始题源标签顶掉', () => {
  const db = createDb(':memory:');
  try {
    db.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
    db.prepare("INSERT INTO problems (id,platform,problem_key,title,difficulty,tags) VALUES (20,'codeforces','20A','T',1500,'[\"题源标签\"]')").run();
    db.prepare("INSERT INTO problems (id,platform,problem_key,title,difficulty,tags) VALUES (21,'codeforces','21B','T',1500,'[\"题源标签\"]')").run();
    const ins = db.prepare(`INSERT INTO problem_keypoints
      (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
      VALUES ('codeforces',?,?,?,1,?,?,1,1,'2026-01-01')`);
    // 20A：库里只有 manual 行（等价于 JSONL 重放后的落库形态）→ 必须回传 manual 的 name
    ins.run('20A', 'misc.sorting', '排序', 'manual', 'manual');
    // 21B：先有 rule / tag 标注，随后被人工校正整题覆盖（setManualKeypoints 删掉该题全部旧行）
    ins.run('21B', 'ds.segtree', '线段树', 'rule', 'rule#r001');
    ins.run('21B', 'basic.greedy', '贪心', 'tag', 'tag');
    setManualKeypoints(db, 'codeforces', '21B', ['misc.sorting'], { dataDir: null });
    const tagsOf = (key: string): string[] => {
      const row = db.prepare(`SELECT ${knowledgeTagsSql(db)} FROM problems p WHERE p.problem_key = ?`).get(key) as {
        tags: string;
      };
      return JSON.parse(row.tags) as string[];
    };
    // 摘掉 manual 的口径下这两题都会读成题源标签 ['题源标签']：人工校正被静默丢弃
    assert.deepEqual(tagsOf('20A'), ['排序']);
    assert.deepEqual(tagsOf('21B'), ['排序'], '被人工校正覆盖的 tag/rule 标注不得复活');
  } finally {
    db.close();
  }
});

test('CTE/join 形态与标量形态同口径：标注侧聚合、v1 表不参与、无标注回退 p.tags', () => {
  const db = createDb(':memory:');
  try {
    db.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
    // 12A：无标注，但有 v1 遗留行 —— 若 pt 分支未摘除，这里会读出「v1主题」
    db.prepare("INSERT INTO problems (id,platform,problem_key,title,difficulty,tags) VALUES (12,'codeforces','12A','T',1500,'[\"题源标签\"]')").run();
    db.prepare("INSERT INTO problem_topics (problem_id,topic_id,confidence,method,pipeline_version) VALUES (12,'v1主题',1,'manual','x')").run();
    // 13B：tag + rule 两来源同在 —— 必须全部返回，且 ai 行不参与
    db.prepare("INSERT INTO problems (id,platform,problem_key,title,difficulty,tags) VALUES (13,'codeforces','13B','T',1500,'[]')").run();
    const ins = db.prepare(`INSERT INTO problem_keypoints
      (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
      VALUES ('codeforces',?,?,?,1,?,'x',1,1,'2026-01-01')`);
    ins.run('13B', 'basic.greedy', '贪心', 'tag');
    ins.run('13B', 'dp.general', '动态规划', 'rule');
    ins.run('13B', 'misc.sorting', '排序', 'ai');
    const rows = db
      .prepare(
        `WITH ${problemKeypointsCte(db)} SELECT p.id, ${knowledgeTagsCoalesceSql()} FROM problems p ` +
          `${knowledgeTagsJoinSql()} ORDER BY p.id`,
      )
      .all() as Array<{ id: number; tags: string }>;
    assert.deepEqual(
      rows.map((r) => `${r.id}:${(JSON.parse(r.tags) as string[]).sort().join(',')}`),
      ['12:题源标签', '13:动态规划,贪心'],
    );
  } finally {
    db.close();
  }
});

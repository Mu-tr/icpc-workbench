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
  knowledgeTagsSql,
  loadAnnotationsIntoDb,
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

test('统计读取路径：达标标注优先，低置信回退 tags，阈值可调', () => {
  const db = createDb(':memory:');
  try {
    insertProblem(db, 'codeforces', '4A', '题A', '["greedy"]');
    db.prepare(
      `INSERT INTO problem_keypoints (platform, problem_key, code, name, confidence, source, method, taxonomy_version, pipeline_version, annotated_at)
       VALUES ('codeforces', '4A', 'basic.binary-search', '二分查找', 0.9, 'rule', 'rule#r002', 1, 1, '2026-01-01T00:00:00Z')`,
    ).run();
    const row1 = db.prepare(`SELECT p.id, ${knowledgeTagsSql(db)} FROM problems p`).get() as { tags: string };
    assert.deepEqual(JSON.parse(row1.tags), ['二分查找']);

    // 阈值调到 0.95 后该标注被过滤 → 回退题源 tags
    setConfidenceThreshold(db, 0.95);
    const row2 = db.prepare(`SELECT p.id, ${knowledgeTagsSql(db)} FROM problems p`).get() as { tags: string };
    assert.deepEqual(JSON.parse(row2.tags), ['greedy']);
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

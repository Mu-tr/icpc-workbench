import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../src/db/index.ts';
import { purgeAiAnnotations, loadAnnotationsIntoDb } from '../src/knowledge/store.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'purge-ai-'));
}

function seedAi(db: ReturnType<typeof createDb>, key: string): void {
  db.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  db.prepare("INSERT OR IGNORE INTO problems (platform,problem_key,title,difficulty,tags) VALUES ('codeforces',?,'T',1500,'[]')").run(key);
  db.prepare(`INSERT INTO problem_keypoints
    (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
    VALUES ('codeforces',?,'basic.greedy','贪心',0.8,'ai','ai',1,1,'2026-01-01')`).run(key);
}

test('purgeAiAnnotations: 删除全部 ai 点位（含 ai:manual-import）', () => {
  const db = createDb(':memory:');
  seedAi(db, '1A');
  db.prepare(`INSERT INTO problem_keypoints
    (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
    VALUES ('codeforces','1A','misc.sorting','排序',0.9,'ai','ai:manual-import',1,1,'2026-01-01')`).run();
  db.prepare(`INSERT INTO problem_keypoints
    (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
    VALUES ('codeforces','1A','dp.general','动态规划',0.9,'rule','rule#r001',1,1,'2026-01-01')`).run();

  const r = purgeAiAnnotations(db, { dataDir: null });
  assert.equal(r.deleted, 2, '两条 ai 点位都应删除');
  const left = db.prepare("SELECT source FROM problem_keypoints WHERE platform='codeforces' AND problem_key='1A'").all() as Array<{ source: string }>;
  assert.deepEqual(left.map((x) => x.source), ['rule'], 'rule 标注必须保留');
  db.close();
});

test('purgeAiAnnotations: 幂等 —— 重复执行不再产生变化', () => {
  const db = createDb(':memory:');
  seedAi(db, '2B');
  const first = purgeAiAnnotations(db, { dataDir: null });
  assert.equal(first.deleted, 1);
  const second = purgeAiAnnotations(db, { dataDir: null });
  assert.equal(second.deleted, 0);
  assert.equal(second.tombstones, 0);
  db.close();
});

test('purgeAiAnnotations: 写 JSONL tombstone 后重放不再复活 ai 标注', () => {
  const dir = tmpDir();
  const db = createDb(':memory:');
  seedAi(db, '3C');
  const r = purgeAiAnnotations(db, { dataDir: dir });
  assert.equal(r.tombstones, 1);

  // 模拟重启：新建库（schema 自带迁移会再次 purge，故先确认 JSONL 重放结果）
  const db2 = createDb(':memory:');
  seedAi(db2, '3C');
  db2.prepare("DELETE FROM problem_keypoints WHERE source='ai'").run();
  const loaded = loadAnnotationsIntoDb(db2, dir);
  assert.equal(loaded.inserted, 0, 'JSONL 里的 ai tombstone 不应让任何标注复活');
  const rows = db2.prepare("SELECT COUNT(*) AS c FROM problem_keypoints WHERE source='ai'").get() as { c: number };
  assert.equal(rows.c, 0);
  db2.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('purgeAiAnnotations: 通过 purge 自身写入的 tombstone 阻止 ai 标注复活', () => {
  const dir = tmpDir();
  const db = createDb(':memory:');
  seedAi(db, '4D');
  const r = purgeAiAnnotations(db, { dataDir: dir });
  assert.equal(r.tombstones, 1, '应为每个 problem×ai 写入一个 tombstone');
  assert.equal(r.deleted, 1, '应删除一条 ai 标注');

  const db2 = createDb(':memory:');
  seedAi(db2, '4D');
  const loaded = loadAnnotationsIntoDb(db2, dir);
  assert.equal(loaded.inserted, 0, 'tombstone 不应让 ai 标注复活');
  const rows = db2.prepare("SELECT COUNT(*) AS c FROM problem_keypoints WHERE source='ai'").get() as { c: number };
  assert.equal(rows.c, 0, '重放后不应存在 ai 标注');
  db2.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

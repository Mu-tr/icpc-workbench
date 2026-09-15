import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../src/db/index.ts';
import { problemUpsertSql } from '../src/import/problemWritePolicy.ts';
import { upsertBankProblems } from '../src/import/bankService.ts';

function freshDb() {
  return createDb(':memory:');
}

test('迁移：老库缺列时自动补齐且幂等', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-mig-'));
  const dbPath = path.join(dir, 't.db');
  const colsOf = (d: any) => (d.prepare('PRAGMA table_info(problems)').all() as Array<{ name: string }>).map((c) => c.name);
  try {
    const db1 = createDb(dbPath);
    assert.ok(colsOf(db1).includes('native_difficulty'));
    // 模拟老库：删掉两列后再重开，迁移应补回
    db1.exec('ALTER TABLE problems DROP COLUMN native_difficulty');
    db1.exec('ALTER TABLE problems DROP COLUMN difficulty_scale');
    assert.ok(!colsOf(db1).includes('native_difficulty'));
    db1.close();
    const db2 = createDb(dbPath);
    const cols = colsOf(db2);
    assert.ok(cols.includes('native_difficulty'));
    assert.ok(cols.includes('difficulty_scale'));
    db2.close();
    // 幂等：再次重开不报错
    const db3 = createDb(dbPath);
    assert.ok(colsOf(db3).includes('difficulty_scale'));
    db3.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('写库：同步来源写入原生难度；题库来源不覆盖已落定的难度与原生值', () => {
  const db = freshDb();
  // 先由优先级更高的 sync(2) 写入，构成「已落定」值
  const upsertSync = db.prepare(problemUpsertSql('sync'));
  upsertSync.run('luogu', 'P3373', '线段树 2', 1800, 'https://www.luogu.com.cn/problem/P3373', '[]', 'sync', '4', 'luogu-2026-06');
  let row = db.prepare("SELECT difficulty, native_difficulty, difficulty_scale FROM problems WHERE problem_key = 'P3373'").get() as any;
  // node:sqlite 返回的行是 null 原型对象，node:assert/strict 的 deepEqual 要求原型一致 → 先摊平成普通对象
  assert.deepEqual({ ...row }, { difficulty: 1800, native_difficulty: '4', difficulty_scale: 'luogu-2026-06' });

  // 题库来源优先级最低（bank(1) < sync(2)）：即使给出不同难度与原生值也不得覆盖已落定值
  // 注：同来源为平级（`>=` 才覆盖），故平级覆盖不在此断言
  const upsert = db.prepare(problemUpsertSql('bank'));
  upsert.run('luogu', 'P3373', '线段树 2', 1500, null, '[]', 'bank', '3', 'luogu-2026-06');
  row = db.prepare("SELECT difficulty, native_difficulty FROM problems WHERE problem_key = 'P3373'").get() as any;
  assert.equal(row.difficulty, 1800);
  assert.equal(row.native_difficulty, '4');

  // 来源更高时覆盖（manual(4) ≥ sync(2)）：难度与原生值一并更新
  db.prepare(problemUpsertSql('manual')).run('luogu', 'P3373', '线段树 2', 2000, null, '[]', 'manual', '5', 'luogu-2026-06');
  row = db.prepare("SELECT difficulty, native_difficulty FROM problems WHERE problem_key = 'P3373'").get() as any;
  assert.equal(row.difficulty, 2000);
  assert.equal(row.native_difficulty, '5');
  db.close();
});

test('题库入库写入原生难度与标度', () => {
  const db = freshDb();
  const r = upsertBankProblems(db, [{
    platform: 'jisuanke', problemKey: 'T1001', title: '计算A+B', difficulty: 800,
    nativeDifficulty: 'level1', difficultyScale: 'jisuanke-level-8',
    url: 'https://www.jisuanke.com/problem/T1001', tags: ['输入和输出'],
  }]);
  assert.equal(r[0].inserted, 1);
  const row = db.prepare("SELECT difficulty, native_difficulty, difficulty_scale FROM problems WHERE problem_key = 'T1001'").get() as any;
  assert.deepEqual({ ...row }, { difficulty: 800, native_difficulty: 'level1', difficulty_scale: 'jisuanke-level-8' });
  db.close();
});

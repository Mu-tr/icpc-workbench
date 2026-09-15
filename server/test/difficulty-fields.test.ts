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

test('写库：原生难度/标度与难度同一条优先级决策（不得落成「手动难度 + 上游档位」的不同源组合）', () => {
  const db = freshDb();
  const read = (key: string) =>
    db
      .prepare(
        "SELECT difficulty, difficulty_source, native_difficulty, difficulty_scale FROM problems WHERE platform = 'luogu' AND problem_key = ?",
      )
      .get(key) as any;

  // (a) 手动标定难度、原生值为空 → 低优先级题库写入（bank(1) < manual(4)）不得补上上游档位
  //     （修复前 native_difficulty 走「库里为空就填」的旧判据 → 落成 2400 + '5'/luogu-2026-06：
  //      API 由原生值派生的档位名「提高」= 2200，与难度 2400 自相矛盾）
  db.prepare(problemUpsertSql('manual')).run('luogu', 'P2400', '题', 2400, null, '[]', 'manual', null, null);
  db.prepare(problemUpsertSql('bank')).run('luogu', 'P2400', '题', 2200, null, '[]', 'bank', '5', 'luogu-2026-06');
  assert.deepEqual({ ...read('P2400') }, {
    difficulty: 2400,
    difficulty_source: 'manual',
    native_difficulty: null,
    difficulty_scale: null,
  });

  // (b) 平级/更高优先级写入真的采纳了难度 → 原生值/标度一并更新（三元组同源）
  db.prepare(problemUpsertSql('sync')).run('luogu', 'P1800', '题', 1500, null, '[]', 'sync', '3', 'luogu-2026-06');
  db.prepare(problemUpsertSql('sync')).run('luogu', 'P1800', '题', 1800, null, '[]', 'sync', '4', 'luogu-2026-06');
  assert.deepEqual({ ...read('P1800') }, {
    difficulty: 1800,
    difficulty_source: 'sync',
    native_difficulty: '4',
    difficulty_scale: 'luogu-2026-06',
  });

  // (b2) 低优先级写入不得改动三元组（难度不动，原生值/标度也不动）
  db.prepare(problemUpsertSql('bank')).run('luogu', 'P1800', '题', 1200, null, '[]', 'bank', '2', 'luogu-2026-06');
  assert.deepEqual({ ...read('P1800') }, {
    difficulty: 1800,
    difficulty_source: 'sync',
    native_difficulty: '4',
    difficulty_scale: 'luogu-2026-06',
  });

  // (c) 难度为空的行照常接收原生值与标度（补全/首入库路径）
  db.prepare(problemUpsertSql('bank')).run('luogu', 'P0000', '题', null, null, '[]', 'bank', null, null);
  db.prepare(problemUpsertSql('bank')).run('luogu', 'P0000', '题', 1500, null, '[]', 'bank', '3', 'luogu-2026-06');
  assert.deepEqual({ ...read('P0000') }, {
    difficulty: 1500,
    difficulty_source: 'bank',
    native_difficulty: '3',
    difficulty_scale: 'luogu-2026-06',
  });
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../src/db/index.ts';

/**
 * 洛谷接口的 language 是数字 langId，历史上被当 JS number 绑进 TEXT 列、
 * 由 SQLite 按 REAL 渲染成 "34.0"。迁移要收成整数字符串 "34"，
 * 非数字语言名与其它平台的行不动，重复打开不二次变化。
 * migrate() 只在 createDb 时触发，所以用临时文件库「写旧数据 → 重开」来驱动。
 */
test('migrate: 归一洛谷数字 langId（"34.0" → "34"），其它值不动且幂等', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-migrate-lang-'));
  const file = path.join(dir, 'icpc.db');
  try {
    const db1 = createDb(file);
    const pid = (db1
      .prepare("INSERT INTO problems (platform, problem_key, title) VALUES ('luogu', 'P1001', 'A+B')")
      .run()
      .lastInsertRowid) as number;
    const cfPid = (db1
      .prepare("INSERT INTO problems (platform, problem_key, title) VALUES ('codeforces', '1919A', 'X')")
      .run()
      .lastInsertRowid) as number;
    const ins = db1.prepare(
      "INSERT INTO submissions (user_id, platform, problem_id, verdict, submitted_at, external_id, language) VALUES (1, ?, ?, 'AC', '2026-08-30T12:00:00.000Z', ?, ?)",
    );
    ins.run('luogu', pid, 'e1', '34.0'); // 病态：REAL 渲染
    ins.run('luogu', pid, 'e2', '2.0');
    ins.run('luogu', pid, 'e3', '28'); // 已归一：不应再被改写
    db1.close();

    // 其它平台的同名值不在本迁移射程内（只有洛谷会下发数字 ID）
    const db1b = createDb(file);
    db1b
      .prepare(
        "INSERT INTO submissions (user_id, platform, problem_id, verdict, submitted_at, external_id, language) VALUES (1, 'codeforces', ?, 'AC', '2026-08-30T12:00:00.000Z', 'e4', 'C++17 (GCC 7-32)')",
      )
      .run(cfPid);
    db1b
      .prepare(
        "INSERT INTO submissions (user_id, platform, problem_id, verdict, submitted_at, external_id, language) VALUES (1, 'codeforces', ?, 'AC', '2026-08-30T12:00:00.000Z', 'e5', '34.0')",
      )
      .run(cfPid);
    db1b.close();

    const db2 = createDb(file);
    const get = (eid: string): string | null =>
      (db2.prepare('SELECT language FROM submissions WHERE external_id = ?').get(eid) as { language: string | null }).language;
    assert.equal(get('e1'), '34');
    assert.equal(get('e2'), '2');
    assert.equal(get('e3'), '28'); // 幂等：干净值不变
    assert.equal(get('e4'), 'C++17 (GCC 7-32)'); // 语言名不动
    assert.equal(get('e5'), '34.0'); // 非洛谷平台不改（迁移按平台限定）
    db2.close();

    const db3 = createDb(file);
    const again = (db3.prepare('SELECT language FROM submissions WHERE external_id = ?').get('e1') as { language: string }).language;
    assert.equal(again, '34');
    db3.close();
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows 下 WAL 句柄释放可能滞后，删不掉就留给系统临时目录清理
    }
  }
});

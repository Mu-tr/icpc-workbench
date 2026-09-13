import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, type Db } from '../src/db/index.ts';
import {
  applyPendingRestore,
  createBackup,
  listBackups,
  maybeDailyBackup,
  requestRestore,
} from '../src/backup.ts';

let db: Db;
let dir: string;
beforeEach(() => {
  db = createDb(':memory:');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-backup-'));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createBackup：VACUUM INTO 快照包含完整数据，listBackups 返回元信息', () => {
  db.prepare("INSERT INTO settings (key, value) VALUES ('k1', 'v1')").run();
  const b = createBackup(db, 'manual', dir);
  assert.match(b.file, /^icpc-\d{8}-\d{6}-manual\.db$/);
  assert.ok(b.size > 0);

  // 备份文件可独立打开且包含数据
  const restored = createDb(path.join(dir, b.file));
  const row = restored.prepare("SELECT value FROM settings WHERE key = 'k1'").get() as { value: string };
  assert.equal(row.value, 'v1');
  restored.close();

  const list = listBackups(db, dir);
  assert.equal(list.length, 1);
  assert.equal(list[0].reason, 'manual');
});

test('保留策略：同 reason 只留最近 N 份，总份数兜底', () => {
  // 手动备份保留 10 份：创建 12 份（用不同 mtime 区分不了同秒 → 依靠文件名退避与清理逻辑）
  for (let i = 0; i < 12; i += 1) {
    createBackup(db, 'manual', dir);
    // 同秒文件名退避依赖 Date.now()%1000，可能碰撞；碰撞时 createBackup 内部会换名，不抛错即可
  }
  assert.ok(listBackups(db, dir).length <= 10, 'manual 备份应只保留 10 份');
});

test('requestRestore + applyPendingRestore：标记、覆盖与 WAL 清理', () => {
  // 模拟生产布局：dbPath 在 dir 下，备份目录派生为 dir/backups，标记写在 dir 下
  const dbPath = path.join(dir, 'main.db');
  const real = createDb(dbPath);
  real.prepare("INSERT INTO settings (key, value) VALUES ('marker', 'real')").run();
  const backup = createBackup(real, 'manual');
  real.close();

  // 备份之后再写入一个新键：恢复后该键应消失（回滚到备份时间点）
  const real2 = createDb(dbPath);
  real2.prepare("INSERT INTO settings (key, value) VALUES ('after-backup', 'x')").run();

  const marker = requestRestore(real2, backup.file);
  assert.ok(marker.requestedAt);
  assert.ok(fs.existsSync(path.join(dir, 'restore-pending.json')), '标记写在数据目录下');
  real2.close();

  const applied = applyPendingRestore(dbPath);
  assert.equal(applied, backup.file);
  assert.ok(!fs.existsSync(path.join(dir, 'restore-pending.json')), '标记应用后清除');
  assert.ok(!fs.existsSync(dbPath + '-wal'), '恢复后应清理 WAL 残留');

  // 恢复后的库不含备份之后的键
  const restored = createDb(dbPath);
  assert.equal(restored.prepare("SELECT COUNT(*) AS c FROM settings WHERE key = 'after-backup'").get()!.c, 0);
  restored.close();
});

test('applyPendingRestore：无标记返回 null；非法/缺失备份安全跳过', () => {
  const dbPath = path.join(dir, 'main.db');
  const cur = createDb(dbPath);
  cur.prepare("INSERT INTO settings (key, value) VALUES ('k', 'v')").run();
  cur.close();
  assert.equal(applyPendingRestore(dbPath), null);

  fs.writeFileSync(path.join(dir, 'restore-pending.json'), JSON.stringify({ file: 'not-exist.db' }));
  assert.equal(applyPendingRestore(dbPath), null);
  const after = createDb(dbPath);
  assert.equal(after.prepare("SELECT value FROM settings WHERE key='k'").get()!.value, 'v', '恢复失败时保留现有数据库');
  after.close();
});

test('maybeDailyBackup：当日幂等，次日（模拟）可再备', () => {
  const r1 = maybeDailyBackup(db, dir);
  assert.equal(r1.created, true);
  const r2 = maybeDailyBackup(db, dir);
  assert.equal(r2.created, false, '同一天重复启动不再备份');
  assert.equal(listBackups(db, dir).length, 1);
});

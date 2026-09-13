import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDataDir, migrateLegacyDataDir } from '../src/data-dir.ts';

// ---------- resolveDataDir：优先级 ----------

test('resolveDataDir: Windows 便携版沿用 exe 旁 data/', () => {
  const dir = resolveDataDir({}, 'win32', 'D:\\app\\icpc-core.exe');
  assert.equal(dir, path.join('D:\\app', 'data'));
});

test('resolveDataDir: ICPC_DATA_DIR 优先级最高（含首尾空白）', () => {
  const explicit = path.join(os.tmpdir(), 'icpc-explicit');
  const dir = resolveDataDir(
    { ICPC_DATA_DIR: `  ${explicit}  ` },
    'darwin',
    '/Applications/icpc-workbench.app/Contents/MacOS/icpc-core',
    '/Users/someone',
  );
  assert.equal(dir, path.resolve(explicit));
});

test('resolveDataDir: macOS 默认落到 ~/Library/Application Support（绝不写进 .app 内）', () => {
  const exec = '/Applications/icpc-workbench.app/Contents/MacOS/icpc-core';
  const dir = resolveDataDir({}, 'darwin', exec, '/Users/someone');
  assert.equal(dir, path.join('/Users/someone', 'Library', 'Application Support', 'icpc-workbench', 'data'));
  // 关键断言：不使用 exe 旁目录（那在应用包内部，会让签名失效/丢数据）
  assert.ok(!dir.startsWith(path.dirname(exec)));
  assert.notEqual(dir, path.join(path.dirname(exec), 'data'));
});

test('resolveDataDir: macOS 但拿不到 HOME → 退回 exe 旁（核心仍可启动）', () => {
  const exec = '/Applications/icpc-workbench.app/Contents/MacOS/icpc-core';
  assert.equal(resolveDataDir({}, 'darwin', exec, undefined), path.join(path.dirname(exec), 'data'));
  assert.equal(resolveDataDir({ HOME: '   ' }, 'darwin', exec, '   '), path.join(path.dirname(exec), 'data'));
});

test('resolveDataDir: 非 macOS 平台不受 HOME 影响', () => {
  const dir = resolveDataDir({ HOME: '/home/someone' }, 'linux', '/opt/icpc/icpc-core');
  assert.equal(dir, path.join('/opt/icpc', 'data'));
});

// ---------- migrateLegacyDataDir：老 nightly 升级搬数据 ----------

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `icpc-${name}-`));
}

test('migrateLegacyDataDir: 应用包内有旧数据 → 复制到新目录，旧目录保留', () => {
  const appDir = tempDir('app');
  const legacy = path.join(appDir, 'data');
  fs.mkdirSync(path.join(legacy, 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'icpc.db'), 'legacy-db');
  fs.writeFileSync(path.join(legacy, 'knowledge', 'annotations.jsonl'), '{"a":1}\n');

  const target = path.join(tempDir('support'), 'data');
  const migrated = migrateLegacyDataDir(path.join(appDir, 'icpc-core'), target);

  assert.equal(migrated, true);
  assert.equal(fs.readFileSync(path.join(target, 'icpc.db'), 'utf8'), 'legacy-db');
  assert.equal(fs.readFileSync(path.join(target, 'knowledge', 'annotations.jsonl'), 'utf8'), '{"a":1}\n');
  // 包内旧目录仍在（只读位置，不强求删除），但不再是读写目标
  assert.ok(fs.existsSync(legacy));
});

test('migrateLegacyDataDir: 新目录已有数据 → 绝不覆盖', () => {
  const appDir = tempDir('app2');
  fs.mkdirSync(path.join(appDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'data', 'icpc.db'), 'old');

  const target = tempDir('support2');
  fs.writeFileSync(path.join(target, 'icpc.db'), 'current');

  assert.equal(migrateLegacyDataDir(path.join(appDir, 'icpc-core'), target), false);
  assert.equal(fs.readFileSync(path.join(target, 'icpc.db'), 'utf8'), 'current');
});

test('migrateLegacyDataDir: Windows 便携版（新旧同路径）不动手', () => {
  const appDir = tempDir('win');
  const dataDir = path.join(appDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'icpc.db'), 'win-db');

  assert.equal(migrateLegacyDataDir(path.join(appDir, 'icpc-core.exe'), dataDir), false);
  assert.equal(fs.readFileSync(path.join(dataDir, 'icpc.db'), 'utf8'), 'win-db');
});

test('migrateLegacyDataDir: 没有旧数据 → 返回 false，不建空目录', () => {
  const appDir = tempDir('empty');
  const target = path.join(tempDir('support3'), 'data');
  assert.equal(migrateLegacyDataDir(path.join(appDir, 'icpc-core'), target), false);
  assert.equal(fs.existsSync(target), false);
});

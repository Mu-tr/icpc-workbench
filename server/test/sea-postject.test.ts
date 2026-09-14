import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPostjectArgs, MACHO_SEA_SEGMENT, SEA_BLOB_NAME, SEA_FUSE } from '../src/sea-postject.ts';

// issue #14 的 mac 版「后台核心崩溃、窗口打不开」就是这段参数错了：
// 少了 --macho-segment-name NODE_SEA，blob 落到 postject 默认的 __POSTJECT 段，
// Node 按官方约定在 NODE_SEA 段里找不到它，启动即崩。这里把官方约定钉死。

test('macOS 必须显式指定 NODE_SEA 段（否则 SEA 启动即崩）', () => {
  const args = buildPostjectArgs('/tmp/icpc-core', '/tmp/sea-prep.blob', true);
  const i = args.indexOf('--macho-segment-name');
  assert.notEqual(i, -1, 'macOS 缺 --macho-segment-name：blob 会落到 __POSTJECT 段，Node 找不到');
  assert.equal(args[i + 1], 'NODE_SEA');
  // 不能是 postject 的默认段名
  assert.notEqual(args[i + 1], '__POSTJECT');
});

test('Windows / Linux 不带该参数（PE 资源、ELF note 都不需要）', () => {
  for (const isMac of [false]) {
    const args = buildPostjectArgs('C:\\app\\icpc-core.exe', 'blob', isMac);
    assert.equal(args.includes('--macho-segment-name'), false);
  }
});

test('目标路径、blob、资源名与哨兵 fuse 都按 Node 约定传入', () => {
  const args = buildPostjectArgs('/tmp/core', '/tmp/sea-prep.blob', true);
  assert.equal(args[0], '/tmp/core');
  assert.equal(args[1], SEA_BLOB_NAME);
  assert.equal(args[2], '/tmp/sea-prep.blob');
  const f = args.indexOf('--sentinel-fuse');
  assert.notEqual(f, -1);
  assert.equal(args[f + 1], SEA_FUSE);
  // 官方文档里的哨兵 fuse 常量，不得随意改动
  assert.equal(SEA_FUSE, 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2');
  assert.equal(SEA_BLOB_NAME, 'NODE_SEA_BLOB');
  assert.equal(MACHO_SEA_SEGMENT, 'NODE_SEA');
});

test('--overwrite 重试时其余参数保持一致', () => {
  const first = buildPostjectArgs('/tmp/core', 'blob', true, false);
  const retry = buildPostjectArgs('/tmp/core', 'blob', true, true);
  assert.equal(retry.at(-1), '--overwrite');
  assert.deepEqual(retry.slice(0, -1), first);
});

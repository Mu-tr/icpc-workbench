import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createDb, type Db } from '../src/db/index.ts';
import { insertNormalized } from '../src/import/importService.ts';
import { previewImport } from '../src/import/preview.ts';
import { parseCsvRowsWithReport, parseManualRowsWithReport } from '../src/import/rows.ts';
import { importRoutes } from '../src/routes/import.ts';
import type { NormalizedSubmission } from '../../shared/src/index.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});
afterEach(() => {
  db.close();
});

function sub(key: string, externalId: string, verdict = 'AC'): NormalizedSubmission {
  return {
    problem: {
      platform: 'codeforces',
      problemKey: key,
      title: `T ${key}`,
      difficulty: 1500,
      tags: ['dp'],
    },
    verdict: verdict as NormalizedSubmission['verdict'],
    submittedAt: '2026-09-01T00:00:00.000Z',
    externalId,
  };
}

test('previewImport：新增 / external_id 重复 / 同题同结果协调 / 题目新建与更新', () => {
  insertNormalized(db, 1, [sub('1A', 'e1'), sub('1B', 'e2')]);
  const preview = previewImport(db, 1, [
    sub('1A', 'e1'), // external_id 已存在 → duplicateSkips
    sub('1A', 'manual:codeforces:1A:WA', 'WA'), // 新提交（不同结果）
    sub('1A', 'manual:codeforces:1A:AC'), // 同题同结果已存在 → manualSkips
    sub('1C', 'e3'), // 新提交 + 题目新建
  ]);
  assert.deepEqual(
    { ...preview },
    {
      newSubmissions: 2,
      duplicateSkips: 1,
      manualSkips: 1,
      problemCreates: 1, // 1C
      problemUpdates: 1, // 1A（1B 不在本批导入中）
    },
  );
});

test('逐行解析报告：单行非法不中断整批，带行号与原因', () => {
  const r = parseManualRowsWithReport('codeforces', [
    { problemKey: '1A' },
    { problemKey: '' }, // 缺 problemKey
    { problemKey: '1B', verdict: 'XX' }, // verdict 非法
    { problemKey: '1C' },
  ]);
  assert.equal(r.subs.length, 2);
  assert.deepEqual(r.invalid, [
    { line: 2, error: '第 2 行缺少 problemKey' },
    { line: 3, error: '第 3 行 verdict 非法: "XX"（可用 AC/WA/TLE/RE/MLE/CE/SKIPPED）' },
  ]);

  const csv = ['problemKey,title,verdict,difficulty,tags,url,submittedAt,language,externalId', '1A,T,AC,1500,dp,,,', ',,,,'].join('\n');
  const rc = parseCsvRowsWithReport('codeforces', csv);
  assert.equal(rc.subs.length, 1);
  assert.equal(rc.invalid.length, 1);
  assert.equal(rc.invalid[0].line, 3, '非法行号应为含表头的文件行号');
  assert.match(rc.invalid[0].error, /problemKey/);
});

test('POST /api/import/preview 返回分类结果，且预览不写库', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/import', importRoutes(db));
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/import`;
  try {
    const res = await fetch(`${base}/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'codeforces',
        rows: [{ problemKey: '1A', verdict: 'AC' }, { problemKey: '', verdict: 'AC' }],
      }),
    });
    const body = (await res.json()) as {
      total: number; valid: number;
      invalid: Array<{ line: number }>;
      preview: { newSubmissions: number; problemCreates: number };
    };
    assert.equal(res.status, 200);
    assert.equal(body.total, 2);
    assert.equal(body.valid, 1);
    assert.equal(body.invalid.length, 1);
    assert.equal(body.preview.newSubmissions, 1);
    assert.equal(body.preview.problemCreates, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM submissions').get()!.c, 0, '预览不得写入数据库');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM problems').get()!.c, 0, '预览不得写入题目表');

    // csv 形式 + 表头缺失 → 400
    const bad = await fetch(`${base}/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'codeforces', csv: 'a,b\n1,2' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    srv.close();
  }
});

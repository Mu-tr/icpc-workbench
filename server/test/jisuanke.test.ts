import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createJisuankeAdapter,
  fetchParticipatedContests,
  mapJisuankeVerdict,
  parseJisuankeTime,
  jisuankeProblemUrl,
  type JisuankeSubmissionRow,
} from '../src/adapters/jisuanke.ts';
import { ManualImportRequiredError, type FetchOptions } from '../src/adapters/types.ts';
import { getAdapter, initAdapters } from '../src/adapters/index.ts';

/**
 * 计蒜客适配器测试。
 * 取数路径：GET /api/contests?page=N&hasParticipated=true（我参加的比赛，数组）
 *         → GET /api/contest/problems?contestId=X（identifier → problemId）
 *         → GET /api/contest/submissions?contestId=X（提交数组，未登录 302）。
 */

const COOKIE = 'session=jsk-session-token';

/** 请求路由器：按 URL 子串匹配返回预置响应（与 daimayuan 测试同款） */
function router(
  pages: Record<string, string | (() => string)>,
  opts: { status?: number; location?: string; seenUrls?: string[]; seenHeaders?: Record<string, string>[] } = {},
): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input);
    opts.seenUrls?.push(u);
    if (opts.seenHeaders) opts.seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
    for (const [key, value] of Object.entries(pages)) {
      if (u.includes(key)) {
        if (opts.status === 302) return new Response('', { status: 302, headers: { location: opts.location ?? '/login' } });
        return new Response(typeof value === 'function' ? value() : value, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

/** 计蒜客北京时间字符串 → 列表接口的 startTime 字段 */
function bjTime(epochMs: number): string {
  const d = new Date(epochMs + 8 * 3600 * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function submissionRow(o: Partial<JisuankeSubmissionRow>): JisuankeSubmissionRow {
  return { hashId: 'h-default', identifier: 'A', title: '默认题', time: 0, status: 'AC', language: 'c++', ...o };
}

// ---------- 纯函数 ----------

test('jisuanke: mapJisuankeVerdict maps ojStatus strings and numeric statuses', () => {
  assert.equal(mapJisuankeVerdict('AC'), 'AC');
  assert.equal(mapJisuankeVerdict('WA'), 'WA');
  assert.equal(mapJisuankeVerdict('PE'), 'WA');
  assert.equal(mapJisuankeVerdict('TL'), 'TLE');
  assert.equal(mapJisuankeVerdict('ML'), 'MLE');
  assert.equal(mapJisuankeVerdict('OL'), 'RE');
  assert.equal(mapJisuankeVerdict('RE_SEGV'), 'RE');
  assert.equal(mapJisuankeVerdict('CE'), 'CE');
  assert.equal(mapJisuankeVerdict('CTL'), 'CE');
  // 评测中 / 系统态不落库
  assert.equal(mapJisuankeVerdict('WT0'), null);
  assert.equal(mapJisuankeVerdict('RI'), null);
  assert.equal(mapJisuankeVerdict('JE'), null);
  // 数字域：二元结果制 0/1；挑战题 ojStatus 序号
  assert.equal(mapJisuankeVerdict(0), 'WA');
  assert.equal(mapJisuankeVerdict(1), 'AC');
  assert.equal(mapJisuankeVerdict(4), 'AC');
  assert.equal(mapJisuankeVerdict(6), 'WA');
  assert.equal(mapJisuankeVerdict(7), 'TLE');
  assert.equal(mapJisuankeVerdict(11), 'CE');
  assert.equal(mapJisuankeVerdict(2), null); // CI 编译中
  assert.equal(mapJisuankeVerdict('42'), null);
  assert.equal(mapJisuankeVerdict(undefined), null);
});

test('jisuanke: parseJisuankeTime treats Beijing time, invalid → 0', () => {
  // 2026-09-05 10:00:00 北京时间 = 2026-09-05 02:00:00 UTC
  assert.equal(parseJisuankeTime('2026-09-05 10:00:00'), Date.UTC(2026, 8, 5, 2, 0, 0));
  assert.equal(parseJisuankeTime('garbage'), 0);
  assert.equal(parseJisuankeTime(undefined), 0);
});

test('jisuanke: jisuankeProblemUrl parses contest-problem key', () => {
  assert.equal(jisuankeProblemUrl('37176-123'), 'https://www.jisuanke.com/contest/37176/problem/123');
  assert.equal(jisuankeProblemUrl('no-key'), 'https://www.jisuanke.com/contests');
});

// ---------- fetchParticipatedContests ----------

test('jisuanke: fetchParticipatedContests pages until empty and sorts newest first', async () => {
  const seenUrls: string[] = [];
  const fetchFn = router(
    {
      'page=1': JSON.stringify([
        { contestId: 101, title: '旧赛', startTime: bjTime(Date.UTC(2026, 0, 1)) },
        { contestId: 102, title: '新赛', startTime: bjTime(Date.UTC(2026, 8, 1)) },
      ]),
      'page=2': JSON.stringify([]),
    },
    { seenUrls },
  );
  const contests = await fetchParticipatedContests(fetchFn, COOKIE);
  assert.deepEqual(contests.map((c) => c.contestId), [102, 101]); // 新→旧
  assert.ok(seenUrls.some((u) => u.includes('hasParticipated=true')));
});

// ---------- fetchUserSubmissions ----------

test('jisuanke: without cookie throws ManualImportRequiredError', async () => {
  const adapter = createJisuankeAdapter();
  await assert.rejects(() => adapter.fetchUserSubmissions('nick'), ManualImportRequiredError);
});

test('jisuanke: empty participated list raises ManualImportRequiredError', async () => {
  const adapter = createJisuankeAdapter(router({ 'hasParticipated=true': '[]' }));
  await assert.rejects(
    () => adapter.fetchUserSubmissions('nick', { cookie: COOKIE }),
    /参赛列表为空/,
  );
});

test('jisuanke: fetch maps verdicts per contest, builds urls, skips judging rows', async () => {
  const fetchFn = router({
    'hasParticipated=true': JSON.stringify([{ contestId: 37176, startTime: bjTime(Date.UTC(2026, 8, 5)) }]),
    'api/contest/problems?contestId=37176': JSON.stringify([ // /api/contest/problems
      { problemId: 90001, identifier: 'A', title: 'A 题' },
      { problemId: 90002, identifier: 'B', title: 'B 题' },
    ]),
    'api/contest/submissions?contestId=37176': JSON.stringify([
      submissionRow({ hashId: 'h1', identifier: 'A', title: 'A 题', time: 1788768000, status: 'AC' }),
      submissionRow({ hashId: 'h2', identifier: 'B', title: 'B 题', time: 1788767900, status: 'TL' }),
      submissionRow({ hashId: 'h3', identifier: 'A', title: 'A 题', time: 1788767800, status: 'WT0' }), // 评测中跳过
      submissionRow({ hashId: 'h4', identifier: 'B', title: 'B 题', time: 1788767700, status: 1 }), // 二元结果制 AC
      submissionRow({ hashId: 'h5', identifier: 'A', title: 'A 题', time: 1788767600, status: 0 }), // 二元结果制 WA
    ]),
  });
  const adapter = createJisuankeAdapter(fetchFn);
  const subs = await adapter.fetchUserSubmissions('nick', { cookie: COOKIE, pageDelayMs: 0 });
  assert.equal(subs.length, 4); // WT0（评测中）跳过
  assert.equal(subs[0].verdict, 'AC');
  assert.equal(subs[0].problem.platform, 'jisuanke');
  assert.equal(subs[0].problem.problemKey, '37176-90001'); // 经题目表映射到 problemId
  assert.equal(subs[0].problem.url, 'https://www.jisuanke.com/contest/37176/problem/90001');
  assert.equal(subs[0].language, 'c++');
  assert.equal(subs[0].submittedAt, '2026-09-07T08:00:00.000Z');
  assert.equal(subs[1].verdict, 'TLE');
  assert.equal(subs[2].verdict, 'AC'); // 二元结果制 status=1
  assert.equal(subs[2].problem.problemKey, '37176-90002');
  assert.equal(subs[3].verdict, 'WA'); // 二元结果制 status=0
});

test('jisuanke: incremental stops at first fully-known contest', async () => {
  const fetchFn = router({
    'hasParticipated=true': JSON.stringify([
      { contestId: 201, startTime: bjTime(Date.UTC(2026, 7, 1)) },
      { contestId: 202, startTime: bjTime(Date.UTC(2026, 6, 1)) },
    ]),
    'api/contest/submissions?contestId=201': JSON.stringify([
      submissionRow({ hashId: 'known1', time: 100 }),
      submissionRow({ hashId: 'known2', time: 90 }),
    ]),
    'api/contest/submissions?contestId=202': () => {
      throw new Error('should not fetch older contest');
    },
  });
  const adapter = createJisuankeAdapter(fetchFn);
  const subs = await adapter.fetchUserSubmissions('nick', {
    cookie: COOKIE,
    knownExternalIds: new Set(['known1', 'known2']),
    pageDelayMs: 0,
  });
  assert.equal(subs.length, 0);
});

test('jisuanke: known rows skipped, newer contest still fetched; unknown contests continue', async () => {
  const fetchFn = router({
    'hasParticipated=true': JSON.stringify([
      { contestId: 301, startTime: bjTime(Date.UTC(2026, 8, 1)) },
      { contestId: 302, startTime: bjTime(Date.UTC(2026, 7, 1)) },
    ]),
    // 302 场无提交（HasNoSubmissions 错误对象形态）：跳过不中断
    'api/contest/submissions?contestId=301': JSON.stringify({ error: 'HasNoSubmissions' }),
    'api/contest/submissions?contestId=302': JSON.stringify([
      submissionRow({ hashId: 'old-known', time: 50, status: 'AC' }),
      submissionRow({ hashId: 'old-new', time: 40, status: 'WA' }),
    ]),
  });
  const adapter = createJisuankeAdapter(fetchFn);
  const subs = await adapter.fetchUserSubmissions('nick', {
    cookie: COOKIE,
    knownExternalIds: new Set(['old-known']),
    pageDelayMs: 0,
  });
  assert.deepEqual(subs.map((s) => s.externalId), ['old-new']);
});

test('jisuanke: maxSubmissions cap marks truncated with contest index cursor', async () => {
  const fetchFn = router({
    'hasParticipated=true': JSON.stringify([
      { contestId: 401, startTime: bjTime(Date.UTC(2026, 8, 1)) },
      { contestId: 402, startTime: bjTime(Date.UTC(2026, 7, 1)) },
      { contestId: 403, startTime: bjTime(Date.UTC(2026, 6, 1)) },
    ]),
    'api/contest/submissions?contestId=401': JSON.stringify([
      submissionRow({ hashId: 'c1a', time: 300, status: 'AC' }),
      submissionRow({ hashId: 'c1b', time: 290, status: 'AC' }),
    ]),
    'api/contest/submissions?contestId=402': JSON.stringify([
      submissionRow({ hashId: 'c2a', time: 200, status: 'AC' }),
      submissionRow({ hashId: 'c2b', time: 190, status: 'AC' }), // 达到 max=3 截断
    ]),
    'api/contest/submissions?contestId=403': JSON.stringify([submissionRow({ hashId: 'c3a', time: 100 })]),
  });
  const adapter = createJisuankeAdapter(fetchFn);
  const opts: FetchOptions = { cookie: COOKIE, maxSubmissions: 3, pageDelayMs: 0 };
  const subs = await adapter.fetchUserSubmissions('nick', opts);
  assert.equal(subs.length, 3);
  assert.equal(opts.truncated, true);
  assert.equal(opts.backfillReachedPage, 2); // 处理到第 2 场
});

test('jisuanke: backfill resumes from contest index cursor and skips known rows', async () => {
  const fetchFn = router({
    'hasParticipated=true': JSON.stringify([
      { contestId: 501, startTime: bjTime(Date.UTC(2026, 8, 1)) },
      { contestId: 502, startTime: bjTime(Date.UTC(2026, 7, 1)) },
      { contestId: 503, startTime: bjTime(Date.UTC(2026, 6, 1)) },
    ]),
    'api/contest/submissions?contestId=501': () => {
      throw new Error('backfill should reprocess contest 501 but fetch is stubbed here');
    },
    'api/contest/submissions?contestId=502': JSON.stringify([submissionRow({ hashId: 'seen', time: 200, status: 'AC' })]),
    'api/contest/submissions?contestId=503': JSON.stringify([submissionRow({ hashId: 'ancient', time: 100, status: 'AC' })]),
  });
  const adapter = createJisuankeAdapter(fetchFn);
  // backfillFromPage=2：跳过第 1 场（501），从 502 续拉
  const subs = await adapter.fetchUserSubmissions('nick', {
    cookie: COOKIE,
    backfill: true,
    backfillFromPage: 2,
    knownExternalIds: new Set(['seen']),
    pageDelayMs: 0,
  });
  assert.deepEqual(subs.map((s) => s.externalId), ['ancient']);
});

test('jisuanke: expired login (302 on submissions) raises ManualImportRequiredError', async () => {
  const adapter = createJisuankeAdapter(
    router(
      {
        'hasParticipated=true': JSON.stringify([{ contestId: 601 }]),
        'api/contest/submissions?contestId=601': '[]',
      },
      { status: 302, location: '/login' },
    ),
  );
  await assert.rejects(() => adapter.fetchUserSubmissions('nick', { cookie: 'stale', pageDelayMs: 0 }), /登录态已失效/);
});

// ---------- checkAuth / 注册 ----------

test('jisuanke: checkAuth validates via /api/user/info uuid field', async () => {
  const ok = createJisuankeAdapter(router({ 'api/user/info': JSON.stringify({ websocket: {}, uuid: 'u-123', name: '蒜徒' }) }));
  const rOk = await ok.checkAuth!({ cookie: COOKIE });
  assert.equal(rOk.ok, true);
  assert.match(rOk.message, /蒜徒/);

  // 未登录响应不含 uuid
  const bad = createJisuankeAdapter(router({ 'api/user/info': JSON.stringify({ websocket: {} }) }));
  const rBad = await bad.checkAuth!({ cookie: 'stale' });
  assert.equal(rBad.ok, false);
  assert.match(rBad.message, /Cookie 未通过登录校验/);

  const stale302 = createJisuankeAdapter(router({ 'api/user/info': '{}' }, { status: 302 }));
  const r302 = await stale302.checkAuth!({ cookie: 'stale' });
  assert.equal(r302.ok, false);

  const netFail = createJisuankeAdapter((async () => {
    throw new Error('fetch failed');
  }) as typeof fetch);
  const rNet = await netFail.checkAuth!({ cookie: 'c' });
  assert.equal(rNet.ok, false);
  assert.match(rNet.message, /无法连接/);
});

test('jisuanke: registered via initAdapters, problemUrl format', () => {
  initAdapters();
  assert.equal(getAdapter('jisuanke')?.platform, 'jisuanke');
  const adapter = createJisuankeAdapter();
  assert.equal(adapter.problemUrl({ problemKey: '37176-123' }), 'https://www.jisuanke.com/contest/37176/problem/123');
});

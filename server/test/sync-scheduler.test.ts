import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db/index.ts';
import { register } from '../src/adapters/registry.ts';
import { syncPlatform } from '../src/adapters/sync.ts';
import {
  __resetSyncSchedulerForTest,
  cancelAutoContinue,
  configureSyncScheduler,
  getAutoContinueRounds,
  listAutoContinue,
  scheduleAutoContinue,
} from '../src/adapters/syncScheduler.ts';

function setup(runResults: boolean[]) {
  const db = createDb(':memory:');
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const runs: string[] = [];
  configureSyncScheduler({
    db,
    now: () => new Date('2026-09-15T00:00:00.000Z').getTime(),
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    cancelTimer: () => {},
    run: async (platform, handle) => {
      runs.push(`${platform}:${handle}`);
      const truncated = runResults.shift() ?? false;
      return { platform, handle, imported: 1, skipped: 0, errors: [], truncated, ...(truncated ? { note: '分批' } : {}) };
    },
  });
  return { db, timers, runs };
}

test('续拉：默认 6 轮上限，按平台节奏排期，轮次耗尽后不再排期', async () => {
  __resetSyncSchedulerForTest();
  // runResults 按「每次实际执行的一轮」依次出队：第 1 轮仍截断 → 再排期；第 2 轮自然结束 → 清空。
  // （brief 原稿此处写 [true, true, false]，但原稿自身注释要求第 2 轮「自然结束」——第二轮取到的
  //   第二个 true 会继续排期，与断言的 listAutoContinue().length === 0 矛盾；按注释意图取 [true, false]。）
  const { db, timers, runs } = setup([true, false]);
  const st = scheduleAutoContinue(db, 'luogu', '1892580');
  assert.ok(st);
  assert.equal(st.maxRounds, 6);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 45_000); // 洛谷节奏
  // 第 1 轮：仍截断 → 再排期
  await timers[0].fn();
  assert.equal(runs.length, 1);
  assert.equal(timers.length, 2);
  // 第 2 轮：自然结束 → 队列清空
  await timers[1].fn();
  assert.equal(listAutoContinue().length, 0);
  db.close();
});

test('续拉：可取消；取消后不再执行', async () => {
  __resetSyncSchedulerForTest();
  const { db, timers, runs } = setup([true]);
  scheduleAutoContinue(db, 'nowcoder', '713093328');
  assert.equal(cancelAutoContinue('nowcoder'), true);
  assert.equal(listAutoContinue().length, 0);
  assert.equal(cancelAutoContinue('nowcoder'), false);
  assert.equal(timers.length, 1);
  assert.equal(runs.length, 0);
  db.close();
});

test('续拉轮数设置与关闭（0 = 关）', () => {
  __resetSyncSchedulerForTest();
  const { db } = setup([]);
  db.prepare("INSERT INTO settings (key, value) VALUES ('sync.autoContinueRounds', ?)").run('0');
  assert.equal(getAutoContinueRounds(db), 0);
  assert.equal(scheduleAutoContinue(db, 'luogu', 'u'), null);
  db.close();
});

test('续拉：轮次耗尽（一直截断）后不再排期，共执行 maxRounds 轮', async () => {
  __resetSyncSchedulerForTest();
  const { db, timers, runs } = setup([true, true, true, true, true, true, true, true]);
  const st = scheduleAutoContinue(db, 'codeforces', 'tourist');
  assert.equal(st?.maxRounds, 6);
  assert.equal(timers[0].ms, 20_000); // CF 节奏
  for (let i = 0; i < timers.length; i += 1) await timers[i].fn();
  assert.equal(runs.length, 6); // 第 6 轮后 round=7 > 6 → 停止
  assert.equal(timers.length, 6);
  assert.equal(listAutoContinue().length, 0);
  db.close();
});

test('续拉：任一轮报错（鉴权/限流）立即停止，不再排期', async () => {
  __resetSyncSchedulerForTest();
  const db = createDb(':memory:');
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let calls = 0;
  configureSyncScheduler({
    db,
    now: () => Date.parse('2026-09-15T00:00:00.000Z'),
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    cancelTimer: () => {},
    run: async (platform, handle) => {
      calls += 1;
      return { platform, handle, imported: 0, skipped: 0, errors: ['[jisuanke] 登录态已失效'], truncated: true };
    },
  });
  scheduleAutoContinue(db, 'jisuanke', 'u');
  assert.equal(timers[0].ms, 90_000); // 计蒜客节奏
  await timers[0].fn();
  assert.equal(calls, 1);
  assert.equal(timers.length, 1); // 失败 → 不再排期
  assert.equal(listAutoContinue().length, 0);
  db.close();
});

test('续拉：执行器抛错同样停止续拉（不外抛到定时器回调）', async () => {
  __resetSyncSchedulerForTest();
  const db = createDb(':memory:');
  const timers: Array<{ fn: () => void; ms: number }> = [];
  configureSyncScheduler({
    db,
    now: () => Date.parse('2026-09-15T00:00:00.000Z'),
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    cancelTimer: () => {},
    run: async () => { throw new Error('boom'); },
  });
  scheduleAutoContinue(db, 'atcoder', 'u');
  await timers[0].fn(); // 不得 reject
  assert.equal(timers.length, 1);
  assert.equal(listAutoContinue().length, 0);
  db.close();
});

test('续拉：同平台串行——重复注册被忽略（不叠加定时器，返回既有状态）', () => {
  __resetSyncSchedulerForTest();
  const { db, timers } = setup([true]);
  const first = scheduleAutoContinue(db, 'qoj', 'Qingyu');
  const second = scheduleAutoContinue(db, 'qoj', 'Qingyu');
  assert.equal(second, first);
  assert.equal(timers.length, 1);
  // 不同平台互不影响（各自独立的节奏与队列）
  const other = scheduleAutoContinue(db, 'leetcode', 'u');
  assert.equal(other?.platform, 'leetcode');
  assert.equal(timers.length, 2);
  assert.equal(timers[1].ms, 60_000);
  db.close();
});

test('续拉：取消会清掉已排期的定时器，且状态带 pending 时间', () => {
  __resetSyncSchedulerForTest();
  const db = createDb(':memory:');
  const cancelled: unknown[] = [];
  let timerId = 0;
  configureSyncScheduler({
    db,
    now: () => Date.parse('2026-09-15T00:00:00.000Z'),
    schedule: (_fn, _ms) => { timerId += 1; return timerId; },
    cancelTimer: (id) => { cancelled.push(id); },
    run: async (platform, handle) => ({ platform, handle, imported: 0, skipped: 0, errors: [], truncated: false }),
  });
  const st = scheduleAutoContinue(db, 'daimayuan', 'u');
  assert.equal(st?.nextAt, '2026-09-15T00:01:00.000Z'); // 60s 后
  assert.equal(st?.running, false);
  assert.equal(st?.round, 1);
  assert.equal(cancelAutoContinue('daimayuan'), true);
  assert.deepEqual(cancelled, [1]); // 定时器被清除
  assert.equal(listAutoContinue().length, 0);
  db.close();
});

test('续拉：未装配调度器（脚本直接调 syncPlatform）时注册返回 null 而非抛错', () => {
  __resetSyncSchedulerForTest();
  const db = createDb(':memory:');
  assert.equal(scheduleAutoContinue(db, 'luogu', 'u'), null);
  db.close();
});

test('sync 层：截断且 manual 触发注册续拉；days 窗口与 auto 触发均不注册', async () => {
  __resetSyncSchedulerForTest();
  const db = createDb(':memory:');
  const timers: Array<{ fn: () => void; ms: number }> = [];
  configureSyncScheduler({
    db,
    now: () => Date.parse('2026-09-15T00:00:00.000Z'),
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    cancelTimer: () => {},
    run: async (platform, handle) => ({ platform, handle, imported: 0, skipped: 0, errors: [], truncated: false }),
  });
  // 假适配器：每次同步都回写截断 + 游标（所有平台通用的截断语义）
  register({
    platform: 'jisuanke',
    knownIdsFilter: true,
    async fetchUserSubmissions(_handle, opts) {
      if (opts) {
        opts.truncated = true;
        opts.backfillReachedPage = -1;
      }
      return [];
    },
    problemUrl: ({ problemKey }) => `https://www.jisuanke.com/problem/${problemKey}`,
  });

  // 手动同步被截断 → 注册续拉（状态随结果回传，供同步中心展示）
  const manual = await syncPlatform(db, 'jisuanke', 'hieZF123', { triggeredBy: 'manual' });
  assert.equal(manual.truncated, true);
  assert.equal(manual.autoContinue?.round, 1);
  assert.equal(manual.autoContinue?.maxRounds, 6);
  assert.equal(manual.autoContinue?.nextAt, '2026-09-15T00:01:30.000Z'); // 计蒜客 90s 后
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 90_000);
  assert.equal(listAutoContinue().length, 1);
  const run = db.prepare("SELECT triggered_by FROM sync_runs ORDER BY id DESC LIMIT 1").get() as { triggered_by: string };
  assert.equal(run.triggered_by, 'manual');

  // days 窗口补充拉取：即便被截断也不注册
  cancelAutoContinue('jisuanke');
  const days = await syncPlatform(db, 'jisuanke', 'hieZF123', { days: 7, triggeredBy: 'days' });
  assert.equal(days.autoContinue, undefined);
  assert.equal(listAutoContinue().length, 0);

  // auto（后台续拉自身）再次截断：不再注册，避免无限续拉；triggered_by 记为 auto
  const auto = await syncPlatform(db, 'jisuanke', 'hieZF123', { triggeredBy: 'auto' });
  assert.equal(auto.autoContinue, undefined);
  assert.equal(listAutoContinue().length, 0);
  const autoRun = db.prepare("SELECT triggered_by FROM sync_runs ORDER BY id DESC LIMIT 1").get() as { triggered_by: string };
  assert.equal(autoRun.triggered_by, 'auto');
  db.close();
});

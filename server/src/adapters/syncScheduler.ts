/**
 * 后台分批续拉：某平台同步因触及单次上限被截断（sync_truncated=1）时，
 * 按平台节奏在后台自动续拉下一批，直到补全或达到轮数上限。
 *
 * 设计取舍：
 * - 只服务于「用户点了一次同步」的会话：轮数上限默认 6（settings['sync.autoContinueRounds']，0=关闭）。
 * - 每平台独立间隔（保守取值，低于该值易触发平台风控）。
 * - 同平台串行：已有待执行或正在执行的续拉时，重复注册被忽略（返回既有状态，不叠加第二个定时器）。
 * - 进程内实现：服务重启后续拉计划丢失，但补全游标（backfill_page）已持久化，用户再点一次同步即续上。
 * - 任一轮失败（尤其鉴权/限流）→ 立即停止该平台续拉（避免把过期 Cookie 打成风控）。
 */
import type { SyncResult } from '../../../shared/src/index.ts';
import type { PlatformId } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { syncPlatform } from './sync.ts';

export const AUTO_CONTINUE_DELAY_MS: Record<PlatformId, number> = {
  codeforces: 20_000,
  atcoder: 60_000,
  luogu: 45_000,
  nowcoder: 90_000,
  jisuanke: 90_000,
  daimayuan: 60_000,
  leetcode: 60_000,
  qoj: 90_000,
};

export const DEFAULT_AUTO_CONTINUE_ROUNDS = 6;

export interface AutoContinueState {
  platform: PlatformId;
  handle: string;
  round: number;
  maxRounds: number;
  nextAt: string;
  running: boolean;
}

export interface SchedulerDeps {
  db: Db;
  now: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
  cancelTimer: (id: unknown) => void;
  run: (platform: PlatformId, handle: string) => Promise<SyncResult>;
}

let deps: SchedulerDeps | null = null;
const jobs = new Map<PlatformId, { state: AutoContinueState; timer: unknown }>();

/** 装配（服务启动调用一次）；测试传 partial 注入假时钟/假执行器 */
export function configureSyncScheduler(partial: Partial<SchedulerDeps>): void {
  const prev = deps;
  const database = partial.db ?? prev?.db;
  if (!database) throw new Error('syncScheduler 需要数据库：请先 configureSyncScheduler({ db })');
  deps = {
    db: database,
    now: partial.now ?? prev?.now ?? (() => Date.now()),
    schedule: partial.schedule ?? prev?.schedule ?? ((fn, ms) => setTimeout(fn, ms)),
    cancelTimer: partial.cancelTimer ?? prev?.cancelTimer ?? ((id) => clearTimeout(id as NodeJS.Timeout)),
    run:
      partial.run ??
      prev?.run ??
      ((platform, handle) => syncPlatform(database, platform, handle, { triggeredBy: 'auto' })),
  };
}

/** 读取续拉轮数上限（0 = 关闭） */
export function getAutoContinueRounds(database: Db): number {
  const row = database.prepare('SELECT value FROM settings WHERE key = ?').get('sync.autoContinueRounds') as { value: string } | undefined;
  const n = Number(row?.value);
  if (!Number.isInteger(n) || n < 0 || n > 50) return DEFAULT_AUTO_CONTINUE_ROUNDS;
  return n;
}

export function listAutoContinue(): AutoContinueState[] {
  return [...jobs.values()].map((j) => j.state);
}

export function cancelAutoContinue(platform: PlatformId): boolean {
  const job = jobs.get(platform);
  if (!job) return false;
  deps?.cancelTimer(job.timer);
  jobs.delete(platform);
  return true;
}

/** 注册续拉；已在队列中返回既有状态，轮数上限为 0 或调度器未装配时返回 null */
export function scheduleAutoContinue(database: Db, platform: PlatformId, handle: string): AutoContinueState | null {
  const maxRounds = getAutoContinueRounds(database);
  if (maxRounds === 0) return null;
  // 未调用 configureSyncScheduler（脚本/测试直接调用 syncPlatform）时静默不排期，
  // 不能让「同步成功但没启动后台调度」变成同步失败
  if (!deps) return null;
  if (jobs.has(platform)) return jobs.get(platform)!.state;
  const delay = AUTO_CONTINUE_DELAY_MS[platform] ?? 60_000;
  const state: AutoContinueState = {
    platform,
    handle,
    round: 1,
    maxRounds,
    nextAt: new Date(deps.now() + delay).toISOString(),
    running: false,
  };
  const timer = deps.schedule(() => void runRound(platform), delay);
  jobs.set(platform, { state, timer });
  return state;
}

async function runRound(platform: PlatformId): Promise<void> {
  const job = jobs.get(platform);
  if (!job) return;
  job.state.running = true;
  let result: SyncResult | null = null;
  try {
    result = await deps!.run(platform, job.state.handle);
  } catch {
    result = null;
  }
  const failed = result === null || result.errors.length > 0;
  const truncated = result?.truncated === true;
  const round = job.state.round + 1;
  if (failed || !truncated || round > job.state.maxRounds) {
    jobs.delete(platform); // 失败（含鉴权/限流）、补全完成、轮次耗尽 → 停止该平台续拉
    return;
  }
  const delay = AUTO_CONTINUE_DELAY_MS[platform] ?? 60_000;
  job.state = {
    ...job.state,
    round,
    running: false,
    nextAt: new Date(deps!.now() + delay).toISOString(),
  };
  job.timer = deps!.schedule(() => void runRound(platform), delay);
}

/** 测试用：清空队列与依赖 */
export function __resetSyncSchedulerForTest(): void {
  for (const job of jobs.values()) deps?.cancelTimer(job.timer);
  jobs.clear();
  deps = null;
}

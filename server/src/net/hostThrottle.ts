/**
 * 全局按域名请求节流层（防触发平台风控）。
 *
 * 背景：各平台适配器只在自己内部 `sleep`，互不感知；同一出口 IP 上的
 * 提交同步、难度回填、题库拉取、赛事中心可以同时打同一个站点。本模块把
 * 「同一域名两次请求的最小间隔」收敛到传输层一处，用最小改动整体降低请求频率：
 * 单个适配器的 URL / 头部 / 重试 / 分页逻辑都不必改动。
 *
 * 语义：
 * - **预约时间片**：每次请求先按 `max(now, 该域上次预约 + 间隔)` 占位，再等到该时刻发出。
 *   并发发起的同域请求因此天然按顺序错开，不会同时打同一站点。
 * - **间隔是下限而非叠加**：调用方本来就等够了（适配器自身的页间 sleep 更慢时）不会额外等待。
 * - **按域名分桶**：各平台节奏互相独立；子域沿用父域配置（`mirror.codeforces.com` → `codeforces.com`）。
 * - **只等一个间隔**：不排队等长任务，最长只等该域一个间隔（≤1.5s），
 *   因此调用点自带的 `AbortSignal.timeout` 超时语义基本不受影响。
 *
 * 已知取舍：
 * - 等待时长不计入 `sync_runs.waited_ms`（那里统计的是适配器自身 sleep 与限流退避）；
 * - 等待中被中止会抛出中止原因，已预约的时间片不回收（最多让下一次少等一个间隔的误差）；
 * - 无法解析的 URL 落到同一个兜底桶，按默认间隔限速。
 */
import { sleep as defaultSleep } from '../adapters/http.ts';

export interface HostThrottleOptions {
  /** 每域最小请求间隔（毫秒）；键为域名，子域自动沿用 */
  minIntervalMs?: Record<string, number>;
  /** 未登记域名的兜底间隔（毫秒） */
  defaultMinIntervalMs?: number;
  /** 注入时钟（测试用） */
  now?: () => number;
  /** 注入睡眠实现（测试用） */
  sleep?: (ms: number) => Promise<void>;
}

export interface HostThrottle {
  /** 节流后的 fetch：可直接注入 createHttpClient / 路由的 fetchFn */
  fetch: typeof fetch;
  /** 该域名当前的最小间隔（毫秒），供诊断与断言 */
  intervalFor(host: string): number;
  /**
   * 该节奏桶的累计统计（单调递增，进程内）：
   * - `requests`：真正发出的请求数（含重试的每一次尝试）；
   * - `lastRequestAt`：最近一次真正发出的时刻（毫秒时间戳；从未发出为 0）。
   *
   * 用途：同步进度展示（「本窗口对该站点请求了 N 次 / 最后一次 X 秒前」）——
   * 让用户看见请求确实在流动。调用方取窗口前后的差值即可。
   */
  stats(host: string): { requests: number; lastRequestAt: number };
  /** 清空预约状态（测试用） */
  reset(): void;
}

/**
 * 生产间隔表：每个值都显著高于对应适配器自带的页间延迟
 * （CF 500ms / AtCoder 1000ms / 洛谷 300ms / 牛客 500ms / QOJ 1000ms /
 * 力扣 300ms / 代码源 400ms / 计蒜客 400ms），从而把整体频率压下来。
 * 同时尊重各站官方要求：AtCoder ≥1s、CF 官方建议 ≤2 req/s（这里取 ~0.83 req/s）。
 */
export const HOST_MIN_INTERVAL_MS: Record<string, number> = {
  'codeforces.com': 1200,
  'atcoder.jp': 1500,
  'www.luogu.com.cn': 700,
  'ac.nowcoder.com': 1100,
  'qoj.ac': 1500,
  'leetcode.cn': 700,
  'bs.daimayuan.top': 800,
  'www.jisuanke.com': 800,
  'kenkoooo.com': 1000,
};

/** 未登记域名的兜底间隔：保守但不至于拖慢一次性请求 */
export const DEFAULT_HOST_MIN_INTERVAL_MS = 600;

/** 从 fetch 入参解析域名；无法解析返回空串（落到兜底桶） */
export function hostOf(input: string | URL | Request): string {
  try {
    const raw =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 该域名归属的节奏桶：命中配置的域名本身（子域归到父域键），未命中则用自己的域名。
 * 父子域共用同一桶 → `codeforces.com` 与 `mirror.codeforces.com` 不会被同时打。
 */
export function bucketOf(host: string, table: Record<string, number>): string {
  if (host === '') return '';
  if (table[host] !== undefined) return host;
  for (const key of Object.keys(table)) {
    if (host.endsWith(`.${key}`)) return key;
  }
  return host;
}

/** 精确匹配优先，其次按「子域」后缀匹配（点边界），最后兜底 */
export function intervalForHost(
  host: string,
  table: Record<string, number>,
  fallback: number,
): number {
  if (host === '') return fallback;
  const exact = table[host];
  if (exact !== undefined) return exact;
  for (const key of Object.keys(table)) {
    if (host.endsWith(`.${key}`)) return table[key]!;
  }
  return fallback;
}

/** 可被 signal 打断的等待：等待期间中止 → 立即抛出且不发起请求 */
async function sleepInterruptible(
  ms: number,
  signal: AbortSignal | null | undefined,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error('请求已被取消');
  if (!signal) {
    await sleep(ms);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error('请求已被取消'));
    signal.addEventListener('abort', onAbort, { once: true });
    sleep(ms).then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * 创建按域名节流的 fetch 包装。
 * @param fn 底层 fetch（测试注入 mock 即可）
 * @param options 间隔表 / 时钟 / 睡眠实现
 */
export function createHostThrottle(
  fn: typeof fetch = fetch,
  options: HostThrottleOptions = {},
): HostThrottle {
  const table = options.minIntervalMs ?? HOST_MIN_INTERVAL_MS;
  const fallback = options.defaultMinIntervalMs ?? DEFAULT_HOST_MIN_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  /** 节奏桶（子域归父域） → 下次可发出请求的最早时刻（时间片预约） */
  const nextAllowedAt = new Map<string, number>();
  /** 节奏桶 → 累计请求数 / 最近一次请求时刻（仅统计，不影响节流判定） */
  const statsByBucket = new Map<string, { requests: number; lastRequestAt: number }>();

  const intervalFor = (host: string): number => intervalForHost(host, table, fallback);

  const throttledFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const host = hostOf(input as string | URL | Request);
    const bucket = bucketOf(host, table);
    const interval = intervalFor(host);
    const t = now();
    const startAt = Math.max(t, nextAllowedAt.get(bucket) ?? 0);
    nextAllowedAt.set(bucket, startAt + interval);
    const wait = startAt - t;
    if (wait > 0) await sleepInterruptible(wait, init?.signal, sleep);
    const stat = statsByBucket.get(bucket) ?? { requests: 0, lastRequestAt: 0 };
    statsByBucket.set(bucket, { requests: stat.requests + 1, lastRequestAt: now() });
    return fn(input, init);
  }) as typeof fetch;

  return {
    fetch: throttledFetch,
    intervalFor,
    stats: (host: string) => {
      const stat = statsByBucket.get(bucketOf(host, table));
      return stat ? { ...stat } : { requests: 0, lastRequestAt: 0 };
    },
    reset: () => {
      nextAllowedAt.clear();
      statsByBucket.clear();
    },
  };
}

/**
 * 生产单例：装配处（adapters/index.ts、路由默认 fetchFn）统一注入它。
 * 全局共享一份预约状态，才能覆盖「同步 + 回填 + 赛事」等所有并行路径。
 */
export const hostThrottle: HostThrottle = createHostThrottle(fetch, {
  minIntervalMs: HOST_MIN_INTERVAL_MS,
  defaultMinIntervalMs: DEFAULT_HOST_MIN_INTERVAL_MS,
});

export const throttledFetch: typeof fetch = hostThrottle.fetch;

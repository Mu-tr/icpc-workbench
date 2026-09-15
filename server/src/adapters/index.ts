import { createAtcoderAdapter } from './atcoder.ts';
import { createCodeforcesAdapter } from './codeforces.ts';
import { createDaimayuanAdapter } from './daimayuan.ts';
import { createJisuankeAdapter } from './jisuanke.ts';
import { createLeetcodeAdapter } from './leetcode.ts';
import { createLuoguAdapter } from './luogu.ts';
import { createNowcoderAdapter } from './nowcoder.ts';
import { createQojAdapter } from './qoj.ts';
import { register } from './registry.ts';
import { createHttpClient, PROD_RETRY } from './http.ts';
import { createHttp1Fetch } from './http1.ts';

// 各平台适配器统一在此注册；平台级开关（enabled）由同步 API 按 settings 过滤。
let initialized = false;

/**
 * 在 server 启动时调用一次，传入 dataDir 供适配器做资源缓存。
 * 适配器共享同一个 HttpClient：生产环境显式开启有限重试（偶发 5xx / 限流自动退避重试 2 次）。
 * 适配器工厂本身默认不重试，以保证单测注入单次响应 mock 时的调用次数语义不变（见 http.ts）。
 */
export function initAdapters(dataDir?: string): void {
  if (initialized) return;
  initialized = true;
  const http = createHttpClient(fetch, PROD_RETRY);
  register(createCodeforcesAdapter(http));
  register(createAtcoderAdapter(dataDir, http));
  register(createLuoguAdapter(http));
  register(createNowcoderAdapter(http));
  register(createDaimayuanAdapter(http));
  register(createLeetcodeAdapter(http));
  register(createJisuankeAdapter(http));
  // QOJ 必须走 HTTP/1.1：Cloudflare 对 h2 请求恒定下发托管挑战（详见 http1.ts 与 qoj.ts 注释）
  register(createQojAdapter(createHttpClient(createHttp1Fetch({ timeoutMs: 25_000 }), PROD_RETRY)));
}
export * from './registry.ts';
export type { PlatformAdapter } from './types.ts';

import type {
  NormalizedSubmission,
  PlatformId,
  Verdict,
} from '../../../shared/src/index.ts';
import { difficultyFields, toCfRating } from '../../../shared/src/difficulty.ts';
import { ManualImportRequiredError } from './types.ts';
import type { FetchOptions, PlatformAdapter } from './types.ts';
import { asHttpClient, sleep, type HttpInit } from './http.ts';

/**
 * 计蒜客（www.jisuanke.com，原 nanti.jisuanke.com 竞赛 OJ）适配器。
 *
 * 平台无公开提交 API，且提交记录不像洛谷/牛客有统一的「记录」页——
 * 它按「参加过的比赛」组织，前端（Vue SPA）的取数路径是：
 *
 * 1. GET /api/contests?page={n}&hasParticipated=true   → 我参加过的比赛列表（未登录返回空数组）
 * 2. GET /api/contest/problems?contestId={id}          → 该赛题目（identifier → problemId，拼题目链接用）
 * 3. GET /api/contest/submissions?contestId={id}       → 我在该赛的提交数组（未登录 302 跳登录）
 *
 * 提交行字段（chunk ContestSubmissions 的表格绑定）：hashId / identifier / title /
 * time（unix 秒）/ status / usedTime / usedMemory / language。
 * status 是 ojStatus 字符串枚举（app.js 内置 i18n 字典）：
 *   AC=通过 PE=格式错误 WA=答案错误 TL=超时 ML=内存超限 OL=输出超限
 *   RE 系=运行错误 CE/CTL=编译错误；WT0/WT1/CI/RI/CO/TF/JE/UE 为评测中/系统态，不落库。
 * 训练赛（二元结果制）会返回数字 status：0=未通过 1=通过；挑战题（challenge）则返回
 * ojStatus 字典序号（4=AC 6=WA 7=TL 8=ML 10=RE 11=CE）。两类都做了映射。
 *
 * 鉴权：纯 Cookie 鉴权（无 Authorization 头），登录态在 s 与 JSKUSS 两项（实测站点
 * 共 4 项 Cookie：acw_tc 为 CDN 项、XSRF-TOKEN 供 POST 使用，均不需要）。注意
 * 站点给未登录访客也发匿名 `s` 会话（2h 有效），因此必须复制「已登录」浏览器发出的
 * Cookie——推荐从 F12 → Network 的真实 /api 请求 Request Headers 整段复制。
 * handle 仅作账号备注（平台无公开用户名），同步完全依赖 Cookie。
 *
 * 分批模型：与页码型平台不同，本适配器的「页」=「一场比赛」（比赛内提交数少，
 * 无内部分页）。增量模式遇「整场提交全部已知」即早停；补全模式（backfill）以
 * backfillReachedPage（比赛序号）为游标跳过已知场次继续向更早补全。
 */

const BASE = 'https://www.jisuanke.com';
const PAGE_DELAY_MS = 400; // 请求间限速，降低对站点的压力
const MAX_CONTEST_LIST_PAGES = 50; // 参赛列表分页保护上限
// 每次同步最多处理的比赛数（每场至多 2 个请求：题目表 + 提交表）：
// 30 场 × 2 请求 × 400ms ≈ 24 秒，与代码源的保守页数预算同级
const PER_SYNC_MAX_CONTESTS = 30;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/**
 * ojStatus 字符串枚举 → 统一 Verdict。
 * 评测中（WT0/WT1/CI/RI）、编译成功（CO）、测试完成（TF）、判题错误（JE）、
 * 未知错误（UE）不在表中 → null，不落库。
 */
const STATUS_TO_VERDICT: Record<string, Verdict> = {
  AC: 'AC',
  PE: 'WA', // 格式错误
  WA: 'WA',
  TL: 'TLE',
  ML: 'MLE',
  OL: 'RE', // 输出超限（与代码源 OLE→RE 同口径）
  RE: 'RE',
  RE_SEGV: 'RE',
  RE_FPE: 'RE',
  RE_BUS: 'RE',
  RE_ABRT: 'RE',
  RE_SYS: 'RE',
  CE: 'CE',
  CTL: 'CE', // 编译超时
};

/**
 * 数字 status → 统一 Verdict（兼容两种数字域）：
 * - 二元结果制训练赛：0=未通过 1=通过；
 * - 挑战题（challenge）ojStatus 字典序号：
 *   0=WT0 1=WT1 2=CI 3=RI 4=AC 5=PE 6=WA 7=TL 8=ML 9=OL 10=RE 11=CE …
 * 两域在 0/1 上冲突（WT0/WT1 vs WA/AC）：等待态只是瞬态，下次同步会以终态重新
 * 出现（hashId 相同、库中已有则跳过），按 0=WA 1=AC 取训练赛口径。
 */
const NUMERIC_STATUS_TO_VERDICT: Record<number, Verdict> = {
  0: 'WA',
  1: 'AC',
  4: 'AC',
  5: 'WA',
  6: 'WA',
  7: 'TLE',
  8: 'MLE',
  9: 'RE',
  10: 'RE',
  11: 'CE',
};

/** status（字符串或数字）→ Verdict；无法识别/评测中返回 null 跳过 */
export function mapJisuankeVerdict(status: unknown): Verdict | null {
  if (typeof status === 'number' && Number.isFinite(status)) {
    return NUMERIC_STATUS_TO_VERDICT[status] ?? null;
  }
  if (typeof status === 'string') {
    if (/^\d+$/.test(status)) return NUMERIC_STATUS_TO_VERDICT[Number(status)] ?? null;
    return STATUS_TO_VERDICT[status] ?? null;
  }
  return null;
}

/**
 * 题库 difficultyType（level1…levelN，接口亦可能给整数档）→ CF rating 近似值，供统一难度标尺。
 * 表与档位名位于 shared/src/difficulty.ts（档位总数按公开题库分布校准为 8 档）。
 * 兼容别名：既有调用点（problemBank 题库拉取）与测试依赖此名。
 */
export const jisuankeDifficultyToRating = (d: unknown): number | null => toCfRating('jisuanke', d);

/** /api/contest/submissions 的单行（前端 ContestSubmissions 表格绑定的字段） */
export interface JisuankeSubmissionRow {
  hashId?: string;
  identifier?: string;
  title?: string;
  /** unix 秒 */
  time?: number;
  status?: string | number;
  usedTime?: number;
  usedMemory?: number;
  language?: string;
  problemId?: number;
}

/** /api/contest/problems 的单行 */
export interface JisuankeProblemRow {
  problemId?: number;
  identifier?: string;
  title?: string;
}

/** /api/contests?hasParticipated=true 的单行 */
export interface JisuankeContestRow {
  contestId: number;
  title?: string;
  /** "2026-09-05 10:00:00"（北京时间，无时区后缀） */
  startTime?: string;
}

/** "2026-09-05 10:00:00"（北京时间）→ epoch 毫秒；解析失败返回 0 排到最后 */
export function parseJisuankeTime(s: string | undefined): number {
  if (!s) return 0;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) - 8 * 3600 * 1000;
}

/** 计蒜客 problemKey（`{contestId}-{problemId|identifier}`）→ 题目页链接 */
export function jisuankeProblemUrl(problemKey: string): string {
  const m = problemKey.match(/^(\d+)-(.+)$/);
  if (m) return `${BASE}/contest/${m[1]}/problem/${m[2]}`;
  return `${BASE}/contests`;
}

interface FetchJsonOk {
  ok: true;
  body: unknown;
}
interface FetchJsonSkip {
  ok: false;
  /** true = 未登录（302 跳登录），需中断同步；false = 单场无权限等，可跳过 */
  unauthorized: boolean;
}

/** 带 Cookie 的 GET → JSON；302 视为未登录，403 视为无权限（跳过该比赛） */
async function fetchJson(
  fetchFn: HttpInit,
  url: string,
  cookie: string,
): Promise<FetchJsonOk | FetchJsonSkip> {
  const res = await asHttpClient(fetchFn).fetch(url, {
    headers: { Cookie: cookie, 'User-Agent': UA, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    redirect: 'manual', // 未登录时平台 302 跳登录页，不跟随
  }, { timeoutMs: 20000 });
  if (res.status === 302 || res.status === 401) return { ok: false, unauthorized: true };
  if (res.status === 403 || res.status === 404) return { ok: false, unauthorized: false };
  if (!res.ok) throw new Error(`计蒜客返回 HTTP ${res.status}，请稍后重试`);
  const body = (await res.json().catch(() => null)) as unknown;
  if (body === null) throw new Error('计蒜客返回非 JSON 响应（可能页面结构变化），请反馈或使用手动导入');
  return { ok: true, body };
}

/** 拉取全部参加过的比赛（按开始时间新→旧排序）。
 * 首页未登录（302）→ 抛 ManualImportRequiredError（否则过期 Cookie 会被误报成「没有比赛」）；
 * 空页 / 返回内容与之前重复（分页到头）→ 结束。 */
export async function fetchParticipatedContests(
  fetchFn: HttpInit,
  cookie: string,
  pageDelayMs: number = PAGE_DELAY_MS,
): Promise<JisuankeContestRow[]> {
  const out: JisuankeContestRow[] = [];
  const seenIds = new Set<number>();
  for (let page = 1; page <= MAX_CONTEST_LIST_PAGES; page += 1) {
    const r = await fetchJson(fetchFn, `${BASE}/api/contests?page=${page}&hasParticipated=true`, cookie);
    if (!r.ok) {
      if (r.unauthorized && page === 1) {
        throw new ManualImportRequiredError(
          'jisuanke',
          '登录态已失效（参赛列表跳转登录），请重新登录 www.jisuanke.com 并更新 Cookie',
        );
      }
      break; // 列表接口异常不阻断：已拿到的比赛继续处理
    }
    // 正常返回数组；防御对象形态 { past: { contests: [...] } } / { contests: [...] }
    const rows: JisuankeContestRow[] = Array.isArray(r.body)
      ? (r.body as JisuankeContestRow[])
      : ((r.body as { past?: { contests?: JisuankeContestRow[] } })?.past?.contests ??
        (r.body as { contests?: JisuankeContestRow[] })?.contests ??
        []);
    let fresh = 0;
    for (const c of rows) {
      if (typeof c?.contestId === 'number' && !seenIds.has(c.contestId)) {
        seenIds.add(c.contestId);
        out.push(c);
        fresh += 1;
      }
    }
    // 空页或整页重复（API 无总数字段，可能对未知参数回退第一页）→ 已到尽头
    if (rows.length === 0 || fresh === 0) break;
    if (pageDelayMs) await new Promise((res) => setTimeout(res, pageDelayMs));
  }
  out.sort((a, b) => parseJisuankeTime(b.startTime) - parseJisuankeTime(a.startTime));
  return out;
}

export function createJisuankeAdapter(fetchFn: HttpInit = fetch): PlatformAdapter {
  const http = asHttpClient(fetchFn);
  const requireCookie = (opts?: FetchOptions): string => {
      const cookie = opts?.cookie?.trim();
      if (!cookie) {
        throw new ManualImportRequiredError(
          'jisuanke',
          '计蒜客提交记录按「参加过的比赛」组织且需登录访问：请在设置页「计蒜客」分别填写 s 与 JSKUSS 两项会话 Cookie（实测站点仅这两项与登录相关）—— 确认浏览器已登录 www.jisuanke.com（右上角显示头像），F12 → Application → Cookies 按名复制值；未登录时站点也会发游客 s 会话，校验不过通常是缺 JSKUSS',
        );
      }
    return cookie;
  };

  return {
    platform: 'jisuanke',
    knownIdsFilter: true,

    async fetchUserSubmissions(
      _handle,
      opts,
    ): Promise<NormalizedSubmission[]> {
      const cookie = requireCookie(opts);
      const contests = await fetchParticipatedContests(fetchFn, cookie, opts?.pageDelayMs ?? PAGE_DELAY_MS);
      if (contests.length === 0) {
        throw new ManualImportRequiredError(
          'jisuanke',
          '参赛列表为空：请确认 Cookie 有效且该账号在 www.jisuanke.com 上参加过至少一场比赛（作业/练习题不在同步范围）',
        );
      }

      const startIndex = opts?.backfill && opts?.backfillFromPage ? Math.max(1, opts.backfillFromPage) : 1;
      const maxSubmissions = opts?.maxSubmissions;
      const out: NormalizedSubmission[] = [];
      let processed = 0;
      let rowCapped = false;
      let caughtUp = false; // 增量模式：整场提交全部已知 → 更早的比赛都在库中
      // 限速等待累计到 opts.waitedMs（同步层写入 sync_runs.waited_ms 供同步中心展示）
      const sleepTracked = async (ms: number): Promise<void> => {
        if (ms > 0) {
          if (opts) opts.waitedMs = (opts.waitedMs ?? 0) + ms;
          await sleep(ms);
        }
      };

      for (let i = startIndex - 1; i < contests.length; i += 1) {
        if (processed >= PER_SYNC_MAX_CONTESTS) break;
        const contest = contests[i];
        processed += 1;

        // 提交数组（未登录 302 → 中断；单场无权限/无提交 → 跳过该场）
        const subRes = await fetchJson(
          fetchFn,
          `${BASE}/api/contest/submissions?contestId=${contest.contestId}`,
          cookie,
        );
        if (!subRes.ok) {
          if (subRes.unauthorized) {
            throw new ManualImportRequiredError(
              'jisuanke',
              '登录态已失效（提交接口跳转登录），请重新登录 www.jisuanke.com 并更新 Cookie',
            );
          }
          continue;
        }
        // HasNoSubmissions 等错误以 {error: "..."} 对象返回，同样视为空场
        const rows: JisuankeSubmissionRow[] = Array.isArray(subRes.body)
          ? (subRes.body as JisuankeSubmissionRow[])
          : [];
        if (rows.length === 0) continue;

        // 行内通常不带 problemId（路由 /contest/:id/problem/:problemId 需要它），
        // 拉题目表建 identifier → problemId 映射；失败则退化为 identifier
        const problemIds = new Map<string, number>();
        if (rows.some((r) => typeof r.problemId !== 'number')) {
          const probRes = await fetchJson(
            fetchFn,
            `${BASE}/api/contest/problems?contestId=${contest.contestId}`,
            cookie,
          );
          if (probRes.ok) {
            const probRows: JisuankeProblemRow[] = Array.isArray(probRes.body)
              ? (probRes.body as JisuankeProblemRow[])
              : ((probRes.body as { problems?: JisuankeProblemRow[] })?.problems ?? []);
            for (const p of probRows) {
              if (typeof p?.problemId === 'number' && p.identifier) {
                problemIds.set(p.identifier, p.problemId);
              }
            }
          }
        }

        rows.sort((a, b) => (b.time ?? 0) - (a.time ?? 0)); // 新→旧
        let knownInContest = 0;
        let storedOrSkipped = 0;
        for (const row of rows) {
          const externalId = String(row.hashId ?? `${contest.contestId}-${row.identifier ?? '?'}-${row.time ?? 0}`);
          if (opts?.knownExternalIds?.has(externalId)) {
            knownInContest += 1;
            storedOrSkipped += 1;
            continue;
          }
          const verdict = mapJisuankeVerdict(row.status);
          if (verdict === null) continue; // 评测中/系统态不落库，也不计入已知
          storedOrSkipped += 1;
          const pid = String(row.problemId ?? problemIds.get(row.identifier ?? '') ?? row.identifier ?? '');
          out.push({
            problem: {
              platform: 'jisuanke' as PlatformId,
              problemKey: `${contest.contestId}-${pid}`,
              title: row.title || row.identifier || String(pid),
              ...difficultyFields('jisuanke', null), // 比赛提交行不含难度档位：由题库/回填路径补齐
              url: jisuankeProblemUrl(`${contest.contestId}-${pid}`),
              tags: [],
            },
            verdict,
            ...(row.language ? { language: row.language } : {}),
            submittedAt: new Date((row.time ?? 0) * 1000).toISOString(),
            externalId,
          });
          if (maxSubmissions && out.length >= maxSubmissions) {
            rowCapped = true;
            break;
          }
        }
        // 整场全部已知（且确有可入库的行）：增量模式早停——更早的比赛都在库中；
        // 补全模式不早停，跳过已知场继续向更早翻页（与 pagedFetch 语义一致）
        if (
          !opts?.backfill &&
          opts?.knownExternalIds &&
          storedOrSkipped > 0 &&
          knownInContest === storedOrSkipped &&
          !rowCapped
        ) {
          caughtUp = true;
          break;
        }
        if (rowCapped) break;
        await sleepTracked(PAGE_DELAY_MS);
      }

      // 截断判定：触及新增上限，或比赛数预算耗尽（未自然扫完/未增量早停）且有新增
      const exhausted = processed >= PER_SYNC_MAX_CONTESTS;
      const truncated = rowCapped || (!caughtUp && exhausted && out.length > 0);
      if (truncated && opts) {
        opts.truncated = true;
        opts.backfillReachedPage = startIndex - 1 + processed; // 本次处理到的比赛序号，下次续拉
      }
      return out;
    },

    problemUrl({ problemKey }) {
      return jisuankeProblemUrl(String(problemKey));
    },

    /** 校验登录态：/api/user/info 登录后响应含 uuid/name 等用户字段（未登录仅返回 websocket 配置）。
     *  带 X-Requested-With 让未登录返回 401 JSON 而非 302 跳转页 */
    async checkAuth({ cookie }) {
      try {
        const res = await http.fetch(`${BASE}/api/user/info`, {
          headers: { Cookie: cookie, 'User-Agent': UA, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          redirect: 'manual',
        }, { timeoutMs: 15000 });
        if (res.status === 302 || res.status === 401) {
          return { ok: false, message: 'Cookie 未通过登录校验：需要 s 与 JSKUSS 两项会话 Cookie，只填 s 一项不够——请在设置页「计蒜客」两个输入框分别填写（确认浏览器已登录后，从 F12 → Application → Cookies 按名复制）' };
        }
        if (!res.ok) {
          return { ok: false, message: `计蒜客返回 HTTP ${res.status}，请稍后重试` };
        }
        const body = (await res.json().catch(() => null)) as { uuid?: string; name?: string } | null;
        if (body && typeof body.uuid === 'string' && body.uuid) {
          return { ok: true, message: `Cookie 有效${body.name ? `，当前用户：${body.name}` : ''}` };
        }
        return { ok: false, message: 'Cookie 未通过登录校验：需要 s 与 JSKUSS 两项会话 Cookie，只填 s 一项不够——请在设置页「计蒜客」两个输入框分别填写（确认浏览器已登录后，从 F12 → Application → Cookies 按名复制）' };
      } catch (e) {
        return { ok: false, message: `无法连接计蒜客：${(e as Error).message}` };
      }
    },
  };
}

import type { PlatformId } from '../../../shared/src/index.ts';
import { toCfRating } from '../../../shared/src/difficulty.ts';
import { fetchWithChallenge, luoguDifficultyToRating } from './luogu.ts';
import { leetcodeDifficultyToRating } from './leetcode.ts';
import { jisuankeDifficultyToRating } from './jisuanke.ts';
import { asHttpClient, sleep, type HttpInit } from './http.ts';

/** 题库题目（无提交记录，仅供扩充待选池） */
export interface BankProblem {
  platform: PlatformId;
  problemKey: string;
  title: string;
  /** CF rating 统一标尺 */
  difficulty: number | null;
  url: string;
  tags: string[];
}

export interface BankFetchOptions {
  /** 洛谷难度下限（1-8 官方分级；默认 3=普及/提高-，过滤纯水题） */
  luoguMinDifficulty?: number;
  /** 每平台最大拉取题数（默认 2000；洛谷约 40 页、牛客约 40 页） */
  max?: number;
  /** 进度回调（每完成一页触发） */
  onProgress?: (fetched: { platform: PlatformId; count: number; total: number | null }) => void;
}

export interface BankFetchResult {
  platform: PlatformId;
  problems: BankProblem[];
  /** 服务端报告的题目总数（洛谷 count / 牛客「共 N 条」；解析失败为 null） */
  total: number | null;
}

const LUOGU_API = 'https://www.luogu.com.cn';
const NOWCODER_API = 'https://ac.nowcoder.com';
const CODEFORCES_API = 'https://codeforces.com/api';
const KENKOOOO_API = 'https://kenkoooo.com/atcoder';
const DAIMAYUAN_BASE = 'https://bs.daimayuan.top';
const LUOGU_PER_PAGE = 50;
const NOWCODER_PER_PAGE = 50;
const DAIMAYUAN_PER_PAGE = 100;

// ---------- 洛谷 ----------

interface LuoguListProblem {
  pid?: string;
  name?: string;
  difficulty?: number;
  /** Lentille 接口返回 tag id 数组，需经 /_lfe/tags 字典转名称 */
  tags?: number[];
}

/**
 * 洛谷公开题库（无需登录）：
 * GET /problem/list?page={n}&type=P&difficulty={d}
 * 请求头 x-lentille-request: content-only；C3VK 挑战由 fetchWithChallenge 自动处理。
 * difficulty 参数支持「最小难度」语义（如 difficulty=4 → 普及+/提高 及以上），
 * 服务端按难度升序返回，翻页至难度超限或页空终止。
 */
export async function fetchLuoguBank(
  fetchFn: HttpInit,
  opts: BankFetchOptions = {},
): Promise<BankFetchResult> {
  const max = opts.max ?? 2000;
  const minDiff = clamp(opts.luoguMinDifficulty ?? 3, 1, 8);
  const problems: BankProblem[] = [];
  const tagDict = await fetchLuoguTagDict(fetchFn);
  let total: number | null = null;

  for (let page = 1; page <= 200; page += 1) {
    const url = `${LUOGU_API}/problem/list?page=${page}&type=P&difficulty=${minDiff}`;
    const res = await fetchWithChallenge(asHttpClient(fetchFn), url, '', undefined, {
      'x-lentille-request': 'content-only',
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: `${LUOGU_API}/problem/list`,
    });
    if (!res.ok) {
      throw new Error(`洛谷题库接口 HTTP ${res.status}，请稍后重试`);
    }
    const text = await res.text();
    if (!text.trim().startsWith('{')) {
      throw new Error('洛谷题库接口返回非 JSON（触发风控或接口变化），请稍后重试');
    }
    const data = JSON.parse(text) as {
      status?: number;
      data?: {
        problems?: {
          count?: number;
          perPage?: number;
          result?: LuoguListProblem[];
        };
      };
    };
    const list = data.data?.problems;
    if (!list || !Array.isArray(list.result)) {
      throw new Error('洛谷题库接口响应结构异常，请稍后重试');
    }
    if (typeof list.count === 'number') total = list.count;
    if (list.result.length === 0) break;

    for (const p of list.result) {
      if (typeof p.pid !== 'string' || !p.pid) continue;
      const rating =
        typeof p.difficulty === 'number' ? luoguDifficultyToRating(p.difficulty) : null;
      problems.push({
        platform: 'luogu',
        problemKey: p.pid,
        title: p.name ?? p.pid,
        difficulty: rating,
        url: `https://www.luogu.com.cn/problem/${p.pid}`,
        tags: (p.tags ?? [])
          .map((id) => tagDict.get(id))
          .filter((t): t is string => typeof t === 'string'),
      });
    }
    opts.onProgress?.({ platform: 'luogu', count: problems.length, total });
    if (problems.length >= max) break;
    if (list.result.length < (list.perPage ?? LUOGU_PER_PAGE)) break;
    await sleep(400); // 洛谷限速：页间间隔
  }
  return { platform: 'luogu', problems: problems.slice(0, max), total };
}

/** 洛谷 tag id → 名称字典（/_lfe/tags，匿名可访问；失败降级为空字典，仅丢失标签） */
async function fetchLuoguTagDict(fetchFn: HttpInit): Promise<Map<number, string>> {
  const dict = new Map<number, string>();
  try {
    const res = await fetchWithChallenge(asHttpClient(fetchFn), `${LUOGU_API}/_lfe/tags`, '', undefined, {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: `${LUOGU_API}/`,
    });
    if (res.ok) {
      const d = (await res.json()) as { tags?: Array<{ id: number; name: string }> };
      for (const t of d.tags ?? []) dict.set(t.id, t.name);
    }
  } catch {
    // 字典拉取失败不阻断题库同步（题目照常入库，仅无标签）
  }
  return dict;
}

// ---------- 牛客 ----------

interface NcBankRow {
  problemId: string;
  title: string;
  difficulty: number | null;
}

/**
 * 牛客公开题库页（无需登录）：GET /acm/problem/list?page={n}
 * 表格行 <tr data-problemId="...">：列依次为 NC 题号 / 标题 / 难度分 / 通过数 / 收藏。
 * 难度分为 CF 风格分值（如 700 / 1100 / 1500），直接作为统一难度标尺。
 * 页面无服务端难度筛选（前端 JS 过滤），按 orderById 顺序翻页。
 */
export async function fetchNowcoderBank(
  fetchFn: HttpInit,
  opts: BankFetchOptions = {},
): Promise<BankFetchResult> {
  const max = opts.max ?? 2000;
  const problems: BankProblem[] = [];
  const seen = new Set<string>();
  let total: number | null = null;

  for (let page = 1; page <= 200; page += 1) {
    const url = `${NOWCODER_API}/acm/problem/list?queryType=all&orderById=true&page=${page}`;
    const res = await asHttpClient(fetchFn).fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: `${NOWCODER_API}/acm/problem/list`,
      },
    });
    if (!res.ok) {
      throw new Error(`牛客题库页 HTTP ${res.status}，请稍后重试`);
    }
    const html = await res.text();
    if (total === null) {
      const m = html.match(/共\s*(\d+)\s*条/);
      if (m) total = Number(m[1]);
    }
    const rows = parseNcRows(html);
    if (rows.length === 0) break;

    for (const row of rows) {
      const key = row.problemId;
      if (seen.has(key)) continue;
      seen.add(key);
      problems.push({
        platform: 'nowcoder',
        problemKey: key,
        title: row.title || `NC${key}`,
        difficulty: row.difficulty,
        url: `https://ac.nowcoder.com/acm/problem/${key}`,
        tags: [],
      });
    }
    opts.onProgress?.({ platform: 'nowcoder', count: problems.length, total });
    if (problems.length >= max) break;
    if (rows.length < NOWCODER_PER_PAGE) break;
    await sleep(500); // 牛客反爬较强：页间限速
  }
  return { platform: 'nowcoder', problems: problems.slice(0, max), total };
}

/** 解析牛客题库页表格行（data-problemId 行；列：NC 题号 / 标题 / 难度 / 通过数 / 收藏） */
function parseNcRows(html: string): NcBankRow[] {
  const rows: NcBankRow[] = [];
  const trRe = /<tr[^>]*data-problemId="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html)) !== null) {
    const problemId = m[1];
    const tds = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) =>
      x[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim(),
    );
    if (tds.length < 3) continue; // 异常行跳过
    const diffText = tds[2];
    // 牛客难度分为 CF 风格分值（约 200-3800）；过小值（如 NC1 Hello 演示题的 2）
    // 是站点脏数据，越界无效 → null，避免拉低难度分位统计
    const difficulty = /^\d+$/.test(diffText) && Number(diffText) >= 100 ? Number(diffText) : null;
    rows.push({ problemId, title: tds[1], difficulty });
  }
  return rows;
}

// ---------- Codeforces ----------

interface CfProblemsetProblem {
  contestId?: number;
  index?: string;
  name?: string;
  rating?: number;
  tags?: string[];
}

/**
 * Codeforces 官方公开接口 problemset.problems（匿名）：单次调用返回全量题库
 * （约 1 万题，自带 CF rating 与算法标签），无翻页、无限速压力。
 * 无 contestId 的条目（acmsguru 等）不在 /contest/{id}/problem/ 链接体系内，跳过。
 */
export async function fetchCodeforcesBank(
  fetchFn: HttpInit,
  opts: BankFetchOptions = {},
): Promise<BankFetchResult> {
  const max = opts.max ?? 20000;
  const res = await asHttpClient(fetchFn).fetch(`${CODEFORCES_API}/problemset.problems`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json',
    },
  }, { timeoutMs: 30000 }); // 单次返回约 1 万题的全量题库，放宽超时
  if (!res.ok) {
    throw new Error(`Codeforces 题库接口 HTTP ${res.status}，请稍后重试`);
  }
  const data = JSON.parse(await res.text()) as {
    status?: string;
    comment?: string;
    result?: { problems?: CfProblemsetProblem[] };
  };
  const list = data.result?.problems;
  if (data.status !== 'OK' || !Array.isArray(list)) {
    throw new Error(`Codeforces 题库接口响应异常${data.comment ? `：${data.comment}` : ''}`);
  }
  const problems: BankProblem[] = [];
  for (const p of list) {
    if (typeof p.contestId !== 'number' || typeof p.index !== 'string' || !p.index) continue;
    problems.push({
      platform: 'codeforces',
      problemKey: `${p.contestId}${p.index}`.toUpperCase(),
      title: p.name ?? `${p.contestId}${p.index}`,
      difficulty: typeof p.rating === 'number' ? p.rating : null,
      url: `https://codeforces.com/contest/${p.contestId}/problem/${p.index}`,
      tags: Array.isArray(p.tags) ? p.tags : [],
    });
    if (problems.length >= max) break;
  }
  return { platform: 'codeforces', problems, total: list.length };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

// ---------- 力扣（leetcode.cn） ----------

interface LcBankQuestion {
  frontendQuestionId?: string;
  title?: string;
  titleCn?: string;
  titleSlug?: string;
  difficulty?: string;
  paidOnly?: boolean;
  topicTags?: Array<{ name?: string }>;
}

const LEETCODE_GRAPHQL = 'https://leetcode.cn/graphql';
const LEETCODE_BANK_PAGE = 100;

const LEETCODE_BANK_QUERY = `query problemsetQuestionList($limit: Int, $skip: Int) {
  problemsetQuestionList(limit: $limit, skip: $skip) {
    total
    questions { frontendQuestionId title titleCn titleSlug difficulty paidOnly topicTags { name } }
  }
}`;

/**
 * 力扣公开题库（匿名可访问）：POST /graphql problemsetQuestionList 分页翻取
 * （约 3300+ 题，每页 100）。题目标识用 slug（与提交同步的 problemKey 一致），
 * 中文标题优先，三级难度映射为 CF rating 标尺，算法标签英文转小写
 * （TAG_ALIAS_TO_CANONICAL 负责归并到中文知识点）。付费题（paidOnly）跳过。
 */
export async function fetchLeetcodeBank(
  fetchFn: HttpInit,
  opts: BankFetchOptions = {},
): Promise<BankFetchResult> {
  const max = opts.max ?? 2000;
  const problems: BankProblem[] = [];
  let total: number | null = null;

  for (let skip = 0; skip < 10000; skip += LEETCODE_BANK_PAGE) {
    const res = await asHttpClient(fetchFn).fetch(LEETCODE_GRAPHQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Referer: 'https://leetcode.cn/problemset/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify({
        query: LEETCODE_BANK_QUERY,
        variables: { limit: LEETCODE_BANK_PAGE, skip },
      }),
    }, { timeoutMs: 30000 });
    if (!res.ok) {
      throw new Error(`力扣题库接口 HTTP ${res.status}，请稍后重试`);
    }
    const body = (await res.json()) as {
      data?: { problemsetQuestionList?: { total?: number; questions?: LcBankQuestion[] } };
      errors?: Array<{ message?: string }>;
    };
    const list = body.data?.problemsetQuestionList;
    if (body.errors?.length || !Array.isArray(list?.questions)) {
      throw new Error(`力扣题库接口响应异常${body.errors?.[0]?.message ? `：${body.errors[0].message}` : ''}，请稍后重试`);
    }
    if (typeof list?.total === 'number') total = list.total;
    if (list.questions.length === 0) break;

    for (const q of list.questions) {
      if (!q.titleSlug || q.paidOnly) continue;
      problems.push({
        platform: 'leetcode',
        problemKey: q.titleSlug.toLowerCase(),
        title: q.titleCn || q.title || q.titleSlug,
        difficulty: leetcodeDifficultyToRating(q.difficulty),
        url: `https://leetcode.cn/problems/${q.titleSlug.toLowerCase()}/`,
        tags: (q.topicTags ?? [])
          .map((t) => (t.name ?? '').trim().toLowerCase())
          .filter(Boolean),
      });
    }
    opts.onProgress?.({ platform: 'leetcode', count: problems.length, total });
    if (problems.length >= max) break;
    if (list.questions.length < LEETCODE_BANK_PAGE) break;
    await sleep(400); // 页间限速
  }
  return { platform: 'leetcode', problems: problems.slice(0, max), total };
}

// ---------- AtCoder（kenkoooo 社区 API） ----------

interface KenkoooProblem {
  id: string;
  contest_id: string;
  problem_index?: string;
  name?: string;
  title?: string;
}

interface KenkoooModel {
  difficulty?: number | null;
  is_experimental?: boolean;
}

/**
 * AtCoder 公开题库：使用社区维护的 kenkoooo/AtCoderProblems 资源接口（匿名可访问）。
 * - GET /resources/problems.json：全量题目列表（约 4000+ 题，含 id / contest_id / title）
 * - GET /resources/problem-models.json：题目难度模型（difficulty 为 AtCoder 预估难度，约 -1000~4000+）
 * 两次单次调用即可拿全量，无翻页；kenkoooo 要求请求间隔 >= 1s，两次调用间 sleep。
 * difficulty 经四舍五入后统一到 CF rating 标尺；负值（极简题）钳到 800（CF 实际下限）。
 */
export async function fetchAtcoderBank(
  fetchFn: HttpInit,
  opts: BankFetchOptions = {},
): Promise<BankFetchResult> {
  const max = opts.max ?? 5000;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: 'application/json',
  };

  // kenkoooo 要求请求间隔 >= 1s：顺序请求 + sleep，不并发（原 Promise.all 违反间隔要求）
  // 两份资源都是全量快照（problems 数千条 / models 上万条），放宽超时到 30s
  const probRes = await asHttpClient(fetchFn).fetch(`${KENKOOOO_API}/resources/problems.json`, {
    headers,
  }, { timeoutMs: 30000 });
  await sleep(1000);
  const modelRes = await asHttpClient(fetchFn).fetch(`${KENKOOOO_API}/resources/problem-models.json`, {
    headers,
  }, { timeoutMs: 30000 });
  if (!probRes.ok) {
    throw new Error(`AtCoder 题库接口 HTTP ${probRes.status}，请稍后重试`);
  }
  if (!modelRes.ok) {
    throw new Error(`AtCoder 难度模型接口 HTTP ${modelRes.status}，请稍后重试`);
  }
  const probList = (await probRes.json()) as KenkoooProblem[];
  const modelMap = (await modelRes.json()) as Record<string, KenkoooModel>;
  if (!Array.isArray(probList)) {
    throw new Error('AtCoder 题库接口响应结构异常，请稍后重试');
  }

  const problems: BankProblem[] = [];
  for (const p of probList) {
    if (typeof p.id !== 'string' || !p.id || typeof p.contest_id !== 'string' || !p.contest_id) continue;
    const model = modelMap[p.id];
    let difficulty: number | null = null;
    if (model && typeof model.difficulty === 'number' && Number.isFinite(model.difficulty)) {
      const d = Math.round(model.difficulty);
      difficulty = d < 800 ? 800 : d; // 负值/极低值钳到 CF 实际下限
    }
    problems.push({
      platform: 'atcoder',
      problemKey: p.id,
      title: p.title || p.name || p.id,
      difficulty,
      url: `https://atcoder.jp/contests/${p.contest_id}/tasks/${p.id}`,
      tags: [],
    });
    if (problems.length >= max) break;
  }
  return { platform: 'atcoder', problems, total: probList.length };
}

// ---------- 代码源（bs.daimayuan.top，Hydro OJ） ----------

/** 代码源（Hydro）1-10 难度 → CF rating：映射表位于 shared/src/difficulty.ts。
 *  兼容别名：内部题库解析与既有测试依赖此名 */
export const daimayuanDifficultyToRating = (d: number): number | null => toCfRating('daimayuan', d);

interface DmyBankRow {
  pid: string;
  title: string;
  difficulty: number | null;
  tags: string[];
}

/**
 * 代码源公开题库页（无需登录）：GET /p?page={n}（每页 100 题，按 pid 升序）。
 * Hydro 渲染表格行 <tr data-pid="{id}">：列含题号/标题（含标签）/通过数/难度（1-10）。
 * 难度 1-10 映射为 CF rating 标尺；标签为中文知识点（模拟/数据结构/线段树…），直接入库。
 * 总数从 <p>{N} problems</p> 提取；翻页至空页或达到 max 终止。
 */
export async function fetchDaimayuanBank(
  fetchFn: HttpInit,
  opts: BankFetchOptions = {},
): Promise<BankFetchResult> {
  const max = opts.max ?? 2000;
  const problems: BankProblem[] = [];
  const seen = new Set<string>();
  let total: number | null = null;

  for (let page = 1; page <= 50; page += 1) {
    const url = `${DAIMAYUAN_BASE}/p?page=${page}`;
    const res = await asHttpClient(fetchFn).fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: `${DAIMAYUAN_BASE}/p`,
      },
    });
    if (!res.ok) {
      throw new Error(`代码源题库页 HTTP ${res.status}，请稍后重试`);
    }
    const html = await res.text();
    if (total === null) {
      const m = html.match(/(\d+)\s*problems/);
      if (m) total = Number(m[1]);
    }
    const rows = parseDmyRows(html);
    if (rows.length === 0) break;

    for (const row of rows) {
      if (seen.has(row.pid)) continue;
      seen.add(row.pid);
      problems.push({
        platform: 'daimayuan',
        problemKey: row.pid,
        title: row.title || row.pid,
        difficulty: row.difficulty,
        url: `${DAIMAYUAN_BASE}/p/${row.pid}`,
        tags: row.tags,
      });
    }
    opts.onProgress?.({ platform: 'daimayuan', count: problems.length, total });
    if (problems.length >= max) break;
    if (rows.length < DAIMAYUAN_PER_PAGE) break;
    await sleep(400); // 页间限速
  }
  return { platform: 'daimayuan', problems: problems.slice(0, max), total };
}

/**
 * 解析代码源题库页表格行（Hydro problem_main 模板）。
 * 行结构：<tr data-pid="{id}">，含：
 *   - col--name 列：<a href="/p/{id}"><b>{id}</b>&nbsp;&nbsp;{标题}</a> + <ul class="problem__tags">标签列表</ul>
 *   - col--difficulty 列：难度 1-10
 */
function parseDmyRows(html: string): DmyBankRow[] {
  const rows: DmyBankRow[] = [];
  const trRe = /<tr\s+data-pid="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html)) !== null) {
    const pid = m[1];
    const cell = m[2];

    // 标题：<a href="/p/{pid}"><b>{pid}</b>&nbsp;&nbsp;{标题}</a>
    const titleMatch = cell.match(/<a\s+href="\/p\/[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    let title = pid;
    if (titleMatch) {
      title = titleMatch[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      // 去掉前导题号（如 "1 [R1A]最大奇数" → "[R1A]最大奇数"）
      title = title.replace(new RegExp(`^${pid}\\s+`), '');
    }

    // 标签：<li class="problem__tag"><a class="problem__tag-link" href="...">{标签}</a></li>
    const tags: string[] = [];
    const tagRe = /class="problem__tag-link"[^>]*>([\s\S]*?)<\/a>/g;
    let tm: RegExpExecArray | null;
    while ((tm = tagRe.exec(cell)) !== null) {
      const tag = tm[1].replace(/<[^>]+>/g, '').trim();
      if (tag) tags.push(tag);
    }

    // 难度：<td class="col--difficulty">N</td>（1-10 → CF rating，映射表在 shared/src/difficulty.ts）
    const diffMatch = cell.match(/class="col--difficulty"[^>]*>\s*(\d+)\s*<\/td>/);
    const diffNum = diffMatch ? Number(diffMatch[1]) : null;
    const difficulty = diffNum !== null ? daimayuanDifficultyToRating(diffNum) : null;

    rows.push({ pid, title, difficulty, tags });
  }
  return rows;
}

// ---------- 计蒜客 ----------

const JISUANKE_BASE = 'https://www.jisuanke.com';
const JISUANKE_PER_PAGE = 50;

interface JisuankeListProblem {
  problemIdentifier?: string;
  title?: string;
  accept?: number;
  submit?: number;
  difficultyType?: string | number;
  passingRate?: number;
  /** 实测为标签数组（可能只回传数量或对象数组），防御性解析 */
  countOfTags?: unknown;
}

/** /api/problems 单页响应体：数组或 { data / problems / result } 包裹，防御性解包 */
function unpackJisuankeProblemPage(body: unknown): JisuankeListProblem[] {
  if (Array.isArray(body)) return body as JisuankeListProblem[];
  const o = body as { data?: unknown; problems?: unknown; result?: unknown };
  for (const cand of [o.data, o.problems, o.result]) {
    if (Array.isArray(cand)) return cand as JisuankeListProblem[];
  }
  return [];
}

/** 标签字段防御性解析：数组（字符串/对象 {name|tagName}）→ 名称数组；其余 → 空数组 */
function parseJisuankeTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((t) =>
      typeof t === 'string'
        ? t
        : String((t as { name?: string; tagName?: string })?.name ?? (t as { tagName?: string })?.tagName ?? ''),
    )
    .filter(Boolean);
}

/**
 * 计蒜客公开题库（匿名可访问，无需 Cookie）：
 * GET /api/problems?page={n}（约 3600 题，每页约 50 条；total 随首页返回）。
 * difficultyType（level1…levelN）→ jisuankeDifficultyToRating 映射统一难度标尺。
 * 题号 problemIdentifier（如 T1001）即 problemKey，题目页 /problem/{identifier}。
 */
export async function fetchJisuankeBank(
  fetchFn: HttpInit,
  opts: BankFetchOptions = {},
): Promise<BankFetchResult> {
  const max = opts.max ?? 2000;
  const problems: BankProblem[] = [];
  let total: number | null = null;

  for (let page = 1; page <= 200; page += 1) {
    const res = await asHttpClient(fetchFn).fetch(`${JISUANKE_BASE}/api/problems?page=${page}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
        Referer: `${JISUANKE_BASE}/problems`,
      },
    });
    if (!res.ok) {
      throw new Error(`计蒜客题库接口 HTTP ${res.status}，请稍后重试`);
    }
    const body = (await res.json().catch(() => null)) as unknown;
    if (body === null) throw new Error('计蒜客题库接口返回非 JSON（接口变化），请稍后重试');
    const rows = unpackJisuankeProblemPage(body);
    // 总数：常见形态 { total } / { data: { total } }（首页即可拿到）
    if (total === null) {
      const o = body as { total?: unknown; data?: { total?: unknown } };
      const t = o.total ?? o.data?.total;
      if (typeof t === 'number') total = t;
    }
    if (rows.length === 0) break;

    for (const p of rows) {
      const key = typeof p.problemIdentifier === 'string' ? p.problemIdentifier.trim() : '';
      if (!key) continue;
      problems.push({
        platform: 'jisuanke',
        problemKey: key,
        title: p.title?.trim() || key,
        difficulty: jisuankeDifficultyToRating(p.difficultyType),
        url: `${JISUANKE_BASE}/problem/${encodeURIComponent(key)}`,
        tags: parseJisuankeTags(p.countOfTags),
      });
    }
    if (problems.length >= max) break;
    await sleep(300); // 页间限速
  }
  return { platform: 'jisuanke', problems: problems.slice(0, max), total };
}

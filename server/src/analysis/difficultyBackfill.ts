import fs from 'node:fs';
import path from 'node:path';
import type { PlatformId } from '../../../shared/src/index.ts';
import { difficultyFields, parseNowcoderScore, type DifficultyScale } from '../../../shared/src/difficulty.ts';
import type { Db } from '../db/index.ts';
import { fetchWithChallenge } from '../adapters/luogu.ts';
import { parseJisuankeProblemTags } from '../adapters/jisuanke.ts';
import { hydroDifficulty, LEETCODE_BANK_PAGE, LEETCODE_BANK_QUERY } from '../adapters/problemBank.ts';
import { asHttpClient, sleep } from '../adapters/http.ts';
import { purifyTags } from '../import/problemWritePolicy.ts';
import { effectiveDataDir } from '../knowledge/store.ts';

/** 单题回填查得的信息（洛谷/牛客逐题查询的返回结构） */
export interface BackfillInfo {
  problemKey: string;
  difficulty: number | null;
  /** 平台原生难度原文（未知为 null；写入 native_difficulty） */
  nativeDifficulty?: string | null;
  /** 原生难度所属标度（见 shared/src/difficulty.ts） */
  difficultyScale?: DifficultyScale | null;
  title: string | null;
  tags: string[] | null;
}

/** 需要回填元数据的题（难度/原生难度/标签三者缺一即入选） */
export interface BackfillTarget {
  platform: PlatformId;
  problemKey: string;
  title: string;
  difficulty: number | null;
  nativeDifficulty: string | null;
  tags: string[];
}

/** 单题元数据：fetcher 的统一返回结构（未知一律 null，不猜） */
export interface ProblemMeta {
  difficulty: number | null;
  nativeDifficulty: string | null;
  difficultyScale: DifficultyScale | null;
  /** 上游给出的标签；null = 上游无标签来源（不覆盖库内已有标签） */
  tags: string[] | null;
  title: string | null;
}

/** 单平台回填结果 */
export interface PlatformBackfillResult {
  platform: string;
  /** 参与回填的题数（该平台需补难度/原生难度/标签的题） */
  scanned: number;
  /** 难度被补上的题数 */
  filled: number;
  /** 原生难度（native_difficulty）由 NULL 被补上的题数（与 filled 相互独立） */
  nativeFilled: number;
  /** 标题/标签被修正的题数 */
  repaired: number;
  /** 上游仍无难度数据的题数（官方未评级等） */
  missing: number;
  /** 拉取失败（风控/网络/上游无此题）的题数 */
  failed: number;
  /** 每题明细（problemKey → 说明） */
  details: Array<{ problemKey: string; action: 'filled' | 'repaired' | 'missing' | 'failed'; note?: string }>;
}

const NOWCODER_API = 'https://ac.nowcoder.com';
const LUOGU_API = 'https://www.luogu.com.cn';
const CODEFORCES_API = 'https://codeforces.com/api';
const KENKOOOO_API = 'https://kenkoooo.com/atcoder';
const LEETCODE_GRAPHQL = 'https://leetcode.cn/graphql';
const DAIMAYUAN_BASE = 'https://bs.daimayuan.top';
const JISUANKE_BASE = 'https://www.jisuanke.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/** kenkoooo 资源缓存 24h（文件与 TTL 与 adapters/atcoder.ts 一致：两处共用同一份缓存文件） */
const RESOURCES_TTL_MS = 24 * 3600 * 1000;
/** 计蒜客题库列表每页条数（实测 20；页大小由服务端固定，不随参数变化） */
const JISUANKE_BANK_PAGE = 20;

/**
 * 平台限速与失败保护：
 * - `delayMs`：**逐题**请求之间的间隔（只有逐题型平台 luogu/nowcoder/daimayuan 会请求上游；
 *   整表型平台的元数据来自整表/缓存，逐题循环不再发请求 → 间隔为 0，页间限速见 SCAN_DELAY_MS）。
 * - `failLimit`：连续失败阈值，超过即视为触发风控并中止该平台（下次运行继续补）。
 *   只有牛客开启（实测匿名搜索连续失败后会被限流，继续打会加重风控）。
 */
const PLATFORM_LIMITS: Record<PlatformId, { delayMs: number; failLimit: number | null }> = {
  nowcoder: { delayMs: 450, failLimit: 8 },
  luogu: { delayMs: 300, failLimit: null },
  daimayuan: { delayMs: 400, failLimit: null },
  leetcode: { delayMs: 0, failLimit: null },
  jisuanke: { delayMs: 0, failLimit: null },
  atcoder: { delayMs: 0, failLimit: null },
  codeforces: { delayMs: 0, failLimit: null },
  qoj: { delayMs: 0, failLimit: null },
};

/** 整表扫描的页间/请求间间隔（力扣分页 400ms；计蒜客分页 300ms；AtCoder 要求 >= 1s） */
const SCAN_DELAY_MS = { leetcode: 400, jisuanke: 300, atcoder: 1000 } as const;

/** 一次回填运行的上下文：整表平台只拉一次，逐题平台用共享的 tag 字典 */
interface BackfillCtx {
  fetchFn: typeof fetch;
  /** 整表型平台：键 → 元数据（同一运行内复用；失败记 null，不重复打上游） */
  tables: Map<PlatformId, Promise<Map<string, ProblemMeta> | null>>;
  /** 本次需要回填的题号（整表平台据此在扫描中提前结束） */
  wanted: Map<PlatformId, Set<string>>;
  /** 洛谷 tag id → 名称字典（懒加载，供逐题详情复用） */
  luoguTagDict?: Promise<Map<number, string>>;
}

// ---------- 回填目标选择 ----------

/** 需要回填的题：无 CF 难度 / 无原生难度 / 无标签（QOJ 无数据来源，排除） */
export function pickBackfillTargets(db: Db): BackfillTarget[] {
  const rows = db
    .prepare(
      `SELECT platform, problem_key, title, difficulty, native_difficulty, tags
         FROM problems
        WHERE platform != 'qoj'
          AND (difficulty IS NULL OR native_difficulty IS NULL OR tags = '[]')
        ORDER BY platform, problem_key`,
    )
    .all() as Array<{
    platform: PlatformId;
    problem_key: string;
    title: string;
    difficulty: number | null;
    native_difficulty: string | null;
    tags: string;
  }>;
  return rows.map((r) => ({
    platform: r.platform,
    problemKey: r.problem_key,
    title: r.title,
    difficulty: r.difficulty,
    nativeDifficulty: r.native_difficulty,
    tags: JSON.parse(r.tags) as string[],
  }));
}

// ---------- 逐题来源：牛客 ----------

/**
 * 解析牛客搜索结果行，分离标题与标签（.title 链接为标题，.tag-label 为算法标签）。
 * 返回 null 表示未命中该题号。
 */
export function parseNcSearchRow(html: string, problemKey: string): BackfillInfo | null {
  const trRe = new RegExp(`<tr[^>]*data-problemId="${problemKey}"[^>]*>([\\s\\S]*?)</tr>`);
  const m = trRe.exec(html);
  if (!m) return null;
  const titleMatch = /class="title"[^>]*>([\s\S]*?)<\/a>/.exec(m[1]);
  const title = titleMatch
    ? titleMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
    : null;
  const tags = [...m[1].matchAll(/class="tag-label[^"]*"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((t) => t[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim())
    .filter(Boolean);
  const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
  const diffText = (tds[2] ?? '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  // 难度分取值规则与题库路径**共用同一个校验器**（200..4000、100 的倍数；离网/越界/空值 → 未知），
  // 否则同一行会对一方「未知」、对另一方「有效」，而 backfill(3) 的优先级会盖掉 bank(1) 的结果
  const nativeScore = parseNowcoderScore(diffText);
  const mapped = difficultyFields('nowcoder', nativeScore);
  return {
    problemKey,
    difficulty: mapped.difficulty ?? null,
    nativeDifficulty: mapped.nativeDifficulty ?? null,
    difficultyScale: mapped.difficultyScale,
    title,
    tags: tags.length > 0 ? tags : null,
  };
}

/** 牛客单题回填：keyword=题号 搜索（匿名可访问），未命中/风控返回 null */
export async function fetchNcProblemInfo(
  fetchFn: typeof fetch,
  problemKey: string,
): Promise<BackfillInfo | null> {
  const url = `${NOWCODER_API}/acm/problem/list?keyword=${encodeURIComponent(problemKey)}`;
  const res = await fetchFn(url, {
    headers: {
      'User-Agent': UA,
      Referer: `${NOWCODER_API}/acm/problem/list`,
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return null; // 调用方按连续失败计数中止
  const html = await res.text();
  return parseNcSearchRow(html, problemKey);
}

// ---------- 逐题来源：洛谷 ----------

interface LgProblemPayload {
  name?: string;
  title?: string;
  difficulty?: number;
  tags?: Array<{ name?: string } | number>;
}

/** 洛谷单题回填：GET /problem/{pid}（content-only），难度分级映射 CF rating，tag id 经字典转名称 */
export async function fetchLgProblemInfo(
  fetchFn: typeof fetch,
  problemKey: string,
  tagDict?: Map<number, string>,
): Promise<BackfillInfo | null> {
  const res = await fetchWithChallenge(fetchFn, `${LUOGU_API}/problem/${problemKey}`, '', undefined, {
    'x-lentille-request': 'content-only',
    Accept: 'application/json',
    Referer: `${LUOGU_API}/problem/${problemKey}`,
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text.trim().startsWith('{')) return null;
  const data = JSON.parse(text) as {
    currentData?: { problem?: LgProblemPayload };
    data?: { problem?: LgProblemPayload };
    problem?: LgProblemPayload;
  };
  const p = data.currentData?.problem ?? data.data?.problem ?? data.problem;
  if (!p) return null;
  // difficulty=0 = 洛谷「暂无评定」：难度未知（null），但原生原文 '0' 照落库 ——
  // 这样该题不会因为「原生值已存在」在下次回填时被反复重查
  const mapped = difficultyFields('luogu', typeof p.difficulty === 'number' ? p.difficulty : null);
  // 标题字段为 name（旧结构 title）；tags 新结构为 id 数组（需字典），旧结构为 {name} 对象数组
  const title = typeof p.name === 'string' ? p.name : typeof p.title === 'string' ? p.title : null;
  const rawTags = Array.isArray(p.tags) ? p.tags : [];
  const tags = rawTags
    .map((t) => {
      if (typeof t === 'number') return tagDict?.get(t) ?? '';
      if (t && typeof t === 'object' && typeof t.name === 'string') return t.name;
      return '';
    })
    .filter(Boolean);
  return {
    problemKey,
    difficulty: mapped.difficulty ?? null,
    nativeDifficulty: mapped.nativeDifficulty ?? null,
    difficultyScale: mapped.difficultyScale,
    title,
    tags: tags.length > 0 ? tags : null,
  };
}

/** 洛谷 tag id → 名称字典（/_lfe/tags 匿名可访问；失败降级空字典，仅丢失标签） */
async function fetchLuoguTagDict(fetchFn: typeof fetch): Promise<Map<number, string>> {
  const dict = new Map<number, string>();
  try {
    const res = await fetchWithChallenge(fetchFn, `${LUOGU_API}/_lfe/tags`, '', undefined, {
      Accept: 'application/json',
      'User-Agent': UA,
      Referer: `${LUOGU_API}/`,
    });
    if (res.ok) {
      const d = (await res.json()) as { tags?: Array<{ id: number; name: string }> };
      for (const t of d.tags ?? []) dict.set(t.id, t.name);
    }
  } catch {
    // 字典失败不阻断回填（难度照常补全）
  }
  return dict;
}

// ---------- 逐题来源：代码源（Hydro） ----------

interface DmyPdoc {
  docId?: number;
  title?: string;
  tag?: string[];
  nSubmit?: number;
  nAccept?: number;
  difficulty?: number;
}

/**
 * 代码源单题元数据：GET /p/{docId} + `Accept: application/json` → `{ pdoc }`。
 * 难度用站点手工档位优先，否则按 Hydro difficultyAlgorithm 本地复算（与题库拉取同源）。
 */
async function fetchDaimayuanMeta(fetchFn: typeof fetch, problemKey: string): Promise<ProblemMeta | null> {
  const res = await asHttpClient(fetchFn).fetch(`${DAIMAYUAN_BASE}/p/${encodeURIComponent(problemKey)}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${DAIMAYUAN_BASE}/p` },
  }, { timeoutMs: 20000 });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { pdoc?: DmyPdoc } | null;
  const pdoc = body?.pdoc;
  if (!pdoc) return null;
  const level = hydroDifficulty(pdoc.nSubmit ?? 0, pdoc.nAccept ?? 0, pdoc.difficulty ?? null);
  const mapped = difficultyFields('daimayuan', level);
  return {
    difficulty: mapped.difficulty ?? null,
    nativeDifficulty: mapped.nativeDifficulty ?? null,
    difficultyScale: mapped.difficultyScale,
    tags: Array.isArray(pdoc.tag) && pdoc.tag.length > 0 ? pdoc.tag.map(String) : null,
    title: typeof pdoc.title === 'string' && pdoc.title.trim() !== '' ? pdoc.title.trim() : null,
  };
}

// ---------- 整表来源：Codeforces / AtCoder / 力扣 / 计蒜客 ----------

function metaFromFields(
  platform: PlatformId,
  raw: unknown,
  extra: { tags: string[] | null; title: string | null },
): ProblemMeta {
  const mapped = difficultyFields(platform, raw);
  return {
    difficulty: mapped.difficulty ?? null,
    nativeDifficulty: mapped.nativeDifficulty ?? null,
    difficultyScale: mapped.difficultyScale,
    tags: extra.tags,
    title: extra.title,
  };
}

/** Codeforces：`problemset.problems` 单次返回全量题库（约 1 万题，自带 rating 与标签） */
async function fetchCodeforcesTable(ctx: BackfillCtx): Promise<Map<string, ProblemMeta>> {
  const res = await asHttpClient(ctx.fetchFn).fetch(`${CODEFORCES_API}/problemset.problems`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  }, { timeoutMs: 30000 });
  if (!res.ok) throw new Error(`Codeforces 题库接口 HTTP ${res.status}`);
  const data = (await res.json()) as {
    status?: string;
    result?: {
      problems?: Array<{ contestId?: number; index?: string; name?: string; rating?: number; tags?: string[] }>;
    };
  };
  const list = data.result?.problems;
  if (data.status !== 'OK' || !Array.isArray(list)) throw new Error('Codeforces 题库接口响应异常');
  const table = new Map<string, ProblemMeta>();
  for (const p of list) {
    if (typeof p.contestId !== 'number' || typeof p.index !== 'string' || !p.index) continue;
    table.set(
      `${p.contestId}${p.index}`.toUpperCase(),
      metaFromFields('codeforces', typeof p.rating === 'number' ? p.rating : null, {
        tags: Array.isArray(p.tags) && p.tags.length > 0 ? p.tags : null,
        title: p.name ?? null,
      }),
    );
  }
  return table;
}

/**
 * AtCoder：kenkoooo 两份资源整表（problems.json / problem-models.json，24h 磁盘缓存，
 * 与 adapters/atcoder.ts 共用同一份缓存文件）。θ 走 shared 的分段锚点映射。
 * 注：AtCoder 无标签来源 → tags 恒为 null（标签缺失的题会持续成为候选，但元数据取自缓存，代价极低）。
 */
async function fetchAtcoderTable(ctx: BackfillCtx): Promise<Map<string, ProblemMeta>> {
  const probData = await loadCachedJson(ctx.fetchFn, `${KENKOOOO_API}/resources/problems.json`, 'atcoder-problems');
  await sleep(SCAN_DELAY_MS.atcoder); // kenkoooo 要求请求间隔 >= 1s
  const modelData = await loadCachedJson(ctx.fetchFn, `${KENKOOOO_API}/resources/problem-models.json`, 'atcoder-problem-models');
  const problems = probData as Array<{ id?: string; title?: string; name?: string }>;
  const models = modelData as Record<string, { difficulty?: number | null }>;
  if (!Array.isArray(problems)) throw new Error('AtCoder 题库资源结构异常');
  const table = new Map<string, ProblemMeta>();
  for (const p of problems) {
    if (typeof p.id !== 'string' || !p.id) continue;
    const theta = models[p.id]?.difficulty;
    table.set(
      p.id,
      metaFromFields('atcoder', typeof theta === 'number' && Number.isFinite(theta) ? theta : null, {
        tags: null,
        title: p.title ?? p.name ?? null,
      }),
    );
  }
  return table;
}

/** kenkoooo 资源缓存读写（文件名与 TTL 与 adapters/atcoder.ts 一致） */
async function loadCachedJson(fetchFn: typeof fetch, url: string, cacheKey: string): Promise<unknown> {
  const dataDir = effectiveDataDir();
  const cachePath = dataDir ? path.join(dataDir, `${cacheKey}.json`) : '';
  if (cachePath && fs.existsSync(cachePath)) {
    const age = Date.now() - fs.statSync(cachePath).mtimeMs;
    if (age < RESOURCES_TTL_MS) return JSON.parse(fs.readFileSync(cachePath, 'utf8')) as unknown;
  }
  const res = await asHttpClient(fetchFn).fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  }, { timeoutMs: 30000 });
  if (!res.ok) throw new Error(`AtCoder 资源接口 HTTP ${res.status}`);
  const data: unknown = await res.json();
  if (cachePath) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(data));
  }
  return data;
}

interface LcQuestion {
  title?: string;
  titleCn?: string;
  titleSlug?: string;
  difficulty?: string;
  paidOnly?: boolean;
  topicTags?: Array<{ name?: string; nameTranslated?: string }>;
}

/**
 * 力扣：`problemsetQuestionList` 分页扫描（全库约 45 次请求，每页 100）。
 * 该节点支持 `titleCn` 与 `topicTags.nameTranslated`；逐题的 `question(titleSlug)`
 * **不支持**这两个字段（实测 GraphQL 400 Cannot query field），故不采用逐题查询。
 */
async function fetchLeetcodeTable(ctx: BackfillCtx): Promise<Map<string, ProblemMeta>> {
  const table = new Map<string, ProblemMeta>();
  const wanted = ctx.wanted.get('leetcode');
  for (let skip = 0; skip < 20000; skip += LEETCODE_BANK_PAGE) {
    const res = await asHttpClient(ctx.fetchFn).fetch(LEETCODE_GRAPHQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Referer: 'https://leetcode.cn/problemset/',
        'User-Agent': UA,
      },
      body: JSON.stringify({ query: LEETCODE_BANK_QUERY, variables: { limit: LEETCODE_BANK_PAGE, skip } }),
    }, { timeoutMs: 30000 });
    if (!res.ok) throw new Error(`力扣题库接口 HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: { problemsetQuestionList?: { total?: number; questions?: LcQuestion[] } };
      errors?: Array<{ message?: string }>;
    };
    const list = body.data?.problemsetQuestionList;
    if (body.errors?.length || !Array.isArray(list?.questions)) {
      throw new Error(`力扣题库接口响应异常${body.errors?.[0]?.message ? `：${body.errors[0].message}` : ''}`);
    }
    if (list.questions.length === 0) break;
    for (const q of list.questions) {
      if (!q.titleSlug) continue;
      const tags = (q.topicTags ?? [])
        .map((t) => (t.nameTranslated || t.name || '').trim().toLowerCase())
        .filter(Boolean);
      table.set(
        q.titleSlug.toLowerCase(),
        metaFromFields('leetcode', q.difficulty, {
          tags: tags.length > 0 ? tags : null,
          title: q.titleCn || q.title || null,
        }),
      );
    }
    if (wanted && wanted.size > 0 && [...wanted].every((k) => table.has(k))) break; // 目标题已齐 → 提前结束
    if (list.questions.length < LEETCODE_BANK_PAGE) break;
    await sleep(SCAN_DELAY_MS.leetcode);
  }
  return table;
}

interface JisuankeBankRow {
  problemIdentifier?: string;
  title?: string;
  difficultyType?: string | number;
  problemTags?: unknown;
}

/**
 * 计蒜客：题库列表整表批量扫描（每页 20 条，~180 页）。
 * 行内 `problemTags` 同时给出难度档位类标签与知识点类标签，故一次扫描即可同时补难度与标签；
 * 题目与目标题号全部对上后提前结束。
 * （计划文本提到的 `/api/problem/tags` 字典实测匿名访问 302 跳转，不可用；行内已自带 tagName，无需字典。）
 */
async function fetchJisuankeTable(ctx: BackfillCtx): Promise<Map<string, ProblemMeta>> {
  const table = new Map<string, ProblemMeta>();
  const wanted = ctx.wanted.get('jisuanke');
  for (let page = 1; page <= 300; page += 1) {
    const res = await asHttpClient(ctx.fetchFn).fetch(`${JISUANKE_BASE}/api/problems?page=${page}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${JISUANKE_BASE}/problems` },
    }, { timeoutMs: 20000 });
    if (!res.ok) throw new Error(`计蒜客题库接口 HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as
      | { total?: number; problems?: JisuankeBankRow[] }
      | null;
    if (body === null) throw new Error('计蒜客题库接口返回非 JSON（接口变化）');
    const rows = Array.isArray(body.problems) ? body.problems : [];
    if (rows.length === 0) break;
    for (const p of rows) {
      const key = typeof p.problemIdentifier === 'string' ? p.problemIdentifier.trim() : '';
      if (!key) continue;
      const { knowledge } = parseJisuankeProblemTags(p.problemTags);
      table.set(
        key,
        metaFromFields('jisuanke', p.difficultyType, {
          tags: knowledge.length > 0 ? knowledge : null,
          title: typeof p.title === 'string' && p.title.trim() !== '' ? p.title.trim() : null,
        }),
      );
    }
    if (wanted && wanted.size > 0 && [...wanted].every((k) => table.has(k))) break;
    if (typeof body.total === 'number' && page * JISUANKE_BANK_PAGE >= body.total) break;
    await sleep(SCAN_DELAY_MS.jisuanke);
  }
  return table;
}

const TABLE_FETCHERS: Partial<Record<PlatformId, (ctx: BackfillCtx) => Promise<Map<string, ProblemMeta>>>> = {
  codeforces: fetchCodeforcesTable,
  atcoder: fetchAtcoderTable,
  leetcode: fetchLeetcodeTable,
  jisuanke: fetchJisuankeTable,
};

/** 整表平台的键 → 元数据；同一运行内只拉一次。
 *  拉取失败缓存 null（不重复打上游，也不中断其他平台）→ 该平台的目标题统一记 failed。 */
function platformTable(platform: PlatformId, ctx: BackfillCtx): Promise<Map<string, ProblemMeta> | null> {
  const cached = ctx.tables.get(platform);
  if (cached) return cached;
  const fetcher = TABLE_FETCHERS[platform];
  const p = fetcher ? fetcher(ctx).catch(() => null) : Promise.resolve(null);
  ctx.tables.set(platform, p);
  return p;
}

/**
 * 单题元数据获取（回填注册表入口）。平台 → 来源：
 * - luogu：GET /problem/{pid}（逐题，300ms 间隔）
 * - nowcoder：GET /acm/problem/list?keyword=（逐题，450ms 间隔 + 连续失败 8 次中止）
 * - daimayuan：GET /p/{docId} JSON（逐题，400ms 间隔）
 * - codeforces / atcoder / leetcode / jisuanke：整表一次拉取后在内存里查（tables 缓存）
 * - qoj：平台无难度/标签来源 → 恒 null（目标选择阶段已排除）
 */
export async function fetchProblemMeta(
  platform: PlatformId,
  problemKey: string,
  ctx: BackfillCtx,
): Promise<ProblemMeta | null> {
  switch (platform) {
    case 'luogu': {
      ctx.luoguTagDict ??= fetchLuoguTagDict(ctx.fetchFn);
      const info = await fetchLgProblemInfo(ctx.fetchFn, problemKey, await ctx.luoguTagDict);
      return info === null ? null : toMeta(info);
    }
    case 'nowcoder': {
      const info = await fetchNcProblemInfo(ctx.fetchFn, problemKey);
      return info === null ? null : toMeta(info);
    }
    case 'daimayuan':
      return fetchDaimayuanMeta(ctx.fetchFn, problemKey);
    case 'codeforces':
      return (await platformTable('codeforces', ctx))?.get(problemKey.toUpperCase()) ?? null;
    case 'atcoder':
      return (await platformTable('atcoder', ctx))?.get(problemKey) ?? null;
    case 'leetcode':
      return (await platformTable('leetcode', ctx))?.get(problemKey.toLowerCase()) ?? null;
    case 'jisuanke':
      return (await platformTable('jisuanke', ctx))?.get(problemKey) ?? null;
    default:
      return null;
  }
}

function toMeta(info: BackfillInfo): ProblemMeta {
  return {
    difficulty: info.difficulty,
    nativeDifficulty: info.nativeDifficulty ?? null,
    difficultyScale: info.difficultyScale ?? null,
    tags: info.tags,
    title: info.title,
  };
}

// ---------- 回填服务 ----------

function ncTitlePolluted(title: string): boolean {
  // 历史问题：parseNcRows 曾把标签 a 链接连着换行一起剥进标题
  return /\n/.test(title) || /\s{4,}\S/.test(title.trim());
}

/** 清洗被污染的牛客标题：仅保留第一段非空文本 */
export function cleanNcTitle(title: string): string {
  const first = title.split('\n').map((s) => s.trim()).find((s) => s.length > 0);
  return first ?? title.trim();
}

/**
 * 未知难度/原生难度/标签的全平台回填：
 * - 目标选择见 pickBackfillTargets（QOJ 排除）
 * - 每平台按 PLATFORM_LIMITS 限速；牛客连续失败 8 次判定风控并中止该平台
 * - 写库统一走 difficulty_source='backfill'（优先级 3）：难度、原生难度、标度、标题、标签
 *   都只在「库内为空 / 上游有值」时补齐，绝不覆盖已有手动值
 */
export async function backfillDifficulties(
  db: Db,
  fetchFn: typeof fetch = fetch,
): Promise<PlatformBackfillResult[]> {
  const targets = pickBackfillTargets(db);
  if (targets.length === 0) return [];

  const byPlatform = new Map<PlatformId, BackfillTarget[]>();
  for (const t of targets) {
    const list = byPlatform.get(t.platform);
    if (list) list.push(t);
    else byPlatform.set(t.platform, [t]);
  }
  const ctx: BackfillCtx = {
    fetchFn,
    tables: new Map(),
    wanted: new Map([...byPlatform].map(([p, list]) => [p, new Set(list.map((t) => t.problemKey))])),
  };

  const results: PlatformBackfillResult[] = [];
  for (const [platform, list] of byPlatform) {
    results.push(await backfillPlatform(db, platform, list, ctx));
  }
  return results;
}

async function backfillPlatform(
  db: Db,
  platform: PlatformId,
  targets: BackfillTarget[],
  ctx: BackfillCtx,
): Promise<PlatformBackfillResult> {
  const limits = PLATFORM_LIMITS[platform];
  const r: PlatformBackfillResult = {
    platform,
    scanned: targets.length,
    filled: 0,
    nativeFilled: 0,
    repaired: 0,
    missing: 0,
    failed: 0,
    details: [],
  };
  const before = db.prepare(
    'SELECT title, difficulty, native_difficulty, tags FROM problems WHERE platform = ? AND problem_key = ?',
  );
  /**
   * 写库语义（与 import/problemWritePolicy.ts 的来源优先级一致：manual(4) > backfill(3) > sync(2) > bank(1)）：
   * - 已有难度且来源为 manual → 难度三元组（difficulty/native_difficulty/difficulty_scale）整体不动
   *   （用户手动标定最高优先；只补标题/标签，避免写出「手动难度 + 上游原生值」这种不同源组合）。
   * - 其余（难度为空 / 来源为 sync、bank 等）→ 补上游值：回填高于 sync/bank，可修正旧映射留下的过时值。
   * - difficulty_source：只有真的采纳了新难度（且不是 manual）才标 'backfill'。
   * - 标题：上游有值才覆盖；标签：上游给了非空标签才覆盖。
   * 注：SQLite 的 SET 右值全部读旧行，故各分支里的 `difficulty IS NOT NULL` 判的是更新前的值。
   */
  const update = db.prepare(
    `UPDATE problems
        SET difficulty = CASE
              WHEN difficulty IS NOT NULL AND COALESCE(difficulty_source, 'sync') = 'manual' THEN difficulty
              ELSE COALESCE(?, difficulty)
            END,
            native_difficulty = CASE
              WHEN difficulty IS NOT NULL AND COALESCE(difficulty_source, 'sync') = 'manual' THEN native_difficulty
              ELSE COALESCE(?, native_difficulty)
            END,
            difficulty_scale = CASE
              WHEN difficulty IS NOT NULL AND COALESCE(difficulty_source, 'sync') = 'manual' THEN difficulty_scale
              ELSE COALESCE(?, difficulty_scale)
            END,
            difficulty_source = CASE
              WHEN difficulty IS NOT NULL AND COALESCE(difficulty_source, 'sync') = 'manual' THEN difficulty_source
              WHEN ? IS NOT NULL THEN 'backfill'
              ELSE difficulty_source
            END,
            title = COALESCE(?, title),
            tags = CASE WHEN ? != '[]' THEN ? ELSE tags END
      WHERE platform = ? AND problem_key = ?`,
  );

  let consecutiveFails = 0;
  for (const t of targets) {
    if (limits.failLimit !== null && consecutiveFails >= limits.failLimit) {
      r.failed += 1;
      r.details.push({ problemKey: t.problemKey, action: 'failed', note: '疑似触发风控，中止后续查询（可稍后重试）' });
      continue;
    }
    let meta: ProblemMeta | null = null;
    let failed = false;
    try {
      meta = await fetchProblemMeta(platform, t.problemKey, ctx);
    } catch {
      failed = true;
    }
    if (failed || meta === null) {
      // 未命中也可能是题号已废弃（如转私密），按单题缺失计，连续缺失也计入风控判定
      r.failed += 1;
      r.details.push({ problemKey: t.problemKey, action: 'failed', note: failed ? '请求失败' : '上游未命中' });
      consecutiveFails += 1;
      if (limits.delayMs > 0) await sleep(limits.delayMs);
      continue;
    }
    consecutiveFails = 0;

    const row = before.get(platform, t.problemKey) as {
      title: string;
      difficulty: number | null;
      native_difficulty: string | null;
      tags: string;
    };
    const tags = meta.tags === null ? null : purifyTags(meta.tags);
    const tagsJson = tags === null || tags.length === 0 ? null : JSON.stringify(tags);
    // 牛客历史缺陷：标题曾被标签污染；上游未给标题时用本地清洗兜底
    const title =
      meta.title !== null && meta.title !== ''
        ? meta.title
        : platform === 'nowcoder' && ncTitlePolluted(row.title)
          ? cleanNcTitle(row.title)
          : null;

    update.run(
      meta.difficulty,
      meta.nativeDifficulty,
      meta.difficultyScale,
      meta.difficulty,
      title,
      tagsJson,
      tagsJson,
      platform,
      t.problemKey,
    );

    // 计数按**实际落库结果**判定（而不是按 SQL 分支二次推断）：manual 行不写原生值时不会被误计
    const after = before.get(platform, t.problemKey) as {
      title: string;
      difficulty: number | null;
      native_difficulty: string | null;
      tags: string;
    };
    const filledByWrite = row.difficulty === null && after.difficulty !== null;
    const filledNative = row.native_difficulty === null && after.native_difficulty !== null;
    const titleChanged = after.title !== row.title;
    const tagsChanged = after.tags !== row.tags;
    if (filledByWrite) r.filled += 1;
    if (filledNative) r.nativeFilled += 1;
    if (filledByWrite) {
      r.details.push({ problemKey: t.problemKey, action: 'filled', note: `难度 ${meta.difficulty}` });
    } else if (meta.difficulty === null) {
      r.missing += 1;
      r.details.push({ problemKey: t.problemKey, action: 'missing', note: '上游无难度数据（未评级/未设定）' });
    } else if (titleChanged || tagsChanged || filledNative) {
      r.repaired += 1;
      r.details.push({
        problemKey: t.problemKey,
        action: 'repaired',
        note: titleChanged ? '修正标题' : tagsChanged ? '补标签' : '补原生难度',
      });
    }
    if (limits.delayMs > 0) await sleep(limits.delayMs);
  }
  return r;
}

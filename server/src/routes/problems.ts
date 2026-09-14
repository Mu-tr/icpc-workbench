import { Router } from 'express';
import { canonicalTag, expandTag, filterNoiseTags } from '../../../shared/src/index.ts';
import type { PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { asyncHandler } from '../asyncHandler.ts';
import { safeTags } from '../analysis/stats.ts';
import { backfillDifficulties } from '../analysis/difficultyBackfill.ts';
import { fetchLuoguBank, fetchNowcoderBank, fetchCodeforcesBank, fetchLeetcodeBank, fetchAtcoderBank, fetchDaimayuanBank, fetchJisuankeBank } from '../adapters/problemBank.ts';
import { upsertBankProblems } from '../import/bankService.ts';
import { problemKeypointsCte, knowledgeTagsJoinSql, knowledgeTagsCoalesceSql, knowledgeTagsExpr } from '../knowledge/store.ts';
import { isValidCode } from '../knowledge/taxonomy.ts';

interface ProblemRow {
  id: number;
  platform: PlatformId;
  problem_key: string;
  title: string;
  difficulty: number | null;
  url: string | null;
  tags: string;
  attempts: number;
  ac_count: number;
  last_ac_at: string | null;
}

/** 难度分桶（与客户端 DIFF_BUCKETS / analysis/stats.bucketForDifficulty 同口径） */
const DIFFICULTY_BUCKETS: Record<string, { min: number | null; max: number | null }> = {
  '未知': { min: null, max: null },
  '<1200': { min: null, max: 1199 },
  '1200-1399': { min: 1200, max: 1399 },
  '1400-1599': { min: 1400, max: 1599 },
  '1600-1899': { min: 1600, max: 1899 },
  '1900-2199': { min: 1900, max: 2199 },
  '2200+': { min: 2200, max: null },
};

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

type StatusFilter = 'all' | 'ac' | 'tried' | 'none';

const STATUS_FILTERS: ReadonlySet<string> = new Set<StatusFilter>(['all', 'ac', 'tried', 'none']);

/** 请求里的过滤条件（解析后的强类型形态） */
interface ProblemFilters {
  platform?: string;
  /** 难度区间（闭区间，rating 标尺） */
  diffMin?: number;
  diffMax?: number;
  /** 已展开同义别名的标签集合；空集 = 不限标签 */
  tagAliases: string[];
  q?: string;
  /** 是否包含未做过的题库题 */
  includeBank: boolean;
  status: StatusFilter;
  /** 只保留难度未知的题（difficulty=未知 分桶） */
  unknownOnly: boolean;
}

/**
 * 把过滤条件下推成 SQL 片段（不含状态，状态需在聚合后判定）。
 *
 * 关键性能取舍：difficulty / tag 曾在前端对「全量 1.9 万行」用 JS filter 过滤，
 * 现在全部变成 SQL 条件 —— 难度按分桶区间下推，标签用 json_each 展开成 EXISTS
 * （JSON 数组支持 GIN 式逐元素匹配，无需把行取回内存再嗅探）。
 * 唯一的例外是**标签的来源**：三来源回退链最终落到 problem_keypoints.name，
 * 它是派生值，只能对 COALESCE 后的 tags 做 json_each —— 所以本函数要求调用方
 * 已 WITH problemKeypointsCte 并 LEFT JOIN，否则 COALESCE 里的 pk 无法绑定。
 */
function buildProblemFilterSql(f: ProblemFilters): { where: string; params: Array<string | number> } {
  let where = '';
  const params: Array<string | number> = [];
  if (!f.includeBank) {
    where += ' AND EXISTS (SELECT 1 FROM submissions s2 WHERE s2.problem_id = p.id AND s2.user_id = ?)';
    params.push(DEFAULT_USER_ID);
  }
  if (f.platform !== undefined) {
    where += ' AND p.platform = ?';
    params.push(f.platform);
  }
  if (f.q !== undefined) {
    where += ' AND (p.title LIKE ? OR p.problem_key LIKE ?)';
    params.push(`%${f.q}%`, `%${f.q}%`);
  }
  // 难度：JS 分支分支成闭区间；未知难度的题在设置区间后不显示（与原客户端行为一致）
  if (f.diffMin !== undefined || f.diffMax !== undefined) {
    where += ' AND p.difficulty IS NOT NULL';
    if (f.diffMin !== undefined) {
      where += ' AND p.difficulty >= ?';
      params.push(f.diffMin);
    }
    if (f.diffMax !== undefined) {
      where += ' AND p.difficulty <= ?';
      params.push(f.diffMax);
    }
  }
  // 标签：所选标签「逻辑或」——任一别名命中即保留
  if (f.tagAliases.length > 0) {
    where +=
      ' AND EXISTS (SELECT 1 FROM json_each(' + knowledgeTagsExpr() +
      ') je WHERE je.value IN (' + f.tagAliases.map(() => '?').join(', ') + '))';
    params.push(...f.tagAliases);
  }
  return { where, params };
}

/** 状态过滤：需在 COUNT/SUM 聚合之后判定 */
function statusHavingSql(status: StatusFilter): string {
  if (status === 'ac') return ' HAVING ac_count > 0';
  if (status === 'tried') return ' HAVING attempts > 0 AND ac_count = 0';
  if (status === 'none') return ' HAVING attempts = 0';
  return '';
}

/** 解析查询串为强类型过滤条件；非法值直接忽略（与原实现的宽松行为一致） */
function parseFilters(query: Record<string, unknown>): ProblemFilters {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  const num = (v: unknown): number | undefined => {
    if (typeof v !== 'string' || v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const out: ProblemFilters = {
    tagAliases: [],
    includeBank: query.bank === '1',
    status: 'all',
    unknownOnly: false,
  };
  const platform = str(query.platform);
  if (platform !== undefined) out.platform = platform;
  const q = str(query.q);
  if (q !== undefined && q.trim() !== '') out.q = q;

  // 难度：优先显式区间 diffMin/diffMax；其次兼容 bucket 名（difficulty=<1200 / 未知 等）
  let diffMin = num(query.diffMin);
  let diffMax = num(query.diffMax);
  let unknownOnly = false;
  const bucket = str(query.difficulty);
  if (bucket !== undefined) {
    if (bucket === '未知') {
      unknownOnly = true;
    } else {
      const range = DIFFICULTY_BUCKETS[bucket];
      if (range !== undefined) {
        // '<1200' 桶的下界取 0（difficulty 恒非负），使区间可下推为闭区间
        if (range.min !== null) diffMin = range.min;
        else diffMin = 0;
        if (range.max !== null) diffMax = range.max;
        else diffMax = undefined;
      }
    }
  }
  out.unknownOnly = unknownOnly;
  if (!unknownOnly) {
    if (diffMin !== undefined) out.diffMin = diffMin;
    if (diffMax !== undefined) out.diffMax = diffMax;
  }

  // 标签：单个 tag 参数或 tag 数组；展开同义别名后 OR 组合
  const raw = query.tag;
  const list: string[] = [];
  if (typeof raw === 'string' && raw !== '') list.push(raw);
  else if (Array.isArray(raw)) for (const t of raw) if (typeof t === 'string' && t !== '') list.push(t);
  const aliases = new Set<string>();
  for (const t of list) for (const name of expandTag(t)) aliases.add(name);
  out.tagAliases = [...aliases];

  const status = query.status;
  if (typeof status === 'string' && STATUS_FILTERS.has(status)) out.status = status as StatusFilter;
  return out;
}

export function problemsRoutes(db: Db, fetchFn: typeof fetch = fetch): Router {
  const r = Router();

  /** 共享的 SELECT/GROUP BY 骨架：标注侧先聚合成 pk 派生表，再 LEFT JOIN（消逐行子查询） */
  const coreFrom = `
      FROM problems p
      LEFT JOIN submissions s ON s.problem_id = p.id AND s.user_id = ?
      ${knowledgeTagsJoinSql()}
      WHERE 1 = 1
  `;
  const coreSelect = `
      SELECT p.id, p.platform, p.problem_key, p.title, p.difficulty, p.url,
             ${knowledgeTagsCoalesceSql()},
             COUNT(s.id) AS attempts,
             COALESCE(SUM(CASE WHEN s.verdict = 'AC' THEN 1 ELSE 0 END), 0) AS ac_count,
             MAX(CASE WHEN s.verdict = 'AC' THEN s.submitted_at END) AS last_ac_at
  `;
  /** 分页查询与计数查询共用的 FROM/WHERE（含未知难度分支），保证两者口径完全一致 */
  const filteredFrom = (f: ProblemFilters): { from: string; params: Array<string | number> } => {
    const { where, params } = buildProblemFilterSql(f);
    return {
      from: coreFrom + where + (f.unknownOnly ? ' AND p.difficulty IS NULL' : ''),
      params,
    };
  };

  /**
   * GET /api/problems?platform=&difficulty=&tag=&q=&bank=1
   * 兼容路径：不传 page/pageSize 时返回**数组**（掌握度地图等既有调用方依赖此形态）。
   * 题库页请改用 /api/problems/page（分页 + 总数），否则 1.9 万行会一次性传回。
   */
  r.get('/', (req, res) => {
    const { platform } = req.query;
    if (typeof platform === 'string' && !PLATFORMS.some((p) => p.id === platform)) {
      return res.status(400).json({ error: `platform 非法: ${String(platform)}` });
    }
    const filters = parseFilters(req.query as Record<string, unknown>);
    const { from, params } = filteredFrom(filters);
    const sql =
      `WITH ${problemKeypointsCte(db)} ` +
      coreSelect +
      from +
      ' GROUP BY p.id' +
      statusHavingSql(filters.status) +
      ' ORDER BY p.difficulty IS NULL, p.difficulty DESC, p.id DESC';
    const rows = db.prepare(sql).all(DEFAULT_USER_ID, ...params) as unknown as ProblemRow[];
    res.json(rows.map(toApiProblem));
  });

  /**
   * GET /api/problems/page?page=1&pageSize=50&...同上的过滤参数
   * 服务端分页：总数与当前页分两次查询（COUNT 走同一过滤条件但不取标注 JSON）。
   * 响应：{ items, total, page, pageSize, hasMore }
   */
  r.get('/page', (req, res) => {
    const { platform } = req.query;
    if (typeof platform === 'string' && !PLATFORMS.some((p) => p.id === platform)) {
      return res.status(400).json({ error: `platform 非法: ${String(platform)}` });
    }
    const filters = parseFilters(req.query as Record<string, unknown>);
    const pageSize = clampInt(req.query.pageSize, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const page = clampInt(req.query.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const offset = (page - 1) * pageSize;
    const { from, params } = filteredFrom(filters);

    const listSql =
      `WITH ${problemKeypointsCte(db)} ` +
      coreSelect +
      from +
      ' GROUP BY p.id' +
      statusHavingSql(filters.status) +
      ' ORDER BY p.difficulty IS NULL, p.difficulty DESC, p.id DESC LIMIT ? OFFSET ?';
    const items = db
      .prepare(listSql)
      .all(DEFAULT_USER_ID, ...params, pageSize, offset) as unknown as ProblemRow[];

    // COUNT 不取标注 JSON（标签过滤已下推到 WHERE），但必须保留 attempts/ac_count 两个
    // 聚合别名 —— statusHavingSql 的 HAVING 引用的正是它们，内层 SELECT 少了别名即报
    // "no such column: ac_count"
    const countSql =
      `WITH ${problemKeypointsCte(db)} ` +
      `SELECT COUNT(*) AS c FROM (SELECT p.id,` +
      ' COUNT(s.id) AS attempts,' +
      " COALESCE(SUM(CASE WHEN s.verdict = 'AC' THEN 1 ELSE 0 END), 0) AS ac_count" +
      from +
      ' GROUP BY p.id' +
      statusHavingSql(filters.status) +
      ')';
    const total = (db.prepare(countSql).get(DEFAULT_USER_ID, ...params) as { c: number }).c;

    res.json({
      items: items.map(toApiProblem),
      total,
      page,
      pageSize,
      hasMore: offset + items.length < total,
    });
  });

  /**
   * GET /api/problems/facets?...同上的过滤参数
   * 侧边栏徽标数据：难度分桶 / 平台分布 / 标签计数。
   * 全部由 SQL 聚合得出，不再要求前端持有全量行。
   */
  r.get('/facets', (req, res) => {
    const { platform } = req.query;
    if (typeof platform === 'string' && !PLATFORMS.some((p) => p.id === platform)) {
      return res.status(400).json({ error: `platform 非法: ${String(platform)}` });
    }
    const filters = parseFilters(req.query as Record<string, unknown>);
    const { from, params } = filteredFrom(filters);
    // 分面统计不带状态页签（页签是列表视图的局部条件），故不套用 statusHavingSql
    const sql =
      `WITH ${problemKeypointsCte(db)} ` +
      `SELECT p.id, p.platform AS platform, p.difficulty AS difficulty, ${knowledgeTagsCoalesceSql()} ` +
      from +
      ' GROUP BY p.id';
    const rows = db.prepare(sql).all(DEFAULT_USER_ID, ...params) as unknown as Array<{
      id: number;
      platform: PlatformId;
      difficulty: number | null;
      tags: string;
    }>;

    const difficulty: Record<string, number> = {};
    for (const key of Object.keys(DIFFICULTY_BUCKETS)) difficulty[key] = 0;
    const platformCounts: Record<string, number> = {};
    for (const p of PLATFORMS) platformCounts[p.id] = 0;
    const tagCounts = new Map<string, number>();
    for (const row of rows) {
      difficulty[bucketName(row.difficulty)] += 1;
      platformCounts[row.platform] = (platformCounts[row.platform] ?? 0) + 1;
      // 与客户端侧边栏同口径：先滤噪声标签，再归并到规范名，同题内去重后计数
      const tags = new Set(filterNoiseTags(safeTags(row.tags)).map((t) => canonicalTag(t)));
      for (const t of tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
    res.json({
      total: rows.length,
      difficulty,
      platforms: PLATFORMS.map((p) => ({ id: p.id, name: p.name, count: platformCounts[p.id] ?? 0 })),
      tags: [...tagCounts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    });
  });

  // POST /api/problems/bank  body: { platform: 'luogu' | 'nowcoder' | 'codeforces' | 'leetcode' | 'atcoder' | 'daimayuan' | 'jisuanke', max?, luoguMinDifficulty? }
  // 拉取公开题库入库（匿名可访问），扩充待选题目池（不产生提交记录）。
  // codeforces / atcoder 为单次 API 调用（全量），通常仅在刷新内置快照后的新题时使用。
  r.post('/bank', asyncHandler(async (req, res) => {
    const { platform, max, luoguMinDifficulty } = req.body ?? {};
    if (
      platform !== 'luogu' && platform !== 'nowcoder' &&
      platform !== 'codeforces' && platform !== 'leetcode' &&
      platform !== 'atcoder' && platform !== 'daimayuan' &&
      platform !== 'jisuanke'
    ) {
      return res.status(400).json({ error: 'platform 需为 luogu / nowcoder / codeforces / leetcode / atcoder / daimayuan / jisuanke' });
    }
    const maxCap = platform === 'codeforces' ? 20000 : platform === 'atcoder' ? 10000 : 5000;
    const maxN =
      typeof max === 'number' && Number.isFinite(max)
        ? Math.min(maxCap, Math.max(50, Math.floor(max)))
        : platform === 'codeforces'
          ? 20000
          : platform === 'atcoder'
            ? 5000
            : 2000;
    const minDiff =
      typeof luoguMinDifficulty === 'number' && Number.isFinite(luoguMinDifficulty)
        ? luoguMinDifficulty
        : undefined;
    try {
      const fetcher =
        platform === 'luogu'
          ? fetchLuoguBank
          : platform === 'nowcoder'
            ? fetchNowcoderBank
            : platform === 'leetcode'
              ? fetchLeetcodeBank
              : platform === 'atcoder'
                ? fetchAtcoderBank
            : platform === 'daimayuan'
              ? fetchDaimayuanBank
              : platform === 'jisuanke'
                ? fetchJisuankeBank
                : fetchCodeforcesBank;
      const result = await fetcher(fetchFn, { max: maxN, ...(minDiff !== undefined ? { luoguMinDifficulty: minDiff } : {}) });
      const imported = upsertBankProblems(db, result.problems);
      res.json({
        ok: true,
        platform,
        total: result.total,
        fetched: result.problems.length,
        inserted: imported[0]?.inserted ?? 0,
        updated: imported[0]?.updated ?? 0,
      });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  }));

  // POST /api/problems/clean-tags
  // 物理清洗库内所有题目的标签（历史数据修复操作）：
  // - 归并：英文别名 → 规范名（dp → 动态规划、binary search → 二分查找），并去重
  // - 过滤：噪声标签（年份/赛事/地区/题型事务等非算法维度）
  // 注：新写入路径已「写入即净化」（见 import/problemWritePolicy.ts purifyTags），
  // 新入库的题再跑本接口结果不变（幂等）；保留它只为修复引入净化前遗留的历史数据。
  r.post('/clean-tags', asyncHandler(async (_req, res) => {
    const rows = db.prepare('SELECT id, tags FROM problems').all() as Array<{ id: number; tags: string }>;
    const update = db.prepare('UPDATE problems SET tags = ? WHERE id = ?');
    let problemsCleaned = 0;
    let tagsRemoved = 0;
    db.exec('BEGIN');
    try {
      for (const row of rows) {
        const raw = safeTags(row.tags);
        const next = [...new Set(filterNoiseTags(raw).map((t) => canonicalTag(t)))];
        if (JSON.stringify(next) !== JSON.stringify(raw)) {
          tagsRemoved += raw.length - next.length;
          update.run(JSON.stringify(next), row.id);
          problemsCleaned += 1;
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    res.json({ ok: true, total: rows.length, problemsCleaned, tagsRemoved });
  }));

  // POST /api/problems/backfill-difficulty
  // 对库内未知难度的洛谷/牛客题逐题查询公开接口回填（匿名可访问）：
  // - 牛客顺带修复标题污染/空标签（题库搜索接口返回分离的标题与算法标签）
  // - CF 未知难度题为 gym/官方 Unrated 比赛，官方无 rating，不参与回填
  // 耗时与待补题数成正比（牛客 ~0.5s/题），大库时前端需提示等待
  r.post('/backfill-difficulty', asyncHandler(async (_req, res) => {
    try {
      const results = await backfillDifficulties(db, fetchFn);
      const unknownLeft = (
        db.prepare('SELECT COUNT(*) AS c FROM problems WHERE difficulty IS NULL').get() as { c: number }
      ).c;
      res.json({ ok: true, results, unknownLeft });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  }));

  /** 合法的卡点性质（与 client 的选项一一对应） */
  const INTENT_OUTCOMES = new Set(['cant_start', 'wrong_approach', 'implementation', 'slight_bug']);

  // POST /api/problems/:platform/:key/intent
  // body: { outcome: 'cant_start'|'wrong_approach'|'implementation'|'slight_bug', code?: string }
  // 记录用户自述的卡点。code 可省略（= 非知识点摩擦）。
  r.post('/:platform/:key/intent', (req, res) => {
    const { platform, key } = req.params;
    if (!PLATFORMS.some((p) => p.id === platform)) {
      return res.status(400).json({ error: `platform 非法: ${platform}` });
    }
    const outcome = req.body?.outcome;
    if (typeof outcome !== 'string' || !INTENT_OUTCOMES.has(outcome)) {
      return res.status(400).json({ error: 'outcome 需为 cant_start / wrong_approach / implementation / slight_bug' });
    }
    const rawCode = req.body?.code;
    if (rawCode !== undefined && rawCode !== null && rawCode !== '') {
      if (typeof rawCode !== 'string' || !isValidCode(rawCode)) {
        return res.status(400).json({ error: `code 非法: ${String(rawCode)}` });
      }
    }
    const code = typeof rawCode === 'string' && rawCode !== '' ? rawCode : null;

    const problem = db
      .prepare('SELECT id FROM problems WHERE platform = ? AND problem_key = ?')
      .get(platform, key) as { id: number } | undefined;
    if (!problem) return res.status(404).json({ error: '题目不存在：请先同步或导入该题' });

    const info = db
      .prepare('INSERT INTO submission_intents (user_id, problem_id, code, outcome) VALUES (?, ?, ?, ?)')
      .run(DEFAULT_USER_ID, problem.id, code, outcome);
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });

  // GET /api/problems/:platform/:key/intents → 该题的卡点记录（时间倒序）
  r.get('/:platform/:key/intents', (req, res) => {
    const { platform, key } = req.params;
    const rows = db
      .prepare(
        `SELECT i.code, i.outcome, i.created_at AS createdAt
           FROM submission_intents i JOIN problems p ON p.id = i.problem_id
          WHERE i.user_id = ? AND p.platform = ? AND p.problem_key = ?
          ORDER BY i.created_at DESC, i.id DESC`,
      )
      .all(DEFAULT_USER_ID, platform, key);
    res.json({ items: rows });
  });

  return r;
}

/** 难度值 → 分桶名（与客户端 DIFF_BUCKETS 一致） */
function bucketName(difficulty: number | null): string {
  if (difficulty === null) return '未知';
  if (difficulty < 1200) return '<1200';
  if (difficulty < 1400) return '1200-1399';
  if (difficulty < 1600) return '1400-1599';
  if (difficulty < 1900) return '1600-1899';
  if (difficulty < 2200) return '1900-2199';
  return '2200+';
}

/** 行 → API 形态（tags 反序列化 + 派生 status） */
function toApiProblem(r: ProblemRow): Omit<ProblemRow, 'tags'> & { tags: string[]; status: 'ac' | 'tried' | 'none' } {
  return {
    ...r,
    tags: safeTags(r.tags),
    status: r.ac_count > 0 ? 'ac' : r.attempts > 0 ? 'tried' : 'none',
  };
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

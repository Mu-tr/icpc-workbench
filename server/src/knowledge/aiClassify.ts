/**
 * L2 AI 批量分类：补 L1 规则未命中的覆盖。
 * 红线（「不信题源 tag」的落地）：输入只有题目标题 + 难度 + taxonomy 候选清单，
 * 绝不给题源 tag。
 * 四道闸：JSON 围栏清洗 → schema 校验 → taxonomy 白名单（幻觉 code 丢弃记审计）
 * → 置信度阈值（统计端过滤低置信）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AiProvider, ChatMessage } from '../ai/provider.ts';
import type { Db } from '../db/index.ts';
import type { PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import { allPoints, isValidCode } from './taxonomy.ts';
import {
  commitAiAnnotations,
  fetchAiBatch,
  markBatchRetry,
  pendingAiCount,
  MAX_ATTEMPTS,
} from './pipeline.ts';
import { effectiveDataDir, type AnnotationWrite } from './store.ts';

export const AI_BATCH_SIZE = 25;
/** 无 Key 导出通道单包题数（手工喂 AI 的实际批量） */
export const EXPORT_BATCH_SIZE = 50;

const ALL_PLATFORM_IDS = new Set<string>(PLATFORMS.map((p) => p.id));

interface BatchProblem {
  platform: string;
  problemKey: string;
  title: string;
  difficulty: number | null;
}

/** 题目复合身份：problemKey 仅平台内唯一（洛谷 1001 与 Codeforces 1001 是两道题），跨平台必须带平台 */
export function problemIdentity(platform: string, problemKey: string): string {
  return `${platform}|${problemKey}`;
}

export interface AiClassifyItem {
  /**
   * AI 返回的题目标识。新格式为复合身份 `platform|problemKey`；
   * 老格式（升级前导出的数据包 / 用户手搓 JSON）是裸题号，需经队列回查消歧。
   */
  ref: string;
  codes: string[];
  confidence: number;
}

export interface ValidatedBatch {
  writes: AnnotationWrite[];
  uncertain: Array<{ platform: string; problemKey: string }>;
  /** 幻觉 code 审计：AI 返回了 taxonomy 中不存在的 code */
  droppedHallucinations: Array<{ problemKey: string; code: string }>;
  /**
   * 歧义标识审计：AI 只给了裸题号，而批次内（或整个队列中）有多道题共用该题号。
   * 此时宁可标 uncertain 也不猜——猜错会把知识点贴到另一平台的题上。
   */
  ambiguous: Array<{ ref: string; candidates: string[] }>;
}

// ---------- 提示词 ----------

function taxonomyDigest(): string {
  return allPoints()
    .map((p) => `${p.code} ${p.name}`)
    .join('\n');
}

/** 构造分类请求消息：system 给 taxonomy 候选清单与输出 schema，user 给题目批次；
 *  correction 非空时追加纠正指令（上一轮零进展后的自动重试用） */
export function buildClassifyMessages(batch: BatchProblem[], correction?: string): ChatMessage[] {
  const system = [
    '你是算法竞赛题目的知识点标注员。根据每道题的「标题 + 难度」判断它考察的知识点。',
    '只能从下面的知识点清单中选择 code，禁止编造清单外的 code；拿不准的题返回空 codes（宁缺毋滥）。',
    '一题可以有多个知识点（如实标注，如「二分答案 + 贪心」），按把握从高到低排列。',
    '只输出 JSON，不要输出任何解释。输出格式：',
    '{"results":[{"id":"平台|题号","codes":["code1","code2"],"confidence":0.0}]}',
    'id 必须原样回抄输入里给出的 id（形如 luogu|P1001），不要改写、不要只回题号——',
    '不同平台存在相同题号的题目，只回题号会导致标注贴错题。',
    '示例：输入含 {"id":"codeforces|1900C",…}，输出就必须写作 {"results":[{"id":"codeforces|1900C","codes":[…],"confidence":0.8}]}（id 与输入逐字一致，含平台前缀）。',
    'confidence 为 0-1 的把握程度。',
    '',
    '知识点清单（code 名称）：',
    taxonomyDigest(),
    ...(correction ? ['', `[重要纠正] ${correction}`] : []),
  ].join('\n');
  const user = JSON.stringify(
    batch.map((b) => ({
      id: problemIdentity(b.platform, b.problemKey),
      title: b.title,
      difficulty: b.difficulty,
    })),
  );
  return [
    { role: 'system', content: system },
    { role: 'user', content: `请标注以下 ${batch.length} 道题：\n${user}` },
  ];
}

// ---------- 输出清洗与校验 ----------

/**
 * JSON 围栏清洗：去任意位置 ``` 围栏 + 括号配对截取首个完整 JSON 对象。
 * 模型常在 JSON 后追加解释文字（"以上是标注结果…"），截到末尾会 parse 失败，
 * 必须按字符串感知的括号配对截到首个对象的右括号；未闭合（输出被截断）时
 * 返回首个 { 到末尾，交由 JSON.parse 报「批次失败」。
 */
export function cleanJsonText(raw: string): string {
  let text = raw.trim();
  if (text.includes('```')) {
    text = text.replace(/```[a-zA-Z]*\s*/g, '').trim();
  }
  const start = text.indexOf('{');
  if (start === -1) return text;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

/** 解析 AI 返回的 JSON；结构不合法时抛错（调用方按批次失败处理） */
export function parseClassifyResponse(raw: string): AiClassifyItem[] {
  const obj = JSON.parse(cleanJsonText(raw)) as { results?: unknown };
  if (!obj || !Array.isArray(obj.results)) {
    throw new Error('AI 返回缺少 results 数组');
  }
  const items: AiClassifyItem[] = [];
  for (const r of obj.results as Array<Record<string, unknown>>) {
    // 兼容两种标识：新格式 id（复合身份）/ 老格式 problemKey（裸题号）
    const ref = typeof r?.id === 'string' ? r.id : typeof r?.problemKey === 'string' ? r.problemKey : null;
    if (ref === null || ref.trim() === '') continue;
    const codes = Array.isArray(r.codes) ? r.codes.filter((c): c is string => typeof c === 'string') : [];
    const confidence =
      typeof r.confidence === 'number' && Number.isFinite(r.confidence)
        ? Math.min(1, Math.max(0, r.confidence))
        : 0.6;
    items.push({ ref: ref.trim(), codes, confidence });
  }
  return items;
}

/** 解析复合身份 `platform|problemKey`；非复合格式返回 null。
 *  容忍模型回抄时的小错：平台名大小写不一（Luogu/luogu）、分隔符两侧夹空格。 */
function parseIdentity(ref: string, validPlatforms: ReadonlySet<string>): { platform: string; problemKey: string } | null {
  const idx = ref.indexOf('|');
  if (idx <= 0) return null;
  const platform = ref.slice(0, idx).trim();
  const problemKey = ref.slice(idx + 1).trim();
  if (problemKey === '') return null;
  const lower = new Map([...validPlatforms].map((p) => [p.toLowerCase(), p]));
  const canonical = lower.get(platform.toLowerCase());
  if (!canonical) return null;
  return { platform: canonical, problemKey };
}

/**
 * 校验一批 AI 结果：标识须能唯一落到批次内的题（复合身份直查；裸题号须在批内唯一，
 * 多义则记 ambiguous 且不猜）；code 白名单校验（幻觉丢弃）；清洗后无 code 的题标 uncertain。
 */
export function validateItems(
  items: AiClassifyItem[],
  batch: BatchProblem[],
  opts: { validPlatforms?: ReadonlySet<string> } = {},
): ValidatedBatch {
  const platforms = opts.validPlatforms ?? new Set(batch.map((b) => b.platform));
  const byIdentity = new Map(batch.map((b) => [problemIdentity(b.platform, b.problemKey), b]));
  // 裸题号反查：同题号命中多题 = 歧义，不得任选
  const byBareKey = new Map<string, BatchProblem[]>();
  for (const b of batch) {
    const list = byBareKey.get(b.problemKey);
    if (list) list.push(b);
    else byBareKey.set(b.problemKey, [b]);
  }

  const answered = new Set<string>();
  const writes: AnnotationWrite[] = [];
  const droppedHallucinations: ValidatedBatch['droppedHallucinations'] = [];
  const ambiguous: ValidatedBatch['ambiguous'] = [];

  for (const item of items) {
    let problem: BatchProblem | undefined;
    const direct = parseIdentity(item.ref, platforms);
    if (direct) {
      problem = byIdentity.get(problemIdentity(direct.platform, direct.problemKey));
    } else {
      const candidates = byBareKey.get(item.ref) ?? [];
      if (candidates.length > 1) {
        // 只给了裸题号且批内重名：记审计、标 uncertain，绝不猜平台
        ambiguous.push({ ref: item.ref, candidates: candidates.map((c) => problemIdentity(c.platform, c.problemKey)) });
        for (const c of candidates) answered.add(problemIdentity(c.platform, c.problemKey));
        continue;
      }
      problem = candidates[0];
    }
    if (!problem) continue; // AI 返回了批次外的标识：丢弃
    const id = problemIdentity(problem.platform, problem.problemKey);
    answered.add(id);

    const codes = [...new Set(item.codes)].filter((code) => {
      const ok = isValidCode(code);
      if (!ok) droppedHallucinations.push({ problemKey: id, code });
      return ok;
    });
    if (codes.length === 0) continue; // 全被丢弃或本就为空 → 落入 uncertain 兜底
    writes.push({
      platform: problem.platform,
      problemKey: problem.problemKey,
      source: 'ai',
      points: codes.map((code, i) => ({
        code,
        // 多 code 时按排序略降置信（AI 按把握排序输出），最低 0.35。
        // 下限刻意低于统计阈值 0.6：多知识点题的第 2、3 个点不再被"托底"到阈值之上，
        // 阈值闸门才真正具备过滤能力（原下限 0.5 与规则最低置信 0.6 挤在一起，闸门形同虚设）。
        confidence: Math.max(0.35, Math.round((item.confidence - i * 0.05) * 100) / 100),
        method: 'ai',
      })),
      // 标题指纹：AI 标注同样记录标注当时的标题，标题修复后据此判定陈旧并回队重标
      title: problem.title,
    });
  }

  const uncertain = batch
    .filter((b) => !answered.has(problemIdentity(b.platform, b.problemKey)))
    .map((b) => ({ platform: b.platform, problemKey: b.problemKey }));
  return { writes, uncertain, droppedHallucinations, ambiguous };
}

// ---------- 审计日志 ----------

interface AuditEntry {
  at: string;
  kind: 'hallucination' | 'batch-failed' | 'uncertain' | 'ambiguous';
  detail: unknown;
}

/** 审计日志：幻觉 code / 批次失败 / uncertain，追加写 knowledge/audit.jsonl */
export function appendAudit(dataDir: string | null, entries: AuditEntry[]): void {
  if (!dataDir || entries.length === 0) return;
  const file = path.join(dataDir, 'knowledge', 'audit.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

// ---------- 批跑（断点续跑：队列在库内，中断后 pending 残留，下次继续） ----------

export interface AiPassResult {
  batches: number;
  annotated: number;
  uncertain: number;
  /** 本批失败（网络/解析），剩余 pending 可下次续跑 */
  failedBatch?: string;
  /** 失败批中本轮已推到队尾待重试的题数 */
  retried?: number;
  /** 失败批中已达到重试上限、转为 failed 出队的题数（可用 retryFailedQueue 捞回） */
  gaveUp?: number;
  /**
   * 本轮因「整批都无法唯一定位题目」（模型始终不回抄「平台|题号」且纠正重试无效）
   * 而整批转 uncertain（人工校正池）出队的题数。出队放行后续队列，不再卡死整条管线。
   */
  demoted?: number;
  /** 预留兼容字段：旧版在整批无法定位时直接中止并置位；现改为纠正重试+转存疑出队，不再中止 */
  stalled?: boolean;
  remaining: number;
}

/** 纠正重试的提示：明确告知上一轮 id 回抄失败，要求逐字回抄 */
const RETRY_HINT =
  '你上一轮的返回无法定位题目：id 没有带「平台|题号」前缀（或平台名与输入不符），导致整批标注作废。' +
  '请重新标注这一批，id 必须逐字回抄输入给出的 id（例如 luogu|P1001），绝不能只写题号。';

/** 批次是否零进展：既没写库也没标存疑（如整批 ambiguous / 整批幻觉 code），队列长度不变 */
function isNoProgress(v: ValidatedBatch): boolean {
  return v.writes.length === 0 && v.uncertain.length === 0;
}

export async function runAiPass(
  db: Db,
  provider: AiProvider,
  opts: {
    dataDir?: string | null;
    batchSize?: number;
    maxBatches?: number;
    maxAttempts?: number;
    signal?: AbortSignal;
  } = {},
): Promise<AiPassResult> {
  const batchSize = opts.batchSize ?? AI_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? Number.MAX_SAFE_INTEGER;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const dataDir = effectiveDataDir(opts.dataDir);
  let batches = 0;
  let annotated = 0;
  let uncertainTotal = 0;
  let demoted = 0;

  while (batches < maxBatches) {
    const batch = fetchAiBatch(db, batchSize);
    if (batch.length === 0) break;
    let items: AiClassifyItem[];
    let validated: ValidatedBatch;
    try {
      const chatOpts = {
        temperature: 0.1,
        maxTokens: 4096,
        ...(opts.signal ? { signal: opts.signal } : {}),
      };
      items = parseClassifyResponse(await provider.chat(buildClassifyMessages(batch), chatOpts));
      validated = validateItems(items, batch);
      if (isNoProgress(validated)) {
        // 零进展（典型：模型只回裸题号且批内同题号跨平台重名）：带纠正信息自动重试一次，
        // 给模型一次改正机会，不消耗额外批次数
        items = parseClassifyResponse(await provider.chat(buildClassifyMessages(batch, RETRY_HINT), chatOpts));
        validated = validateItems(items, batch);
      }
    } catch (e) {
      // 批次失败：整批记一次失败并把队尾挪到后面（不直接标 failed，避免网络抖动把题打死），
      // 然后中止本次批跑——下一轮从队首取到的是**下一批**，不会每轮卡死在同 25 题上。
      const message = (e as Error).message;
      const outcome = markBatchRetry(
        db,
        batch.map((b) => ({ platform: b.platform, problemKey: b.problemKey })),
        message,
        maxAttempts,
      );
      appendAudit(dataDir, [
        {
          at: new Date().toISOString(),
          kind: 'batch-failed',
          detail: { size: batch.length, error: message, ...outcome },
        },
      ]);
      return {
        batches,
        annotated,
        uncertain: uncertainTotal,
        failedBatch: message,
        retried: outcome.retried,
        gaveUp: outcome.failed,
        remaining: pendingAiCount(db),
      };
    }
    appendAudit(dataDir, [
      ...validated.droppedHallucinations.map((d) => ({
        at: new Date().toISOString(),
        kind: 'hallucination' as const,
        detail: d,
      })),
      ...validated.ambiguous.map((a) => ({
        at: new Date().toISOString(),
        kind: 'ambiguous' as const,
        detail: a,
      })),
      ...validated.uncertain.map((u) => ({
        at: new Date().toISOString(),
        kind: 'uncertain' as const,
        detail: u,
      })),
    ]);
    if (isNoProgress(validated)) {
      // 纠正重试后仍零进展：不再中止整条管线（旧版在这里 stalled 收手，但队列顺序未变，
      // 下次重跑取到的还是同一批 25 题 → 永久卡死）。整批转 uncertain 人工校正池出队，
      // 放行后续队列；审计已记下 ambiguous 明细，人工可据此校正。
      const demotedList = batch.map((b) => ({ platform: b.platform, problemKey: b.problemKey }));
      const at = new Date().toISOString();
      appendAudit(dataDir, [
        {
          at,
          kind: 'batch-failed',
          detail: {
            size: demotedList.length,
            error: '整批无法唯一定位（模型未回抄「平台|题号」，纠正重试无效），已整批转存疑待人工校正',
          },
        },
        ...demotedList.map((u) => ({ at, kind: 'uncertain' as const, detail: u })),
      ]);
      commitAiAnnotations(db, [], demotedList, { dataDir });
      batches += 1;
      demoted += demotedList.length;
      uncertainTotal += demotedList.length;
      continue;
    }
    commitAiAnnotations(db, validated.writes, validated.uncertain, { dataDir });
    batches += 1;
    annotated += validated.writes.length;
    uncertainTotal += validated.uncertain.length;
  }
  return { batches, annotated, uncertain: uncertainTotal, demoted, remaining: pendingAiCount(db) };
}

// ---------- 无 Key 导出通道（下载数据包手动喂 AI，粘贴回 JSON 入库） ----------

/** 导出待标注题目 + 提示词（markdown），供无 Key 用户手动喂任意 AI */
export function exportQueuePackage(db: Db, limit = EXPORT_BATCH_SIZE): string {
  const batch = fetchAiBatch(db, limit);
  const messages = buildClassifyMessages(batch);
  return [
    '# 知识点标注数据包',
    '',
    `待标注 ${batch.length} 题。把下面两段消息原样发给任意 AI，将返回的 JSON 粘贴回「题目管理 → 知识点管线 → 导入 AI 标注」。`,
    '',
    '## System',
    '',
    messages[0].content as string,
    '',
    '## User',
    '',
    messages[1].content as string,
    '',
  ].join('\n');
}

/**
 * 导入手动喂 AI 得到的 JSON 结果（与 L2 同校验同落库，source=ai method=ai:manual-import）。
 * 标识消歧：复合身份（platform|problemKey）直查 problems；裸题号（老数据包）回查队列，
 * 同题号多平台命中时**全部放进批次**交给 validateItems 记 ambiguous，不猜平台。
 */
export function importAiResults(
  db: Db,
  raw: string,
  opts: { dataDir?: string | null } = {},
): { annotated: number; uncertain: number; droppedHallucinations: number; ambiguous: number } {
  const items = parseClassifyResponse(raw);
  const findByIdentity = db.prepare(
    `SELECT p.platform, p.problem_key AS problemKey, p.title, p.difficulty
     FROM problems p WHERE p.platform = ? AND p.problem_key = ?`,
  );
  const findQueued = db.prepare(
    `SELECT q.platform, q.problem_key AS problemKey, p.title, p.difficulty
     FROM knowledge_queue q JOIN problems p ON p.platform = q.platform AND p.problem_key = q.problem_key
     WHERE q.problem_key = ?`,
  );
  const batch: BatchProblem[] = [];
  const seen = new Set<string>();
  const push = (rows: BatchProblem[]): void => {
    for (const row of rows) {
      const id = problemIdentity(row.platform, row.problemKey);
      if (seen.has(id)) continue;
      seen.add(id);
      batch.push(row);
    }
  };
  for (const item of items) {
    // 与批跑同一套容忍解析（平台大小写 / 空格）；裸题号回查队列
    const identity = parseIdentity(item.ref, ALL_PLATFORM_IDS);
    if (identity) {
      push(findByIdentity.all(identity.platform, identity.problemKey) as unknown as BatchProblem[]);
    } else {
      push(findQueued.all(item.ref) as unknown as BatchProblem[]);
    }
  }
  const validated = validateItems(items, batch);
  // method 标记为人工导入通道
  for (const w of validated.writes) {
    for (const p of w.points) p.method = 'ai:manual-import';
  }
  const dataDir = effectiveDataDir(opts.dataDir);
  appendAudit(
    dataDir,
    [
      ...validated.droppedHallucinations.map((d) => ({
        at: new Date().toISOString(),
        kind: 'hallucination' as const,
        detail: d,
      })),
      ...validated.ambiguous.map((a) => ({
        at: new Date().toISOString(),
        kind: 'ambiguous' as const,
        detail: a,
      })),
    ],
  );
  commitAiAnnotations(db, validated.writes, [], { dataDir });
  return {
    annotated: validated.writes.length,
    uncertain: validated.uncertain.length,
    droppedHallucinations: validated.droppedHallucinations.length,
    ambiguous: validated.ambiguous.length,
  };
}

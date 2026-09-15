// 平台难度 → Codeforces rating 统一标尺的**唯一真源**。
// 每张表都在注释里标注实测依据与样本量（详见 docs/superpowers/specs/2026-09-15-...-design.md §2）。
// 平台改档（如洛谷 2026-06 难度体系调整）时只改本文件。
import type { PlatformId } from './index.ts';

/** CF rating 取值域：CF 题库实际范围（800–3500，步长 100） */
export const CF_RATING_MIN = 800;
export const CF_RATING_MAX = 3500;

export type DifficultyScale =
  | 'cf-rating'
  | 'luogu-2026-06'
  | 'atcoder-kenkoooo-irt'
  | 'nowcoder-score'
  | 'leetcode-tier'
  | 'jisuanke-level-8'
  | 'hydro-1-10'
  | 'none';

export interface DifficultyParse {
  rating: number | null;
  label: string | null;
  scale: DifficultyScale;
  /** 平台原生难度原文（去空白）；未知为 null */
  native: string | null;
}

function clampRating(n: number): number {
  return Math.min(CF_RATING_MAX, Math.max(CF_RATING_MIN, Math.round(n)));
}

/** 洛谷官方难度枚举（`/_lfe/config` → `ProblemDifficulty`，2026-06 版）：0=暂无评定，1..8 有名 */
export const LUOGU_LEVEL_NAMES: Readonly<Record<number, string>> = {
  1: '入门', 2: '普及−', 3: '普及', 4: '普及+/提高−',
  5: '提高', 6: '提高+/省选−', 7: '省选/NOI−', 8: 'NOI/NOI+/CTS',
};

/**
 * 洛谷档位 → CF rating。
 * 实测：洛谷 `problem/list?type=CF`（10984 道 CF 镜像题）× CF API `problemset.problems`，737 对配对，
 * 各档中位数 = 800/1000/1500/1800/2200/2400/2600/3400；与官方公布区间自洽
 * （青 提高 ≈ CF2000-2400、蓝 ≈ 2300-2700、紫 ≈ 2700-3100）。
 * 注意：洛谷官方称其难度定义为「临时」，且黑题拆分已在计划中 → 不得把 8 写死为档数上限以外的假设。
 */
export const LUOGU_LEVEL_TO_RATING: Readonly<Record<number, number>> = {
  1: 800, 2: 1000, 3: 1500, 4: 1800, 5: 2200, 6: 2400, 7: 2600, 8: 3400,
};

/** 计蒜客 8 档（app.js i18n `difficultyType`；档位名与洛谷同源，英文为 CF 称号） */
export const JISUANKE_LEVEL_NAMES: Readonly<Record<number, string>> = {
  1: '入门', 2: '普及−', 3: '普及', 4: '普及+/提高−',
  5: '提高', 6: '提高+', 7: '省选', 8: '国赛',
};
/** 计蒜客档位名与洛谷一一对应，故直接复用同一实测表（通过率交叉校验一致，见 spec §2.4） */
export const JISUANKE_LEVEL_TO_RATING: Readonly<Record<number, number>> = LUOGU_LEVEL_TO_RATING;

/**
 * AtCoder：社区模型 kenkoooo `problem-models.json` 的 IRT difficulty → CF rating。
 * 实测桥（349 对）：洛谷 `type=AT` 镜像题（8098 题）× kenkoooo，各洛谷档的 kenkoooo 中位数与其
 * CF 中位数对齐 → 锚点表。**不是加常数**：低段差约 +550、中段约 +100、高段趋于相等。
 */
export const ATCODER_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [-386, 800], [451, 1000], [973, 1500], [1545, 1800],
  [2107, 2200], [2325, 2400], [2653, 2600], [3392, 3400],
];

export function atcoderThetaToRating(theta: number): number {
  if (!Number.isFinite(theta)) return CF_RATING_MIN;
  const first = ATCODER_ANCHORS[0];
  const last = ATCODER_ANCHORS[ATCODER_ANCHORS.length - 1];
  if (theta <= first[0]) return clampRating(first[1]);
  // 超出最后一个锚点：沿最后一段斜率外推后再钳到 CF 上限（spec §2.3「超出两端钳到 800/3500」）。
  // 不能直接返回 last[1]（=3400）——那样 θ>3392 的题会全停在 3400，永远取不到 CF 上限档。
  if (theta >= last[0]) {
    const [x0, y0] = ATCODER_ANCHORS[ATCODER_ANCHORS.length - 2];
    const t = (theta - x0) / (last[0] - x0);
    return clampRating(y0 + t * (last[1] - y0));
  }
  for (let i = 1; i < ATCODER_ANCHORS.length; i += 1) {
    const [x0, y0] = ATCODER_ANCHORS[i - 1];
    const [x1, y1] = ATCODER_ANCHORS[i];
    if (theta <= x1) {
      const t = (theta - x0) / (x1 - x0);
      return clampRating(y0 + t * (y1 - y0));
    }
  }
  return clampRating(last[1]);
}

/** 力扣三级难度 → CF rating（面试导向，启发式；无官方对照表） */
export const LEETCODE_TIER_TO_RATING: Readonly<Record<string, number>> = {
  easy: 1000, medium: 1500, hard: 2100,
};

/** 代码源（Hydro）1-10 难度 → CF rating：站内相对难度（AC 率 × 提交量），启发式 ±200 */
export const HYDRO_LEVEL_TO_RATING: Readonly<Record<number, number>> = {
  1: 800, 2: 900, 3: 1000, 4: 1200, 5: 1400,
  6: 1600, 7: 1800, 8: 2000, 9: 2200, 10: 2400,
};

/** 牛客难度分（平台自评、与 CF 同量纲；实测 200–3700，新题可能为空） */
export function nowcoderScoreToRating(raw: number): number | null {
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return clampRating(raw);
}

function toNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function parseNativeDifficulty(platform: PlatformId, raw: unknown): DifficultyParse {
  const nativeText =
    raw === null || raw === undefined || raw === '' ? null : String(raw).trim() === '' ? null : String(raw).trim();
  const none: DifficultyParse = { rating: null, label: null, scale: 'none', native: nativeText };

  switch (platform) {
    case 'codeforces': {
      const n = toNumber(raw);
      return { rating: n === null ? null : clampRating(n), label: n === null ? null : String(n), scale: 'cf-rating', native: nativeText };
    }
    case 'luogu': {
      const n = toNumber(raw);
      if (n === null || n <= 0) return { rating: null, label: null, scale: 'luogu-2026-06', native: nativeText };
      const rating = LUOGU_LEVEL_TO_RATING[n] ?? null;
      return { rating, label: LUOGU_LEVEL_NAMES[n] ?? null, scale: 'luogu-2026-06', native: nativeText };
    }
    case 'jisuanke': {
      // 题库接口返回 `levelN` 字符串；整数档位一并接受（渠道差异与旧调用点兼容，属健壮性兜底）
      const s = typeof raw === 'number' ? '' : String(raw ?? '').trim();
      const level =
        typeof raw === 'number' && Number.isInteger(raw) ? raw : Number(/^level(\d+)$/i.exec(s)?.[1] ?? NaN);
      const rating = Number.isInteger(level) ? JISUANKE_LEVEL_TO_RATING[level] ?? null : null;
      return {
        rating,
        label: Number.isInteger(level) ? JISUANKE_LEVEL_NAMES[level] ?? null : null,
        scale: 'jisuanke-level-8',
        native: nativeText,
      };
    }
    case 'atcoder': {
      const n = toNumber(raw);
      return {
        rating: n === null ? null : atcoderThetaToRating(n),
        label: n === null ? null : String(Math.round(n)),
        scale: 'atcoder-kenkoooo-irt',
        native: nativeText,
      };
    }
    case 'nowcoder': {
      const n = toNumber(raw);
      const rating = n === null ? null : nowcoderScoreToRating(n);
      return { rating, label: n === null ? null : String(n), scale: 'nowcoder-score', native: nativeText };
    }
    case 'leetcode': {
      const key = String(raw ?? '').trim().toLowerCase();
      const rating = LEETCODE_TIER_TO_RATING[key] ?? null;
      const zh = key === 'easy' ? '简单' : key === 'medium' ? '中等' : key === 'hard' ? '困难' : null;
      return { rating, label: zh, scale: 'leetcode-tier', native: nativeText };
    }
    case 'daimayuan': {
      const n = toNumber(raw);
      // Hydro 难度域就是 1-10（站点 slider 上限 10）：越界值（>10，含 10.5 这类小数）
      // 不钳到第 10 档，按项目规则「未知一律 null，不猜」处理。
      if (n === null || n <= 0 || n > 10) return { rating: null, label: null, scale: 'hydro-1-10', native: nativeText };
      const level = Math.round(n);
      return {
        rating: HYDRO_LEVEL_TO_RATING[level] ?? null,
        label: `${level}/10`,
        scale: 'hydro-1-10',
        native: nativeText,
      };
    }
    default:
      // QOJ：平台无难度字段（UOJ 系数据模型），明确不下发难度
      return none;
  }
}

export function toCfRating(platform: PlatformId, raw: unknown): number | null {
  return parseNativeDifficulty(platform, raw).rating;
}

export function nativeDifficultyLabel(platform: PlatformId, raw: unknown): string | null {
  return parseNativeDifficulty(platform, raw).label;
}

/**
 * 适配器统一入口：一次给出「映射后的 CF rating + 原生原文 + 标度」。
 * 未知难度**不产出** `difficulty` 键（保持既有 semantics：缺失 = 未知，写库时落 NULL 且不覆盖旧值）。
 */
export function difficultyFields(
  platform: PlatformId,
  raw: unknown,
): { difficulty?: number; nativeDifficulty?: string; difficultyScale: DifficultyScale } {
  const parsed = parseNativeDifficulty(platform, raw);
  return {
    ...(parsed.rating !== null ? { difficulty: parsed.rating } : {}),
    ...(parsed.native !== null ? { nativeDifficulty: parsed.native } : {}),
    difficultyScale: parsed.scale,
  };
}

/** CF 称号（展示用；与 rating 分段一致） */
export function cfRatingTitle(rating: number): { en: string; zh: string } {
  const r = clampRating(rating);
  if (r < 1200) return { en: 'Newbie', zh: '新手' };
  if (r < 1400) return { en: 'Pupil', zh: '入门' };
  if (r < 1600) return { en: 'Specialist', zh: '熟练' };
  if (r < 1900) return { en: 'Expert', zh: '专家' };
  if (r < 2100) return { en: 'Candidate Master', zh: '候选大师' };
  if (r < 2300) return { en: 'Master', zh: '大师' };
  if (r < 2400) return { en: 'International Master', zh: '国际大师' };
  if (r < 2600) return { en: 'Grandmaster', zh: '宗师' };
  if (r < 3000) return { en: 'International Grandmaster', zh: '国际宗师' };
  return { en: 'Legendary Grandmaster', zh: '传奇宗师' };
}

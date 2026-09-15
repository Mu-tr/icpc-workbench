# 多平台题目拉取 / 难度映射 / 提交记录拉取 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 8 个平台的题目元数据与提交记录都能稳定拉取，并把每个平台的原生难度统一映射到 Codeforces rating 标尺（保留原生值），截断时后台按平台节奏自动分批续拉。

**Architecture:** 新增 `shared/src/difficulty.ts` 作为**唯一的难度映射真源**（表驱动 + 每个平台带实测依据注释）；适配器只给出原生难度原文并调用 `difficultyFields()`；`problems` 表新增 `native_difficulty` / `difficulty_scale` 两列（幂等迁移），三条写库路径（同步/手动导入/题库/回填）统一写入；题库拉取按平台修正为「平台真正提供」的字段；计蒜客新增练习提交数据源；`syncScheduler.ts` 在截断后按平台间隔自动续拉。

**Tech Stack:** Node 22+ / TypeScript / Express / node:sqlite（零原生依赖）/ node:test + tsx / React 19 + Ant Design 5。

**Spec:** `docs/superpowers/specs/2026-09-15-platform-difficulty-and-fetch-design.md`

## Global Constraints

- 难度统一标尺 = **CF rating，取值域 [800, 3500]**（`CF_RATING_MIN` / `CF_RATING_MAX`），越界一律钳位；未知一律 `null`，**不猜**。
- 映射表**只能有一份**，位于 `shared/src/difficulty.ts`；其他文件不得再定义平台→CF 映射表（`grep -rn "TO_RATING" server/src shared/src` 只应命中该文件与薄包装别名）。
- 实测取值（不得改动）：洛谷/计蒜客 1–8 → `800/1000/1500/1800/2200/2400/2600/3400`；AtCoder 锚点 `(-386,800) (451,1000) (973,1500) (1545,1800) (2107,2200) (2325,2400) (2653,2600) (3392,3400)`；力扣 easy/medium/hard → `1000/1500/2100`；代码源 1–10 → `800/900/1000/1200/1400/1600/1800/2000/2200/2400`；牛客难度分原值钳位。
- 每次对外请求都必须受限流约束（见 spec §3.7）；任何新增分页都必须支持 `knownExternalIds` 增量 + 游标续拉 + `opts.truncated` 回传。
- 计蒜客练习同步默认开启（`settings['jisuanke.practiceSync']` 缺省视为 `true`）。
- 后台续拉默认 6 轮上限（`settings['sync.autoContinueRounds']`）、可取消、鉴权失败立即停止。
- 提交信息用中文，遵循仓库既有风格 `type(scope): 说明`。
- 每个任务结束都要跑：`npm run typecheck -w server`；涉及前端时另加 `npm run typecheck -w client`。

---

### Task 1: 统一难度模块 `shared/src/difficulty.ts`

**Files:**
- Create: `shared/src/difficulty.ts`
- Modify: `shared/src/index.ts`（导出 + `NormalizedProblem` / `PlatformMeta` 扩展）
- Test: `server/test/difficulty.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `CF_RATING_MIN = 800` / `CF_RATING_MAX = 3500`
  - `type DifficultyScale = 'cf-rating' | 'luogu-2026-06' | 'atcoder-kenkoooo-irt' | 'nowcoder-score' | 'leetcode-tier' | 'jisuanke-level-8' | 'hydro-1-10' | 'none'`
  - `interface DifficultyParse { rating: number | null; label: string | null; scale: DifficultyScale; native: string | null }`
  - `parseNativeDifficulty(platform: PlatformId, raw: unknown): DifficultyParse`
  - `toCfRating(platform: PlatformId, raw: unknown): number | null`
  - `nativeDifficultyLabel(platform: PlatformId, raw: unknown): string | null`
  - `difficultyFields(platform: PlatformId, raw: unknown): { difficulty?: number; nativeDifficulty?: string; difficultyScale: DifficultyScale }`
  - `cfRatingTitle(rating: number): { en: string; zh: string }`
  - `atcoderThetaToRating(theta: number): number`
  - 表：`LUOGU_LEVEL_TO_RATING` / `LUOGU_LEVEL_NAMES` / `JISUANKE_LEVEL_TO_RATING` / `JISUANKE_LEVEL_NAMES` / `ATCODER_ANCHORS` / `LEETCODE_TIER_TO_RATING` / `HYDRO_LEVEL_TO_RATING`

- [ ] **Step 1: 写失败测试 `server/test/difficulty.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  atcoderThetaToRating,
  cfRatingTitle,
  difficultyFields,
  nativeDifficultyLabel,
  parseNativeDifficulty,
  toCfRating,
} from '../../shared/src/difficulty.ts';

test('difficulty: 洛谷 1-8 档映射为实测中位数，0 为未知', () => {
  // 证据：洛谷 type=CF 镜像题 × CF API rating 共 737 对（见 spec §2.2）
  const expected = [800, 1000, 1500, 1800, 2200, 2400, 2600, 3400];
  expected.forEach((rating, i) => {
    assert.equal(toCfRating('luogu', i + 1), rating);
  });
  assert.equal(toCfRating('luogu', 0), null); // 暂无评定（且 difficulty=0 在列表接口是"不筛选"）
  assert.equal(toCfRating('luogu', 9), null); // 越界档位不得当 8 用
  assert.equal(nativeDifficultyLabel('luogu', 5), '提高');
  assert.equal(nativeDifficultyLabel('luogu', 8), 'NOI/NOI+/CTS');
});

test('difficulty: 计蒜客 level1-8 与洛谷同档同名（i18n 字典实测）', () => {
  assert.equal(toCfRating('jisuanke', 'level1'), 800);
  assert.equal(toCfRating('jisuanke', 'level8'), 3400);
  assert.equal(nativeDifficultyLabel('jisuanke', 'level6'), '提高+');
  assert.equal(toCfRating('jisuanke', 'level9'), null); // 实测 level9 题量 0
  assert.equal(toCfRating('jisuanke', 'others'), null);
});

test('difficulty: AtCoder kenkoooo 难度按实测锚点分段线性，两端钳位', () => {
  assert.equal(atcoderThetaToRating(-386), 800);
  assert.equal(atcoderThetaToRating(-5000), 800); // 极简题钳到 CF 下限
  assert.equal(atcoderThetaToRating(3392), 3400);
  assert.equal(atcoderThetaToRating(9000), 3500); // 超出上限钳位
  // 锚点之间线性：451→1000 / 973→1500 的中点 712 → 约 1250
  assert.equal(atcoderThetaToRating(712), 1250);
  // 单调性
  const xs = [-1000, 0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4500];
  const ys = xs.map(atcoderThetaToRating);
  for (let i = 1; i < ys.length; i += 1) assert.ok(ys[i] >= ys[i - 1], `${xs[i]} 应不小于 ${xs[i - 1]}`);
});

test('difficulty: 牛客难度分同量纲直用并钳位，空值/0 为未知', () => {
  assert.equal(toCfRating('nowcoder', 1500), 1500);
  assert.equal(toCfRating('nowcoder', 200), 800); // 低于 CF 下限 → 钳到 800
  assert.equal(toCfRating('nowcoder', 3700), 3500);
  assert.equal(toCfRating('nowcoder', 0), null);
  assert.equal(toCfRating('nowcoder', ''), null);
  assert.equal(toCfRating('nowcoder', null), null);
});

test('difficulty: 力扣三档、代码源 1-10、CF 原值、QOJ 恒空', () => {
  assert.equal(toCfRating('leetcode', 'EASY'), 1000);
  assert.equal(toCfRating('leetcode', 'hard'), 2100);
  assert.equal(nativeDifficultyLabel('leetcode', 'MEDIUM'), '中等');
  assert.equal(toCfRating('daimayuan', 10), 2400);
  assert.equal(toCfRating('daimayuan', 0), null); // Hydro 未设定且无提交统计
  assert.equal(toCfRating('codeforces', 1900), 1900);
  assert.equal(toCfRating('codeforces', undefined), null);
  assert.equal(toCfRating('qoj', 1234), null);
  assert.equal(parseNativeDifficulty('qoj', 1234).scale, 'none');
});

test('difficulty: difficultyFields 同时产出映射值与原生原文', () => {
  assert.deepEqual(difficultyFields('luogu', 4), {
    difficulty: 1800,
    nativeDifficulty: '4',
    difficultyScale: 'luogu-2026-06',
  });
  // 未知难度：只有标度，没有值（保持既有"缺 difficulty 键"的语义）
  assert.deepEqual(difficultyFields('atcoder', null), { difficultyScale: 'atcoder-kenkoooo-irt' });
  assert.equal('difficulty' in difficultyFields('atcoder', null), false);
});

test('difficulty: cfRatingTitle 边界', () => {
  assert.equal(cfRatingTitle(800).en, 'Newbie');
  assert.equal(cfRatingTitle(1200).en, 'Pupil');
  assert.equal(cfRatingTitle(1600).en, 'Expert');
  assert.equal(cfRatingTitle(1900).en, 'Candidate Master');
  assert.equal(cfRatingTitle(2400).en, 'Grandmaster');
  assert.equal(cfRatingTitle(3500).en, 'Legendary Grandmaster');
  assert.equal(cfRatingTitle(800).zh, '新手');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test server/test/difficulty.test.ts`
Expected: FAIL —— `Cannot find module '../../shared/src/difficulty.ts'`

- [ ] **Step 3: 实现 `shared/src/difficulty.ts`**

```ts
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
  if (theta >= last[0]) return clampRating(last[1]);
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
      const s = String(raw ?? '').trim();
      const m = /^level(\d+)$/i.exec(s);
      const level = m ? Number(m[1]) : NaN;
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
      if (n === null || n <= 0) return { rating: null, label: null, scale: 'hydro-1-10', native: nativeText };
      return {
        rating: HYDRO_LEVEL_TO_RATING[Math.min(10, Math.round(n))] ?? null,
        label: `${Math.round(n)}/10`,
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --test server/test/difficulty.test.ts`
Expected: PASS（7 个用例）

- [ ] **Step 5: `shared/src/index.ts` 导出与类型扩展**

在文件顶部类型区新增（`NormalizedProblem` 内）：

```ts
  /**
   * 平台原生难度原文（洛谷 `4` / 计蒜客 `level6` / 力扣 `HARD` / 牛客 `1500` / kenkoooo `1545`）。
   * 与 difficulty（CF rating）同时写入，供平台改档后按标度重算与 UI 展示。
   */
  nativeDifficulty?: string;
  /** 原生难度所属标度（见 difficulty.ts 的 DifficultyScale） */
  difficultyScale?: DifficultyScale;
```

`PlatformMeta` 增加能力标记（QOJ 无题库、无难度）：

```ts
  /** 是否提供公开题库拉取（QOJ 无：/problems 需 cf_clearance 且无难度字段） */
  hasBank: boolean;
  /** 难度所属标度（前端展示与说明用） */
  difficultyScale: DifficultyScale;
  /** 提交来源：contest=比赛内提交；practice=自由练题/题库提交；none=不适用 */
  syncSources: Array<'contest' | 'practice' | 'none'>;
```

`PLATFORMS` 每项补齐上述字段：`codeforces/atcoder/luogu/nowcoder/leetcode/daimayuan` → `{ hasBank: true, difficultyScale: <各自标度>, syncSources: ['none'] }`；`jisuanke` → `{ hasBank: true, difficultyScale: 'jisuanke-level-8', syncSources: ['contest', 'practice'] }`；`qoj` → `{ hasBank: false, difficultyScale: 'none', syncSources: ['none'] }`。

文件末尾追加导出：

```ts
// ---------- 平台难度 → CF rating 统一标尺（唯一真源） ----------

export {
  CF_RATING_MIN,
  CF_RATING_MAX,
  LUOGU_LEVEL_NAMES,
  LUOGU_LEVEL_TO_RATING,
  JISUANKE_LEVEL_NAMES,
  JISUANKE_LEVEL_TO_RATING,
  ATCODER_ANCHORS,
  LEETCODE_TIER_TO_RATING,
  HYDRO_LEVEL_TO_RATING,
  atcoderThetaToRating,
  nowcoderScoreToRating,
  parseNativeDifficulty,
  toCfRating,
  nativeDifficultyLabel,
  difficultyFields,
  cfRatingTitle,
  type DifficultyScale,
  type DifficultyParse,
} from './difficulty.ts';
```

顶部加入 `import type { DifficultyScale } from './difficulty.ts';`（仅类型，不产生运行时循环依赖）。

- [ ] **Step 6: 类型检查并提交**

Run: `npm run typecheck -w server && npx tsx --test server/test/difficulty.test.ts`
Expected: 均通过

```bash
git add shared/src/difficulty.ts shared/src/index.ts server/test/difficulty.test.ts
git commit -m "feat(difficulty): 统一平台难度→CF rating 模块（实测表驱动）"
```

---

### Task 2: 数据模型 —— `native_difficulty` / `difficulty_scale`

**Files:**
- Modify: `server/src/db/schema.sql:57-70`（`problems` 建表）
- Modify: `server/src/db/index.ts:41-72`（迁移）
- Modify: `server/src/import/problemWritePolicy.ts`
- Modify: `server/src/import/importService.ts:55-66`
- Modify: `server/src/import/bankService.ts`
- Test: `server/test/difficulty-fields.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `NormalizedProblem.nativeDifficulty/difficultyScale`
- Produces: `problemUpsertSql(source)` 的 INSERT 语句新增两列（列序固定 `..., difficulty_source, native_difficulty, difficulty_scale`），调用方需多传 2 个参数

- [ ] **Step 1: 写失败测试 `server/test/difficulty-fields.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db/index.ts';
import { problemUpsertSql } from '../src/import/problemWritePolicy.ts';
import { upsertBankProblems } from '../src/import/bankService.ts';

function freshDb() {
  return createDb(':memory:');
}

test('迁移：老库缺列时自动补齐且幂等', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-mig-'));
  const dbPath = path.join(dir, 't.db');
  const colsOf = (d: any) => (d.prepare('PRAGMA table_info(problems)').all() as Array<{ name: string }>).map((c) => c.name);
  try {
    const db1 = createDb(dbPath);
    assert.ok(colsOf(db1).includes('native_difficulty'));
    // 模拟老库：删掉两列后再重开，迁移应补回
    db1.exec('ALTER TABLE problems DROP COLUMN native_difficulty');
    db1.exec('ALTER TABLE problems DROP COLUMN difficulty_scale');
    assert.ok(!colsOf(db1).includes('native_difficulty'));
    db1.close();
    const db2 = createDb(dbPath);
    const cols = colsOf(db2);
    assert.ok(cols.includes('native_difficulty'));
    assert.ok(cols.includes('difficulty_scale'));
    db2.close();
    // 幂等：再次重开不报错
    const db3 = createDb(dbPath);
    assert.ok(colsOf(db3).includes('difficulty_scale'));
    db3.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('写库：同步来源写入原生难度；题库来源不覆盖已落定的难度与原生值', () => {
  const db = freshDb();
  const upsert = db.prepare(problemUpsertSql('bank'));
  upsert.run('luogu', 'P3373', '线段树 2', 1800, 'https://www.luogu.com.cn/problem/P3373', '[]', 'bank', '4', 'luogu-2026-06');
  let row = db.prepare("SELECT difficulty, native_difficulty, difficulty_scale FROM problems WHERE problem_key = 'P3373'").get() as any;
  assert.deepEqual(row, { difficulty: 1800, native_difficulty: '4', difficulty_scale: 'luogu-2026-06' });

  // 题库来源优先级最低：即使给出不同难度也不得覆盖
  upsert.run('luogu', 'P3373', '线段树 2', 1500, null, '[]', 'bank', '3', 'luogu-2026-06');
  row = db.prepare("SELECT difficulty, native_difficulty FROM problems WHERE problem_key = 'P3373'").get() as any;
  assert.equal(row.difficulty, 1800);
  assert.equal(row.native_difficulty, '4');

  // 同步来源（优先级 2 < backfill 3）同样不覆盖 bank 之上的既有值；来源更高时覆盖
  db.prepare(problemUpsertSql('manual')).run('luogu', 'P3373', '线段树 2', 2000, null, '[]', 'manual', '5', 'luogu-2026-06');
  row = db.prepare("SELECT difficulty, native_difficulty FROM problems WHERE problem_key = 'P3373'").get() as any;
  assert.equal(row.difficulty, 2000);
  assert.equal(row.native_difficulty, '5');
  db.close();
});

test('题库入库写入原生难度与标度', () => {
  const db = freshDb();
  const r = upsertBankProblems(db, [{
    platform: 'jisuanke', problemKey: 'T1001', title: '计算A+B', difficulty: 800,
    nativeDifficulty: 'level1', difficultyScale: 'jisuanke-level-8',
    url: 'https://www.jisuanke.com/problem/T1001', tags: ['输入和输出'],
  }]);
  assert.equal(r[0].inserted, 1);
  const row = db.prepare("SELECT difficulty, native_difficulty, difficulty_scale FROM problems WHERE problem_key = 'T1001'").get() as any;
  assert.deepEqual(row, { difficulty: 800, native_difficulty: 'level1', difficulty_scale: 'jisuanke-level-8' });
  db.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx --test server/test/difficulty-fields.test.ts`
Expected: FAIL（`no such column: native_difficulty`）

- [ ] **Step 3: schema + 迁移**

`server/src/db/schema.sql` 的 `problems` 表定义改为：

```sql
CREATE TABLE IF NOT EXISTS problems (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  platform    TEXT NOT NULL REFERENCES platforms(id),
  problem_key TEXT NOT NULL,                   -- 平台内唯一标识，如 1919C / abc321_a
  title       TEXT NOT NULL,
  difficulty  INTEGER,                         -- CF rating 统一标尺（映射见 shared/src/difficulty.ts）
  url         TEXT,
  tags        TEXT NOT NULL DEFAULT '[]',      -- JSON 数组字符串（写入即净化：噪声标签已过滤 + 同义词已归并）
  -- 难度来源（优先级 manual > backfill > sync > bank）：决定新值能否覆盖已有值，见 import/problemWritePolicy.ts
  difficulty_source TEXT,
  -- 平台原生难度原文与所属标度（如 '4' + 'luogu-2026-06'）：平台改档后可按标度重算，UI 可显示双标度
  native_difficulty TEXT,
  difficulty_scale TEXT,
  UNIQUE (platform, problem_key)
);
```

`server/src/db/index.ts` 的 `migrate()` 中，`difficulty_source` 分支之后追加：

```ts
  // v0.6: 难度双标度——保留平台原生难度原文与所属标度（便于平台改档后重算 + UI 展示）
  if (!problemCols.has('native_difficulty')) db.exec('ALTER TABLE problems ADD COLUMN native_difficulty TEXT');
  if (!problemCols.has('difficulty_scale')) db.exec('ALTER TABLE problems ADD COLUMN difficulty_scale TEXT');
```

- [ ] **Step 4: 写入路径**

`server/src/import/problemWritePolicy.ts`：`problemUpsertSql` 的 SQL 改为（difficulty 的两个 CASE 之后追加同样的两个 CASE）：

```sql
    INSERT INTO problems
      (platform, problem_key, title, difficulty, url, tags, difficulty_source, native_difficulty, difficulty_scale)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, problem_key) DO UPDATE SET
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE problems.title END,
      url = COALESCE(excluded.url, problems.url),
      tags = CASE WHEN excluded.tags != '[]' THEN excluded.tags ELSE problems.tags END,
      difficulty = CASE
        WHEN excluded.difficulty IS NULL THEN problems.difficulty
        WHEN problems.difficulty IS NULL THEN excluded.difficulty
        WHEN ${prio} >= ${EXISTING_PRIORITY_SQL} THEN excluded.difficulty
        ELSE problems.difficulty
      END,
      difficulty_source = CASE
        WHEN excluded.difficulty IS NULL THEN problems.difficulty_source
        WHEN problems.difficulty IS NULL THEN excluded.difficulty_source
        WHEN ${prio} >= ${EXISTING_PRIORITY_SQL} THEN excluded.difficulty_source
        ELSE problems.difficulty_source
      END,
      native_difficulty = CASE
        WHEN excluded.native_difficulty IS NULL THEN problems.native_difficulty
        WHEN problems.native_difficulty IS NULL THEN excluded.native_difficulty
        WHEN ${prio} >= ${EXISTING_PRIORITY_SQL} THEN excluded.native_difficulty
        ELSE problems.native_difficulty
      END,
      difficulty_scale = CASE
        WHEN excluded.difficulty_scale IS NULL THEN problems.difficulty_scale
        WHEN problems.difficulty_scale IS NULL THEN excluded.difficulty_scale
        WHEN ${prio} >= ${EXISTING_PRIORITY_SQL} THEN excluded.difficulty_scale
        ELSE problems.difficulty_scale
      END`;
```

`server/src/import/importService.ts` 的 upsert 调用补两个参数：

```ts
        JSON.stringify(purifyTags(s.problem.tags)),
        source,
        s.problem.nativeDifficulty ?? null,
        s.problem.difficultyScale ?? null,
```

`server/src/import/bankService.ts`：入参类型加 `nativeDifficulty: string | null; difficultyScale: string | null;`，调用处补：

```ts
        JSON.stringify(purifyTags(r.tags ?? [])),
        'bank',
        r.nativeDifficulty ?? null,
        r.difficultyScale ?? null,
```

- [ ] **Step 5: 运行测试与全量回归**

Run: `npx tsx --test server/test/difficulty-fields.test.ts && npm run test -w server`
Expected: 新用例通过；既有用例若有 `problemUpsertSql` 参数数量断言需同步更新（`server/test/*` 中 grep `problemUpsertSql` 定位）

- [ ] **Step 6: 提交**

```bash
git add server/src/db/schema.sql server/src/db/index.ts server/src/import/problemWritePolicy.ts server/src/import/importService.ts server/src/import/bankService.ts server/test/difficulty-fields.test.ts
git commit -m "feat(db): problems 增加 native_difficulty/difficulty_scale 并贯通三条写库路径"
```

---

### Task 3: 适配器接入统一难度模块（8 平台）

**Files:**
- Modify: `server/src/adapters/codeforces.ts:135-152`
- Modify: `server/src/adapters/atcoder.ts:175-202`
- Modify: `server/src/adapters/luogu.ts:36-51,375-400`
- Modify: `server/src/adapters/nowcoder.ts:124-141`
- Modify: `server/src/adapters/leetcode.ts:54-65,197-210`
- Modify: `server/src/adapters/daimayuan.ts:165-182`
- Modify: `server/src/adapters/jisuanke.ts:102-125,347-359`
- Modify: `server/src/adapters/qoj.ts:270-286`（注释说明 + 标度）
- Modify: `server/src/adapters/problemBank.ts:446-458`（删除 daimayuan 本地表，改用共享薄包装）
- Test: `server/test/adapters-difficulty.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `difficultyFields` / `toCfRating`
- Produces: 各适配器输出的 `NormalizedProblem` 带 `nativeDifficulty` + `difficultyScale`；薄包装别名保留：`luoguDifficultyToRating`、`leetcodeDifficultyToRating`、`jisuankeDifficultyToRating`、`daimayuanDifficultyToRating`

- [ ] **Step 1: 写失败测试 `server/test/adapters-difficulty.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { luoguDifficultyToRating } from '../src/adapters/luogu.ts';
import { leetcodeDifficultyToRating } from '../src/adapters/leetcode.ts';
import { jisuankeDifficultyToRating } from '../src/adapters/jisuanke.ts';
import { daimayuanDifficultyToRating } from '../src/adapters/problemBank.ts';
import { createCodeforcesAdapter } from '../src/adapters/codeforces.ts';

test('薄包装别名与统一模块一致（旧调用点不用改）', () => {
  assert.equal(luoguDifficultyToRating(4), 1800);
  assert.equal(luoguDifficultyToRating(0), null);
  assert.equal(leetcodeDifficultyToRating('HARD'), 2100);
  assert.equal(jisuankeDifficultyToRating('level5'), 2200);
  assert.equal(daimayuanDifficultyToRating(9), 2200);
});

test('CF 适配器输出原生 rating 与标度', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({
    status: 'OK',
    result: [{
      id: 1, creationTimeSeconds: 1700000000,
      problem: { contestId: 1919, index: 'C', name: 'X', rating: 1900, tags: ['dp'] },
      verdict: 'OK', programmingLanguage: 'GNU C++20',
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const out = await createCodeforcesAdapter(fetchFn).fetchUserSubmissions('someone', { pageDelayMs: 0 });
  assert.equal(out[0].problem.difficulty, 1900);
  assert.equal(out[0].problem.nativeDifficulty, '1900');
  assert.equal(out[0].problem.difficultyScale, 'cf-rating');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx --test server/test/adapters-difficulty.test.ts`
Expected: FAIL（`daimayuanDifficultyToRating` 未导出 / 原生字段缺失）

- [ ] **Step 3: 逐适配器改造**

`codeforces.ts`（`normalize`）：

```ts
import { difficultyFields } from '../../../shared/src/difficulty.ts';
// ...
  return {
    problem: {
      platform: 'codeforces' as PlatformId,
      problemKey: key,
      title: s.problem.name,
      ...difficultyFields('codeforces', s.problem.rating),
      url: problemUrlFor(contestId, index),
      tags: s.problem.tags ?? [],
    },
```

`atcoder.ts`（`normalize`）：删除内联 `Math.max(800, ...)` 钳位，改为

```ts
  const problem = {
    platform: 'atcoder' as PlatformId,
    problemKey: s.problem_id,
    title,
    ...difficultyFields('atcoder', rawDifficulty ?? null),
    url: `https://atcoder.jp/contests/${s.contest_id}/tasks/${s.problem_id}`,
    tags: [],
  };
```

`luogu.ts`：删除 `LUOGU_DIFFICULTY_TO_RATING` 表，保留导出名（旧调用点与测试依赖）：

```ts
import { difficultyFields, toCfRating } from '../../../shared/src/difficulty.ts';
// 兼容别名：内部映射表已收敛到 shared/src/difficulty.ts
export const luoguDifficultyToRating = (d: number): number | null => toCfRating('luogu', d);
// map 内：
        ...difficultyFields('luogu', Number.isFinite(rawDifficulty) ? rawDifficulty : null),
```

`nowcoder.ts`（`normalize`）：提交列表不含难度，`problem` 对象内加一项（只有标度、无 difficulty 键）：

```ts
            problem: {
              platform: 'nowcoder' as PlatformId,
              problemKey: row.pid,
              title: row.title || row.pid,
              ...difficultyFields('nowcoder', null), // 提交列表不含难度：由题库/回填路径补齐
              url: `https://ac.nowcoder.com/acm/problem/${row.pid}`,
              tags: [],
            },
```

`leetcode.ts`：

```ts
export const leetcodeDifficultyToRating = (d?: string | null): number | null => toCfRating('leetcode', d);
// normalize 内：
              ...difficultyFields('leetcode', null), // 提交接口不含难度，由题库/回填补齐
```

`daimayuan.ts`（`normalize`）：`...difficultyFields('daimayuan', null)`，并把文件头注释里「难度/标签 Hydro 无统一标尺，暂不下发」更新为「难度由题库/回填路径按 Hydro 算法补齐」。

`jisuanke.ts`：删除 `JISUANKE_LEVEL_TO_RATING` 表，保留别名：

```ts
export const jisuankeDifficultyToRating = (d: unknown): number | null => toCfRating('jisuanke', d);
// 比赛提交行 normalize 内（行内无难度档位）：
              ...difficultyFields('jisuanke', null),
```

`qoj.ts`（`normalizeQojRow`）：`...difficultyFields('qoj', null)`，并在文件头把「题目难度：QOJ 无难度字段」补一句「标度记为 none，UI 显示『平台不提供难度』」。

`problemBank.ts`：删除 `DAIMAYUAN_DIFFICULTY_TO_RATING`，新增导出别名：

```ts
export const daimayuanDifficultyToRating = (d: number): number | null => toCfRating('daimayuan', d);
```

- [ ] **Step 4: 运行测试与全量回归**

Run: `npx tsx --test server/test/adapters-difficulty.test.ts && npm run test -w server`
Expected: 通过（既有适配器测试若断言 `difficulty` 值需按新表核对：洛谷 4→1800、AtCoder 钳位下限仍为 800）

- [ ] **Step 5: 提交**

```bash
git add server/src/adapters server/test/adapters-difficulty.test.ts
git commit -m "refactor(adapters): 8 平台难度统一走 shared/difficulty，并下发原生难度与标度"
```

---

### Task 4: 题库拉取按平台修正

**Files:**
- Modify: `server/src/adapters/problemBank.ts`（牛客/力扣/代码源/计蒜客/AtCoder/洛谷）
- Modify: `server/src/adapters/jisuanke.ts`（导出难度档位解析，供题库复用）
- Test: `server/test/problem-bank.test.ts`（扩展）

**Interfaces:**
- Consumes: Task 1 的 `difficultyFields`；Task 3 的别名
- Produces:
  - `BankProblem` 增加 `nativeDifficulty: string | null; difficultyScale: string | null`
  - `BankFetchOptions` 增加 `atcoderTagsFromLuogu?: boolean`（默认 false）、`luoguTypes?: Array<'P'|'B'|'CF'|'AT'|'SP'|'UVA'>`（默认 `['P']`）
  - `hydroDifficulty(nSubmit: number, nAccept: number, stored?: number | null): number | null`（导出以便单测）
  - `parseJisuankeProblemTags(problemTags: unknown): { difficulty: string | null; knowledge: string[] }`

- [ ] **Step 1: 写失败测试（追加到 `server/test/problem-bank.test.ts`）**

```ts
import { hydroDifficulty, parseJisuankeProblemTags } from '../src/adapters/problemBank.ts';

test('代码源：Hydro 难度算法本地复算（源码 difficultyAlgorithm 逐字实现）', () => {
  // 站点显示值 = pdoc.difficulty 优先，否则 round(10 − 13·s·acRate)（s 为 nSubmit 的数值积分）
  assert.equal(hydroDifficulty(2136, 947, null), 6);
  assert.equal(hydroDifficulty(2136, 947, 4), 4); // 站点手工设定值优先
  assert.equal(hydroDifficulty(0, 0, null), null);
});

test('计蒜客：problemTags 双类型解析（difficulty / knowledge）', () => {
  const parsed = parseJisuankeProblemTags([
    { tagName: '入门', type: 'difficulty' },
    { tagName: '输入和输出', type: 'knowledge' },
    { tagName: '数学', type: 'knowledge' },
  ]);
  assert.equal(parsed.difficulty, '入门');
  assert.deepEqual(parsed.knowledge, ['输入和输出', '数学']);
  assert.deepEqual(parseJisuankeProblemTags(undefined), { difficulty: null, knowledge: [] });
});

test('牛客：列表页算法标签被解析（现状丢弃 tags）', () => {
  const html = `<tr data-problemId="19842">
    <td><a href="/acm/problem/19842">NC19842</a></td>
    <td class="fn-right" colspan="2"><a class="title" href="/acm/problem/19842">约数</a>
      <a class="tag-label js-tag" data-id="145480">gcd与exgcd</a>
      <a class="tag-label js-tag" data-id="145607">数论</a></td>
    <td> 1500 </td><td>926</td><td></td></tr>`;
  const rows = parseNcBankRows(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].difficulty, 1500);
  assert.deepEqual(rows[0].tags, ['gcd与exgcd', '数论']);
  assert.equal(rows[0].title, '约数'); // 标题不得混入标签
});
```

（`parseNcBankRows` 为 Task 4 新增导出，替代内部 `parseNcRows`。）

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx --test server/test/problem-bank.test.ts`
Expected: FAIL（未导出 `hydroDifficulty` / `parseNcBankRows`）

- [ ] **Step 3: 实现**

**牛客**：重写行解析，先取标签再剥标签（避免标题污染），难度走统一模块：

```ts
interface NcBankRow { problemId: string; title: string; difficulty: number | null; tags: string[] }

/** 解析牛客题库行：按 data-problemId 定位（页面存在 colspan，列索引不可靠） */
export function parseNcBankRows(html: string): NcBankRow[] {
  const rows: NcBankRow[] = [];
  const trRe = /<tr[^>]*data-problemId="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html)) !== null) {
    const problemId = m[1];
    const cell = m[2];
    const tags = [...cell.matchAll(/class="tag-label[^"]*"[^>]*>([\s\S]*?)<\/a>/g)]
      .map((t) => t[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim())
      .filter(Boolean);
    const titleRaw = /class="title"[^>]*>([\s\S]*?)<\/a>/.exec(cell)?.[1]
      ?? [...cell.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)][1]?.[1] ?? '';
    const title = titleRaw.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const tds = [...cell.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    // 难度列：优先取「第 3 个纯数字单元格」（colspan 行会少列），非 100 倍数视作脏数据
    const diffText = tds.find((t, i) => i >= 2 && /^\d+$/.test(t) && Number(t) % 100 === 0) ?? '';
    const difficulty = diffText === '' ? null : toCfRating('nowcoder', Number(diffText));
    if (title === '' && tags.length === 0) continue;
    rows.push({ problemId, title, difficulty, tags });
  }
  return rows;
}
```

`fetchNowcoderBank` 内改用 `parseNcBankRows`，并把标签/原生值写入 `BankProblem`：

```ts
      problems.push({
        platform: 'nowcoder',
        problemKey: row.problemId,
        title: row.title || `NC${row.problemId}`,
        difficulty: row.difficulty,
        nativeDifficulty: row.difficulty === null ? null : String(row.difficulty),
        difficultyScale: 'nowcoder-score',
        url: `https://ac.nowcoder.com/acm/problem/${row.problemId}`,
        tags: row.tags,
      });
```

**代码源**：改走 JSON + 本地复算（Hydro 算法源码逐字实现）：

```ts
// Hydro `packages/hydrooj/src/lib/difficulty.ts` 的 difficultyAlgorithm 逐字实现：
//   s = ∫_0^{nSubmit} 2·exp(−2·ln²x)/(x·√π) dx（步长 0.1，采样密度 2）
//   difficulty = max(1, round(10 − 13·s·acRate))
const HYDRO_CACHE = { s: 0, y: 0, values: [0] as number[] };
function hydroLogp(x: number): number {
  return (2 * Math.exp(-2 * (Math.log(x) ** 2))) / x / 2.506628274631;
}
function hydroIntegrate(y: number): number {
  let lastY = HYDRO_CACHE.y;
  if (y <= lastY) return HYDRO_CACHE.values[y] ?? 0;
  let s = HYDRO_CACHE.s;
  let x0 = (lastY / 2) * 0.1;
  while (y > lastY) {
    x0 += 0.1;
    s += hydroLogp(x0) * 0.1;
    for (let i = 1; i <= 2; i += 1) HYDRO_CACHE.values.push(s);
    lastY += 2;
  }
  HYDRO_CACHE.y = lastY;
  HYDRO_CACHE.s = s;
  return HYDRO_CACHE.values[y] ?? s;
}
/** 代码源题库难度：站点手工设定值优先，否则按 Hydro 算法复算；无提交统计 → null */
export function hydroDifficulty(nSubmit: number, nAccept: number, stored?: number | null): number | null {
  if (typeof stored === 'number' && stored > 0) return Math.round(stored);
  if (!Number.isFinite(nSubmit) || nSubmit <= 0) return null;
  const acRate = Math.max(0, Math.min(1, nAccept / nSubmit));
  return Math.max(1, Math.round(10 - 13 * hydroIntegrate(Math.floor(nSubmit)) * acRate));
}
```

`fetchDaimayuanBank` 改为：`GET /p?page=N` + `Accept: application/json` → `pdocs`，`pcount` 为总数，`ppcount` 为总页数；难度用 `hydroDifficulty(p.nSubmit, p.nAccept, p.difficulty)`，标签取 `p.tag`；不再解析 HTML（删除 `parseDmyRows`）。

**计蒜客**：`problemTags` 双类型 + 难度档位：

```ts
export function parseJisuankeProblemTags(v: unknown): { difficulty: string | null; knowledge: string[] } {
  if (!Array.isArray(v)) return { difficulty: null, knowledge: [] };
  const knowledge: string[] = [];
  let difficulty: string | null = null;
  for (const t of v) {
    const name = String((t as { tagName?: string })?.tagName ?? '').trim();
    if (name === '') continue;
    if ((t as { type?: string })?.type === 'difficulty') difficulty = name;
    else knowledge.push(name);
  }
  return { difficulty, knowledge };
}
```

`fetchJisuankeBank` 内：

```ts
    for (const p of rows) {
      const key = typeof p.problemIdentifier === 'string' ? p.problemIdentifier.trim() : '';
      if (!key) continue;
      const { difficulty: diffTag, knowledge } = parseJisuankeProblemTags(p.problemTags);
      problems.push({
        platform: 'jisuanke',
        problemKey: key,
        title: p.title?.trim() || key,
        ...difficultyFields('jisuanke', p.difficultyType),
        nativeDifficulty: typeof p.difficultyType === 'string' ? p.difficultyType : null,
        difficultyScale: 'jisuanke-level-8',
        url: `${JISUANKE_BASE}/problem/${encodeURIComponent(key)}`,
        // 算法标签取 knowledge 类（difficulty 类已由难度字段表达）
        tags: knowledge,
      });
    }
```

（`parseJisuankeTags` 旧函数删除；`difficultyFields` 已自带 `nativeDifficulty`，上面的显式覆盖用于保证 `levelN` 原文一定落库。）

**力扣**：查询补中文标签：

```ts
const LEETCODE_BANK_QUERY = `query problemsetQuestionList($limit: Int, $skip: Int) {
  problemsetQuestionList(limit: $limit, skip: $skip) {
    total
    questions { frontendQuestionId title titleCn titleSlug difficulty paidOnly topicTags { name nameTranslated } }
  }
}`;
```

`tags` 取值改为 `(t.nameTranslated || t.name)`（中文优先，直接命中知识体系），`difficulty` 走 `difficultyFields('leetcode', q.difficulty)`。

**AtCoder（可选标签桥）**：新增

```ts
/** 用洛谷 AT 镜像补 AtCoder 标签（默认关闭）：洛谷 pid `AT_abc300_a` → AtCoder id `abc300_a` */
async function luoguAtcoderTagMap(
  fetchFn: HttpInit,
  opts: { maxPages?: number; onProgress?: BankFetchOptions['onProgress'] },
): Promise<{ map: Map<string, string[]>; scanned: number }> {
  const map = new Map<string, string[]>();
  const tagDict = await fetchLuoguTagDict(fetchFn);
  const maxPages = opts.maxPages ?? 60;
  let scanned = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await fetchWithChallenge(asHttpClient(fetchFn), `${LUOGU_API}/problem/list?page=${page}&type=AT`, '', undefined, {
      'x-lentille-request': 'content-only',
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: `${LUOGU_API}/problem/list`,
    });
    if (!res.ok) break;
    const text = await res.text();
    if (!text.trim().startsWith('{')) break;
    const list = (JSON.parse(text) as { data?: { problems?: { result?: LuoguListProblem[] } } }).data?.problems?.result ?? [];
    if (list.length === 0) break;
    for (const p of list) {
      const pid = typeof p.pid === 'string' ? p.pid : '';
      if (!pid.startsWith('AT_')) continue;
      const atcoderId = pid.slice(3).toLowerCase();
      const tags = (p.tags ?? []).map((id) => tagDict.get(id)).filter((t): t is string => typeof t === 'string');
      if (tags.length > 0) map.set(atcoderId, tags);
    }
    scanned += list.length;
    opts.onProgress?.({ platform: 'atcoder', count: map.size, total: null });
    await sleep(700);
  }
  return { map, scanned };
}
```

`fetchAtcoderBank` 末尾：若 `opts.atcoderTagsFromLuogu === true`，先建 map 再在循环里 `tags: tagMap.get(p.id) ?? []`，并在 `BankFetchResult` 增加可选统计字段 `tagMatched?: number; tagUnmatched?: number; tagScanned?: number`。

**洛谷**：`luoguTypes` 支持多类型（默认 `['P']`），`difficulty=0` 的语义陷阱写进注释；难度走 `difficultyFields('luogu', p.difficulty)`，`nativeDifficulty: String(p.difficulty)`。

**QOJ**：`fetchQojBank` 不实现；`POST /api/problems/bank` 对 `qoj` 直接返回 400 与原因（Task 8）。

- [ ] **Step 4: 运行测试**

Run: `npx tsx --test server/test/problem-bank.test.ts && npm run test -w server`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add server/src/adapters/problemBank.ts server/src/adapters/jisuanke.ts server/test/problem-bank.test.ts
git commit -m "feat(bank): 牛客标签/力扣中文标签/代码源 JSON+算法/计蒜客双类型标签/AtCoder 标签桥"
```

---

### Task 5: 元数据回填扩展到全平台

**Files:**
- Modify: `server/src/analysis/difficultyBackfill.ts`
- Test: `server/test/difficulty-backfill.test.ts`（扩展）

**Interfaces:**
- Consumes: Task 1/3/4
- Produces:
  - `type BackfillTarget = { platform: PlatformId; problemKey: string; difficulty: number | null; nativeDifficulty: string | null; tags: string[]; title: string }`
  - `pickBackfillTargets(db: Db): BackfillTarget[]`（选择条件：`difficulty IS NULL OR native_difficulty IS NULL OR tags = '[]'`，QOJ 排除）
  - `fetchProblemMeta(platform, problemKey, ctx): Promise<{ difficulty: number | null; nativeDifficulty: string | null; difficultyScale: string | null; tags: string[] | null; title: string | null } | null>`

- [ ] **Step 1: 写失败测试**

```ts
import { pickBackfillTargets } from '../src/analysis/difficultyBackfill.ts';
import { createDb } from '../src/db/index.ts';

test('回填目标选择：未知难度/无原生值/无标签，且排除 QOJ', () => {
  const db = createDb(':memory:');
  const ins = db.prepare(`INSERT INTO problems (platform, problem_key, title, difficulty, url, tags, difficulty_source, native_difficulty, difficulty_scale)
    VALUES (?, ?, ?, ?, NULL, ?, 'sync', ?, ?)`);
  ins.run('luogu', 'P1', 'A', 1800, '["dp"]', '4', 'luogu-2026-06');   // 完整 → 不入选
  ins.run('luogu', 'P2', 'B', null, '["dp"]', null, null);              // 无难度 → 入选
  ins.run('nowcoder', 'NC1', 'C', 1500, '[]', '1500', 'nowcoder-score'); // 无标签 → 入选（覆盖 NC 标签缺失）
  ins.run('qoj', 'Q1', 'D', null, '[]', null, null);                    // QOJ 无来源 → 排除
  const targets = pickBackfillTargets(db);
  assert.deepEqual(targets.map((t) => `${t.platform}:${t.problemKey}`).sort(), ['luogu:P2', 'nowcoder:NC1']);
  db.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx --test server/test/difficulty-backfill.test.ts`
Expected: FAIL（`pickBackfillTargets` 未导出）

- [ ] **Step 3: 实现注册表与目标选择**

```ts
/** 需要回填的题：无 CF 难度 / 无原生难度 / 无标签（QOJ 无数据来源，排除） */
export function pickBackfillTargets(db: Db): BackfillTarget[] {
  const rows = db.prepare(
    `SELECT platform, problem_key, title, difficulty, native_difficulty, tags
       FROM problems
      WHERE platform != 'qoj'
        AND (difficulty IS NULL OR native_difficulty IS NULL OR tags = '[]')
      ORDER BY platform, problem_key`,
  ).all() as Array<{ platform: PlatformId; problem_key: string; title: string; difficulty: number | null; native_difficulty: string | null; tags: string }>;
  return rows.map((r) => ({
    platform: r.platform,
    problemKey: r.problem_key,
    title: r.title,
    difficulty: r.difficulty,
    nativeDifficulty: r.native_difficulty,
    tags: JSON.parse(r.tags) as string[],
  }));
}
```

每平台 meta fetcher（`FETCHERS: Record<PlatformId, Fetcher>`，QOJ 为始终返回 null 的空实现）：

| 平台 | 实现要点（复用已有函数，避免重复造） |
|---|---|
| luogu | 现有 `fetchLgProblemInfo` + `fetchLuoguTagDict` |
| nowcoder | 现有 `fetchNcProblemInfo`（keyword 模式才有标签） |
| leetcode | 新增 GraphQL `question(titleSlug){ difficulty topicTags{ nameTranslated name } }`，难度走 `difficultyFields('leetcode', q.difficulty)` |
| daimayuan | 新增 `GET /p/{docId}`（JSON）取 `pdoc.tag`，难度用 `hydroDifficulty(pdoc.nSubmit, pdoc.nAccept, pdoc.difficulty)` |
| jisuanke | `/api/problem/tags` 字典 + `GET /api/problems?page=&status=` 一次批量回填题库（有 `problemTags` 即有难度与标签）；逐题兜底走 `GET /api/problem?problemIdentifier=` 不可用（返回 SPA HTML），故仅批量 |
| atcoder | kenkoooo 两份资源整表（24h 磁盘缓存，复用 `adapters/atcoder.ts` 的缓存文件 `atcoder-problems.json` / `atcoder-problem-models.json`） |
| codeforces | `problemset.problems` 整表 |

写库统一走 `difficulty_source = 'backfill'`（优先级 3）并同时写 `native_difficulty` / `difficulty_scale`：

```ts
    const update = db.prepare(
      `UPDATE problems
          SET difficulty = COALESCE(?, difficulty),
              native_difficulty = COALESCE(?, native_difficulty),
              difficulty_scale = COALESCE(?, difficulty_scale),
              difficulty_source = CASE WHEN ? IS NOT NULL THEN 'backfill' ELSE difficulty_source END,
              title = COALESCE(?, title),
              tags = CASE WHEN ? != '[]' THEN ? ELSE tags END
        WHERE platform = ? AND problem_key = ?`,
    );
```

- [ ] **Step 4: 运行测试与回归**

Run: `npx tsx --test server/test/difficulty-backfill.test.ts && npm run test -w server`
Expected: 通过（牛客既有「连续失败 8 次中止风控」用例必须保持通过）

- [ ] **Step 5: 提交**

```bash
git add server/src/analysis/difficultyBackfill.ts server/test/difficulty-backfill.test.ts
git commit -m "feat(backfill): 元数据回填扩展到全平台（含标签缺失题）"
```

---

### Task 6: 计蒜客练习提交数据源

**Files:**
- Modify: `server/src/adapters/jisuanke.ts`
- Modify: `server/src/adapters/sync.ts`（注入练习开关）
- Test: `server/test/jisuanke.test.ts`（扩展）

**Interfaces:**
- Consumes: `parseJisuankeTime` / `mapJisuankeVerdict` / `difficultyFields`
- Produces:
  - `interface JisuankePracticeProblem { problemId: number; problemIdentifier: string; title: string; difficultyType: string | null; tags: string[] }`
  - `fetchJisuankePracticeProblems(fetchFn: HttpInit, cookie: string, opts?: { pageDelayMs?: number }): Promise<{ problems: JisuankePracticeProblem[]; pagesScanned: number }>`
  - `fetchJisuankeProblemSubmissions(fetchFn: HttpInit, cookie: string, problemId: number, page: number): Promise<{ rows: Array<{ hashId: string; status: string | number; time: string; language?: string }>; total: number }>`
  - 适配器返回：练习 + 比赛提交合并

- [ ] **Step 1: 写失败测试（追加到 `server/test/jisuanke.test.ts`）**

```ts
import { fetchJisuankePracticeProblems, fetchJisuankeProblemSubmissions } from '../src/adapters/jisuanke.ts';

test('练习预筛：status=passed/attempted 两次过滤请求，解析题库行', async () => {
  const seen: string[] = [];
  const fetchFn = (async (input: string | URL) => {
    const u = String(input);
    seen.push(u);
    if (u.includes('status=passed')) {
      return new Response(JSON.stringify({ total: 2, problems: [
        { problemId: 34486, problemIdentifier: 'T1001', title: '计算A+B', difficultyType: 'level1', problemTags: [{ tagName: '入门', type: 'difficulty' }, { tagName: '输入和输出', type: 'knowledge' }] },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('status=attempted')) {
      return new Response(JSON.stringify({ total: 1, problems: [
        { problemId: 34487, problemIdentifier: 'T1002', title: '输出马里奥', difficultyType: 'level1', problemTags: [] },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const r = await fetchJisuankePracticeProblems(fetchFn, COOKIE, { pageDelayMs: 0 });
  assert.deepEqual(r.problems.map((p) => p.problemIdentifier), ['T1001', 'T1002']);
  assert.equal(r.problems[0].difficultyType, 'level1');
  assert.deepEqual(r.problems[0].tags, ['输入和输出']);
  assert.ok(seen.some((u) => u.includes('status=passed')));
  assert.ok(seen.some((u) => u.includes('status=attempted')));
});

test('练习提交：北京时间字符串 → ISO，hashId 为 externalId，total 用于早停', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({
    submissions: [{ hashId: '4zoBj7', language: 'c++', status: 'AC', time: '2026-09-13 12:37:47', usedTime: 1, usedMemory: 3820 }],
    total: 1,
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const r = await fetchJisuankeProblemSubmissions(fetchFn, COOKIE, 34486, 1);
  assert.equal(r.total, 1);
  assert.equal(r.rows[0].hashId, '4zoBj7');
  assert.equal(r.rows[0].time, '2026-09-13 12:37:47');
});

test('练习提交入库键用 problemIdentifier，且带难度与标签（与题库行合并）', async () => {
  const fetchFn = (async (input: string | URL) => {
    const u = String(input);
    if (u.includes('/api/problems')) {
      return new Response(JSON.stringify({ total: 1, problems: [
        { problemId: 34486, problemIdentifier: 'T1001', title: '计算A+B', difficultyType: 'level1', problemTags: [{ tagName: '输入和输出', type: 'knowledge' }] },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/api/problem/submissions')) {
      return new Response(JSON.stringify({ submissions: [{ hashId: 'h1', status: 'AC', time: '2026-09-13 12:37:47', language: 'c++' }], total: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const adapter = createJisuankeAdapter(fetchFn);
  const out = await adapter.fetchUserSubmissions('hieZF123', { cookie: COOKIE, pageDelayMs: 0 });
  const practice = out.find((s) => s.problem.problemKey === 'T1001');
  assert.ok(practice, '练习提交应按 problemIdentifier 入库');
  assert.equal(practice.verdict, 'AC');
  assert.equal(practice.problem.difficulty, 800);
  assert.equal(practice.problem.nativeDifficulty, 'level1');
  assert.deepEqual(practice.problem.tags, ['输入和输出']);
  assert.equal(practice.problem.url, 'https://www.jisuanke.com/problem/T1001');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx --test server/test/jisuanke.test.ts`
Expected: FAIL（未导出练习函数）

- [ ] **Step 3: 实现练习来源**

```ts
/** 练习预筛：题库列表按登录用户的 status 服务端过滤（实测 status=passed|attempted 生效） */
export async function fetchJisuankePracticeProblems(
  fetchFn: HttpInit,
  cookie: string,
  opts: { pageDelayMs?: number } = {},
): Promise<{ problems: JisuankePracticeProblem[]; pagesScanned: number }> {
  const out: JisuankePracticeProblem[] = [];
  const seen = new Set<number>();
  let pagesScanned = 0;
  for (const status of ['passed', 'attempted'] as const) {
    for (let page = 1; page <= MAX_PRACTICE_SCAN_PAGES; page += 1) {
      const r = await fetchJson(fetchFn, `${BASE}/api/problems?page=${page}&status=${status}`, cookie);
      if (!r.ok) {
        if (r.unauthorized) throw new ManualImportRequiredError('jisuanke', '登录态已失效（题库状态接口 401），请重新登录 www.jisuanke.com 并更新 Cookie');
        break;
      }
      const body = r.body as { problems?: JisuankeListProblemRow[]; total?: number };
      const rows = body.problems ?? [];
      pagesScanned += 1;
      for (const p of rows) {
        if (typeof p.problemId !== 'number' || seen.has(p.problemId)) continue;
        const identifier = typeof p.problemIdentifier === 'string' ? p.problemIdentifier.trim() : '';
        if (!identifier) continue;
        seen.add(p.problemId);
        const { difficulty: _d, knowledge } = parseJisuankeProblemTags(p.problemTags);
        out.push({
          problemId: p.problemId,
          problemIdentifier: identifier,
          title: p.title?.trim() || identifier,
          difficultyType: typeof p.difficultyType === 'string' ? p.difficultyType : null,
          tags: knowledge,
        });
      }
      const total = typeof body.total === 'number' ? body.total : rows.length;
      if (rows.length === 0 || page * PAGE_SIZE_PROBLEMS >= total) break;
      if (opts.pageDelayMs !== 0) await sleep(opts.pageDelayMs ?? PAGE_DELAY_MS);
    }
  }
  return { problems: out, pagesScanned };
}
```

其中 `PAGE_SIZE_PROBLEMS = 20`（实测题库列表每页 20 条）、`MAX_PRACTICE_SCAN_PAGES = 60`（保护上限；实际页数 = 做题数/20）。

单题提交：

```ts
export async function fetchJisuankeProblemSubmissions(
  fetchFn: HttpInit,
  cookie: string,
  problemId: number,
  page: number,
): Promise<{ rows: JisuankePracticeSubmissionRow[]; total: number }> {
  const r = await fetchJson(fetchFn, `${BASE}/api/problem/submissions?problemId=${problemId}&page=${page}`, cookie);
  if (!r.ok) {
    if (r.unauthorized) throw new ManualImportRequiredError('jisuanke', '登录态已失效（练习提交接口 401），请重新登录 www.jisuanke.com 并更新 Cookie');
    return { rows: [], total: 0 };
  }
  const body = r.body as { submissions?: JisuankePracticeSubmissionRow[]; total?: number };
  return { rows: body.submissions ?? [], total: typeof body.total === 'number' ? body.total : (body.submissions ?? []).length };
}
```

适配器主流程（练习段插在比赛段之前，共用 `out` / `known` / `maxSubmissions` / 游标）：

```ts
      // ---------- 练习（题库）提交：默认开启，见 settings['jisuanke.practiceSync'] ----------
      if (opts?.practiceSync !== false) {
        const scan = await fetchJisuankePracticeProblems(fetchFn, cookie, { pageDelayMs: opts?.pageDelayMs ?? PAGE_DELAY_MS });
        const startProblem = opts?.backfill && opts?.backfillFromPage ? Math.max(1, opts.backfillFromPage) : 1;
        let processed = 0;
        for (let i = startProblem - 1; i < scan.problems.length; i += 1) {
          if (processed >= PER_SYNC_MAX_PRACTICE_PROBLEMS) { practiceExhausted = true; break; }
          const p = scan.problems[i];
          processed += 1;
          // 增量判据：先取第 1 页；若该页提交全部已知且 total ≤ 已返回条数 → 该题无新增（1 次请求即跳过）
          const first = await fetchJisuankeProblemSubmissions(fetchFn, cookie, p.problemId, 1);
          const alreadyKnown = first.rows.filter((r) => opts?.knownExternalIds?.has(String(r.hashId))).length;
          if (first.rows.length > 0 && alreadyKnown === first.rows.length && first.total <= first.rows.length) {
            await sleepTracked(PAGE_DELAY_MS);
            continue;
          }
          const rows = first.rows;
          for (const row of rows) {
            const externalId = String(row.hashId);
            if (opts?.knownExternalIds?.has(externalId)) continue;
            const verdict = mapJisuankeVerdict(row.status);
            if (verdict === null) continue;
            out.push({
              problem: {
                platform: 'jisuanke' as PlatformId,
                problemKey: p.problemIdentifier,
                title: p.title,
                ...difficultyFields('jisuanke', p.difficultyType),
                url: `${BASE}/problem/${encodeURIComponent(p.problemIdentifier)}`,
                tags: p.tags,
              },
              verdict,
              ...(row.language ? { language: row.language } : {}),
              submittedAt: new Date(parseJisuankeTime(row.time)).toISOString(),
              externalId,
            });
            if (maxSubmissions && out.length >= maxSubmissions) { rowCapped = true; break; }
          }
          if (rowCapped) break;
          await sleepTracked(PAGE_DELAY_MS);
        }
        if (practiceExhausted || rowCapped) { /* 置 opts.truncated，游标 = startProblem-1+processed */ }
      }
```

`problemUrl` 修正（练习键是 `T1001`，不是 `contestId-pid`）：

```ts
    problemUrl({ problemKey }) {
      const key = String(problemKey);
      return /^\d+-/.test(key) ? jisuankeProblemUrl(key) : `${BASE}/problem/${encodeURIComponent(key)}`;
    },
```

`FetchOptions` 增加：

```ts
  /** 计蒜客练习（题库）提交同步开关；缺省 = 开启（settings['jisuanke.practiceSync'] 注入） */
  practiceSync?: boolean;
```

`server/src/adapters/sync.ts` 注入：

```ts
    const practiceSync = platform === 'jisuanke'
      ? readSetting('jisuanke.practiceSync') !== 'false'
      : undefined;
    // fetchOpts 内：
      ...(practiceSync !== undefined ? { practiceSync } : {}),
```

- [ ] **Step 4: 运行测试**

Run: `npx tsx --test server/test/jisuanke.test.ts && npm run test -w server`
Expected: 通过（既有比赛路径用例不受影响；注意比赛用例的 mock 需对 `/api/problems` 返回空数组以便练习段快速结束——若既有用例因此失败，在 mock 默认分支已返回 `[]` 时无需改动）

- [ ] **Step 5: 提交**

```bash
git add server/src/adapters/jisuanke.ts server/src/adapters/sync.ts server/src/adapters/types.ts server/test/jisuanke.test.ts
git commit -m "feat(jisuanke): 新增练习（题库）提交同步，按题意键与题库行合并"
```

---

### Task 7: 后台分批续拉调度器

**Files:**
- Create: `server/src/adapters/syncScheduler.ts`
- Modify: `server/src/adapters/sync.ts`（截断后注册续拉）
- Modify: `server/src/index.ts`（启动装配）
- Test: `server/test/sync-scheduler.test.ts`

**Interfaces:**
- Consumes: `syncPlatform`（`adapters/sync.ts`）
- Produces:
  - `interface AutoContinueState { platform: PlatformId; handle: string; round: number; maxRounds: number; nextAt: string; running: boolean }`
  - `AUTO_CONTINUE_DELAY_MS: Record<PlatformId, number>`
  - `configureSyncScheduler(deps: Partial<SchedulerDeps>): void`（测试注入假时钟/假执行器）
  - `scheduleAutoContinue(db: Db, platform: PlatformId, handle: string): AutoContinueState | null`
  - `cancelAutoContinue(platform: PlatformId): boolean`
  - `listAutoContinue(): AutoContinueState[]`
  - `getAutoContinueRounds(db: Db): number`
  - `__resetSyncSchedulerForTest(): void`

- [ ] **Step 1: 写失败测试 `server/test/sync-scheduler.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db/index.ts';
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
  const { db, timers, runs } = setup([true, true, false]);
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx --test server/test/sync-scheduler.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `server/src/adapters/syncScheduler.ts`**

```ts
/**
 * 后台分批续拉：某平台同步因触及单次上限被截断（sync_truncated=1）时，
 * 按平台节奏在后台自动续拉下一批，直到补全或达到轮数上限。
 *
 * 设计取舍：
 * - 只服务于「用户点了一次同步」的会话：轮数上限默认 6（settings['sync.autoContinueRounds']，0=关闭）。
 * - 每平台独立间隔（保守取值，低于该值易触发平台风控）。
 * - 同平台串行：已有待执行或正在执行的续拉时，重复注册被忽略。
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

/** 注册续拉；已在队列中或轮数上限为 0 时返回 null */
export function scheduleAutoContinue(database: Db, platform: PlatformId, handle: string): AutoContinueState | null {
  const maxRounds = getAutoContinueRounds(database);
  if (maxRounds === 0) return null;
  if (jobs.has(platform)) return jobs.get(platform)!.state;
  const delay = AUTO_CONTINUE_DELAY_MS[platform] ?? 60_000;
  const state: AutoContinueState = {
    platform,
    handle,
    round: 1,
    maxRounds,
    nextAt: new Date(deps!.now() + delay).toISOString(),
    running: false,
  };
  const timer = deps!.schedule(() => void runRound(platform), delay);
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
    jobs.delete(platform);
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
```

`server/src/adapters/sync.ts` 在成功分支（写好 `platform_accounts` 之后）追加：

```ts
    if (truncated && opts.triggeredBy !== 'auto' && opts.triggeredBy !== 'days') {
      const state = scheduleAutoContinue(db, platform, handle);
      if (state) result.autoContinue = { round: state.round, maxRounds: state.maxRounds, nextAt: state.nextAt };
    }
```

`SyncResult`（`shared/src/index.ts`）增加：

```ts
  /** 截断后已注册的后台续拉（缺省/关闭时无此字段） */
  autoContinue?: { round: number; maxRounds: number; nextAt: string };
```

`SyncOptions.triggeredBy` 增加 `'auto'`：

```ts
export interface SyncOptions {
  // ...
  triggeredBy?: 'manual' | 'retry' | 'days' | 'all' | 'auto';
}
```

`server/src/index.ts` 启动处（`initAdapters(dataDir)` 之后）追加：

```ts
  configureSyncScheduler({ db });
```

- [ ] **Step 4: 运行测试**

Run: `npx tsx --test server/test/sync-scheduler.test.ts && npm run test -w server`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add server/src/adapters/syncScheduler.ts server/src/adapters/sync.ts server/src/index.ts shared/src/index.ts server/test/sync-scheduler.test.ts
git commit -m "feat(sync): 截断后按平台节奏后台分批续拉（可取消、轮数可配）"
```

---

### Task 8: API 暴露（题目难度双标度 / 续拉状态 / 新参数）

**Files:**
- Modify: `server/src/routes/problems.ts`
- Modify: `server/src/routes/sync.ts`
- Modify: `server/src/routes/settings.ts`（续拉轮数设置项）
- Test: `server/test/route-difficulty.test.ts`

**Interfaces:**
- Consumes: Task 1/2/4/5/7
- Produces:
  - `GET /api/problems`、`/page`：行增加 `nativeDifficulty`、`difficultyScale`、`difficultyLabel`
  - `POST /api/problems/bank`：`atcoderTags?: boolean`、`luoguTypes?: string[]`；`qoj` → 400
  - `POST /api/problems/backfill-difficulty`：全平台
  - `GET /api/sync/status`：增加 `autoContinue`
  - `POST /api/sync/auto-continue/cancel` body `{ platform }`

- [ ] **Step 1: 写失败测试（略去样板，见下）**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createDb } from '../src/db/index.ts';
import { problemsRoutes } from '../src/routes/problems.ts';

async function withServer(db: any, fn: (base: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use('/api/problems', problemsRoutes(db, fetch));
  const server = app.listen(0);
  const port = (server.address() as any).port;
  try { await fn(`http://127.0.0.1:${port}`); } finally { server.close(); }
}

test('GET /api/problems 返回原生难度与派生标签', async () => {
  const db = createDb(':memory:');
  db.prepare(`INSERT INTO problems (platform, problem_key, title, difficulty, url, tags, difficulty_source, native_difficulty, difficulty_scale)
    VALUES ('luogu','P3373','线段树 2',1800,NULL,'["线段树"]','sync','4','luogu-2026-06')`).run();
  await withServer(db, async (base) => {
    const rows = await (await fetch(`${base}/api/problems?bank=1`)).json() as any[];
    const row = rows.find((r) => r.problem_key === 'P3373');
    assert.equal(row.difficulty, 1800);
    assert.equal(row.nativeDifficulty, '4');
    assert.equal(row.difficultyScale, 'luogu-2026-06');
    assert.equal(row.difficultyLabel, '提高');
  });
  db.close();
});
```

- [ ] **Step 2: 运行确认失败** — Run: `npx tsx --test server/test/route-difficulty.test.ts`，Expected: FAIL（字段缺失）

- [ ] **Step 3: 实现**

`problems.ts`：`ProblemRow` 增加三列，`coreSelect` 增列，`toApiProblem` 派生 label：

```ts
import { nativeDifficultyLabel, type DifficultyScale } from '../../../shared/src/difficulty.ts';
// coreSelect 增列： p.native_difficulty, p.difficulty_scale
function toApiProblem(r: ProblemRow) {
  return {
    ...r,
    tags: safeTags(r.tags),
    difficultyLabel: r.native_difficulty === null
      ? null
      : nativeDifficultyLabel(r.platform, r.native_difficulty),
    status: r.ac_count > 0 ? 'ac' : r.attempts > 0 ? 'tried' : 'none',
  };
}
```

`POST /bank`：平台白名单加 `qoj` 拒绝分支；`atcoderTags` → `fetchAtcoderBank(fetchFn, { ..., tagsFromLuogu: true })`；`luoguTypes` → `fetchLuoguBank(fetchFn, { ..., types })`。

`POST /backfill-difficulty`：调用 `backfillDifficulties(db, fetchFn)`（Task 5 已覆盖全平台），返回里带上每平台 `nativeFilled` 计数。

`routes/sync.ts`：`/status` 的每项增加 `autoContinue: listAutoContinue().find((s) => s.platform === p.id) ?? null`；新增

```ts
  // POST /api/sync/auto-continue/cancel  body: { platform }
  r.post('/auto-continue/cancel', (req, res) => {
    const { platform } = req.body ?? {};
    if (!PLATFORMS.some((p) => p.id === platform)) return res.status(400).json({ error: `platform 非法: ${String(platform)}` });
    res.json({ ok: true, cancelled: cancelAutoContinue(platform as PlatformId) });
  });
```

`routes/settings.ts`：在既有 settings 读写白名单中加入 `sync.autoContinueRounds`（整数 0–50，越界回退默认 6；复用 `sync.maxSubmissions` 同款校验风格）。

- [ ] **Step 4: 运行测试与回归**

Run: `npx tsx --test server/test/route-difficulty.test.ts && npm run test -w server && npm run typecheck -w server`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add server/src/routes server/test/route-difficulty.test.ts
git commit -m "feat(api): 题目难度双标度输出、续拉状态与取消、题库新参数"
```

---

### Task 9: 前端展示

**Files:**
- Modify: `client/src/ui.ts`（难度标签格式化）
- Modify: `client/src/pages/Problems.tsx`（题目列 tooltip、题库页签、续拉状态与取消）
- Modify: `client/src/pages/Settings.tsx`（续拉轮数设置项、计蒜客练习同步开关）
- Test: `client/test/difficultyLabel.test.ts`

**Interfaces:**
- Consumes: Task 8 的 API 字段
- Produces: `formatDifficulty(difficulty, nativeLabel, scale): string`（`ui.ts` 导出）

- [ ] **Step 1: 写失败测试 `client/test/difficultyLabel.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDifficulty } from '../src/ui.ts';

test('formatDifficulty：CF 数值 + 平台原生标签', () => {
  assert.equal(formatDifficulty(1800, '提高', 'luogu-2026-06'), '1800 · 洛谷 提高');
  assert.equal(formatDifficulty(1500, null, 'nowcoder-score'), '1500');
  assert.equal(formatDifficulty(null, null, 'none'), '难度未知');
  assert.equal(formatDifficulty(null, null, 'none', '平台不提供难度'), '平台不提供难度');
});
```

- [ ] **Step 2: 运行确认失败** — Run: `npm run test -w client`，Expected: FAIL（未导出）

- [ ] **Step 3: 实现**

```ts
/** 难度展示：CF 数值 + 平台原生档位（题库未入库难度时给空态文案） */
export function formatDifficulty(
  difficulty: number | null | undefined,
  nativeLabel?: string | null,
  scale?: string | null,
  emptyText = '难度未知',
): string {
  if (difficulty == null) return emptyText;
  const platformName =
    scale === 'luogu-2026-06' ? '洛谷'
    : scale === 'jisuanke-level-8' ? '计蒜客'
    : scale === 'leetcode-tier' ? '力扣'
    : scale === 'hydro-1-10' ? '代码源'
    : scale === 'atcoder-kenkoooo-irt' ? 'AtCoder'
    : scale === 'nowcoder-score' ? '牛客'
    : null;
  return nativeLabel && platformName ? `${difficulty} · ${platformName} ${nativeLabel}` : String(difficulty);
}
```

`Problems.tsx`：难度列 `render` 用 `Tooltip title={formatDifficulty(...)}`；`BankTab` 平台列表改为读 `PLATFORMS.filter((p) => p.hasBank)`，不再硬编码；`SyncTab` 增加续拉展示：

```tsx
{status?.autoContinue && (
  <Alert
    type="info"
    showIcon
    message={`后台续拉中：第 ${status.autoContinue.round}/${status.autoContinue.maxRounds} 轮，预计 ${new Date(status.autoContinue.nextAt).toLocaleTimeString()} 继续`}
    action={<Button size="small" onClick={cancelAutoContinue}>停止续拉</Button>}
  />
)}
```

（`status` 来自 `GET /api/sync/status`；`cancelAutoContinue` → `POST /api/sync/auto-continue/cancel`。）

`Settings.tsx`：平台账号区增加「后台续拉轮数」（InputNumber 0–50，0=关闭，保存到 `sync.autoContinueRounds`）与计蒜客「同步自由练题提交」开关（保存 `jisuanke.practiceSync`）。

- [ ] **Step 4: 运行测试与构建**

Run: `npm run test -w client && npm run typecheck -w client && npm run build`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add client/src client/test/difficultyLabel.test.ts
git commit -m "feat(client): 难度双标度展示、题库页签按平台能力渲染、续拉状态与开关"
```

---

### Task 10: 文档与全量验收

**Files:**
- Modify: `README.md`、`README.en.md`（平台能力表：难度标度与来源、QOJ 无难度说明）
- Modify: `icpc-workbench-项目总结与后续完善指南.md`（关键情报：各平台难度表示与实测结论）
- Test: 全量

- [ ] **Step 1: 文档更新**：在 README 平台表增加「难度标度」列（CF rating / 洛谷 9 档 / kenkoooo IRT / 牛客难度分 / 力扣三档 / 计蒜客 8 档 / 代码源 1-10 / QOJ 不提供），并在「已知限制」写明洛谷难度为官方「临时定义」、牛客约 20% 新题无难度分、QOJ 题目无难度不进训练计划候选池。
- [ ] **Step 2: 全量验证**

Run: `npm run typecheck && npm test && npm run build && npm run lint`
Expected: 全部通过；随后手工验收：`npm run dev:server` 后

```bash
curl -X POST http://localhost:3001/api/sync/jisuanke -H "Content-Type: application/json" -d '{"handle":"hieZF123"}'
curl http://localhost:3001/api/sync/status
curl -X POST http://localhost:3001/api/problems/bank -H "Content-Type: application/json" -d '{"platform":"jisuanke","max":200}'
```

Expected: 计蒜客返回 `imported ≥ 1`（T1001 的 AC 记录，实测该账号 passed=1）；`/api/sync/status` 可见 `autoContinue`（若截断）；题库拉取返回 `inserted/updated` 且难度非空比例显著高于改动前。

- [ ] **Step 3: 提交**

```bash
git add README.md README.en.md icpc-workbench-项目总结与后续完善指南.md
git commit -m "docs: 平台难度标度与拉取能力说明，附验收记录"
```

---

## 自检（写计划后对照 spec）

- **spec 覆盖**：§3.1→Task 1；§3.2→Task 2；§3.3→Task 4；§3.4→Task 5；§3.5→Task 6；§3.6→Task 7；§3.7→各任务限速步骤 + Global Constraints；§3.8→Task 9；§3.9→Task 8；§4→各任务错误分支；§5→各任务测试步骤 + Task 10；§6→Task 10 文档；§7→Task 10 验收。
- **与 spec 的两处有意偏差**（已在计划内注明理由）：① 力扣题库不取 `acRate`（当前无消费方，YAGNI）；② 计蒜客逐题提交的「整题已知早停」用 `total ≤ 已返回条数 + 全部已知`判定（`knownExternalIds` 是全局集合，无法按题聚合，故用该等效判据）。
- **类型一致性**：`difficultyFields` / `parseNativeDifficulty` / `toCfRating` / `hydroDifficulty` / `parseNcBankRows` / `parseJisuankeProblemTags` / `pickBackfillTargets` / `scheduleAutoContinue` / `listAutoContinue` / `cancelAutoContinue` / `getAutoContinueRounds` / `formatDifficulty` 在各任务中名称与签名一致。

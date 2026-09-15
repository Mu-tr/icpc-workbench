import { PLATFORMS } from '../../shared/src/index.ts'
import type { PlatformId } from '../../shared/src/index.ts'

/**
 * 纯展示层工具：平台主题色 / 难度配色。
 * 只做视觉取值，不涉及任何业务逻辑与 API。
 */

/** 平台展示色（彩色圆点标识用，与后端无关；暗色底下的高可读版本） */
export const PLATFORM_COLOR: Record<PlatformId, string> = {
  codeforces: '#58a3ff',
  atcoder: '#f2b75b',
  luogu: '#45d5e5',
  nowcoder: '#69d7a5',
  daimayuan: '#f2965c',
  leetcode: '#ffa116',
  jisuanke: '#7ee0a3', // 计蒜客品牌绿（暗色底可读版）
  qoj: '#b18cff', // QOJ / Universal Cup：暗色底可读的紫罗兰
}

export function platformName(id: PlatformId): string {
  return PLATFORMS.find((p) => p.id === id)?.name ?? id
}

/** CF rating 段位配色（与 Codeforces 官方段位色一致的暗色底版本） */
export function difficultyColor(d: number | null | undefined): string {
  if (d == null) return '#8993a2'
  if (d < 1200) return '#aab6c2' // new
  if (d < 1400) return '#55d990' // pupil
  if (d < 1600) return '#45d5e5' // specialist
  if (d < 1900) return '#58a3ff' // expert
  if (d < 2100) return '#a887ff' // candidate master
  if (d < 2400) return '#ffbd61' // master
  return '#ff5d70' // grandmaster+
}

/** 平台难度标度 → 展示用的平台名（标度名只在 shared/src/difficulty.ts 定义，这里只做中文名映射） */
const SCALE_PLATFORM_NAME: Record<string, string> = {
  'luogu-2026-06': '洛谷',
  'jisuanke-level-8': '计蒜客',
  'leetcode-tier': '力扣',
  'hydro-1-10': '代码源',
  'atcoder-kenkoooo-irt': 'AtCoder',
  'nowcoder-score': '牛客',
}

/**
 * 难度展示：CF 统一标尺数值 + 平台原生档位（题库未入库难度时给空态文案）。
 *
 * `difficulty` 是服务端映射到 CF rating 标尺后的值；`nativeLabel` 传服务端下发的
 * `difficultyLabel`（映射表只在 shared/src/difficulty.ts 一份，前端不再自行换算档位名）。
 * - 数值为空 → `emptyText`（默认「难度未知」），有原生档位也不显示；
 * - 有原生档位且标度有对应平台名 → `1800 · 洛谷 提高`；
 * - 其余（无原生档位、标度未知、cf-rating 的原生标签就是数值本身）→ 只给数值。
 */
export function formatDifficulty(
  difficulty: number | null | undefined,
  nativeLabel?: string | null,
  scale?: string | null,
  emptyText = '难度未知',
): string {
  if (difficulty == null) return emptyText
  const platformName = scale ? SCALE_PLATFORM_NAME[scale] : undefined
  return nativeLabel && platformName ? `${difficulty} · ${platformName} ${nativeLabel}` : String(difficulty)
}

/** AC 率文本配色（表格 / 统计用） */
export function rateColor(rate: number): string {
  if (rate >= 55) return '#69d7a5'
  if (rate >= 40) return '#f2c46d'
  return '#ff7b84'
}

/** 标签散列配色：同一标签永远取同一颜色（分类栏圆点标记用） */
const TAG_PALETTE = [
  '#86a8ff',
  '#69d7a5',
  '#f2c46d',
  '#ff7b84',
  '#45d5e5',
  '#c080ff',
  '#ffbd61',
  '#58a3ff',
  '#8ee7c0',
  '#f29b66',
]

export function tagColor(tag: string): string {
  let h = 0
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0
  return TAG_PALETTE[h % TAG_PALETTE.length]
}

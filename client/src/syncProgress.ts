/**
 * 同步进度文案（纯函数，供同步进度面板/悬浮卡/页内提示共用，便于单测）。
 *
 * 数据来自 `GET /api/sync/progress`：只有**真实发生过的请求**（节流层计数）与已用时，
 * 没有百分比——适配器内部的页数/条数不下放到前端，宁可不给进度也不给假进度。
 * 因此这里的目标是「让用户确认它还在动，并知道大概要等多久、能不能离开页面」。
 */
import type { SyncProgressBatch, SyncProgressJob, SyncProgressSnapshot } from '../../shared/src/index.ts'
import { platformName } from './ui'

/** 心跳新鲜度阈值（毫秒）：<5s 正常；5–10s 提示上游偏慢；>10s 明确告知在等上游 */
export const HEARTBEAT_OK_MS = 5_000
export const HEARTBEAT_SLOW_MS = 10_000

/** 心跳语气：ok=正常流动 / slow=偏慢 / waiting=在等上游 / idle=还没发出第一个请求 */
export type HeartbeatTone = 'ok' | 'slow' | 'waiting' | 'idle'

/** 模式文案（full=换账号全量 / incremental=增量 / backfill=补全历史 / days=最近 N 天） */
export function modeText(job: Pick<SyncProgressJob, 'mode' | 'days'>): string {
  switch (job.mode) {
    case 'full':
      return '全量重拉'
    case 'backfill':
      return '补全更早历史'
    case 'days':
      return job.days ? `最近 ${job.days} 天` : '指定时间窗'
    default:
      return '增量同步'
  }
}

/** 阶段文案：拉取提交记录 → 写入数据库 */
export function phaseText(job: Pick<SyncProgressJob, 'phase'>): string {
  return job.phase === 'saving' ? '正在写入数据库' : '正在拉取提交记录'
}

/** 已用时：12 秒 / 1 分 12 秒（≥1 小时按 1 小时 02 分，避免超长数字） */
export function elapsedText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total} 秒`
  const m = Math.floor(total / 60)
  if (m < 60) {
    const s = total % 60
    return s === 0 ? `${m} 分` : `${m} 分 ${s} 秒`
  }
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${h} 小时 ${String(mm).padStart(2, '0')} 分`
}

/** 心跳语气判定（lastRequestAgoMs=null 表示本次窗口内还没发出任何请求） */
export function heartbeatTone(lastRequestAgoMs: number | null): HeartbeatTone {
  if (lastRequestAgoMs === null) return 'idle'
  if (lastRequestAgoMs < HEARTBEAT_OK_MS) return 'ok'
  if (lastRequestAgoMs < HEARTBEAT_SLOW_MS) return 'slow'
  return 'waiting'
}

/** 心跳文案：让用户看到「最后一次请求」发生在多久之前 */
export function heartbeatText(lastRequestAgoMs: number | null): string {
  if (lastRequestAgoMs === null) return '正在建立连接，等待首个请求…'
  const s = lastRequestAgoMs / 1000
  const ago = s < 10 ? `${s.toFixed(1)} 秒` : `${Math.round(s)} 秒`
  switch (heartbeatTone(lastRequestAgoMs)) {
    case 'ok':
      return `最后一次请求 ${ago}前`
    case 'slow':
      return `等待上游响应…（最后一次请求 ${ago}前）`
    default:
      return `上游响应较慢，仍在等待（最后一次请求 ${ago}前）`
  }
}

/** 单平台紧凑一行：`增量同步 · 已用时 42 秒 · 已请求 12 次 · 最后一次请求 0.8 秒前` */
export function jobLineText(job: SyncProgressJob): string {
  const parts = [modeText(job), phaseText(job), `已用时 ${elapsedText(job.elapsedMs)}`, `已请求 ${job.siteRequests} 次`]
  if (heartbeatTone(job.lastRequestAgoMs) !== 'ok') parts.push(heartbeatText(job.lastRequestAgoMs))
  return parts.join(' · ')
}

/** 面板/卡片标题行：单个平台直接报平台名；多个平台报总数与进度位置 */
export function summaryText(snapshot: SyncProgressSnapshot): string {
  const { jobs, batch } = snapshot
  if (batch && batch.current) {
    const idx = batch.platforms.indexOf(batch.current) + 1
    const total = batch.platforms.length
    const elapsed = batch.elapsedMs > 0 ? ` · 已用时 ${elapsedText(batch.elapsedMs)}` : ''
    return total > 1
      ? `正在同步 ${platformName(batch.current)}（第 ${idx}/${total} 个平台）${elapsed}`
      : `正在同步 ${platformName(batch.current)}${elapsed}`
  }
  if (jobs.length === 1) {
    const job = jobs[0]!
    return `正在同步 ${platformName(job.platform)} · 已用时 ${elapsedText(job.elapsedMs)}`
  }
  if (jobs.length > 1) {
    const longest = jobs.reduce((a, b) => (a.elapsedMs >= b.elapsedMs ? a : b))
    return `正在同步 ${jobs.length} 个平台 · 最长已用时 ${elapsedText(longest.elapsedMs)}`
  }
  if (batch) {
    const ok = batch.completed.filter((c) => c.status === 'ok').length
    const failed = batch.completed.length - ok
    return failed > 0
      ? `本次一键同步已结束：成功 ${ok} 个，失败 ${failed} 个 · 共 ${elapsedText(batch.elapsedMs)}`
      : `本次一键同步已完成 ${batch.completed.length}/${batch.platforms.length} 个平台 · 共 ${elapsedText(batch.elapsedMs)}`
  }
  return ''
}

/** 该快照是否还有「正在进行」的内容（面板/悬浮卡据此决定是否渲染与轮询） */
export function hasRunningProgress(snapshot: SyncProgressSnapshot): boolean {
  return snapshot.jobs.length > 0 || (snapshot.batch !== null && snapshot.batch.finishedAt === null)
}

/** 是否只在展示「已结束的批次收尾状态」（前端据此在若干秒后自行隐藏） */
export function isBatchWrapUp(snapshot: SyncProgressSnapshot): boolean {
  return snapshot.jobs.length === 0 && snapshot.batch !== null && snapshot.batch.finishedAt !== null
}

/** 收尾状态展示时长：结束后再亮一会儿（「已完成 N/M」），随后面板自行消失 */
export const WRAP_UP_VISIBLE_MS = 60_000

/**
 * 面板是否应当渲染：正在进行中 → 是；刚结束的收尾状态 → 在 60 秒内亮着，之后隐藏。
 * （服务端会把结束的批次保留约 5 分钟，这里由前端决定展示窗口，避免残留。）
 */
export function wrapUpVisible(snapshot: SyncProgressSnapshot, now: number = Date.now()): boolean {
  if (hasRunningProgress(snapshot)) return true
  if (!isBatchWrapUp(snapshot)) return false
  const finished = Date.parse(snapshot.batch!.finishedAt!)
  if (!Number.isFinite(finished)) return false
  const age = now - finished
  // 时钟偏差容忍：finishedAt 在未来也照常展示（不因客户端慢几秒而闪掉收尾状态）
  return age <= WRAP_UP_VISIBLE_MS
}

/** 批次里某平台的状态：pending=待同步 / running=同步中 / ok=已完成 / failed=失败 */
export type BatchRowState = 'pending' | 'running' | 'ok' | 'failed'

export function batchRows(batch: SyncProgressBatch): Array<{
  platform: SyncProgressJob['platform']
  state: BatchRowState
  imported: number
  error?: string
}> {
  const done = new Map(batch.completed.map((c) => [c.platform, c]))
  return batch.platforms.map((platform) => {
    const item = done.get(platform)
    if (item) {
      return {
        platform,
        state: item.status === 'ok' ? 'ok' : 'failed',
        imported: item.imported,
        ...(item.error ? { error: item.error } : {}),
      }
    }
    return { platform, state: batch.current === platform ? 'running' : 'pending', imported: 0 }
  })
}

/** 状态徽标文案 */
export function batchStateText(state: BatchRowState, imported: number): string {
  switch (state) {
    case 'pending':
      return '待同步'
    case 'running':
      return '同步中'
    case 'ok':
      return imported > 0 ? `已完成 +${imported} 条` : '已完成（无新提交）'
    default:
      return '失败'
  }
}

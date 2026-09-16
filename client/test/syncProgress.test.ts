/**
 * 同步进度文案纯函数测试（client/src/syncProgress.ts）。
 * 这些文案是「用户判断有没有卡住」的唯一依据，因此口径要稳定：
 * 已用时格式、心跳三档判定、批量逐行状态、以及「无进行中内容时不渲染」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SyncProgressJob, SyncProgressSnapshot } from '../../shared/src/index.ts'
import {
  batchRows,
  batchStateText,
  elapsedText,
  hasRunningProgress,
  heartbeatText,
  heartbeatTone,
  isBatchWrapUp,
  jobLineText,
  modeText,
  phaseText,
  summaryText,
  wrapUpVisible,
} from '../src/syncProgress.ts'

function job(over: Partial<SyncProgressJob> = {}): SyncProgressJob {
  return {
    platform: 'codeforces',
    handle: 'tourist',
    mode: 'incremental',
    phase: 'fetching',
    startedAt: '2026-09-15T00:00:00.000Z',
    elapsedMs: 42_000,
    siteRequests: 12,
    lastRequestAgoMs: 800,
    ...over,
  }
}

test('syncProgress(客户端): 已用时格式（秒 / 分秒 / 小时）', () => {
  assert.equal(elapsedText(0), '0 秒')
  assert.equal(elapsedText(42_400), '42 秒')
  assert.equal(elapsedText(60_000), '1 分')
  assert.equal(elapsedText(72_000), '1 分 12 秒')
  assert.equal(elapsedText(3_600_000), '1 小时 00 分')
  assert.equal(elapsedText(7_860_000), '2 小时 11 分')
  assert.equal(elapsedText(-5), '0 秒', '负数按 0 处理，不出现「-1 秒」')
})

test('syncProgress(客户端): 心跳三档 + 首个请求前的中性文案', () => {
  assert.equal(heartbeatTone(null), 'idle')
  assert.equal(heartbeatTone(100), 'ok')
  assert.equal(heartbeatTone(6_000), 'slow')
  assert.equal(heartbeatTone(30_000), 'waiting')
  assert.match(heartbeatText(null), /等待首个请求/)
  assert.equal(heartbeatText(800), '最后一次请求 0.8 秒前')
  assert.match(heartbeatText(6_000), /等待上游响应/)
  assert.match(heartbeatText(30_000), /上游响应较慢/)
})

test('syncProgress(客户端): 模式与阶段文案', () => {
  assert.equal(modeText({ mode: 'incremental' }), '增量同步')
  assert.equal(modeText({ mode: 'full' }), '全量重拉')
  assert.equal(modeText({ mode: 'backfill' }), '补全更早历史')
  assert.equal(modeText({ mode: 'days', days: 7 }), '最近 7 天')
  assert.equal(phaseText({ phase: 'fetching' }), '正在拉取提交记录')
  assert.equal(phaseText({ phase: 'saving' }), '正在写入数据库')
})

test('syncProgress(客户端): 紧凑一行含已用时/请求数；心跳正常时省略心跳尾巴', () => {
  assert.equal(
    jobLineText(job()),
    '增量同步 · 正在拉取提交记录 · 已用时 42 秒 · 已请求 12 次',
  )
  assert.match(jobLineText(job({ lastRequestAgoMs: 20_000 })), /上游响应较慢/)
})

test('syncProgress(客户端): 单平台同步的标题与「无内容不渲染」判定', () => {
  const snap: SyncProgressSnapshot = { jobs: [job()], batch: null }
  assert.equal(summaryText(snap), '正在同步 Codeforces · 已用时 42 秒')
  assert.equal(hasRunningProgress(snap), true)

  assert.equal(hasRunningProgress({ jobs: [], batch: null }), false, '无同步 → 面板/悬浮卡都不渲染')
  assert.equal(summaryText({ jobs: [], batch: null }), '')
})

test('syncProgress(客户端): 一键同步标题带「第 N/M 个平台」', () => {
  const snap: SyncProgressSnapshot = {
    jobs: [job({ platform: 'luogu' })],
    batch: {
      platforms: ['codeforces', 'luogu', 'nowcoder'],
      current: 'luogu',
      completed: [{ platform: 'codeforces', status: 'ok', imported: 5 }],
      startedAt: '2026-09-15T00:00:00.000Z',
      elapsedMs: 90_000,
      finishedAt: null,
    },
  }
  assert.equal(summaryText(snap), '正在同步 洛谷（第 2/3 个平台） · 已用时 1 分 30 秒')
  assert.equal(hasRunningProgress(snap), true)
  assert.equal(isBatchWrapUp(snap), false)
})

test('syncProgress(客户端): 批次收尾状态（已完成/失败计数）与收尾判定', () => {
  const finished: SyncProgressSnapshot = {
    jobs: [],
    batch: {
      platforms: ['codeforces', 'luogu', 'nowcoder'],
      current: null,
      completed: [
        { platform: 'codeforces', status: 'ok', imported: 5 },
        { platform: 'luogu', status: 'failed', imported: 0, error: 'HTTP 403' },
      ],
      startedAt: '2026-09-15T00:00:00.000Z',
      elapsedMs: 120_000,
      finishedAt: '2026-09-15T00:02:00.000Z',
    },
  }
  assert.equal(summaryText(finished), '本次一键同步已结束：成功 1 个，失败 1 个 · 共 2 分')
  assert.equal(hasRunningProgress(finished), false, '已结束 → 不再轮询')
  assert.equal(isBatchWrapUp(finished), true, '但保留收尾展示')
})

test('syncProgress(客户端): 面板渲染窗口 —— 进行中显示，收尾亮 60 秒后隐藏', () => {
  const finishedAt = '2026-09-15T00:02:00.000Z'
  const snap: SyncProgressSnapshot = {
    jobs: [],
    batch: {
      platforms: ['codeforces'],
      current: null,
      completed: [{ platform: 'codeforces', status: 'ok', imported: 3 }],
      startedAt: '2026-09-15T00:00:00.000Z',
      elapsedMs: 120_000,
      finishedAt,
    },
  }
  const t = Date.parse(finishedAt)
  assert.equal(wrapUpVisible(snap, t), true, '刚结束 → 展示「已完成」')
  assert.equal(wrapUpVisible(snap, t + 30_000), true)
  assert.equal(wrapUpVisible(snap, t + 61_000), false, '超过 60 秒 → 面板自行消失')
  assert.equal(wrapUpVisible(snap, t - 3_000), true, '客户端时钟略慢时不闪掉收尾状态')

  // 进行中 / 完全没有内容
  const running: SyncProgressSnapshot = { jobs: [job()], batch: null }
  assert.equal(wrapUpVisible(running, t), true)
  assert.equal(wrapUpVisible({ jobs: [], batch: null }, t), false)
})

test('syncProgress(客户端): 批次逐行状态（待同步/同步中/已完成/失败）', () => {
  const rows = batchRows({
    platforms: ['codeforces', 'luogu', 'nowcoder', 'qoj'],
    current: 'nowcoder',
    completed: [
      { platform: 'codeforces', status: 'ok', imported: 12 },
      { platform: 'luogu', status: 'failed', imported: 0, error: 'HTTP 403' },
    ],
    startedAt: '2026-09-15T00:00:00.000Z',
    elapsedMs: 30_000,
    finishedAt: null,
  })
  assert.deepEqual(rows, [
    { platform: 'codeforces', state: 'ok', imported: 12 },
    { platform: 'luogu', state: 'failed', imported: 0, error: 'HTTP 403' },
    { platform: 'nowcoder', state: 'running', imported: 0 },
    { platform: 'qoj', state: 'pending', imported: 0 },
  ])
  assert.equal(batchStateText('pending', 0), '待同步')
  assert.equal(batchStateText('running', 0), '同步中')
  assert.equal(batchStateText('ok', 12), '已完成 +12 条')
  assert.equal(batchStateText('ok', 0), '已完成（无新提交）')
  assert.equal(batchStateText('failed', 0), '失败')
})

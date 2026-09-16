/**
 * 同步结果文案纯函数测试（client/src/syncStatus.ts）。
 * 这些文案决定用户对「上次同步到底成不成、为什么没数据」的判断，口径必须稳定。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SyncRun } from '../../shared/src/index.ts'
import {
  absoluteTimeText,
  hasAnyAccount,
  healthColor,
  healthText,
  lastSyncSummary,
  platformRunLine,
  relativeTimeText,
  triggeredByText,
  type SyncPlatformStatusView,
} from '../src/syncStatus.ts'

const NOW = Date.parse('2026-09-15T12:00:00.000Z')

function run(over: Partial<SyncRun> = {}): SyncRun {
  return {
    id: 1,
    platform: 'codeforces',
    handle: 'tourist',
    startedAt: '2026-09-15T11:57:00.000Z',
    finishedAt: '2026-09-15T11:57:30.000Z',
    durationMs: 30_000,
    imported: 12,
    skipped: 3,
    truncated: 0,
    waitedMs: 0,
    mode: 'incremental',
    status: 'ok',
    errorCode: null,
    errorMessage: null,
    triggeredBy: 'manual',
    nextSuggestedSyncAt: '2026-09-15T15:57:00.000Z',
    ...over,
  }
}

function status(over: Partial<SyncPlatformStatusView> = {}): SyncPlatformStatusView {
  return {
    platform: 'codeforces',
    platformName: 'Codeforces',
    handle: 'tourist',
    enabled: true,
    lastSyncAt: '2026-09-15T11:57:30.000Z',
    status: 'healthy',
    latestRun: run(),
    autoContinue: null,
    ...over,
  }
}

test('syncStatus: 相对时间（刚刚/分钟/小时/天；无值=从未）', () => {
  assert.equal(relativeTimeText(null, NOW), '从未')
  assert.equal(relativeTimeText('2026-09-15T11:59:40.000Z', NOW), '刚刚')
  assert.equal(relativeTimeText('2026-09-15T11:45:00.000Z', NOW), '15 分钟前')
  assert.equal(relativeTimeText('2026-09-15T09:00:00.000Z', NOW), '3 小时前')
  assert.equal(relativeTimeText('2026-09-13T12:00:00.000Z', NOW), '2 天前')
  assert.equal(relativeTimeText('2026-09-15T12:00:30.000Z', NOW), '刚刚', '服务端时钟略快不出现负数')
  assert.equal(relativeTimeText('坏数据', NOW), '坏数据', '无法解析时原样回显，不显示 Invalid Date')
})

test('syncStatus: 绝对时间显示与非法值', () => {
  assert.equal(absoluteTimeText(null), '-')
  assert.equal(absoluteTimeText('坏数据'), '坏数据')
  assert.match(absoluteTimeText('2026-09-15T11:57:00.000Z'), /^2026-09-15 \d{2}:\d{2}$/)
})

test('syncStatus: 健康徽章文案与配色', () => {
  assert.equal(healthText('healthy'), '健康')
  assert.equal(healthText('auth_expired'), '鉴权失效 / 风控')
  assert.equal(healthText('rate_limited'), '被限流')
  assert.equal(healthText('schema_changed'), '页面结构变化')
  assert.equal(healthText('manual_required'), '需手动导入')
  assert.equal(healthText('degraded'), '异常')
  assert.equal(healthText('never'), '从未同步')
  assert.equal(healthColor('healthy'), 'success')
  assert.equal(healthColor('never'), 'default')
  assert.equal(healthColor('manual_required'), 'warning')
  assert.equal(healthColor('auth_expired'), 'error')
})

test('syncStatus: 触发方式文案（含未知值原样回显）', () => {
  assert.equal(triggeredByText('manual'), '手动')
  assert.equal(triggeredByText('all'), '一键同步')
  assert.equal(triggeredByText('days'), '窗口补拉')
  assert.equal(triggeredByText('retry'), '重试')
  assert.equal(triggeredByText('auto'), '后台续拉')
  assert.equal(triggeredByText('whatever'), 'whatever')
})

test('syncStatus: 单平台行摘要（成功含新增/去重/限速等待；失败带原因；从未同步）', () => {
  assert.equal(platformRunLine(status(), NOW), '3 分钟前 · 手动 · 新增 12 条 · 去重 3')
  assert.equal(
    platformRunLine(status({ latestRun: run({ imported: 0, skipped: 0, waitedMs: 4_500 }) }), NOW),
    '3 分钟前 · 手动 · 无新提交 · 限速等待 5s',
  )
  assert.equal(
    platformRunLine(
      status({
        status: 'auth_expired',
        latestRun: run({ status: 'failed', errorCode: 'auth_expired', errorMessage: '洛谷 API HTTP 403', imported: 0 }),
      }),
      NOW,
    ),
    '3 分钟前 · 手动 · 失败：洛谷 API HTTP 403',
  )
  // 失败但服务端没给文案时退回健康徽章文案
  assert.match(
    platformRunLine(status({ status: 'rate_limited', latestRun: run({ status: 'failed', errorMessage: null, imported: 0 }) }), NOW),
    /失败：被限流/,
  )
  assert.equal(platformRunLine(status({ latestRun: null, status: 'never' }), NOW), '从未同步')
})

test('syncStatus: 整体摘要（上次同步时间 + 成功比例 + 新增合计）', () => {
  const statuses = [
    status(),
    status({
      platform: 'luogu',
      latestRun: run({ id: 2, platform: 'luogu', imported: 30, skipped: 0, startedAt: '2026-09-15T11:57:20.000Z' }),
    }),
    status({
      platform: 'qoj',
      status: 'auth_expired',
      latestRun: run({
        id: 3,
        platform: 'qoj',
        imported: 0,
        startedAt: '2026-09-15T11:57:40.000Z',
        status: 'failed',
        errorMessage: 'HTTP 403',
      }),
    }),
  ]
  assert.equal(
    lastSyncSummary(statuses, NOW),
    '上次同步：2 分钟前 · 成功 2/3 个平台，失败 1 个 · 新增 42 条',
  )
  assert.equal(
    lastSyncSummary([status({ latestRun: run({ imported: 0, skipped: 0 }) })], NOW),
    '上次同步：3 分钟前 · 成功 1/1 个平台 · 无新提交',
  )
  assert.equal(lastSyncSummary([], NOW), '尚无同步记录：绑定平台账号后点「同步数据」开始')
  assert.equal(hasAnyAccount(statuses), true)
  assert.equal(hasAnyAccount([]), false)
})

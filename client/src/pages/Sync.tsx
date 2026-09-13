import { useCallback, useEffect, useState } from 'react'
import { App as AntdApp, Button, InputNumber, Table, Tag, Tooltip } from 'antd'
import { CloudSyncOutlined, DownloadOutlined, RedoOutlined, SyncOutlined } from '@ant-design/icons'
import PageHeader from '../components/PageHeader'
import PlatformTag from '../components/PlatformTag'
import { get, post } from '../api'
import { saveUrlAsFile } from '../download'
import type { PlatformId, PlatformSyncStatus, SyncRun } from '../../../shared/src/index.ts'

interface PlatformStatus {
  platform: PlatformId
  platformName: string
  enabled: boolean
  handle: string
  lastSyncAt: string | null
  status: PlatformSyncStatus
  latestRun: SyncRun | null
}

const STATUS_META: Record<PlatformSyncStatus, { color: string; label: string }> = {
  healthy: { color: 'green', label: '正常' },
  degraded: { color: 'orange', label: '异常' },
  auth_expired: { color: 'red', label: '凭据失效' },
  rate_limited: { color: 'gold', label: '限流' },
  schema_changed: { color: 'purple', label: '结构变化' },
  manual_required: { color: 'blue', label: '需手动导入' },
  never: { color: 'default', label: '未同步' },
}

const MODE_LABEL: Record<SyncRun['mode'], string> = {
  full: '全量',
  incremental: '增量',
  backfill: '补全',
  days: '窗口',
}

const TRIGGER_LABEL: Record<string, string> = {
  manual: '手动',
  retry: '重试',
  all: '一键',
  days: '窗口',
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export default function Sync() {
  const { message } = AntdApp.useApp()
  const [statuses, setStatuses] = useState<PlatformStatus[]>([])
  const [runs, setRuns] = useState<SyncRun[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [days, setDays] = useState<number>(7)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, r] = await Promise.all([
        get<{ statuses: PlatformStatus[] }>('/api/sync/status'),
        get<SyncRun[]>('/api/sync/runs?limit=50'),
      ])
      setStatuses(s.statuses)
      setRuns(r)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    void load()
  }, [load])

  const runPlatform = async (p: PlatformId, handle: string, days?: number): Promise<boolean> => {
    const r = await post<{ errors: string[]; imported?: number }>(`/api/sync/${p}`, days ? { handle, days } : { handle })
    if (r.errors?.length) {
      message.warning(`${r.errors[0]}`)
      return false
    }
    return true
  }

  // 一键同步所有启用的绑定账号
  const syncAll = async () => {
    setSyncing(true)
    try {
      await post('/api/sync/all')
      message.success('同步完成')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSyncing(false)
      await load()
    }
  }

  // 重试所有非正常状态的平台（凭据失效/限流/结构变化/异常/需手动导入）
  const retryFailed = async () => {
    const targets = statuses.filter((s) => s.enabled && s.handle && s.status !== 'healthy' && s.status !== 'never')
    if (targets.length === 0) {
      message.info('没有需要重试的平台')
      return
    }
    setSyncing(true)
    try {
      let ok = 0
      for (const t of targets) {
        if (await runPlatform(t.platform, t.handle)) ok += 1
      }
      message.success(`重试完成：${ok}/${targets.length} 个平台恢复成功`)
    } finally {
      setSyncing(false)
      await load()
    }
  }

  // 仅同步最近 N 天：对所有启用账号做窗口补充拉取（漏拉的历史补齐）
  const syncRecentDays = async () => {
    const targets = statuses.filter((s) => s.enabled && s.handle)
    if (targets.length === 0) {
      message.info('没有已绑定的平台账号')
      return
    }
    setSyncing(true)
    try {
      let total = 0
      for (const t of targets) {
        const r = await post<{ imported: number }>(`/api/sync/${t.platform}`, { handle: t.handle, days })
        total += r.imported ?? 0
      }
      message.success(`已同步最近 ${days} 天：共新增 ${total} 条`)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSyncing(false)
      await load()
    }
  }

  const exportDiagnostics = () => {
    void saveUrlAsFile({
      url: '/api/sync/diagnostics',
      filename: 'sync-diagnostics.txt',
      mime: 'text/plain;charset=utf-8',
      successText: '诊断日志已导出（不含任何密钥）',
      message,
    })
  }

  const failedCount = statuses.filter((s) => s.enabled && s.status !== 'healthy' && s.status !== 'never').length

  const columns = [
    {
      title: '时间',
      dataIndex: 'startedAt',
      width: 165,
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: '平台',
      dataIndex: 'platform',
      width: 110,
      render: (v: PlatformId) => <PlatformTag id={v} />,
    },
    { title: '账号', dataIndex: 'handle', width: 120, ellipsis: true },
    { title: '模式', dataIndex: 'mode', width: 70, render: (v: SyncRun['mode']) => MODE_LABEL[v] ?? v },
    {
      title: '新增 / 去重',
      width: 100,
      render: (_: unknown, r: SyncRun) => `${r.imported} / ${r.skipped}`,
    },
    {
      title: '限速等待',
      dataIndex: 'waitedMs',
      width: 95,
      render: (v: number) => (v > 0 ? formatDuration(v) : '-'),
    },
    {
      title: '耗时',
      dataIndex: 'durationMs',
      width: 85,
      render: (v: number) => formatDuration(v),
    },
    {
      title: '结果',
      dataIndex: 'status',
      width: 190,
      render: (v: SyncRun['status'], r: SyncRun) =>
        v === 'ok' ? (
          <Tag color="green">成功{r.truncated ? '（分批截断）' : ''}</Tag>
        ) : (
          <Tooltip title={r.errorMessage ?? ''}>
            <Tag color={r.errorCode === 'manual_required' ? 'blue' : 'red'}>
              {STATUS_META[(r.errorCode as PlatformSyncStatus) in STATUS_META ? (r.errorCode as PlatformSyncStatus) : 'degraded'].label}
            </Tag>
          </Tooltip>
        ),
    },
    { title: '触发', dataIndex: 'triggeredBy', width: 70, render: (v: string) => TRIGGER_LABEL[v] ?? v },
    {
      title: '下次推荐',
      dataIndex: 'nextSuggestedSyncAt',
      width: 165,
      render: (v: string | null) => (v ? new Date(v).toLocaleString() : '-'),
    },
  ]

  return (
    <div>
      <PageHeader
        title="同步中心"
        description="各平台同步健康状态与任务历史：失败可解释、可重试、可导出诊断"
        extra={
          <>
            <Button icon={<SyncOutlined spin={syncing} />} loading={syncing} onClick={syncAll} type="primary">
              同步全部
            </Button>
            <Button icon={<RedoOutlined />} disabled={syncing || failedCount === 0} onClick={retryFailed}>
              重试失败平台{failedCount > 0 ? `（${failedCount}）` : ''}
            </Button>
            <InputNumber min={1} max={365} value={days} onChange={(v) => setDays(v ?? 7)} addonBefore="最近" addonAfter="天" style={{ width: 150 }} />
            <Button disabled={syncing} onClick={syncRecentDays}>
              窗口同步
            </Button>
            <Button icon={<DownloadOutlined />} onClick={exportDiagnostics}>
              导出诊断
            </Button>
          </>
        }
      />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {statuses.map((s) => {
          const meta = STATUS_META[s.status]
          return (
            <Tooltip
              key={s.platform}
              title={
                s.latestRun?.errorMessage
                  ? `${s.latestRun.errorMessage}`
                  : s.lastSyncAt
                    ? `上次同步：${new Date(s.lastSyncAt).toLocaleString()}`
                    : '尚未同步过'
              }
            >
              <Tag color={meta.color} style={{ fontSize: 13, padding: '4px 10px', cursor: 'default' }}>
                <CloudSyncOutlined /> {s.platformName} · {meta.label}
              </Tag>
            </Tooltip>
          )
        })}
        {statuses.length === 0 && !loading && <Tag>尚无绑定账号，请先在「设置 → 平台账号与适配器」绑定</Tag>}
      </div>

      <Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={runs}
        pagination={{ pageSize: 15, showSizeChanger: false }}
        locale={{ emptyText: '还没有同步记录，点击「同步全部」开始' }}
      />
    </div>
  )
}

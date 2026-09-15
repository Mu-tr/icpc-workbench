import { Router } from 'express';
import type { PlatformId, PlatformSyncStatus, SyncRun } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { asyncHandler } from '../asyncHandler.ts';
import { syncPlatform } from '../adapters/sync.ts';
import { cancelAutoContinue, listAutoContinue } from '../adapters/syncScheduler.ts';

interface SyncRunRow {
  id: number;
  platform: string;
  handle: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number;
  imported: number;
  skipped: number;
  truncated: number;
  waited_ms: number;
  mode: SyncRun['mode'];
  status: SyncRun['status'];
  error_code: string | null;
  error_message: string | null;
  triggered_by: string;
  next_suggested_sync_at: string | null;
}

function toSyncRun(r: SyncRunRow): SyncRun {
  return {
    id: r.id,
    platform: r.platform as PlatformId,
    handle: r.handle,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.duration_ms,
    imported: r.imported,
    skipped: r.skipped,
    truncated: r.truncated,
    waitedMs: r.waited_ms,
    mode: r.mode,
    status: r.status,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    triggeredBy: r.triggered_by,
    nextSuggestedSyncAt: r.next_suggested_sync_at,
  };
}

/** 按最近一次同步结果推导平台健康状态（同步中心徽章） */
function deriveStatus(latest: SyncRun | undefined): PlatformSyncStatus {
  if (!latest) return 'never';
  if (latest.status === 'ok') return 'healthy';
  switch (latest.errorCode) {
    case 'auth_expired': return 'auth_expired';
    case 'rate_limited': return 'rate_limited';
    case 'schema_changed': return 'schema_changed';
    case 'manual_required': return 'manual_required';
    default: return 'degraded';
  }
}

export function syncRoutes(db: Db): Router {
  const r = Router();

  // GET /api/sync/runs?limit=50 → 同步任务历史（新→旧），供同步中心表格展示
  r.get('/runs', (req, res) => {
    const n = Number(req.query.limit);
    const limit = Number.isInteger(n) ? Math.min(200, Math.max(1, n)) : 50;
    const rows = db
      .prepare(
        `SELECT * FROM sync_runs WHERE user_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(DEFAULT_USER_ID, limit) as unknown as SyncRunRow[];
    res.json(rows.map(toSyncRun));
  });

  // GET /api/sync/status → 每个绑定平台的健康状态、最近一次同步摘要与后台续拉状态
  // autoContinue：该平台的待执行续拉（round/maxRounds/nextAt/running），无排期时为 null
  r.get('/status', (_req, res) => {
    const accounts = db
      .prepare(
        'SELECT platform, handle, last_sync_at, enabled FROM platform_accounts WHERE user_id = ? ORDER BY platform',
      )
      .all(DEFAULT_USER_ID) as Array<{ platform: string; handle: string; last_sync_at: string | null; enabled: number }>;
    const latestStmt = db.prepare(
      'SELECT * FROM sync_runs WHERE user_id = ? AND platform = ? ORDER BY started_at DESC, id DESC LIMIT 1',
    );
    const autoContinues = listAutoContinue();
    const statuses = PLATFORMS
      .filter((p) => accounts.some((a) => a.platform === p.id))
      .map((p) => {
        // 从未同步过的平台没有 sync_runs 行：`get()` 返回 undefined，必须先判空再转换，
        // 否则 toSyncRun(undefined) 直接抛异常 → 整个 /status 变成 500（前端同步中心白屏）
        const latestRow = latestStmt.get(DEFAULT_USER_ID, p.id) as unknown as SyncRunRow | undefined;
        const latest = latestRow === undefined ? null : toSyncRun(latestRow);
        return {
          platform: p.id,
          platformName: p.name,
          enabled: accounts.find((a) => a.platform === p.id)?.enabled === 1,
          handle: accounts.find((a) => a.platform === p.id)?.handle ?? '',
          lastSyncAt: accounts.find((a) => a.platform === p.id)?.last_sync_at ?? null,
          status: deriveStatus(latest ?? undefined),
          latestRun: latest,
          autoContinue: autoContinues.find((s) => s.platform === p.id) ?? null,
        };
      });
    res.json({ statuses });
  });

  // GET /api/sync/diagnostics → 纯文本诊断报告（附件下载）。
  // 只包含平台配置状态与最近同步历史，不含任何 Cookie / API Key 原文。
  r.get('/diagnostics', (_req, res) => {
    const accounts = db
      .prepare('SELECT platform, handle, last_sync_at, enabled, sync_truncated, backfill_page FROM platform_accounts WHERE user_id = ? ORDER BY platform')
      .all(DEFAULT_USER_ID) as Array<{ platform: string; handle: string; last_sync_at: string | null; enabled: number; sync_truncated: number; backfill_page: number | null }>;
    const runs = db
      .prepare('SELECT * FROM sync_runs WHERE user_id = ? ORDER BY started_at DESC, id DESC LIMIT 50')
      .all(DEFAULT_USER_ID) as unknown as SyncRunRow[];
    const adapterEnabled = db
      .prepare("SELECT key, value FROM settings WHERE key LIKE 'adapter.%.enabled'")
      .all() as Array<{ key: string; value: string }>;
    const lines: string[] = [
      'ICPC Workbench 同步诊断报告',
      `生成时间：${new Date().toISOString()}`,
      '',
      '== 平台账号 ==',
      ...accounts.map((a) =>
        `- ${a.platform}: handle=${a.handle} enabled=${a.enabled} last_sync_at=${a.last_sync_at ?? '从未'} sync_truncated=${a.sync_truncated} backfill_page=${a.backfill_page ?? '-'}`),
      '',
      '== 适配器开关 ==',
      ...adapterEnabled.map((a) => `- ${a.key} = ${a.value}`),
      '',
      '== 最近 50 次同步（新→旧） ==',
      ...runs.map((r) =>
        `- [${r.started_at}] ${r.platform} (${r.handle}) mode=${r.mode} status=${r.status}` +
        ` imported=${r.imported} skipped=${r.skipped} waited=${r.waited_ms}ms duration=${r.duration_ms}ms` +
        (r.error_code ? ` error=${r.error_code}: ${r.error_message ?? ''}` : '')),
    ];
    const body = lines.join('\r\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sync-diagnostics.txt"');
    res.send(body);
  });

  // POST /api/sync/all → 一键同步所有已绑定的启用账号（顺序执行，避免同时打多个平台接口）。
  // 每个平台沿用自身增量策略：AtCoder from_second / 牛客 since 截断 / CF·洛谷 已知提交号提前终止。
  // 未绑定账号的平台直接跳过；单平台失败不影响其余平台。
  r.post('/all', asyncHandler(async (_req, res) => {
    const accounts = db
      .prepare(
        'SELECT platform, handle FROM platform_accounts WHERE user_id = ? AND enabled = 1 ORDER BY platform',
      )
      .all(DEFAULT_USER_ID) as Array<{ platform: PlatformId; handle: string }>;
    const results = [];
    for (const acc of accounts) {
      const started = Date.now();
      const result = await syncPlatform(db, acc.platform, acc.handle, { triggeredBy: 'all' });
      results.push({ ...result, durationMs: Date.now() - started });
    }
    res.json({ results });
  }));

  // POST /api/sync/auto-continue/cancel  body: { platform }
  // 取消该平台的后台续拉（用户手动同步抢占、或明确不想再等），幂等：无排期时 cancelled=false。
  // 必须注册在 POST /:platform 之前（否则会被当成 platform='auto-continue' 的单段路径处理）。
  r.post('/auto-continue/cancel', (req, res) => {
    const { platform } = req.body ?? {};
    if (!PLATFORMS.some((p) => p.id === platform)) {
      return res.status(400).json({ error: `platform 非法: ${String(platform)}` });
    }
    res.json({ ok: true, cancelled: cancelAutoContinue(platform as PlatformId) });
  });

  // POST /api/sync/:platform  body: { handle, days? }
  // days 为正整数时走「仅同步最近 N 天」窗口模式：补充拉取漏掉的历史，不改账号同步状态。
  r.post('/:platform', asyncHandler(async (req, res) => {
    const { platform } = req.params;
    const { handle, days } = req.body ?? {};
    if (!PLATFORMS.some((p) => p.id === platform)) {
      return res.status(400).json({ error: `platform 非法: ${platform}` });
    }
    if (typeof handle !== 'string' || handle.trim() === '') {
      return res.status(400).json({ error: 'handle 必填' });
    }
    const daysN = Number(days);
    const opts = Number.isInteger(daysN) && daysN > 0
      ? { days: Math.min(365, daysN), triggeredBy: 'days' as const }
      : { triggeredBy: 'manual' as const };
    const result = await syncPlatform(db, platform as PlatformId, handle.trim(), opts);
    // 平台无公开 API 等受限情况返回 200 + errors 引导（非致命）
    res.json(result);
  }));

  return r;
}

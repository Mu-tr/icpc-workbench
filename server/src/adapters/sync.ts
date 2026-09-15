import type {
  PlatformId,
  SyncResult,
} from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { insertNormalized } from '../import/importService.ts';
import { getAdapter } from './registry.ts';
import { createBackup } from '../backup.ts';
import { ManualImportRequiredError, SyncError, type FetchOptions, type SyncErrorCode } from './types.ts';

export interface SyncOptions {
  userId?: number;
  /** 仅同步最近 N 天（补充拉取窗口）：不改 platform_accounts 状态，插入仍按唯一键去重 */
  days?: number;
  /** 同步触发来源（写入 sync_runs.triggered_by，供同步中心展示） */
  triggeredBy?: 'manual' | 'retry' | 'days' | 'all';
}

/** 每个平台建议的同步间隔（毫秒）：按平台风控强度选定，同步中心据此展示「下次推荐同步时间」 */
const SUGGESTED_SYNC_INTERVAL_MS: Partial<Record<PlatformId, number>> = {
  codeforces: 2 * 3600_000,
  atcoder: 6 * 3600_000,
  luogu: 6 * 3600_000,
  nowcoder: 12 * 3600_000,
  leetcode: 12 * 3600_000,
  daimayuan: 12 * 3600_000,
  // QOJ：前置 Cloudflare，请求密度越低越安全；提交记录按页（10 条/页）拉取，不宜过于频繁
  qoj: 12 * 3600_000,
};
const DEFAULT_SYNC_INTERVAL_MS = 12 * 3600_000;

/**
 * 将同步过程中的异常归类为可解释错误码（sync_runs.error_code）：
 * 优先识别显式 SyncError，再按既有适配器错误消息的特征回退匹配。
 */
export function classifySyncError(e: unknown): SyncErrorCode {
  if (e instanceof SyncError) return e.code;
  if (e instanceof ManualImportRequiredError) return 'manual_required';
  const msg = String((e as Error)?.message ?? '');
  if (/HTTP 429|限流|Too Many Requests/i.test(msg)) return 'rate_limited';
  if (/HTTP 40[13]|Cookie|风控|登录|auth/i.test(msg)) return 'auth_expired';
  if (/结构|解析失败|页面异常|parse/i.test(msg)) return 'schema_changed';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout|abort|网络/i.test(msg)) return 'network';
  return 'unknown';
}

/** 单次同步新增提交数默认上限与取值范围（分批拉取防封号）；与 settings 路由共用同一约束。
 *  保守取值：默认 500 条/次，可调 100–1500。重型用户（>2000 条）需多次点击同步逐步补全，
 *  但每次请求量小、耗时可控，最大程度避免触发平台风控封号。 */
export const DEFAULT_SYNC_MAX_SUBMISSIONS = 500;
export const MIN_SYNC_MAX_SUBMISSIONS = 100;
export const MAX_SYNC_MAX_SUBMISSIONS = 1500;

/** 库中该平台已有的平台侧提交号（适配器提前终止分页用） */
function loadKnownExternalIds(
  db: Db,
  userId: number,
  platform: PlatformId,
): Set<string> {
  const rows = db
    .prepare('SELECT external_id FROM submissions WHERE user_id = ? AND platform = ?')
    .all(userId, platform) as Array<{ external_id: string }>;
  return new Set(rows.map((r) => r.external_id));
}

/** 读取单次同步上限设置（sync.maxSubmissions），越界回退默认值 */
export function readMaxSubmissions(db: Db): number {
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('sync.maxSubmissions') as { value: string } | undefined;
  const n = Number(row?.value);
  if (!Number.isInteger(n) || n < MIN_SYNC_MAX_SUBMISSIONS || n > MAX_SYNC_MAX_SUBMISSIONS) {
    return DEFAULT_SYNC_MAX_SUBMISSIONS;
  }
  return n;
}

/** AtCoder 按 epoch 升序拉取（最旧→最新），其余平台均按新→旧 */
function isAscendingPlatform(platform: PlatformId): boolean {
  return platform === 'atcoder';
}

/**
 * 同步某个平台账号的刷题记录（分批防封号）：
 * 1. 检查平台开关（settings.adapter.<platform>.enabled，缺省启用）
 * 2. 读取 platform_accounts.last_sync_at / sync_truncated 做增量或补全
 * 3. 适配器按 maxSubmissions 上限分批拉取 → insertNormalized 事务入库
 * 4. 更新 last_sync_at / sync_truncated 与账号信息
 *
 * 防封号策略：单次同步只拉 maxSubmissions 条新增（默认 1000），触及上限即停止并标记
 * sync_truncated=1；下次同步自动进入补全模式（backfill）继续拉取更早的历史，把原本一次性的
 * 全量拉取拆成多次小批量，避免短时间内大量请求触发平台风控。补全模式跳过已入库的页继续向更旧翻；
 * 当某次补全一无所获（已无可达早期记录）时自动结束补全。
 * 平台无公开 API（ManualImportRequiredError）→ 转为引导提示而非失败。
 */
export async function syncPlatform(
  db: Db,
  platform: PlatformId,
  handle: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const userId = opts.userId ?? DEFAULT_USER_ID;
  const result: SyncResult = { platform, handle, imported: 0, skipped: 0, errors: [] };

  const adapter = getAdapter(platform);
  if (!adapter) {
    result.errors.push(`未注册适配器: ${platform}`);
    return result;
  }
  const enabledRaw = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(`adapter.${platform}.enabled`) as { value: string } | undefined;
  if (enabledRaw?.value === 'false') {
    result.errors.push(`平台 ${platform} 已禁用（可在设置中开启）`);
    return result;
  }

  // 同步历史（sync_runs）：无论成败都记录，供同步中心展示失败原因与限速等待
  const startedAt = new Date().toISOString();
  const startedTick = Date.now();
  let mode: 'full' | 'incremental' | 'backfill' | 'days' = 'incremental';
  let waitedMs = 0;
  let truncated = false;

  const daysWindow = opts.days && opts.days > 0 ? opts.days : 0;

  const account = db
    .prepare('SELECT handle, last_sync_at, sync_truncated, backfill_page FROM platform_accounts WHERE user_id = ? AND platform = ?')
    .get(userId, platform) as { handle: string; last_sync_at: string | null; sync_truncated: number; backfill_page: number | null } | undefined;
  // 换账号判定：handle 不同，或从未成功同步过（last_sync_at 为空，如设置页改绑后）。
  // 两种情况都要求全量重拉 + 清空该平台旧数据，避免跨账号数据混入或增量起点错乱。
  // 注意：同 handle 首次成功同步时也会清空该平台旧数据（含手动导入记录）——
  // 语义是"同步以平台数据为准"，手动导入数据会被平台数据取代。
  // days 窗口模式是补充拉取，不改账号状态、不触发清空。
  const handleChanged =
    !daysWindow &&
    account !== undefined &&
    (account.handle !== handle || !account.last_sync_at);

  try {
    // 换账号会清空该平台旧提交：先建「重置前」恢复点（失败只记日志，不阻塞同步）
    if (handleChanged) {
      try {
        const b = createBackup(db, 'pre-reset');
        console.log(`[backup] 换账号重置前备份已创建: ${b.file}`);
      } catch (e) {
        console.error(`[backup] 重置前备份失败（继续同步）: ${(e as Error).message}`);
      }
    }
    // 换账号/未成功同步过：全量重拉（不沿用可能属于旧账号的增量起点）
    const since =
      daysWindow
        ? new Date(Date.now() - daysWindow * 86_400_000).toISOString()
        : !handleChanged && account?.last_sync_at ? account.last_sync_at : undefined;
    // 声明支持已知提交号过滤的适配器（CF/洛谷/牛客，拉取按新到旧排序）：
    // 注入库中已有提交号，适配器整页已知即提前终止分页，实现真实增量。
    // days 窗口模式不注入（否则整页已知会提前终止，覆盖不到窗口内漏拉的历史），
    // 窗口终止由 since 早停承担，重复插入由唯一键去重兜底。
    const knownExternalIds =
      !daysWindow && !handleChanged && adapter.knownIdsFilter
        ? loadKnownExternalIds(db, userId, platform)
        : undefined;
    // 需登录平台：从 settings 读取 Cookie / CSRF 注入适配器
    const readSetting = (key: string): string | undefined => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row?.value;
    };
    const cookie = readSetting(`cookie.${platform}`);
    const csrf = readSetting(`csrf.${platform}`);
    // 复刻浏览器 UA（QOJ 等 cf_clearance 绑定 UA 的平台需要；缺省由适配器用内置 UA）
    const ua = readSetting(`ua.${platform}`);
    const maxSubmissions = readMaxSubmissions(db);
    // 计蒜客练习（题库）提交开关：缺省开启，仅字面量 'false' 关闭
    const practiceSync = platform === 'jisuanke'
      ? readSetting('jisuanke.practiceSync') !== 'false'
      : undefined;
    // 补全模式：上次同步被截断（仍有更早历史待拉），且非换账号全量重拉
    const backfill = !daysWindow && !handleChanged && account?.sync_truncated === 1;
    mode = daysWindow ? 'days' : handleChanged ? 'full' : backfill ? 'backfill' : 'incremental';

    // 始终传入一个完整对象，便于适配器回写 truncated / backfillReachedPage / waitedMs out 字段。
    // windowSince 仅在 days 窗口模式注入：降序平台分页按窗口起点提前终止；
    // 常规增量绝不注入时间截断（牛客存在提交晚于其提交时间出现在列表的真实场景）。
    const fetchOpts: FetchOptions = {
      ...(since ? { since } : {}),
      ...(daysWindow && since ? { windowSince: since } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { csrf } : {}),
      ...(ua ? { ua } : {}),
      ...(knownExternalIds ? { knownExternalIds } : {}),
      maxSubmissions,
      ...(practiceSync !== undefined ? { practiceSync } : {}),
      ...(backfill ? { backfill: true } : {}),
      ...(backfill && account?.backfill_page ? { backfillFromPage: account.backfill_page } : {}),
    };
    const rows = await adapter.fetchUserSubmissions(handle, fetchOpts);
    truncated = fetchOpts.truncated === true;
    waitedMs = fetchOpts.waitedMs ?? 0;
    const reachedPage = fetchOpts.backfillReachedPage;

    // 换账号：全量重拉，并在同一事务内清空该平台旧提交再写入新数据
    const r = insertNormalized(db, userId, rows, {
      clearPlatform: handleChanged ? platform : undefined,
    });
    result.imported = r.imported;
    result.skipped = r.skipped;
    if (!daysWindow && !handleChanged && (since || (knownExternalIds && knownExternalIds.size > 0))) {
      result.incremental = true;
    }

    // days 窗口模式为补充拉取：不改 platform_accounts 状态（last_sync_at / 补全游标保持原样）
    if (daysWindow) {
      result.note = `已同步最近 ${daysWindow} 天：新增 ${r.imported} 条（重复 ${r.skipped} 条自动跳过）。`;
      recordSyncRun(db, userId, platform, handle, startedAt, startedTick, {
        mode, status: 'ok', imported: r.imported, skipped: r.skipped, truncated: false, waitedMs,
        triggeredBy: opts.triggeredBy ?? 'days', nextSuggestedSyncAt: null,
      });
      return result;
    }

    // last_sync_at 推进策略：
    // - 升序平台（AtCoder，按 epoch 升序、用 since/from_second 续拉）：被截断时推进到「本次拉到的
    //   最新提交时间」，下次同步从该时间点继续向前补全；未截断则推进到当前时刻。
    // - 降序平台（CF/洛谷/牛客等，按新→旧、用 knownIds 增量）：始终推进到当前时刻——它们的增量
    //   依赖 knownExternalIds 而非 since，last_sync_at 仅用于换账号判定与增量标记，补全由
    //   sync_truncated 驱动 backfill 跳页实现，与 last_sync_at 取值无关。
    let nextLastSyncAt: string;
    if (truncated && isAscendingPlatform(platform) && rows.length > 0) {
      nextLastSyncAt = rows.reduce(
        (max, x) => (x.submittedAt > max ? x.submittedAt : max),
        rows[0].submittedAt,
      );
    } else {
      nextLastSyncAt = new Date().toISOString();
    }
    // sync_truncated：截断（仍有更早历史）置 1，否则（自然结束 / 补全一无所获）清 0
    const nextTruncated = truncated ? 1 : 0;
    // backfill_page：截断时记录本次拉到的最深页（下次续拉），自然结束/补全完成时清空
    const nextBackfillPage = truncated && reachedPage ? reachedPage : null;

    db.prepare(
      `INSERT INTO platform_accounts (user_id, platform, handle, last_sync_at, enabled, sync_truncated, backfill_page)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(user_id, platform) DO UPDATE SET
         handle = excluded.handle,
         last_sync_at = excluded.last_sync_at,
         enabled = 1,
         sync_truncated = excluded.sync_truncated,
         backfill_page = excluded.backfill_page`,
    ).run(userId, platform, handle, nextLastSyncAt, nextTruncated, nextBackfillPage);

    if (truncated) {
      result.truncated = true;
      result.note =
        `提交记录较多，已分批同步 ${r.imported} 条以防触发平台风控；再次点击同步可继续补全更早的历史记录。` +
        `（单次上限可在「设置 → 平台账号与适配器」中调整）`;
    }
    recordSyncRun(db, userId, platform, handle, startedAt, startedTick, {
      mode, status: 'ok', imported: r.imported, skipped: r.skipped, truncated, waitedMs,
      triggeredBy: opts.triggeredBy ?? 'manual',
      nextSuggestedSyncAt: new Date(Date.now() + (SUGGESTED_SYNC_INTERVAL_MS[platform] ?? DEFAULT_SYNC_INTERVAL_MS)).toISOString(),
    });
  } catch (e) {
    const code = classifySyncError(e);
    if (e instanceof ManualImportRequiredError) {
      result.errors.push(e.message);
    } else {
      result.errors.push((e as Error).message);
    }
    recordSyncRun(db, userId, platform, handle, startedAt, startedTick, {
      mode, status: 'failed', imported: 0, skipped: 0, truncated: false, waitedMs,
      triggeredBy: opts.triggeredBy ?? 'manual', nextSuggestedSyncAt: null,
      errorCode: code, errorMessage: (e as Error).message,
    });
  }
  return result;
}

/** 写入一条同步历史（sync_runs）。 */
function recordSyncRun(
  db: Db,
  userId: number,
  platform: PlatformId,
  handle: string,
  startedAt: string,
  startedTick: number,
  data: {
    mode: string;
    status: 'ok' | 'failed';
    imported: number;
    skipped: number;
    truncated: boolean;
    waitedMs: number;
    triggeredBy: string;
    nextSuggestedSyncAt: string | null;
    errorCode?: SyncErrorCode;
    errorMessage?: string;
  },
): void {
  db.prepare(
    `INSERT INTO sync_runs (user_id, platform, handle, started_at, finished_at, duration_ms,
       imported, skipped, truncated, waited_ms, mode, status, error_code, error_message,
       triggered_by, next_suggested_sync_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    userId, platform, handle, startedAt, new Date().toISOString(), Date.now() - startedTick,
    data.imported, data.skipped, data.truncated ? 1 : 0, data.waitedMs, data.mode, data.status,
    data.errorCode ?? null, data.errorMessage ?? null, data.triggeredBy, data.nextSuggestedSyncAt,
  );
}

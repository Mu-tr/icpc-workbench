import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db/index.ts';

/**
 * SQLite 备份与恢复点：
 * - createBackup 用 VACUUM INTO 生成一致快照（WAL 模式下安全，无需停服）。
 * - 备份目录默认为数据库同级的 backups/；可通过 dir 参数覆盖（测试用）。
 * - 恢复采用「标记 + 重启生效」：进程内热恢复会与打开中的连接/WAL 冲突，
 *   因此只写 restore-pending.json，两个启动入口在 createDb 前调用
 *   applyPendingRestore 完成覆盖。
 */

export type BackupReason = 'manual' | 'daily' | 'pre-upgrade' | 'pre-import' | 'pre-reset';

/** 各 reason 的保留份数：超出后从最旧开始清理 */
const KEEP_PER_REASON: Record<BackupReason, number> = {
  manual: 10,
  daily: 7,
  'pre-upgrade': 3,
  'pre-import': 3,
  'pre-reset': 3,
};
/** 所有备份的总上限（兜底，防止磁盘无限膨胀） */
const KEEP_TOTAL = 30;

const FILE_RE = /^icpc-(\d{8}-\d{6})-([a-z-]+)\.db$/;

interface BackupMeta {
  file: string;
  reason: BackupReason;
  createdAtMs: number;
  size: number;
}

/** 从数据库句柄推导备份目录（数据库同级的 backups/）；内存库无文件路径 → 必须传 dir */
export function backupDirFor(db: Db, dir?: string): string {
  if (dir) return dir;
  const rows = db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>;
  const main = rows.find((r) => r.name === 'main');
  if (!main?.file) throw new Error('无法确定数据库文件路径（内存库需显式传入备份目录）');
  return path.join(path.dirname(main.file), 'backups');
}

function listBackupFiles(dir: string): BackupMeta[] {
  if (!fs.existsSync(dir)) return [];
  const out: BackupMeta[] = [];
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(FILE_RE);
    if (!m) continue;
    const stat = fs.statSync(path.join(dir, f));
    if (!stat.isFile()) continue;
    out.push({ file: f, reason: m[2] as BackupReason, createdAtMs: stat.mtimeMs, size: stat.size });
  }
  return out.sort((a, b) => b.createdAtMs - a.createdAtMs);
}

function timestampFor(d = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** 创建备份（VACUUM INTO 一致快照），随后按保留策略清理旧备份。失败时抛错由调用方决定如何呈现。 */
export function createBackup(db: Db, reason: BackupReason, dir?: string): { file: string; size: number } {
  const backupDir = backupDirFor(db, dir);
  fs.mkdirSync(backupDir, { recursive: true });
  // 同一秒内可能创建多个备份（如连续手动点击）：文件已存在时退避到带毫秒后缀
  let file = `icpc-${timestampFor()}-${reason}.db`;
  if (fs.existsSync(path.join(backupDir, file))) {
    file = `icpc-${timestampFor()}-${reason}-${Date.now() % 1000}.db`;
  }
  const target = path.join(backupDir, file);
  // VACUUM INTO 要求目标不存在；路径中的单引号需要转义（SQL 字面量）
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  pruneBackups(db, reason, dir);
  return { file, size: fs.statSync(target).size };
}

/** 按保留策略清理：同 reason 保留最近 KEEP_PER_REASON 份，总量兜底 KEEP_TOTAL */
export function pruneBackups(db: Db, reason: BackupReason, dir?: string): void {
  const backupDir = backupDirFor(db, dir);
  const all = listBackupFiles(backupDir);
  const sameReason = all.filter((b) => b.reason === reason);
  const doomed = new Set(sameReason.slice(KEEP_PER_REASON[reason]).map((b) => b.file));
  if (all.length > KEEP_TOTAL) {
    for (const b of all.slice(KEEP_TOTAL)) doomed.add(b.file);
  }
  for (const f of doomed) {
    try {
      fs.unlinkSync(path.join(backupDir, f));
    } catch {
      // 清理失败不阻塞备份主流程
    }
  }
}

/** 列出全部备份（新→旧） */
export function listBackups(db: Db, dir?: string): BackupMeta[] {
  return listBackupFiles(backupDirFor(db, dir));
}

const RESTORE_MARKER = 'restore-pending.json';

/**
 * 请求恢复：校验目标备份存在后写 restore-pending.json，重启时由
 * applyPendingRestore 覆盖数据库文件。返回实际写入的标记内容。
 */
export function requestRestore(db: Db, file: string, dir?: string): { file: string; requestedAt: string } {
  const backupDir = backupDirFor(db, dir);
  if (!FILE_RE.test(file) || !fs.existsSync(path.join(backupDir, file))) {
    throw new Error(`备份不存在或名称非法: ${file}`);
  }
  const dataDir = path.dirname(backupDir);
  const marker = { file, requestedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dataDir, RESTORE_MARKER), JSON.stringify(marker), 'utf8');
  return marker;
}

/**
 * 启动时应用待恢复标记（必须在 createDb 之前调用）：
 * 用备份覆盖数据库文件（连同删除 WAL/SHM 残留），成功或失败都清除标记。
 * 返回已恢复的备份文件名；无标记或恢复未执行时返回 null。
 */
export function applyPendingRestore(dbPath: string, dataDir?: string): string | null {
  const markerPath = path.join(path.dirname(dbPath), RESTORE_MARKER);
  if (!fs.existsSync(markerPath)) return null;
  let file: string | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { file?: string };
    file = typeof raw.file === 'string' ? raw.file : null;
  } catch {
    fs.rmSync(markerPath, { force: true });
    return null;
  }
  fs.rmSync(markerPath, { force: true });
  if (!file || !FILE_RE.test(file)) return null;
  const backupDir = path.join(path.dirname(dbPath), 'backups');
  const source = path.join(backupDir, file);
  if (!fs.existsSync(source)) return null;
  try {
    fs.copyFileSync(source, dbPath);
    for (const suffix of ['-wal', '-shm']) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
    console.log(`[backup] 已恢复备份 ${file}，数据库回滚到该时间点`);
    return file;
  } catch (e) {
    console.error(`[backup] 恢复备份失败（继续使用现有数据库）: ${(e as Error).message}`);
    return null;
  }
}

/** 每日首次启动备份：settings 键 backup.lastDailyAt 记录最近备份日期（UTC），幂等 */
export function maybeDailyBackup(db: Db, dir?: string): { created: boolean; file?: string } {
  const today = new Date().toISOString().slice(0, 10);
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'backup.lastDailyAt'")
    .get() as { value: string } | undefined;
  if (row?.value === today) return { created: false };
  const { file } = createBackup(db, 'daily', dir);
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('backup.lastDailyAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(today);
  return { created: true, file };
}

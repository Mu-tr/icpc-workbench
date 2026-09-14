import express from 'express';
import type { Server } from 'node:http';
import { aiConfigFromDb, loadConfig } from './config.ts';
import { createDb } from './db/index.ts';
import { applyPendingRestore, createBackup, maybeDailyBackup } from './backup.ts';
import { seedBuiltinBank } from './db/builtinBank.ts';
import { initAdapters } from './adapters/index.ts';
import { asyncHandler } from './asyncHandler.ts';
import { errorHandler, securityHeaders } from './middleware.ts';
import { backupsRoutes } from './routes/backups.ts';
import { checkinsRoutes } from './routes/checkins.ts';
import { contestsRoutes } from './routes/contests.ts';
import { aiRoutes } from './routes/ai.ts';
import { exportRoutes } from './routes/export.ts';
import { importRoutes } from './routes/import.ts';
import { knowledgeRoutes } from './routes/knowledge.ts';
import { listsRoutes } from './routes/lists.ts';
import { plansRoutes } from './routes/plans.ts';
import { problemsRoutes } from './routes/problems.ts';
import { reviewsRoutes } from './routes/reviews.ts';
import { settingsRoutes } from './routes/settings.ts';
import { statsRoutes } from './routes/stats.ts';
import { syncRoutes } from './routes/sync.ts';
import { templatesRoutes } from './routes/templates.ts';
import { todayRoutes } from './routes/today.ts';
import { updateRoutes, APP_VERSION } from './routes/update.ts';
import { widgetRoutes } from './routes/widget.ts';
import { PLATFORMS } from '../../shared/src/index.ts';
import { initKnowledgeStore, loadAnnotationsIntoDb, purgeAiAnnotations } from './knowledge/store.ts';

const config = loadConfig();
// 恢复点回滚：必须在 createDb 之前应用（覆盖数据库文件）
applyPendingRestore(config.dbPath);
const db = createDb(config.dbPath);
seedBuiltinBank(db); // 内置题库播种：版本变化时 upsert 一次，日常启动零开销
initAdapters(config.dataDir);
// 知识点管线：JSONL 源真相 → SQLite 索引幂等重建（无 JSONL 时零开销）
initKnowledgeStore(config.dataDir);
try {
  const purged = purgeAiAnnotations(db, { dataDir: config.dataDir });
  if (purged.deleted > 0 || purged.tombstones > 0) {
    console.log(`[knowledge] 已清理 AI 标注: 删除 ${purged.deleted} 条，写入 ${purged.tombstones} 个 tombstone`);
  }
} catch (e) {
  console.error(`[knowledge] AI 标注清理失败（不影响启动）: ${(e as Error).message}`);
}
try {
  const loaded = loadAnnotationsIntoDb(db, config.dataDir);
  if (loaded.lines > 0) {
    console.log(`[knowledge] 已从 JSONL 重建索引: ${loaded.inserted} 条标注 / ${loaded.problems} 题（跳过未知 code ${loaded.skippedUnknownCode}）`);
  }
} catch (e) {
  console.error(`[knowledge] JSONL 索引重建失败（不影响启动）: ${(e as Error).message}`);
}
// 每日首次启动自动备份（settings 键幂等）；失败不阻塞启动
try {
  const daily = maybeDailyBackup(db);
  if (daily.created) console.log(`[backup] 已创建每日备份 ${daily.file}`);
} catch (e) {
  console.error(`[backup] 每日备份失败（不影响启动）: ${(e as Error).message}`);
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(securityHeaders);

app.use('/api/import', importRoutes(db));
app.use('/api/sync', syncRoutes(db));
app.use('/api/stats', statsRoutes(db));
app.use('/api/plans', plansRoutes(db, () => aiConfigFromDb(db, config)));
app.use('/api/ai', aiRoutes(db, () => aiConfigFromDb(db, config)));
app.use('/api/lists', listsRoutes(db, () => aiConfigFromDb(db, config)));
app.use('/api/knowledge', knowledgeRoutes(db));
app.use('/api/export', exportRoutes(db));
app.use('/api/problems', problemsRoutes(db));
app.use('/api/reviews', reviewsRoutes(db));
app.use('/api/today', todayRoutes(db));
app.use('/api/templates', templatesRoutes(db));
app.use('/api/contests', contestsRoutes());
app.use('/api/checkins', checkinsRoutes(db));
app.use('/api/settings', settingsRoutes(db, config));
app.use('/api/backups', backupsRoutes(db));
app.use('/api/update', updateRoutes(config, () => createBackup(db, 'pre-upgrade')));
app.use('/widget', widgetRoutes());

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    platforms: PLATFORMS.map((p) => p.id),
    dbPath: config.dbPath,
    version: APP_VERSION,
  });
});

// 全局错误中间件：必须放在所有路由之后
app.use(errorHandler);

const port = Number(process.env.PORT ?? config.port);
// 这是本地单用户应用：绝不默认暴露到局域网。若以后需要远程访问，应单独
// 设计认证和 TLS，而不是通过修改此处的默认行为绕过安全边界。
const server: Server = app.listen(port, '127.0.0.1', () => {
  console.log(`[server] listening on http://localhost:${port}`);
  console.log(`[server] widget page: http://localhost:${port}/widget`);
});
server.on('error', (e: NodeJS.ErrnoException) => {
  // Windows 上 3000-3xxx 段可能被 Hyper-V/winnat 动态保留（重启后区间变化），
  // 绑定报 EACCES——给出可操作的解法，而不是一句 "listen EACCES" 让人无从下手。
  if (e.code === 'EACCES') {
    console.error(
      `[server] 端口 ${port} 被系统保留，无法监听（Windows Hyper-V/winnat 动态保留区间，重启后可能变化）。\n` +
        `[server] 解法（任选其一）：\n` +
        `[server]   1. 管理员 PowerShell 执行: net stop winnat; net start winnat  （释放动态保留）\n` +
        `[server]   2. 换端口启动: PORT=4100 npm run dev  （前端代理需同步改 client/vite.config.ts）`,
    );
  } else {
    console.error(`[server] 监听端口 ${port} 失败: ${e.message}`);
  }
  process.exit(1);
});

// Graceful shutdown：收到信号时关闭 HTTP 连接与数据库，避免 WAL 写入中途被强制终止
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[server] shutting down…');
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // 兜底：5 秒后仍未退出则强制退出
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

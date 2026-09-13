import { Router } from 'express';
import type { Db } from '../db/index.ts';
import { asyncHandler } from '../asyncHandler.ts';
import { createBackup, listBackups, requestRestore } from '../backup.ts';

export function backupsRoutes(db: Db): Router {
  const r = Router();

  // GET /api/backups → 恢复点列表（新→旧）
  r.get('/', (_req, res) => {
    res.json({
      backups: listBackups(db).map((b) => ({
        file: b.file,
        reason: b.reason,
        createdAtMs: b.createdAtMs,
        size: b.size,
      })),
    });
  });

  // POST /api/backups → 手动创建恢复点
  r.post('/', (req, res) => {
    try {
      const b = createBackup(db, 'manual');
      res.json({ ok: true, file: b.file, size: b.size });
    } catch (e) {
      res.status(500).json({ error: `备份创建失败: ${(e as Error).message}` });
    }
  });

  // POST /api/backups/:name/restore → 请求恢复（写标记，重启应用后生效）
  r.post('/:name/restore', asyncHandler(async (req, res) => {
    try {
      const marker = requestRestore(db, String(req.params.name));
      res.json({ ok: true, needRestart: true, ...marker, message: '已登记恢复请求：重启应用后，数据库将回滚到该恢复点。' });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  }));

  return r;
}

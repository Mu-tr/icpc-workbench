import { Router } from 'express';
import type { ManualSubmissionRow, PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { insertNormalized } from '../import/importService.ts';
import { previewImport } from '../import/preview.ts';
import { parseCsvRowsWithReport, parseManualRow, parseManualRowsWithReport } from '../import/rows.ts';
import { createBackup } from '../backup.ts';

/** 单次导入行数达到该阈值时先建「导入前」恢复点（防误导入大批脏数据） */
const IMPORT_BACKUP_THRESHOLD = 20;

export function importRoutes(db: Db): Router {
  const r = Router();

  // 批量导入前的恢复点：失败只记日志，不阻塞导入
  const preImportBackup = (rowCount: number): void => {
    if (rowCount < IMPORT_BACKUP_THRESHOLD) return;
    try {
      const b = createBackup(db, 'pre-import');
      console.log(`[backup] 导入前备份已创建: ${b.file}（${rowCount} 行）`);
    } catch (e) {
      console.error(`[backup] 导入前备份失败（继续导入）: ${(e as Error).message}`);
    }
  };

  // POST /api/import/preview  body: { platform, rows? | csv? }
  // 变更预览：不写库，返回将新增/跳过的提交数、题目新建/更新数与逐行非法明细。
  r.post('/preview', (req, res) => {
    const { platform, rows, csv } = req.body ?? {};
    if (!isPlatform(platform)) {
      return res.status(400).json({ error: `platform 非法: ${String(platform)}` });
    }
    try {
      let report;
      if (Array.isArray(rows)) {
        report = parseManualRowsWithReport(platform as PlatformId, rows as ManualSubmissionRow[]);
      } else if (typeof csv === 'string') {
        report = parseCsvRowsWithReport(platform as PlatformId, csv);
      } else {
        return res.status(400).json({ error: 'rows（数组）或 csv（字符串）必填其一' });
      }
      const preview = previewImport(db, DEFAULT_USER_ID, report.subs);
      res.json({ total: report.subs.length + report.invalid.length, valid: report.subs.length, invalid: report.invalid, preview });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  r.post('/manual', (req, res) => {
    const { platform, rows } = req.body ?? {};
    if (!isPlatform(platform)) {
      return res.status(400).json({ error: `platform 非法: ${String(platform)}` });
    }
    if (!Array.isArray(rows)) {
      return res.status(400).json({ error: 'rows 必须是数组' });
    }
    try {
      const subs = rows.map((row, i) =>
        parseManualRow(platform as PlatformId, row as ManualSubmissionRow, i),
      );
      preImportBackup(subs.length);
      res.json(insertNormalized(db, DEFAULT_USER_ID, subs));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  r.post('/csv', (req, res) => {
    const { platform, csv } = req.body ?? {};
    if (!isPlatform(platform)) {
      return res.status(400).json({ error: `platform 非法: ${String(platform)}` });
    }
    if (typeof csv !== 'string') {
      return res.status(400).json({ error: 'csv 必须是字符串' });
    }
    try {
      const report = parseCsvRowsWithReport(platform as PlatformId, csv);
      if (report.invalid.length > 0) {
        // 与预览前的历史行为一致：直接导入路径遇到非法行仍整批拒绝（预览流程才容忍部分合法行）
        return res.status(400).json({ error: report.invalid[0].error });
      }
      preImportBackup(report.subs.length);
      res.json(insertNormalized(db, DEFAULT_USER_ID, report.subs));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  return r;
}

function isPlatform(p: unknown): p is PlatformId {
  return typeof p === 'string' && PLATFORMS.some((x) => x.id === p);
}

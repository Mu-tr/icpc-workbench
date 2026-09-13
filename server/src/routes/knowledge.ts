import { Router } from 'express';
import type { Db } from '../db/index.ts';
import type { AiConfig } from '../config.ts';
import type { KnowledgeCompareReport } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import { asyncHandler } from '../asyncHandler.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { AiProvider } from '../ai/provider.ts';
import { allPoints, isValidCode, loadTaxonomy } from '../knowledge/taxonomy.ts';
import {
  getConfidenceThreshold,
  getCoverage,
  keypointsOfProblem,
  setConfidenceThreshold,
  setManualKeypoints,
} from '../knowledge/store.ts';
import { PIPELINE_CODE_VERSION, pendingAiCount, pipelineVersion, retryFailedQueue, runRulePass } from '../knowledge/pipeline.ts';
import { loadRules, rulesVersion } from '../knowledge/ruleEngine.ts';
import { exportQueuePackage, importAiResults, runAiPass } from '../knowledge/aiClassify.ts';
import { computeWeakness } from '../analysis/weakness.ts';
import { rate } from '../analysis/stats.ts';

export function knowledgeRoutes(db: Db, getAiConfig: () => AiConfig): Router {
  const r = Router();

  // POST /api/knowledge/build  body: { mode?: 'l1'|'l2'|'all', rerun?: boolean, maxBatches? }
  // 跑管线：L1 规则批跑（增量或版本差量重跑）；L2 需已配置 AI，无 Key 时返回待标注数与导出提示
  r.post('/build', asyncHandler(async (req, res) => {
    const mode = ['l1', 'l2', 'all'].includes(String(req.body?.mode)) ? String(req.body.mode) : 'all';
    const rerun = req.body?.rerun === true;
    const maxBatches = Number.isInteger(req.body?.maxBatches) ? Math.max(1, Number(req.body.maxBatches)) : undefined;
    const result: Record<string, unknown> = { ok: true, mode };
    if (mode !== 'l2') {
      result.l1 = runRulePass(db, { rerun });
    }
    if (mode !== 'l1') {
      const provider = new AiProvider(getAiConfig());
      if (!provider.enabled) {
        result.l2 = { skipped: 'AI 未配置，请配置 API Key 或使用导出通道', pending: pendingAiCount(db) };
      } else {
        result.l2 = await runAiPass(db, provider, maxBatches !== undefined ? { maxBatches } : {});
      }
    }
    result.coverage = getCoverage(db);
    res.json(result);
  }));

  // GET /api/knowledge/coverage → 覆盖率报告（题库页「待标注 N 题」与覆盖率展示）
  r.get('/coverage', (_req, res) => {
    res.json(getCoverage(db));
  });

  // GET /api/knowledge/taxonomy → 知识点体系全量（人工校正 UI 的候选树）
  r.get('/taxonomy', (_req, res) => {
    res.json(loadTaxonomy());
  });

  // GET /api/knowledge/problem/:platform/:key → 单题当前标注（题库详情/校正入口）
  r.get('/problem/:platform/:key', (req, res) => {
    if (!PLATFORMS.some((p) => p.id === req.params.platform)) {
      return res.status(400).json({ error: `platform 非法: ${req.params.platform}` });
    }
    res.json({
      platform: req.params.platform,
      problemKey: req.params.key,
      knowledgePoints: keypointsOfProblem(db, req.params.platform, req.params.key),
    });
  });

  // PUT /api/knowledge/:platform/:key  body: { codes: string[] }
  // L3 人工校正：整题覆盖写 source=manual，永久置顶（重跑管线不覆盖 manual）；空数组 = 人工确认「无知识点」
  r.put('/:platform/:key', (req, res) => {
    if (!PLATFORMS.some((p) => p.id === req.params.platform)) {
      return res.status(400).json({ error: `platform 非法: ${req.params.platform}` });
    }
    const codes = req.body?.codes;
    if (!Array.isArray(codes) || codes.some((c) => typeof c !== 'string')) {
      return res.status(400).json({ error: 'codes 需为字符串数组' });
    }
    for (const code of codes as string[]) {
      if (!isValidCode(code)) return res.status(400).json({ error: `未知知识点 code: ${code}` });
    }
    setManualKeypoints(db, req.params.platform, req.params.key, [...new Set(codes as string[])]);
    res.json({ ok: true, knowledgePoints: keypointsOfProblem(db, req.params.platform, req.params.key) });
  });

  // GET /api/knowledge/compare?topN=20 → 切换期双跑：tag 口径 vs 知识点口径弱项 top
  r.get('/compare', (req, res) => {
    const topN = Math.min(50, Math.max(1, Number(req.query.topN) || 20));
    const minAttempts = Math.max(1, Number(req.query.minAttempts) || 5);
    const knowledgeCaliber = computeWeakness(db, DEFAULT_USER_ID, { topN, minAttempts });
    const tagCaliber = computeWeakness(db, DEFAULT_USER_ID, { topN, minAttempts, tagsSql: 'p.tags AS tags' });
    // 未覆盖桶：无达标标注、统计端回退题源 tag 的提交占比
    const t = getConfidenceThreshold(db);
    const uncovered = db
      .prepare(
        `SELECT COUNT(*) AS attempts, COALESCE(SUM(CASE WHEN s.verdict = 'AC' THEN 1 ELSE 0 END), 0) AS ac
         FROM submissions s JOIN problems p ON s.problem_id = p.id
         WHERE s.user_id = ? AND NOT EXISTS (
           SELECT 1 FROM problem_keypoints pk
           WHERE pk.platform = p.platform AND pk.problem_key = p.problem_key AND pk.confidence >= ?
         )`,
      )
      .get(DEFAULT_USER_ID, t) as { attempts: number; ac: number };
    const report: KnowledgeCompareReport = {
      generatedAt: new Date().toISOString(),
      threshold: t,
      tagCaliber: tagCaliber.items,
      knowledgeCaliber: knowledgeCaliber.items,
      uncovered:
        uncovered.attempts > 0
          ? { attempts: uncovered.attempts, ac: uncovered.ac, acRate: rate(uncovered.attempts, uncovered.ac) }
          : null,
    };
    res.json(report);
  });

  // GET /api/knowledge/export-queue?limit=50 → 无 Key 通道：下载待标注题 + 提示词（手动喂任意 AI）
  // 上限 1000：单次 AI 对话建议 100-200 题（输出窗口限制），大包供用户自行拆分喂多轮
  r.get('/export-queue', (req, res) => {
    const limit = Math.min(1000, Math.max(10, Number(req.query.limit) || 50));
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="knowledge-queue.md"');
    res.send(exportQueuePackage(db, limit));
  });

  // POST /api/knowledge/import  body: { raw } ← 手动喂 AI 得到的标注 JSON（同 L2 校验与落库）
  r.post('/import', (req, res) => {
    const raw = req.body?.raw;
    if (typeof raw !== 'string' || raw.trim() === '') {
      return res.status(400).json({ error: 'raw 不能为空（粘贴 AI 返回的 JSON）' });
    }
    try {
      res.json({ ok: true, ...importAiResults(db, raw) });
    } catch (e) {
      res.status(400).json({ error: `标注 JSON 解析失败: ${(e as Error).message}` });
    }
  });

  // GET /api/knowledge/sample?rate=0.01 → 批跑后随机抽检清单（人工复核驱动规则迭代）
  r.get('/sample', (req, res) => {
    const rate01 = Math.min(1, Math.max(0.001, Number(req.query.rate) || 0.01));
    const annotatedCount = (
      db.prepare('SELECT COUNT(*) AS c FROM (SELECT 1 FROM problem_keypoints GROUP BY platform, problem_key)').get() as { c: number }
    ).c;
    const n = Math.max(1, Math.round(annotatedCount * rate01));
    const rows = db
      .prepare(
        `SELECT platform, problem_key AS problemKey, code, name, confidence, source, method
         FROM problem_keypoints
         WHERE (platform, problem_key) IN (
           SELECT platform, problem_key FROM problem_keypoints GROUP BY platform, problem_key ORDER BY RANDOM() LIMIT ?
         )
         ORDER BY platform, problem_key, confidence DESC`,
      )
      .all(n) as unknown as Array<Record<string, unknown>>;
    res.json({ sampleSize: n, rate: rate01, items: rows });
  });

  // POST /api/knowledge/threshold  body: { value: 0..1 } → 统计端置信度阈值（设置页可调）
  r.post('/threshold', (req, res) => {
    const value = Number(req.body?.value);
    try {
      setConfidenceThreshold(db, value);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
    res.json({ ok: true, threshold: getConfidenceThreshold(db) });
  });

  // GET /api/knowledge/meta → 版本信息（taxonomy/管线/规则，审计与排查用）
  // pipelineVersion 为复合版本（代码版本 × 1000 + rules.json 版本），两者都单列出来便于定位差量重跑原因
  r.get('/meta', (_req, res) => {
    res.json({
      taxonomyVersion: loadTaxonomy().version,
      pipelineVersion: pipelineVersion(),
      pipelineCodeVersion: PIPELINE_CODE_VERSION,
      rulesVersion: rulesVersion(),
      rules: loadRules().length,
      codes: allPoints().length,
    });
  });

  // POST /api/knowledge/retry-failed → 把 attempts 超限转 failed 的题捞回 pending（attempts 清零）
  r.post('/retry-failed', (_req, res) => {
    const requeued = retryFailedQueue(db);
    res.json({ ok: true, requeued, coverage: getCoverage(db) });
  });

  return r;
}

import { Router } from 'express';
import type { Db } from '../db/index.ts';
import type { KnowledgeCompareReport } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import { asyncHandler } from '../asyncHandler.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { allPoints, isValidCode, loadTaxonomy } from '../knowledge/taxonomy.ts';
import {
  getConfidenceThreshold,
  getCoverage,
  keypointsOfProblem,
  READABLE_SOURCES_SQL,
  setConfidenceThreshold,
  setManualKeypoints,
} from '../knowledge/store.ts';
import { PIPELINE_CODE_VERSION, gapReport, pipelineVersion, runRulePass } from '../knowledge/pipeline.ts';
import { loadRules, rulesVersion } from '../knowledge/ruleEngine.ts';
import { recomputeConceptStats } from '../knowledge/conceptStats.ts';
import { computeWeakness } from '../analysis/weakness.ts';
import { rate } from '../analysis/stats.ts';

export function knowledgeRoutes(db: Db): Router {
  const r = Router();

  // POST /api/knowledge/build  body: { rerun?: boolean }
  // 跑 L1：规则批跑（增量或版本差量重跑）+ 题源标签映射。
  // AI 已退出清洗模块，故不再有 L2 分支；未覆盖的题进「词表缺口」报告（GET /gaps）。
  r.post('/build', asyncHandler(async (req, res) => {
    const rerun = req.body?.rerun === true;
    const result = { ok: true, l1: runRulePass(db, { rerun }), conceptStats: recomputeConceptStats(db) };
    res.json({ ...result, coverage: getCoverage(db) });
  }));

  // GET /api/knowledge/coverage → 覆盖率报告（总题数 / 已标注 / 未覆盖 / 来源分布 / 阈值）
  r.get('/coverage', (_req, res) => {
    res.json(getCoverage(db));
  });

  // GET /api/knowledge/gaps → 词表缺口报告（补 tags.ts 同义组是提升覆盖率的唯一手段）
  r.get('/gaps', (req, res) => {
    const limit = Number(req.query.limit);
    res.json(gapReport(db, Number.isInteger(limit) ? { limit: Math.min(500, Math.max(1, limit)) } : {}));
  });

  // POST /api/knowledge/recompute-stats → 重算概念统计（覆盖率与信息量）。
  // 当前没有 upsert 触发钩子的概念统计自动重算；此接口供手动修复与 UI 刷新触发。
  r.post('/recompute-stats', (_req, res) => {
    const written = recomputeConceptStats(db);
    res.json({ ok: true, concepts: written, computedAt: new Date().toISOString() });
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
             AND ${READABLE_SOURCES_SQL}
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

  // GET /api/knowledge/sample?rate=0.01 → 批跑后随机抽检清单（人工复核驱动规则迭代）
  r.get('/sample', (req, res) => {
    const rate01 = Math.min(1, Math.max(0.001, Number(req.query.rate) || 0.01));
    const annotatedCount = (
      db.prepare(`SELECT COUNT(*) AS c FROM (SELECT 1 FROM problem_keypoints WHERE ${READABLE_SOURCES_SQL} GROUP BY platform, problem_key)`).get() as { c: number }
    ).c;
    const n = Math.max(1, Math.round(annotatedCount * rate01));
    const rows = db
      .prepare(
        `SELECT platform, problem_key AS problemKey, code, name, confidence, source, method
         FROM problem_keypoints
         WHERE ${READABLE_SOURCES_SQL}
           AND (platform, problem_key) IN (
             SELECT platform, problem_key FROM problem_keypoints WHERE ${READABLE_SOURCES_SQL} GROUP BY platform, problem_key ORDER BY RANDOM() LIMIT ?
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

  return r;
}

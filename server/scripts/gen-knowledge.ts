/**
 * 离线批跑知识点管线（仿 gen-builtin-bank.ts，首版全量建库用）。
 * 用法：
 *   npx tsx scripts/gen-knowledge.ts            # L1 全量首跑（增量：只扫未标注题）
 *   npx tsx scripts/gen-knowledge.ts --rerun    # 规则差量重跑（taxonomy/pipeline 版本落后子集）
 *   npx tsx scripts/gen-knowledge.ts --limit 500
 */
import { loadConfig } from '../src/config.ts';
import { createDb } from '../src/db/index.ts';
import { getCoverage, initKnowledgeStore, loadAnnotationsIntoDb } from '../src/knowledge/store.ts';
import { runRulePass } from '../src/knowledge/pipeline.ts';

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? Number(args[limitIdx + 1]) : undefined;

const config = loadConfig();
const db = createDb(config.dbPath);
initKnowledgeStore(config.dataDir);
const loaded = loadAnnotationsIntoDb(db, config.dataDir);
if (loaded.lines > 0) {
  console.log(`[knowledge] JSONL 重放: ${loaded.lines} 行 → ${loaded.inserted} 条标注 / ${loaded.problems} 题`);
}

const l1 = runRulePass(db, {
  rerun: args.includes('--rerun'),
  ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
});
console.log(`[knowledge] L1: 扫描 ${l1.scanned} 题，命中落库 ${l1.annotated}，入词表缺口 ${l1.enqueued}，manual 跳过 ${l1.skippedManual}`);

const cov = getCoverage(db);
console.log(
  `[knowledge] 覆盖率: ${cov.annotated}/${cov.total} = ${cov.coverage}%` +
    `（rule ${cov.bySource.rule} / tag ${cov.bySource.tag} / manual ${cov.bySource.manual}，` +
    `低置信 ${cov.lowConfidenceOnly}，未覆盖 ${cov.uncovered}，阈值 ${cov.threshold}，` +
    `taxonomy v${cov.taxonomyVersion} / pipeline v${cov.pipelineVersion}）`,
);
db.close();

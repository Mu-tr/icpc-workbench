/**
 * 弱项判断的预测力验证（清洗重构 spec §3.3）。
 *
 * 目的：证明（或证否）「概念级弱项」比「仅看难度」更有预测力。
 * 方法：按时间切分提交，用前 80% 拟合 P(WA | code, bucket)，预测后 20% 的失败，
 * 报告 AUC 并对照「仅用难度桶」的基线。
 *
 * ⚠️ 允许证否：若概念层 AUC 不显著高于难度基线，说明概念无增量价值，
 * 应在输出里明确写出结论并停止扩展该方向，而不是调参到看起来可用。
 *
 * 用法：cd server && node --experimental-transform-types scripts/validate-weakness.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '../src/db/index.ts';
import { bucketForDifficulty } from '../src/analysis/stats.ts';

/** 得分 → 是否为正样本的 AUC（Mann-Whitney U，tie 计 0.5） */
export function auc(scores: number[], labels: boolean[]): number {
  if (scores.length !== labels.length) throw new Error('scores 与 labels 长度不一致');
  const pos: number[] = [];
  const neg: number[] = [];
  for (let i = 0; i < scores.length; i += 1) (labels[i] ? pos : neg).push(scores[i]);
  if (pos.length === 0 || neg.length === 0) return 0.5;
  let wins = 0;
  for (const p of pos) {
    for (const n of neg) {
      if (p > n) wins += 1;
      else if (p === n) wins += 0.5;
    }
  }
  return wins / (pos.length * neg.length);
}

/** 按时间升序切分为 train/test 两段（保证 train 全部早于 test） */
export function splitByTime<T extends { submittedAt: string }>(
  rows: T[],
  trainRatio: number,
): { train: T[]; test: T[] } {
  const sorted = [...rows].sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0));
  const cut = Math.floor(sorted.length * trainRatio);
  return { train: sorted.slice(0, cut), test: sorted.slice(cut) };
}

/** 固定种子 PRNG（mulberry32）：验证工具报出的区间必须可复现，不能用 Math.random。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BOOTSTRAP_ITERS = 2000;
export const BOOTSTRAP_SEED = 20260913;

/**
 * AUC 差值的 bootstrap 标准误（固定种子，可复现）。
 *
 * 为什么必须报：AUC 是统计量，两个 AUC 的差值只有连同**抽样不确定性**一起看才有意义。
 * 本脚本首轮实测就是反例——190 条测试样本上 +0.014 的差值，按点估计正负号会被读成
 * 「概念层胜出」，而它完全落在抽样误差内。spec §3.4 明确要求「不给出确定性结论」。
 *
 * 两个 AUC 共用同一测试集（相互相关），故逐样本有放回重采样、每个重复内同时重算两个 AUC，
 * 这样重采样天然保留了相关性；各自算标准误再相加会高估不确定性。
 *
 * 重采样后某一类缺失的重复会被跳过；有效重复不足 100 次时返回 NaN，调用方据此视为无法判定。
 */
export function bootstrapDiffStdError(
  a: number[],
  b: number[],
  labels: boolean[],
  iters: number = BOOTSTRAP_ITERS,
  seed: number = BOOTSTRAP_SEED,
): number {
  const n = labels.length;
  if (n === 0 || a.length !== n || b.length !== n) return Number.NaN;
  const rand = mulberry32(seed);
  const diffs: number[] = [];
  for (let it = 0; it < iters; it += 1) {
    const sa: number[] = [];
    const sb: number[] = [];
    const sl: boolean[] = [];
    for (let i = 0; i < n; i += 1) {
      const j = Math.floor(rand() * n);
      sa.push(a[j]);
      sb.push(b[j]);
      sl.push(labels[j]);
    }
    if (!sl.some(Boolean) || !sl.some((v) => !v)) continue;
    diffs.push(auc(sa, sl) - auc(sb, sl));
  }
  if (diffs.length < 100) return Number.NaN;
  const mean = diffs.reduce((x, y) => x + y, 0) / diffs.length;
  const variance = diffs.reduce((acc, d) => acc + (d - mean) * (d - mean), 0) / (diffs.length - 1);
  return Math.sqrt(variance);
}

interface SubRow {
  problemId: number;
  verdict: string;
  submittedAt: string;
  difficulty: number | null;
}

function main(): void {
  const dbPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'icpc.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`数据库文件不存在：${dbPath}`);
    console.error('请确认路径正确后再运行验证脚本。');
    process.exit(1);
  }
  const db = createDb(dbPath);
  const subs = db
    .prepare(
      `SELECT s.problem_id AS problemId, s.verdict, s.submitted_at AS submittedAt, p.difficulty
         FROM submissions s JOIN problems p ON p.id = s.problem_id
         WHERE s.user_id = 1`,
    )
    .all() as unknown as SubRow[];

  console.log(`提交样本: ${subs.length} 条`);
  if (subs.length < 50) {
    console.log('⚠️  样本过少（<50），本验证无统计功效，结论不可用。');
    console.log('    这也正是为什么需要 submission_intents：带明确意图的样本信息量远高于模糊的题目标签。');
    db.close();
    return;
  }

  // 每题的知识点 code（problem_keypoints 按 platform+problem_key 与 problems 关联）
  const kpRows = db
    .prepare(
      `SELECT p.id AS problemId, pk.code
         FROM problem_keypoints pk
         JOIN problems p ON p.platform = pk.platform AND p.problem_key = pk.problem_key
        WHERE pk.source IN ('tag','rule','manual')`,
    )
    .all() as unknown as Array<{ problemId: number; code: string }>;
  const codesByProblem = new Map<number, string[]>();
  for (const k of kpRows) {
    const a = codesByProblem.get(k.problemId) ?? [];
    a.push(k.code);
    codesByProblem.set(k.problemId, a);
  }

  const { train, test: testSet } = splitByTime(subs, 0.8);
  // spec 将「知识型失败」限定为 WA/TLE；编译错误 / 跳过 / 运行时异常不属于知识弱点。
  const isFail = (v: string): boolean => v === 'WA' || v === 'TLE';

  // 概念层：按 (code, bucket) 统计训练集失败率
  const stat = new Map<string, { n: number; fail: number }>();
  const bucketStat = new Map<string, { n: number; fail: number }>();
  const bump = (m: Map<string, { n: number; fail: number }>, k: string, fail: boolean): void => {
    const e = m.get(k) ?? { n: 0, fail: 0 };
    e.n += 1;
    if (fail) e.fail += 1;
    m.set(k, e);
  };
  for (const s of train) {
    const b = bucketForDifficulty(s.difficulty);
    const f = isFail(s.verdict);
    bump(bucketStat, b, f);
    for (const c of codesByProblem.get(s.problemId) ?? []) bump(stat, `${c}\u0000${b}`, f);
  }
  const globalFail =
    train.length === 0 ? 0.5 : train.filter((s) => isFail(s.verdict)).length / train.length;

  // 预测
  const conceptScores: number[] = [];
  const bucketScores: number[] = [];
  const labels: boolean[] = [];
  let codesCovered = 0;
  for (const s of testSet) {
    const b = bucketForDifficulty(s.difficulty);
    const codes = codesByProblem.get(s.problemId) ?? [];
    let score = globalFail;
    if (codes.length > 0) {
      codesCovered += 1;
      // 多 code 取失败率最高者：任一知识点薄弱即可能失败
      const rates = codes.map((c) => {
        const e = stat.get(`${c}\u0000${b}`);
        return e && e.n > 0 ? e.fail / e.n : globalFail;
      });
      score = Math.max(...rates);
    }
    conceptScores.push(score);
    const be = bucketStat.get(b);
    bucketScores.push(be && be.n > 0 ? be.fail / be.n : globalFail);
    labels.push(isFail(s.verdict));
  }

  const aConcept = auc(conceptScores, labels);
  const aBucket = auc(bucketScores, labels);
  const posRate = labels.filter(Boolean).length / Math.max(1, labels.length);

  console.log(`\n=== 验证结果 ===`);
  console.log(`  训练/测试: ${train.length} / ${testSet.length}（按时间切分）`);
  console.log(`  测试集失败率: ${(posRate * 100).toFixed(1)}%`);
  console.log(`  测试集中有知识点 code 的题: ${codesCovered} / ${testSet.length}`);
  console.log(`\n  AUC（概念 × 难度）: ${aConcept.toFixed(3)}`);
  console.log(`  AUC（仅难度桶）    : ${aBucket.toFixed(3)}   ← 基线`);
  console.log(`  AUC（随机）        : 0.500`);
  console.log(`\n  增量: ${(aConcept - aBucket >= 0 ? '+' : '')}${(aConcept - aBucket).toFixed(3)}`);

  if (testSet.length < 100) {
    console.log(`\n⚠️  测试集仅 ${testSet.length} 条，AUC 置信区间极宽，以上数字不足以支撑结论。`);
  }
  const coverageRatio = testSet.length > 0 ? codesCovered / testSet.length : 0;
  const coverageOk = coverageRatio >= 0.5;
  const diff = aConcept - aBucket;
  const seDiff = bootstrapDiffStdError(conceptScores, bucketScores, labels);
  const haveCi = Number.isFinite(seDiff);
  const ciLow = haveCi ? diff - 1.96 * seDiff : Number.NaN;
  const ciHigh = haveCi ? diff + 1.96 * seDiff : Number.NaN;
  // 只有区间不跨 0，才能说方向已经站得住。只看点估计的正负号会给出过早结论：
  // 本脚本首轮实测的 +0.014 / -0.017 都落在噪声里，却会被读成「胜出」或「无价值」。
  const conclusive = haveCi && (ciLow > 0 || ciHigh < 0);

  if (haveCi) {
    console.log(`\n  差值 95% 区间: [${ciLow.toFixed(3)}, ${ciHigh.toFixed(3)}]（bootstrap ${BOOTSTRAP_ITERS} 次重采样，固定种子）`);
  } else {
    console.log(`\n  ⚠️ 差值区间无法估计（有效重采样不足或测试集退化），以下只能看点估计。`);
  }

  if (coverageOk && conclusive) {
    if (diff > 0) {
      console.log(`\n✅ 结论：概念层优于难度基线，弱项判断具备增量价值（测试集覆盖率 ${codesCovered}/${testSet.length}，95% 区间下限 ${ciLow.toFixed(3)} > 0）。`);
      console.log(`   按 spec §3.3 的约定，可认为在当前覆盖水平下概念标签具备预测增量价值。`);
    } else {
      console.log(`\n❌ 结论：概念层未跑赢「仅看难度」基线（测试集覆盖率 ${codesCovered}/${testSet.length}，95% 区间上限 ${ciHigh.toFixed(3)} < 0）。`);
      console.log(`   按 spec §3.3 的约定，这表明题目级概念标签对预测失败无增量价值——`);
      console.log(`   应停止扩展该方向，转而依靠 submission_intents 的用户声明。`);
    }
  } else {
    console.log(`\n⚠️ 尚不能下结论：增量 ${(diff >= 0 ? '+' : '')}${diff.toFixed(3)}（概念层${diff > 0 ? '高于' : '不高于'}基线，但证据不足）。`);
    if (!coverageOk) {
      console.log(`   覆盖率不足（${codesCovered}/${testSet.length}）：多数测试题无知识点 code，概念 AUC 主要由全局失败率兜底决定，`);
      console.log(`   当前数字更接近「未证成」而非「证否」。建议先运行完整 POST /api/knowledge/build 提高标注覆盖率，再重新运行本脚本。`);
    }
    if (!conclusive) {
      console.log(`   差距落在抽样误差内（95% 区间含 0）：样本量 ${testSet.length} 条不足以判定方向，`);
      console.log(`   这只是初步迹象，需积累更多提交样本后再判定——不应据此启动或放弃该方向。`);
    }
  }

  // 每概念样本数（功效提示）
  console.log(`\n=== 各 (code × bucket) 训练样本数（<20 视为功效不足） ===`);
  const sorted = [...stat.entries()].sort((a, b) => b[1].n - a[1].n);
  const lowPower = sorted.filter(([, e]) => e.n < 20);
  const top20 = sorted.filter(([, e]) => e.n >= 20).slice(0, 20);
  for (const [k, e] of top20) {
    const [code, b] = k.split('\u0000');
    console.log(`  ${code.padEnd(26)} ${b.padEnd(11)} n=${String(e.n).padStart(4)}  失败率=${((e.fail / e.n) * 100).toFixed(0)}%`);
  }
  if (lowPower.length > 0) {
    console.log(`\n  ⚠️ 以下 (code × bucket) 训练样本 <20，统计功效不足，仅作参考：`);
    for (const [k, e] of lowPower) {
      const [code, b] = k.split('\u0000');
      console.log(`  ${code.padEnd(26)} ${b.padEnd(11)} n=${String(e.n).padStart(4)}  失败率=${((e.fail / e.n) * 100).toFixed(0)}%`);
    }
  }
  db.close();
}

// 仅在被直接执行时跑（被测试 import 时不触发）
if (process.argv[1] && process.argv[1].endsWith('validate-weakness.ts')) main();

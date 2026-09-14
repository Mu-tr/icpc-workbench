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
  const isFail = (v: string): boolean => v !== 'AC';

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
  if (aConcept <= aBucket) {
    console.log(`\n❌ 结论：概念层未跑赢「仅看难度」基线。`);
    console.log(`   按 spec §3.3 的约定，这表明题目级概念标签对预测失败无增量价值——`);
    console.log(`   应停止扩展该方向，转而依靠 submission_intents 的用户声明。`);
  } else {
    console.log(`\n✅ 结论：概念层优于难度基线，弱项判断具备增量价值。`);
  }

  // 每概念样本数（功效提示）
  console.log(`\n=== 各 (code × bucket) 训练样本数（<20 视为功效不足） ===`);
  const sorted = [...stat.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 20);
  for (const [k, e] of sorted) {
    const [code, b] = k.split('\u0000');
    const flag = e.n < 20 ? '  ⚠️ 功效不足' : '';
    console.log(`  ${code.padEnd(26)} ${b.padEnd(11)} n=${String(e.n).padStart(4)}  失败率=${((e.fail / e.n) * 100).toFixed(0)}%${flag}`);
  }
  db.close();
}

// 仅在被直接执行时跑（被测试 import 时不触发）
if (process.argv[1] && process.argv[1].endsWith('validate-weakness.ts')) main();

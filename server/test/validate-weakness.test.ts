import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auc, bootstrapDiffStdError, splitByTime } from '../scripts/validate-weakness.ts';

test('bootstrapDiffStdError: 固定种子可复现，且对退化输入返回 NaN', () => {
  // 两组成绩的正负样本排序都是「混合」的（不是一组恒定、一组完美），
  // 这样重采样才会真的改变各自的 AUC，差值分布才有非零方差。
  const a = [0.9, 0.4, 0.6, 0.1];
  const b = [0.2, 0.8, 0.5, 0.5];
  const labels = [true, true, false, false];
  const first = bootstrapDiffStdError(a, b, labels);
  assert.equal(bootstrapDiffStdError(a, b, labels), first, '同一份数据必须得到同一个区间（固定种子）');
  assert.ok(Number.isFinite(first) && first > 0, `两组成绩不同时标准误应 > 0，实得 ${first}`);
  // 两组完全相同 → 每个重采样的差值恒为 0 → 标准误 0（而不是 NaN）
  assert.equal(bootstrapDiffStdError(a, a, labels), 0);
  // 恒定得分那组：AUC 在重采样下恒为 0.5，差值方差仍可来自另一组
  assert.ok(Number.isFinite(bootstrapDiffStdError(a, [0.5, 0.5, 0.5, 0.5], labels)));
  // 退化输入：空测试集 / 只有单一类别 → 有效重采样不足 → NaN（调用方据此判为「无法判定」）
  assert.ok(Number.isNaN(bootstrapDiffStdError([], [], [])));
  assert.ok(Number.isNaN(bootstrapDiffStdError([1, 2, 3], [1, 2, 3], [true, true, true])));
});

test('auc: 完美排序为 1，完全反向为 0，无信息为 0.5', () => {
  assert.equal(auc([3, 2, 1], [true, true, false]), 1);
  assert.equal(auc([1, 2, 3], [true, true, false]), 0);
  // 正负样本得分分布完全相同 → 0.5（半计并列）
  assert.equal(auc([1, 2, 1, 2], [true, true, false, false]), 0.5);
});

test('auc: 处理并列得分（半计）', () => {
  // 一个正样本与一个负样本同分 → 各计 0.5
  assert.equal(auc([1, 1], [true, false]), 0.5);
});

test('auc: 空或单类返回 0.5 而非抛错', () => {
  assert.equal(auc([], []), 0.5);
  assert.equal(auc([1, 2], [true, true]), 0.5);
});

test('splitByTime: 按时间切分且不丢样本', () => {
  const rows = [
    { submittedAt: '2026-01-01T00:00:00.000Z', id: 1 },
    { submittedAt: '2026-01-02T00:00:00.000Z', id: 2 },
    { submittedAt: '2026-01-03T00:00:00.000Z', id: 3 },
    { submittedAt: '2026-01-04T00:00:00.000Z', id: 4 },
  ];
  const { train, test: testSet } = splitByTime(rows, 0.5);
  assert.equal(train.length + testSet.length, 4);
  assert.ok(train.every((r) => r.submittedAt <= testSet[0].submittedAt), '训练集必须全部早于测试集');
});

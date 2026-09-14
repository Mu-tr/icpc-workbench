import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auc, splitByTime } from '../scripts/validate-weakness.ts';

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

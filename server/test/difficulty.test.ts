import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  atcoderThetaToRating,
  cfRatingTitle,
  difficultyFields,
  nativeDifficultyLabel,
  parseNativeDifficulty,
  toCfRating,
} from '../../shared/src/difficulty.ts';

test('difficulty: 洛谷 1-8 档映射为实测中位数，0 为未知', () => {
  // 证据：洛谷 type=CF 镜像题 × CF API rating 共 737 对（见 spec §2.2）
  const expected = [800, 1000, 1500, 1800, 2200, 2400, 2600, 3400];
  expected.forEach((rating, i) => {
    assert.equal(toCfRating('luogu', i + 1), rating);
  });
  assert.equal(toCfRating('luogu', 0), null); // 暂无评定（且 difficulty=0 在列表接口是"不筛选"）
  assert.equal(toCfRating('luogu', 9), null); // 越界档位不得当 8 用
  assert.equal(nativeDifficultyLabel('luogu', 5), '提高');
  assert.equal(nativeDifficultyLabel('luogu', 8), 'NOI/NOI+/CTS');
});

test('difficulty: 计蒜客 level1-8 与洛谷同档同名（i18n 字典实测）', () => {
  assert.equal(toCfRating('jisuanke', 'level1'), 800);
  assert.equal(toCfRating('jisuanke', 'level8'), 3400);
  assert.equal(nativeDifficultyLabel('jisuanke', 'level6'), '提高+');
  assert.equal(toCfRating('jisuanke', 'level9'), null); // 实测 level9 题量 0
  assert.equal(toCfRating('jisuanke', 'others'), null);
});

test('difficulty: AtCoder kenkoooo 难度按实测锚点分段线性，两端钳位', () => {
  assert.equal(atcoderThetaToRating(-386), 800);
  assert.equal(atcoderThetaToRating(-5000), 800); // 极简题钳到 CF 下限
  assert.equal(atcoderThetaToRating(3392), 3400);
  assert.equal(atcoderThetaToRating(9000), 3500); // 超出上限钳位
  // 锚点之间线性：451→1000 / 973→1500 的中点 712 → 约 1250
  assert.equal(atcoderThetaToRating(712), 1250);
  // 单调性
  const xs = [-1000, 0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4500];
  const ys = xs.map(atcoderThetaToRating);
  for (let i = 1; i < ys.length; i += 1) assert.ok(ys[i] >= ys[i - 1], `${xs[i]} 应不小于 ${xs[i - 1]}`);
});

test('difficulty: 牛客难度分同量纲直用并钳位，空值/0 为未知', () => {
  assert.equal(toCfRating('nowcoder', 1500), 1500);
  assert.equal(toCfRating('nowcoder', 200), 800); // 低于 CF 下限 → 钳到 800
  assert.equal(toCfRating('nowcoder', 3700), 3500);
  assert.equal(toCfRating('nowcoder', 0), null);
  assert.equal(toCfRating('nowcoder', ''), null);
  assert.equal(toCfRating('nowcoder', null), null);
});

test('difficulty: 力扣三档、代码源 1-10、CF 原值、QOJ 恒空', () => {
  assert.equal(toCfRating('leetcode', 'EASY'), 1000);
  assert.equal(toCfRating('leetcode', 'hard'), 2100);
  assert.equal(nativeDifficultyLabel('leetcode', 'MEDIUM'), '中等');
  assert.equal(toCfRating('daimayuan', 10), 2400);
  assert.equal(toCfRating('daimayuan', 0), null); // Hydro 未设定且无提交统计
  assert.equal(toCfRating('daimayuan', 11), null); // 越界档（>10）：未知就是未知，不钳到第 10 档
  assert.equal(toCfRating('codeforces', 1900), 1900);
  assert.equal(toCfRating('codeforces', undefined), null);
  assert.equal(toCfRating('qoj', 1234), null);
  assert.equal(parseNativeDifficulty('qoj', 1234).scale, 'none');
});

test('difficulty: difficultyFields 同时产出映射值与原生原文', () => {
  assert.deepEqual(difficultyFields('luogu', 4), {
    difficulty: 1800,
    nativeDifficulty: '4',
    difficultyScale: 'luogu-2026-06',
  });
  // 未知难度：只有标度，没有值（保持既有"缺 difficulty 键"的语义）
  assert.deepEqual(difficultyFields('atcoder', null), { difficultyScale: 'atcoder-kenkoooo-irt' });
  assert.equal('difficulty' in difficultyFields('atcoder', null), false);
});

test('difficulty: cfRatingTitle 边界', () => {
  assert.equal(cfRatingTitle(800).en, 'Newbie');
  assert.equal(cfRatingTitle(1200).en, 'Pupil');
  assert.equal(cfRatingTitle(1600).en, 'Expert');
  assert.equal(cfRatingTitle(1900).en, 'Candidate Master');
  assert.equal(cfRatingTitle(2400).en, 'Grandmaster');
  assert.equal(cfRatingTitle(3500).en, 'Legendary Grandmaster');
  assert.equal(cfRatingTitle(800).zh, '新手');
});

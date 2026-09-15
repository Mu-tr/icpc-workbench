/**
 * 百分数展示纯函数 pct 的单元测试（node:test）。
 *
 * 缺陷背景：后端 `server/src/analysis/stats.ts` 的 `rate()` 与 `analysis/weakness.ts`
 * 产出的 `acRate` / `avgAcRate` / `gap` 单位是**百分数**（14.3 表示 14.3%），
 * 而不是 0–1 比例。设置页「双口径对比」弹窗曾对它们再乘 100，于是显示成 1430%
 * 与 4330.0%。本测试把该约定钉在唯一一处格式化函数上：pct 只补 '%'，绝不做比例换算。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pct } from '../src/ui.ts'

test('pct：百分数值直接补 %，不再乘以 100', () => {
  // 后端 rate() 的量纲：14.3 = 14.3%（不是 0.143）
  assert.equal(pct(14.3), '14.3%')
  assert.equal(pct(31.3), '31.3%') // gap 是百分点差值
  assert.equal(pct(43.3), '43.3%') // 未覆盖桶 AC 率
  assert.equal(pct(45.6), '45.6%')
})

test('pct：整数与 0 不产生多余小数位', () => {
  assert.equal(pct(0), '0%')
  assert.equal(pct(100), '100%')
  assert.equal(pct(50), '50%')
})

test('pct：四舍五入到 1 位小数', () => {
  assert.equal(pct(14.34), '14.3%')
  assert.equal(pct(14.36), '14.4%')
  assert.equal(pct(0.05), '0.1%')
})

test('pct：大于 100 的值原样呈现（用于暴露单位错误，而不是被静默钳制）', () => {
  // 若上游误按比例传入（0.143 传成 14.3 已被正确渲染；但 1430 说明上游多乘了 100），
  // 这里保持原值以便在界面上立刻看出量纲错误。
  assert.equal(pct(1430), '1430%')
})

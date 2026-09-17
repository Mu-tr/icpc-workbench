/**
 * streamBuffer.ts 流式攒批单元测试。
 * 用 node:test 运行：node --experimental-strip-types test/streamBuffer.test.ts
 *
 * 关心的三件事：
 *   1. 首字不等一个完整周期（否则打字反馈会慢半拍）；
 *   2. 密集推流时被合并成少量几次落库，且**总内容一个字都不少**；
 *   3. flush/dispose 能把缓冲里剩下的内容送出去（停止生成时不能吞字）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStreamBuffer } from '../src/streamBuffer.ts'

/** 收集落库回调收到的内容 */
function collector(intervalMs: number) {
  const calls: Array<{ delta: string; reasoning: string }> = []
  const buf = createStreamBuffer((c) => calls.push(c), intervalMs)
  return { buf, calls }
}

describe('createStreamBuffer', () => {
  it('第一个字立刻落库，不等一个完整周期', () => {
    const { buf, calls } = collector(50)
    buf.pushDelta('你')
    assert.equal(calls.length, 1, '首字应当立即落库')
    assert.equal(calls[0]!.delta, '你')
    buf.dispose()
  })

  it('密集推流被合并，且内容一个字不少', () => {
    const { buf, calls } = collector(20)
    const text = '这是一段逐字推流的回复内容，用来验证攒批不会吞字。'
    for (const ch of text) buf.pushDelta(ch)
    assert.ok(calls.length < text.length, `应当被合并，实际落库 ${calls.length} 次`)
    buf.dispose()
    assert.equal(calls.map((c) => c.delta).join(''), text, '合并后内容必须与原文本完全一致')
  })

  it('停一段时间后再来，依然立刻落库（不会留下一个字的延迟）', async () => {
    const { buf, calls } = collector(30)
    buf.pushDelta('a')
    assert.equal(calls.length, 1)
    await new Promise((r) => setTimeout(r, 40))
    buf.pushDelta('b')
    assert.equal(calls.length, 2, '间隔已超过周期，应当立刻落库')
    assert.equal(calls[1]!.delta, 'b')
    buf.dispose()
  })

  it('flush 把攒下的内容送出去', () => {
    const { buf, calls } = collector(1000)
    buf.pushDelta('a') // 首字立即落库，同时确立周期起点
    assert.equal(calls.length, 1)
    buf.pushDelta('你好')
    assert.equal(calls.length, 1, '未到周期不应落库')
    buf.flush()
    assert.equal(calls.length, 2)
    assert.equal(calls[1]!.delta, '你好')
    buf.dispose()
  })

  it('dispose 后不再落库（定时器已清掉）', async () => {
    const { buf, calls } = collector(20)
    buf.pushDelta('x')
    buf.dispose()
    const after = calls.length
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(calls.length, after, 'dispose 之后不应再有落库')
  })

  it('正文与思维链共用一次落库', () => {
    const { buf, calls } = collector(1000)
    buf.pushReasoning('先') // 首字立即落库，确立周期起点
    const afterFirst = calls.length
    buf.pushReasoning('想一下')
    buf.pushDelta('结论是')
    assert.equal(calls.length, afterFirst, '同一周期内不应落库')
    buf.flush()
    assert.equal(calls.length, afterFirst + 1, '两者应当合并成一次落库')
    const last = calls[calls.length - 1]!
    assert.equal(last.delta, '结论是')
    assert.equal(last.reasoning, '想一下')
    buf.dispose()
  })

  it('空串不入缓冲，不会触发无意义的落库', () => {
    const { buf, calls } = collector(10)
    buf.pushDelta('')
    buf.pushReasoning('')
    assert.equal(calls.length, 0)
    buf.dispose()
    assert.equal(calls.length, 0)
  })
})

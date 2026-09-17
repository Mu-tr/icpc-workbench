/**
 * 流式 delta 的批量落库缓冲。
 *
 * 背景：AI 是逐 token 推流的，一个 token 一个 delta。若每个 delta 都直接写进 store，
 * React 每秒会被唤醒上百次：每次都要重新解析整段 Markdown、重新排版所有公式、
 * 再启动一次平滑滚动动画。表现出来就是文字在抖、风扇在转、滚动条在打架。
 *
 * 这里把 delta 攒起来，按固定节奏统一写库：
 *   · 攒批 —— 上百次渲染压到每秒十几次，肉眼看仍然连贯；
 *   · 首字不等待 —— 距上次落库已超过间隔时立刻写，不让第一个字干等一个周期；
 *   · 收尾必达 —— 流结束/被中断时 flush()，最后一个字不会留在缓冲里；
 *   · 正文与思维链共用一个定时器 —— 两者同帧到达时也只触发一次渲染。
 *
 * 只在浏览器里用（依赖 setTimeout），纯逻辑、无 React 依赖，便于单测。
 */

/** 一次落库里送出的增量（正文与思维链可能各为空串） */
export interface StreamChunk {
  delta: string
  reasoning: string
}

export interface StreamBuffer {
  /** 攒一段正文增量 */
  pushDelta(chunk: string): void
  /** 攒一段思维链增量 */
  pushReasoning(chunk: string): void
  /** 立刻送出攒下的全部内容（流正常结束时调用） */
  flush(): void
  /** 送出剩余内容并停掉定时器（异常/中止时调用，等价于 flush 后再不可用） */
  dispose(): void
}

/**
 * @param apply 落库回调，收到的是攒批后的合并增量
 * @param intervalMs 落库最小间隔（毫秒）。默认 50ms ≈ 20fps，
 *                   再快就看不出差别，却会让长回复的解析开销成倍上升。
 */
export function createStreamBuffer(apply: (chunk: StreamChunk) => void, intervalMs = 50): StreamBuffer {
  let delta = ''
  let reasoning = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let last = 0

  function flushNow(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (!delta && !reasoning) return
    const chunk: StreamChunk = { delta, reasoning }
    delta = ''
    reasoning = ''
    last = Date.now()
    apply(chunk)
  }

  /** 有内容待送时安排一次落库：已经等够就立刻送，否则等到间隔满 */
  function schedule(): void {
    if (timer !== null) return
    const waited = Date.now() - last
    if (waited >= intervalMs) {
      flushNow()
      return
    }
    timer = setTimeout(flushNow, intervalMs - waited)
  }

  return {
    pushDelta(chunk) {
      if (!chunk) return
      delta += chunk
      schedule()
    },
    pushReasoning(chunk) {
      if (!chunk) return
      reasoning += chunk
      schedule()
    },
    flush: flushNow,
    dispose: flushNow,
  }
}

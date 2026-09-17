/**
 * 公式渲染失败的**可观测性**（dev-only 诊断，纯函数 + 一个控制台出口）。
 *
 * 现状问题：rehype-katex 配的是 `throwOnError: false`，KaTeX 解析失败时不会抛错，
 * 而是渲染成一段红色源码：
 *   `<span class="katex-error" title="ParseError: …" style="color:#cc0000">\frac{1}</span>`
 * 也就是说**渲染事故是静默发生的** —— 用户看到红色公式，但既不知道原因，
 * 也无法把可复现的信息交给我们（"公式渲染有问题"这类反馈没法定位）。
 *
 * 这里在开发环境下把每个公式用 KaTeX **严格模式**（`throwOnError: true`）复核一遍，
 * 失败项打一条 `console.warn` 并挂到 `globalThis.__dshMathIssues`，
 * 用户报障时可以直接复制。生产构建里整个模块的分支被 `import.meta.env.DEV` 静态消除。
 *
 * 与 katex 自带 `contrib/auto-render` 的 `errorCallback` 是同一个思路：
 * 解析失败时不静默吞掉，而是把「哪段源码、什么错」交出来。
 */
import katex from 'katex'

export interface MathIssue {
  /** 公式源码（不含定界符） */
  body: string
  /** 块级公式还是行内公式 */
  displayMode: boolean
  /** KaTeX 的报错信息 */
  message: string
}

/**
 * 复核结果缓存：流式输出时同一个公式每一帧都会被复核一遍，
 * 缓存让每个公式最多只解析一次（键里区分行内/块级，同一源码在两种模式下的可解析性相同，
 * 但报错信息里的模式信息不同，分开更清楚）。
 */
const cache = new Map<string, true | string>()

/** 缓存上限：超了直接清空（公式总量本来就不大，简单策略足够） */
const CACHE_LIMIT = 500

function remember(key: string, value: true | string): void {
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(key, value)
}

/**
 * 复核预处理结果里的每个公式，返回**解析失败**的项（能解析的返回空数组）。
 *
 * 只在代码区之外、`$…$` / `$$…$$` 之间取源码 —— 与 markdownMath 的公式区定义一致。
 * 用 `strict: false` 只是为了不把"非标准命令"的警告混进"解析失败"里：
 * 后者才是会让用户看到源码的事故（前者由 rehype-katex 默认的 strict: 'warn' 负责）。
 */
export function auditMathRender(text: string): MathIssue[] {
  const issues: MathIssue[] = []
  const segments = text.split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g)
  for (let i = 1; i < segments.length; i += 2) {
    const seg = segments[i]!
    const displayMode = seg.startsWith('$$')
    const body = displayMode ? seg.slice(2, -2) : seg.slice(1, -1)
    const key = `${displayMode ? 'B' : 'I'}:${body}`
    const hit = cache.get(key)
    if (hit === true) continue
    if (typeof hit === 'string') {
      issues.push({ body, displayMode, message: hit })
      continue
    }
    try {
      katex.renderToString(body, { displayMode, throwOnError: true, strict: false })
      remember(key, true)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      remember(key, message)
      issues.push({ body, displayMode, message })
    }
  }
  return issues
}

/** 诊断出口名：用户报障时可以 `copy(__dshMathIssues)` 把现场交出来 */
const GLOBAL_KEY = '__dshMathIssues'

/**
 * 复核并把失败项报到控制台（dev-only 调用点）。
 * @returns 失败项个数（0 表示本次渲染里所有公式都能被 KaTeX 解析）
 */
export function reportMathIssues(text: string): number {
  const issues = auditMathRender(text)
  if (issues.length === 0) return 0
  ;(globalThis as Record<string, unknown>)[GLOBAL_KEY] = issues
  /* eslint-disable no-console */
  console.warn(
    `[markdown] ${issues.length} 处公式 KaTeX 解析失败（已渲染为红色源码）。` +
      `详情见 globalThis.${GLOBAL_KEY}：`,
    issues,
  )
  /* eslint-enable no-console */
  return issues.length
}

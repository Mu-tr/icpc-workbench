/**
 * Markdown 数学公式预处理管线（纯函数，无 React 依赖，便于单元测试）。
 *
 * AI 输出的数学内容存在多种"不规范"形式，remark-math 只认 $...$ / $$...$$ 定界符，
 * 此处在渲染前做一次性归一化。核心是**先把内容分成三类区域**，再对号入座：
 *
 *   ┌ 代码区（围栏代码块 / 行内代码）—— 原样保留，绝不参与任何公式转换
 *   ├ 公式区（$...$ / $$...$$ / 归一化后的 LaTeX 定界符）—— 只做符号归一化
 *   └ 文本区 —— 检测裸数学并包裹定界符
 *
 * 保护机制：代码区在管线开始时被抽出，换成 U+0000 占位符，管线结束后原样还原。
 * 这样后续所有基于正则的公式逻辑都"看不见"代码，从根上避免
 * `ios::sync_with_stdio` / `g[prev].push_back` / `f_{i,j}` 被误当作公式渲染。
 */
import {
  isMarkdownishLang,
  looksLikeCode,
  looksLikeCodeReference,
  looksStronglyMath,
  normalizeLang,
  normalizeMathScriptChars,
  shouldConvertFenceToMath,
  stripLineComments,
} from './markdownCode.ts'

/* ============================ 区域保护 ============================ */

/** 占位符前缀/后缀：U+0000 在正常 Markdown 源文本中不可能出现，且不匹配任何数学/代码特征 */
const MARK = '\u0000'

/**
 * 保护上下文：全局共享的占位符编号。
 *
 * 必须跨阶段共享 —— 围栏 / 行内代码 / 缩进块依次替换文本，
 * 如果编号在各自阶段里从 0 重新开始，同名占位符就会互相覆盖（历史上出现过
 * 「行内代码与围栏占用同一个 0 号占位符」导致围栏语法泄漏进正文的 bug）。
 */
interface ProtectionContext {
  parts: string[]
  next: number
}

function newContext(): ProtectionContext {
  return { parts: [], next: 0 }
}

/** 记录一段被保护的内容，返回它的全局占位符 */
function mark(ctx: ProtectionContext, fragment: string): string {
  const id = ctx.next++
  ctx.parts[id] = fragment
  return `${MARK}${id}${MARK}`
}

/** 还原所有占位符（幂等：占位符只由本模块生成） */
function restoreAll(text: string, ctx: ProtectionContext): string {
  return text.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_m, i: string) => ctx.parts[Number(i)] ?? '')
}

/** 行内代码 span（支持 ``a`b`` 这类多反引号界定） */
const BACKTICK_SPAN = /(`+)([^\n]+?)\1/g

/**
 * 行内代码（`...`）默认原样保留，绝不参与公式转换。
 *
 * 反引号通常是"这段是代码"的显式标注：`dp_max`、`g[prev].push_back(cur)`、
 * `a[x] + a[x+1]` 被渲染成斜体公式是排版事故。
 *
 * **唯一例外**：span 内是真正的 LaTeX 数学（含 `_{…}` / `^{…}` / `\命令`）。
 * AI 常把公式写成 `` `dp_{i-1}` ``、`` `\max_{j}(dp_j)` ``，此时反引号是误加，
 * 保留会让它显示成字面等宽文本 `dp_{i-1}`（用户反馈的"仍然没渲染成下标"）。
 * 这类内容剥掉反引号交回公式管线。判定刻意收窄到"含 LaTeX 记号"，
 * 所以 `push_back`、`[1, i]`、`dp[i][j]`、`a[x] + a[x+1]` 仍保持代码外观。
 *
 * 必须放在围栏保护之后调用：否则围栏开合的三个反引号会被当作行内代码的界定符，
 * 围栏语法随之泄漏进正文。
 */
function protectInlineCode(text: string, ctx: ProtectionContext): string {
  return text.replace(BACKTICK_SPAN, (m, _tick: string, body: string) => {
    // 行内代码不跨行；跨行说明是误配对（例如与之后的围栏反引号配成一对）
    if (body.includes('\n')) return m
    const t = body.trim()
    // span 内是 LaTeX 数学 → 剥掉反引号交给公式管线。
    // 单字母下标（`dp_i`、`c_j`）也算：它们与 `dp_{i-1}` 是同一种记法，
    // 一个渲染成公式、另一个渲染成等宽代码会非常割裂。
    if (/_{|\^\{|\\[a-zA-Z]/.test(t) || /^[A-Za-z]{1,3}_[A-Za-z0-9]$/.test(t)) return t
    return mark(ctx, m)
  })
}

/**
 * 围栏代码块（``` / ~~~）：
 * - 判定为公式的块 → 剥掉围栏，正文交回文本区（走公式管线）
 * - 判定为代码的块 → 整体保护，绝不改写
 */
function protectFenceBlocks(text: string, ctx: ProtectionContext): string {
  // 围栏正则必须允许 \r\n（AI 输出常带 CRLF），且正文首行可能自身以反引号开头，
  // 因此用「只在行首出现的等长收尾围栏」匹配，而不是 \2 反向引用。
  return text.replace(
    /^[ \t]*(`{3,}|~{3,})([^\r\n]*)\r?\n([\s\S]*?)^[ \t]*(`{3,}|~{3,})[ \t]*$/gm,
    (m, openFence: string, info: string, body: string, closeFence: string) => {
      // 收尾围栏必须与起始围栏同类且不短于起始围栏
      if (openFence[0] !== closeFence[0] || closeFence.length < openFence.length) return m
      // 判定为公式 → 剥围栏交回公式管线；否则一律作为代码整体保护
      if (!shouldConvertFenceToMath(info, body)) return mark(ctx, m)
      // 已经是"文本 + 行内公式"混合内容：直接去围栏按普通 Markdown 渲染，
      // 套成 $$...$$ 会让内部 $ 造成嵌套截断
      if (/\$/.test(body)) return mark(ctx, body.trim())
      const normalized = normalizeFenceBody(body)
      if (!normalized) return mark(ctx, m)
      return `\n\n$$\n${normalized}\n$$\n\n`
    },
  )
}

/**
 * 缩进代码块（4+ 空格）：AI 偶尔用缩进而非围栏表示代码块。
 * 内容像数学且不像代码时按公式渲染（去掉缩进），否则整体保护为代码。
 */
function protectIndentedBlocks(text: string, ctx: ProtectionContext): string {
  return text.replace(
    /(?:^|\n)([ \t]{4,}[^\n]+(?:\n[ \t]{4,}[^\n]+)*)/g,
    (match, block: string) => {
      const body = normalizeFenceBody(block)
      if (body && looksStronglyMath(body) && !looksLikeCode(body)) {
        if (/\$/.test(body)) return `\n\n${body}\n\n`
        return `\n\n$$\n${body}\n$$\n\n`
      }
      // 非公式：整体保护（连前缀换行一起保护，避免空行被后续处理吃掉）
      return mark(ctx, match)
    },
  )
}

/* ============================ 1. 外层围栏剥离 ============================ */

/**
 * 正文是否含**真实的 Markdown 语法**。
 *
 * 用于判断"整段被围栏包住的文本"到底是 Markdown 正文还是代码：
 * 空语言标记的围栏（```` ``` ````）最常见的情况是代码块，只有内容确实长得像
 * Markdown（标题/列表/引用/已有公式）时才剥掉围栏重新解析，否则一律当代码保留。
 */
function looksLikeMarkdownBody(body: string): boolean {
  return [
    /^[ \t]{0,3}#{1,6}\s/m, // ATX 标题
    /^[ \t]{0,3}(?:[-*+]|\d+\.)\s+\S/m, // 无序/有序列表
    /^[ \t]{0,3}>\s?\S/m, // 引用块
    /^\|.*\|[ \t]*$/m, // 表格
    /^[ \t]*(?:\*\*\*|---|___)[ \t]*$/m, // 分隔线
    /\$\$[\s\S]*?\$\$|\$[^$\n]+\$/, // 已有公式定界符
  ].some((re) => re.test(body))
}

/**
 * 剥离 AI 输出中误加的外层围栏：
 *
 * - 整段被 ```markdown 包裹、或空标记围栏里装的是 Markdown 正文（有标题/列表等语法）
 *   → ReactMarkdown 会把它渲染成 <pre><code> 而不是解析内部 Markdown，此处提取正文。
 * - 整段被围栏包裹但内容其实是**数学公式**（AI 常把整段推导写成 ```latex / ```math，
 *   或用一个空标记围栏把纯公式行包起来）→ 也要剥掉，否则公式会被当代码渲染。
 * - 其他情况（cpp/py 等语言，或空标记但内容是代码）围栏必须保留 ——
 *   剥掉会让代码变裸文本、进而被数学包裹逻辑污染
 *   （如 ios::sync_with_stdio 被包进 $...$，a[x] + a[x+1] 被渲染成 a 下标 [x+1]）。
 * - 内部嵌套围栏时不剥（那是 Markdown 正文里的代码块）。
 */
export function stripOuterCodeFence(text: string): string {
  const m = text.match(/^[ \t]*(`{3,}|~{3,})([^\r\n]*)\r?\n([\s\S]*?)[ \t]*\r?\n?[ \t]*\1[ \t]*$/)
  if (!m) return text
  const info = m[2] ?? ''
  const body = m[3] ?? ''
  if (body.includes('```') || body.includes('~~~')) return text
  // 判定为公式的围栏（```math / ```latex，或正文含明确 LaTeX 记号）：转成块级公式
  if (shouldConvertFenceToMath(info, body)) {
    const normalized = normalizeFenceBody(body)
    if (!normalized) return text
    return /\$/.test(normalized) ? `${normalized}\n` : `\n\n$$\n${normalized}\n$$\n\n`
  }
  // 只有"明确是 Markdown"的围栏才剥掉：显式 markdown 标记，或正文确实含 Markdown 语法
  const explicitMarkdown = normalizeLang(info) !== '' && isMarkdownishLang(info)
  if (!explicitMarkdown && !looksLikeMarkdownBody(body)) return text
  return `${body}\n`
}

/* ============================ 2. 裸数学包裹 ============================ */

/** Markdown 中的「非文本区」：围栏代码块、行内代码、已有公式（$...$ / $$...$$） */
const CODE_OR_MATH = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`+[^`\n]*`+|\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g

/**
 * 对 Markdown 源文本中「普通文本区」（代码块/行内代码/已有公式之外的部分）做转换。
 * 其余部分原样保留 —— 代码块里的下划线标识符、公式内部的内容都不能被二次处理。
 */
function transformTextRegions(text: string, fn: (s: string) => string): string {
  return text
    .split(CODE_OR_MATH)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join('')
}

/**
 * 该文本块是否是 Markdown 表格（至少含一行以竖线分隔的单元格）。
 * 表格内的公式必须是行内公式：块级公式会插入换行，把表格行拆散。
 */
function isTableBlock(block: string): boolean {
  return /^[ \t]*\|.*\|[ \t]*$/m.test(block)
}

/**
 * 把 AI 常用的 LaTeX 公式定界符统一为 remark-math 能识别的 $ 格式。
 *
 * remark-math (v6) 仅支持 $...$（行内）和 $$...$$（块级），但 AI 模型（尤其是
 * 数学/算法场景）经常输出 \(...\) 和 \[...\] 定界符，这些不会被识别为公式而是
 * 当作普通文本渲染。此处做一次性转换：
 *   \[...\]  →  $$...$$   （块级公式，跨行；$$ 必须独占一行）
 *   \(...\)  →  $...$     （行内公式）
 *
 * 表格里的 \[...\] 例外：降级为行内 $...$ —— 块级公式会在表格行里插入换行，
 * 把整行单元格拆散。
 *
 * 注意：必须先处理 \[...\]（双字符定界符），再处理 \(...\)，避免误匹配。
 * 转换在代码块/行内代码/已有公式之外进行（代码块中的 LaTeX 不应被渲染为公式）。
 */
/**
 * 把 `\[ … \]` 转换成 remark-math 能识别的块级公式，并**保持引用块前缀**。
 *
 * 公式源码里可能带 Markdown 结构前缀（最典型是引用块 `> `）。这些前缀不能留在
 * `$$` 内部 —— KaTeX 无法处理公式内部的行首 `> `，整个公式会解析失败、以纯文本显示
 * （用户截图里"> \[ … \]" 原样出现就是这个原因）。转换时把前缀补到每一行，
 * 引用块结构因此保持有效。
 *
 * 表格行例外：`$$` 块会插入换行、把整行单元格拆散，所以降级为行内 `$…$`。
 */
function convertDisplayMath(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let inDisplay = false
  const inlineMath = (s: string) => s.replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner: string) => `$${inner.trim()}$`)

  for (const line of lines) {
    const quote = /^([ \t]*>[ \t]?)/.exec(line)?.[1] ?? ''
    const body = quote ? line.slice(quote.length) : line

    if (inDisplay) {
      if (body.includes('\\]')) {
        const [head, ...tail] = body.split('\\]')
        out.push(`${quote}${head}`)
        out.push(`${quote}$$`)
        inDisplay = false
        const rest = tail.join('\\]')
        if (rest.trim()) out.push(quote + inlineMath(rest))
        continue
      }
      out.push(quote + body)
      continue
    }

    // 单行完整 `\[ … \]`
    const single = /\\\[([\s\S]*?)\\\]/.exec(body)
    if (single) {
      if (isTableBlock(line)) {
        // 表格行里必须是行内公式，否则 `$$` 会把整行单元格拆散
        out.push(`${quote}${inlineMath(body.replace(/\\\[([\s\S]*?)\\\]/g, (_m, b: string) => `$${b.trim()}$`))}`)
      } else {
        out.push(`${quote}$$`)
        out.push(`${quote}${single[1]!.trim()}`)
        out.push(`${quote}$$`)
        const rest = body.slice(single.index + single[0].length)
        if (rest.trim()) out.push(quote + inlineMath(rest))
      }
      continue
    }

    // 多行公式的开头
    if (body.includes('\\[')) {
      inDisplay = true
      out.push(`${quote}$$`)
      const rest = body.replace(/\\\[/g, '')
      if (rest.trim()) out.push(`${quote}${rest}`)
      continue
    }

    out.push(quote + inlineMath(body))
  }
  return out.join('\n')
}

export function normalizeMathDelimiters(text: string): string {
  // 先保护代码区（围栏 / 行内代码）：里面的 `\(` `\)` 是代码文本，不能转换
  const ctx = newContext()
  const afterFence = protectFenceBlocks(text, ctx)
  const afterInline = protectInlineCode(afterFence, ctx)
  return restoreAll(convertDisplayMath(afterInline), ctx)
}

/**
 * 把**引用块标记**（行首 `> `）临时换成占位符。
 *
 * AI 常把公式放在引用块里（`> \[ … \]`）。KaTeX 无法在公式内部处理行首的 `> `，
 * 它会让公式解析直接失败、原文以纯文本显示（用户截图里的"渲染有问题"）。
 * 这里把 `>` 抽出来，让引用块内的公式能像普通公式一样被识别与包裹，
 * 管线结束时再原样还原 —— 引用块结构保持不变。
 */
function protectBlockquoteMarks(text: string, ctx: ProtectionContext): string {
  return text
    .split('\n')
    .map((line) => {
      const m = /^([ \t]*>[ \t]?)/.exec(line)
      return m ? mark(ctx, m[1]!) + line.slice(m[1]!.length) : line
    })
    .join('\n')
}

/**
 * 检测并包裹 AI 输出中的「裸数学」片段为 $...$，使其能被 remark-math 识别渲染。
 *
 * AI 模型（尤其数学/算法场景）经常输出不带任何定界符的数学表达式，例如：
 *   - 下标：need_i, f_{i mod a_m}, c_i, a_m
 *   - 上标：2^k, 2^j, 2^{j+1}
 *   - LaTeX 命令：\frac{n(n+1)}{2}, \sum_{i=1}^{n}, \sqrt{V}
 *   - 复杂度：O(V²/B log V), O(V√V log V)
 *   - 赋值式：f_{i mod a_m} ← f_{i mod a_m} + f_i / c_i
 *
 * 此外 AI 常把数学公式放在代码围栏里（避免 Markdown 语法干扰），这些块先被
 * shouldConvertFenceToMath 判定为公式、剥掉围栏后再走本函数。
 *
 * 反向保护同样重要：正文里的**代码引用**（`g[prev].push_back(cur)`、
 * `std::sort(...)`）会被识别为代码样式并渲染成行内代码，而不是斜体公式。
 */
export function wrapBareMath(text: string): string {
  // 第一步：把代码区抽出来换成占位符（公式块判定为真的会先被剥围栏放出正文）。
  // 顺序不可调换：必须先抽围栏，再处理行内代码 —— 否则围栏开合的反引号会被
  // 行内代码正则配成一对，围栏语法直接泄漏进正文。
  const ctx = newContext()
  // 引用块标记也要先抽出来：否则 `> ` 会跑进公式内部让 KaTeX 解析失败
  const afterQuote = protectBlockquoteMarks(text, ctx)
  const afterFence = protectFenceBlocks(afterQuote, ctx)
  const afterInline = protectInlineCode(afterFence, ctx)
  const afterIndent = protectIndentedBlocks(afterInline, ctx)

  // 第二步：剩余的文本区里检测裸数学并包裹（公式区/代码区都不参与）
  const wrapped = transformTextRegions(afterIndent, (part) => wrapMathInText(part, ctx))

  // 第三步：还原代码区与引用块标记
  return restoreAll(wrapped, ctx)
}

/**
 * 独占一行的数学表达式升级为块级公式（居中、独立成行）。
 *
 * AI 经常把递推式直接写在句末或紧跟说明文字之后（"于是得到 dp_i = \max…"），
 * 若只做行内包裹，公式会跟着正文流排、还会在 `=` 处被拆成 `$dp_i =$ $\max…$` 两段，
 * 版面拥挤且上下标范围丢失。这里把"这一行主要就是公式"的行提升为 `$$…$$`：
 *   · 完全纯公式（行内只允许空白/标点）→ 升级；
 *   · 只有极短引导语 + 公式（如"于是得到 <公式>"，引导语占比 < 10%）→ 也升级，
 *     引导语留在原行，公式独立成块——这正是常见的数理排版写法；
 *   · 引导语再长就不动（"若 $Y_i \ge 0$ 则…"这类说明句里的公式必须留在行内）。
 *   · 升级时用**原文**包进 `$$…$$`，而不是包裹后的 `$…$`（否则会出现 `$$…$x$…$$` 嵌套）。
 */
function tryStandaloneDisplayMath(rawLine: string): string | null {
  const trimmed = rawLine.trim()
  if (!trimmed || trimmed.includes('$$') || trimmed.length > 400) return null
  if (!looksStronglyMath(trimmed) || looksLikeCode(trimmed)) return null
  const wrapped = wrapMathInLine(trimmed)
  const parts = wrapped.split(CODE_OR_MATH)
  if (!parts.some((p, i) => i % 2 === 1 && p.startsWith('$'))) return null
  const prose = parts
    .filter((_p, i) => i % 2 === 0)
    .join('')
    .replace(/[\s.,;:!?，。；：！？、（）()[\]]/g, '')
  // 纯公式，或引导语极短（占比 < 10%）→ 升级为块级公式
  if (prose.length > 0 && prose.length / trimmed.length >= 0.1) return null
  return `\n$$\n${trimmed}\n$$\n`
}

/**
 * 合并被空白隔开的相邻行内公式：`$dp_i =$ $\max…$` → `$dp_i = \max…$`。
 *
 * 裸数学包裹是"按数学种子贪心扩展"的，种子之间只要出现非数学字符（`=`、`\`）就会断开，
 * 于是一个完整式子被拆成多段 `$…$`。拆开后 KaTeX 会分别排版，
 * `\max_{…}` 的范围下标随之失去整体性（还会多出一段孤立的 `$dp_i =$`）。
 */
function mergeAdjacentInlineMath(text: string): string {
  // 去掉两段之间的空白分隔符，使它们合并为一个 $...$ 区（保留其余空白）。
  // 不能用 `$a$ $b$` → `$a b$` 以外的方式紧贴，否则会拼出 `$$` 定界符。
  return text.replace(/(\$[^$\n]+?)\$([ \t]+)\$(?=[^$\n]+\$)/g, (_m, prev: string) => `${prev} `)
}

/**
 * 把文本切成独立行，逐行处理（数学片段不跨行） */
function wrapMathInText(text: string, ctx: ProtectionContext): string {
  // 先把表格块的竖线换成占位符，表格结构就不会被数学包裹破坏
  const body = protectTablePipes(text, ctx)
  const lines = body.split('\n')
  // 逐行升级为块级公式，但**不打断已有的多行 $$…$$ 块**
  //（$$ 与收尾 $$ 分处两行，必须整体保留，否则会把展示公式拆坏）
  const out: string[] = []
  let inDisplay = false
  for (const line of lines) {
    const fences = (line.match(/\$\$/g) ?? []).length
    const wasInDisplay = inDisplay
    if (fences % 2 === 1) inDisplay = !inDisplay
    if (wasInDisplay || inDisplay) {
      out.push(line)
      continue
    }
    out.push(tryStandaloneDisplayMath(line) ?? wrapMathInLine(line))
  }
  return mergeAdjacentInlineMath(out.join('\n'))
}

/**
 * 匹配一个"数学种子"：任何包含下标/上标/LaTeX命令/数学符号/下标访问/限定名的 token。
 * 注意不含单箭头 → —— "q1 → q2" 这类链式文本（如拓扑序、状态转移）太常见，
 * 会把整个句子都卷进公式。
 *
 * 限定名 `std::sort`、下标访问 `dp[i]` 也纳入种子：它们本身不是数学，但需要被捕获后
 * 判为「代码引用」并渲染成行内代码，否则会以普通文本混在数学公式之间，视觉上分不清。
 */
const MATH_SEED = /(?:[a-zA-Z]+_\{[^}]*\}|[a-zA-Z]+_[a-zA-Z0-9]+|[0-9a-zA-Z]\^\{[^}]*\}|[0-9a-zA-Z]\^[0-9a-zA-Z]+|\b[a-zA-Z_]\w*(?:::\w+)+|\b[a-zA-Z_]\w*\s*[[{][^\]}]*[\]}]|\\[a-zA-Z]+\{?[^$\n]*|←|·|V²|V³|√|≤|≥|≠|∈|∉|∪|∩|⊕|⊗|∀|∃|Σ|Π|∑|∏|ℓ|\|(?=[^\s|]))/

/**
 * 判断字符是否可以纳入数学片段（向种子两侧扩展时用）。
 * 在原 ASCII 数学字符之外补充：… − · ⇔ ⇒ ⇐ ≤ ≥ ≠ ← → ↔ （AI 常用的 Unicode 数学符号，
 * 若不含它们，"Σ(ri − li + 1)"、"O(n·3^{n/6})" 这类公式会在 − / · 处断成残缺片段）。
 *
 * 还包含 `=` `<` `>` `!`：`dp_i = \max_{…}` 这类等式若不纳入，会在 `=` 处断成
 * `$dp_i =$ $\max…$` 两段公式，白白拆碎一个式子。
 *
 * 还包含 `|`：公式里的绝对值需要它。表格的单元格分隔符会**提前**被
 * protectTablePipes 换成占位符，所以这里可以放心纳入。
 */
function isMathChar(ch: string): boolean {
  return /[a-zA-Z0-9+\-*/^_=<>{}[\]().,!\\|⇔⇒⇐∩∪⊕⊗⊆⊇∈∉≤≥≠√²³←→↔ℓΣΠ∑∏∀∃∂∇∞…−·x]/.test(ch)
}

/**
 * 把整个**表格块**里的竖线换成占位符，让它们对数学包裹完全不可见。
 *
 * 竖线有双重身份：公式里的绝对值（该进公式）和表格单元格分隔符（绝不能进公式）。
 * 逐个竖线猜身份非常脆弱（`|dp_i ← dp_{i-1}|说明|` 这种紧贴写法会把分隔线也吞掉，
 * 实测整张表格会退化成纯文本）。这里改成按**结构**判定：
 * 只要识别出这是 Markdown 表格（表头行 + `---` 分隔行 + 若干数据行），
 * 就把这些行里的竖线全部换成占位符 —— 表格结构 100% 安全；
 * 单元格内部的数学照常在后面被包裹（因为它已经不含竖线了）。
 * 表格之外的竖线保持原样，绝对值仍会正常进公式。
 */
function protectTablePipes(text: string, ctx: ProtectionContext): string {
  const lines = text.split('\n')
  const isDelimiterRow = (l: string) =>
    /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/.test(l) && l.includes('-')
  // 先确定哪些行属于表格：分隔行的上一行是表头、下一行起是数据行
  const inTable = lines.map(() => false)
  for (let i = 0; i < lines.length; i++) {
    const prev = i > 0 ? lines[i - 1]! : ''
    const next = i + 1 < lines.length ? lines[i + 1]! : ''
    if (isDelimiterRow(lines[i]!) && prev.includes('|')) inTable[i] = true
    if (isDelimiterRow(prev) && lines[i]!.includes('|')) inTable[i] = true
    if (isDelimiterRow(next) && lines[i]!.includes('|')) inTable[i] = true
    void next
  }
  // 数据行可能有多条：从分隔行往下连续含竖线的行都算
  for (let i = 0; i < lines.length; i++) {
    if (inTable[i] && isDelimiterRow(lines[i]!)) {
      for (let j = i + 1; j < lines.length && lines[j]!.includes('|'); j++) inTable[j] = true
    }
  }
  return lines.map((line, i) => (inTable[i] ? line.replace(/\|/g, () => mark(ctx, '|')) : line)).join('\n')
}

function wrapMathInLine(line: string): string {
  let result = ''
  let pos = 0
  while (pos < line.length) {
    const remaining = line.slice(pos)
    const seedMatch = MATH_SEED.exec(remaining)
    if (!seedMatch) {
      result += remaining
      break
    }
    const seedStart = seedMatch.index
    const seedEnd = seedStart + seedMatch[0].length

    // 从种子两侧贪心扩展：向前收集连续的数学字符，向后也收集
    let start = pos + seedStart
    let end = pos + seedEnd

    // 向前只扩展连续数学字符（不含空格，避免吞掉太多普通文本）
    while (start > pos && isMathChar(line[start - 1]!)) start--

    // 向后扩展：连续数学字符 + 受限空格（空格后必须跟数学字符）
    while (end < line.length) {
      if (isMathChar(line[end]!)) {
        end++
      } else if (line[end] === ' ' && end + 1 < line.length && isMathChar(line[end + 1]!)) {
        end++
      } else {
        break
      }
    }

    // Markdown 强调定界符（**bold** / *italic*）不能进入公式内部：
    // KaTeX 会把 ** 渲染成 ∗∗ 并连带破坏外部加粗。把它们留在公式外面。
    while (start < end && (line[start] === '*' || line[start] === '_')) start++
    while (end > start && line[end - 1] === '*') end--

    const fragment = line.slice(start, end)
    // 片段与已输出部分可能重叠（种子匹配可以在向前扩展越过的区域内再次命中），
    // 用 max(start, consumed) 收敛起点，防止 "g[prev].push_back" 被输出两遍。
    const fragStart = Math.max(start, pos)
    if (fragStart >= end) {
      // 片段整体都在已消费区域内（强调定界符剥离后为空），跳过
      pos = end
      continue
    }
    const visible = line.slice(fragStart, end)
    if (MATH_SEED.test(fragment)) {
      if (fragStart > pos) result += line.slice(pos, fragStart)
      // 代码引用 → 行内代码；数学表达式 → 行内公式。
      // 代码引用要连同尾随空格一起写成 `xxx `（不 trim），否则会吃掉原文的词间空格
      result += looksLikeCodeReference(visible) ? '`' + visible + '`' : `$${visible}$`
    } else {
      if (fragStart > pos) result += line.slice(pos, fragStart)
      result += visible
    }
    pos = end
  }
  return result
}

/* ============================ 3. 公式内符号归一化 ============================ */

/** 手动尺寸命令（`\big` 系列）：`\left`/`\right` 已能自适应，不需要它们 */
const MANUAL_SIZE_CMD = '\\\\(?:[bB]igg?)(?:l|r|m)?'

/**
 * 公式源码清理：修掉会让 KaTeX **直接解析失败**的写法，并压缩冗余尺寸命令。
 *
 * AI 偶尔输出"手动尺寸命令 + 自适应定界符"的嵌套写法：
 *   `\max\Biggl\left\{ … \Biggr\right\}` —— `\Biggl` 后面必须紧跟定界符，
 *   跟 `\left` 是非法 LaTeX，KaTeX 抛错后会把**原始源码**当文本显示
 *   （用户截图里公式位置出现 `\boxed{...}` 源码就是这个原因）。
 *
 * `\left…\right` 本身按内容高度自适应，所以前面的手动尺寸命令直接去掉：
 * 既修好解析，又简化了源码（对应反馈"命令书写冗长"）。
 *
 * ⚠ 只做行内替换，不要动换行：`$$` 必须独占一行，把换行折叠成空格会把块级公式
 * 降级成行内公式（围栏正文的换行在 normalizeFenceBody 里单独处理）。
 */
/**
 * 简化「手动尺寸命令 + 自适应定界符」的**非法嵌套**。
 *
 * `\Bigl\left\{` 是非法 LaTeX：`\left` 必须是定界符上的最外层命令，
 * KaTeX 会报 `Got function '\left' with no arguments as argument to '\Bigl'`，
 * 整个公式解析失败、原文以纯文本显示（用户截图里公式位置出现源码就是这个原因）。
 *
 * 用一次扫描处理所有这种嵌套，并保证成对替换：
 *   `\Bigl\left\{ … \Bigr\}`        → `\left\{ … \right\}`
 *   `\Bigl\left\{ … \Bigr\right\}`  → `\left\{ … \right\}`
 * 也就是把开头的 `\Bigl` 换成 `\left`，与它配对的收尾命令换成 `\right`。
 * 找不到配对收尾时整对都不动（宁可原样显示，也不要把公式改坏）。
 * `\Bigl(` 这类合法用法（没有嵌套 `\left`）完全不受影响。
 */
function fixManualSizeNesting(body: string): string {
  // 只有 `\Bigl\left` 这一种形态是非法嵌套（`\Bigl\{`、`\Bigl(` 都是合法的，不能动）
  if (!new RegExp(`${MANUAL_SIZE_CMD}\\s*\\\\left\\b`).test(body)) return body
  let out = body
  // 1. 去掉 `\Bigl\left` 里的 `\Bigl`，让 `\left` 成为最外层
  out = out.replace(new RegExp(`${MANUAL_SIZE_CMD}\\s*(?=\\\\left\\b)`, 'g'), '')
  // 2. `\Bigr\right` 里的 `\Bigr` 同理是多余的
  out = out.replace(new RegExp(`${MANUAL_SIZE_CMD}\\s*(?=\\\\right\\b)`, 'g'), '')
  // 3. 收尾还带手动尺寸命令（`\Bigr\}`）时，为刚裸露的 `\left` 配一个 `\right`。
  //    必须**成对**处理：删掉 `\Bigr` 会让 `\right` 落单，KaTeX 同样会报错。
  const leftCount = (out.match(/\\left\b/g) ?? []).length
  const rightCount = (out.match(/\\right\b/g) ?? []).length
  if (rightCount < leftCount) {
    let need = leftCount - rightCount
    const closeRe = new RegExp(`${MANUAL_SIZE_CMD}\\s*(?=[)\\]|.\\\\{}])`, 'g')
    out = out.replace(closeRe, (m) => {
      if (need > 0) {
        need--
        // 保留命令后面的原空白，避免把 `\Bigr\},` 变成 `\right\},`（会多出间隙）
        return '\\right' + (/\s$/.test(m) ? ' ' : '')
      }
      return m
    })
  }
  return out
}

function cleanMathSource(body: string): string {
  return fixManualSizeNesting(body)
}

/**
 * 围栏正文归一化：去掉空行、把折行合并为空格。
 *
 * AI 常把一条公式拆成多行写（在逗号后换行、中间还夹空行）；这些换行在数学模式下
 * 只是空白，但空行会提前终止 `$$` 块、导致公式被截断。这里统一压成单行。
 */
function normalizeFenceBody(body: string): string {
  return stripLineComments(body)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .trim()
}

/** 需要"限制符在正下方"的大运算符：\max / \min / \lim / \sum … */
const BIG_OPERATORS = ['max', 'min', 'lim', 'sup', 'inf', 'det', 'gcd']

/** 会使公式明显变高的结构：出现它们才需要把定界符升级为自适应尺寸 */
const TALL_CONSTRUCT =
  /\\(?:max|min|lim|sup|inf|det|gcd|frac|dfrac|tfrac|sqrt|sum|prod|int|iint|oint|binom|begin|substack|overset|underset|stackrel|overline|underline)\b|\\[a-zA-Z]*[Bb]ig|\^\{[^}]{4,}\}|_\{[^}]{5,}\}/

/**
 * 公式内 KaTeX 排版增强（只处理 $...$ / $$...$$ 内部）：
 *
 * 1. **清理非法/冗余尺寸命令**：去掉 `\Biggl\left` 这类会让 KaTeX 解析失败的嵌套。
 * 2. **大运算符补 `\limits`**：AI 常写 `\max_{条件}`。行内模式下 KaTeX 会把条件放在
 *    右下角，遇到多行条件（Y_j ≤ Y_i 且 B_j ≤ B_i）就与算式挤在一起、看起来像重叠。
 *    显式写 `\max\limits_{…}` 可保证条件排在正下方（上下标形态），与常见数理排版一致。
 * 3. **`\{` / `\}` 升级为自适应尺寸**：`\max_{…}`、`\frac`、`\sum` 会把公式撑高，
 *    而普通 `\{` 固定小号，包不住内容。公式里出现"高结构"时把 `\{…\}` 换成
 *    `\left\{…\right\}`，大括号随内容高度自动放大（已有 `\left`/`\right` 的不重复处理）。
 */
function enhanceMathLayout(body: string): string {
  // 1. 清理非法/冗余尺寸命令（源内换行由围栏转换阶段折叠，见 normalizeFenceBody）
  let out = cleanMathSource(body)
  // 2. 大运算符限制符移到正下方。
  //    负向断言严格限定"运算符名之后直接跟下标"，避免在 `\max\left\{`、`\max (x)`、
  //    已有 `\max\limits` 等情况下插入多余空格并破坏原有间距。
  for (const op of BIG_OPERATORS) {
    out = out.replace(
      new RegExp(`(\\\\${op})(?!\\s*\\\\limits)(?![a-zA-Z])(\\s*)_`, 'g'),
      (_m, cmd: string, gap: string) => `${cmd}\\limits${gap}_`,
    )
  }
  // 3. 高结构里的普通花括号升级为自适应尺寸（已有 \left / \big 系列的不动）
  if (TALL_CONSTRUCT.test(out)) {
    out = out
      .replace(/(?<!\\left)(?<!\\big)(?<!\\Big)(?<!\\bigg)(?<!\\Bigg)\\\{/g, '\\left\\{')
      .replace(/(?<!\\right)(?<!\\big)(?<!\\Big)(?<!\\bigg)(?<!\\Bigg)\\\}/g, '\\right\\}')
  }
  // 4. 再修一次手动尺寸命令嵌套：第 3 步会把 `\Bigl\{` 升级成 `\left\{`，
  //    从而**新产生** `\Bigl\left` 这种非法嵌套（当初正是它让 KaTeX 解析失败）。
  //    必须放在最后，否则会被后面的升级重新引入。
  return fixManualSizeNesting(out)
}

/**
 * 把数学片段中的 KaTeX 不兼容字符转为合法 LaTeX：
 * - 特殊字符转义：& → \&, # → \#, % → \%（KaTeX 中 & 是表格分隔符、# 是宏参数、% 是注释）
 * - Unicode 数学符号 → LaTeX 命令（KaTeX 不认识 ¬ ⊕ ⊗ ℓ 等 Unicode 符号）
 * 仅在 $...$ / $$...$$ 包裹的数学内容内做转换，不影响普通文本。
 */
export function normalizeMathSymbols(text: string): string {
  // 按公式分段：只处理 $...$ / $$...$$ 内的内容
  const segments = text.split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g)
  return segments
    .map((seg, i) => {
      if (i % 2 === 0) return seg // 普通文本：不转换
      const isBlock = seg.startsWith('$$')
      const body = isBlock ? seg.slice(2, -2) : seg.slice(1, -1)
      const converted = body
        // LaTeX 命令保护：不转换已存在的 \& \# \% 等
        .replace(/(?<!\\)&/g, '\\&')
        .replace(/(?<!\\)#/g, '\\#')
        .replace(/(?<!\\)%/g, '\\%')
        // Unicode 数学符号 → LaTeX 命令
        .replace(/¬/g, '\\neg ')
        .replace(/⊕/g, '\\oplus ')
        .replace(/⊗/g, '\\otimes ')
        .replace(/ℓ/g, '\\ell ')
        .replace(/≤/g, '\\le ')
        .replace(/≥/g, '\\ge ')
        .replace(/≠/g, '\\ne ')
        .replace(/·/g, '\\cdot ')
        .replace(/×/g, '\\times ')
        .replace(/÷/g, '\\div ')
        .replace(/→/g, '\\to ')
        .replace(/←/g, '\\leftarrow ')
        .replace(/↔/g, '\\leftrightarrow ')
        .replace(/⇔/g, '\\Leftrightarrow ')
        .replace(/⇒/g, '\\Rightarrow ')
        // Unicode 省略号/减号 → LaTeX 等价物（KaTeX 把 … 渲染成文本省略号，
        // 数学排版应为 \dots；− 是 Unicode 数学减号，转为 ASCII 减号更稳）
        .replace(/…/g, '\\dots ')
        .replace(/−/g, '-')
        .replace(/√/g, '\\sqrt ')
        .replace(/⌊/g, '\\lfloor ')
        .replace(/⌋/g, '\\rfloor ')
        .replace(/⌈/g, '\\lceil ')
        .replace(/⌉/g, '\\rceil ')
        .replace(/∈/g, '\\in ')
        .replace(/∉/g, '\\notin ')
        .replace(/∪/g, '\\cup ')
        .replace(/∩/g, '\\cap ')
        .replace(/⊆/g, '\\subseteq ')
        .replace(/⊇/g, '\\supseteq ')
        .replace(/∀/g, '\\forall ')
        .replace(/∃/g, '\\exists ')
        .replace(/∂/g, '\\partial ')
        .replace(/∞/g, '\\infty ')
        .replace(/Σ/g, '\\sum ')
        .replace(/∏/g, '\\prod ')
        .replace(/²/g, '^2')
        .replace(/³/g, '^3')
        // Unicode 下标字符 → _{...}（连续多个下标合并为一组，如 ᵢ₋₁ → _{i-1}）
        .replace(/([ᵢⱼₙₘₚₖₐᵦₓᵧ₀₁₂₃₄₅₆₇₈₉₊₋]+)/g, (m: string) => {
          const map: Record<string, string> = {
            'ᵢ': 'i', 'ⱼ': 'j', 'ₙ': 'n', 'ₘ': 'm', 'ₚ': 'p', 'ₖ': 'k',
            'ₐ': 'a', 'ᵦ': 'b', 'ₓ': 'x', 'ᵧ': 'y',
            '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5',
            '₆': '6', '₇': '7', '₈': '8', '₉': '9', '₀': '0',
            '₊': '+', '₋': '-',
          }
          return '_{' + [...m].map((c) => map[c] ?? c).join('') + '}'
        })
        // Unicode 上标数字 → ^{...}（连续多个合并，如 ¹² → ^{12}）
        .replace(/([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g, (m: string) => {
          const map: Record<string, string> = {
            '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
            '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
          }
          return '^{' + [...m].map((c) => map[c] ?? c).join('') + '}'
        })
      return isBlock ? `$$${converted}$$` : `$${converted}$`
    })
    .join('')
}

/** 对整段文本里的公式做排版增强（\limits、自适应定界符） */
function enhanceMathLayoutInText(text: string): string {
  const segments = text.split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g)
  return segments
    .map((seg, i) => {
      if (i % 2 === 0) return seg
      const isBlock = seg.startsWith('$$')
      const body = isBlock ? seg.slice(2, -2) : seg.slice(1, -1)
      return isBlock ? `$$${enhanceMathLayout(body)}$$` : `$${enhanceMathLayout(body)}$`
    })
    .join('')
}

/* ============================ 4. 入口 ============================ */

/**
 * 完整预处理：按管线顺序归一化 AI 输出的代码 / 公式 / 文本。
 * Markdown 组件渲染前的唯一入口。
 *
 * 顺序说明：
 *  1. 清掉变体选择符/不换行空格（模型偶发输出，会让 KaTeX 渲染出方框）
 *  2. Unicode 上下标字符归一化为 LaTeX 上下标（ⱼ → _{j}，否则字体缺字形出方框）
 *  3. 剥离误包的整段 markdown 围栏
 *  4. LaTeX 定界符归一化（\[…\] → $$…$$）
 *  5. 裸数学包裹（内部完成代码区保护与还原）
 *  6. 公式内 Unicode 符号归一化
 *  7. 公式排版增强（大运算符补 \limits、花括号升级为自适应尺寸）
 */
export function preprocessMath(text: string): string {
  const cleaned = normalizeMathScriptChars(text.replace(/[\uFE0E\uFE0F]/g, '').replace(/\u00A0/g, ' '))
    // LaTeX 间距命令里的分号/冒号会被裸数学的片段扩展当作"非数学字符"而截断公式
    // （`\max_{0 \le j < i,\; Y_j …}` 会在 `\;` 处裂开）。统一成等价的 `\,`。
    .replace(/\\[;:]/g, '\\,')
  const normalized = normalizeMathSymbols(wrapBareMath(normalizeMathDelimiters(stripOuterCodeFence(cleaned))))
  return enhanceMathLayoutInText(normalized)
}

/** 供测试/调试使用：语言标记归一化 */
export { normalizeLang }

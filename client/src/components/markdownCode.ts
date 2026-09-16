/**
 * Markdown「代码 vs 公式」判定（纯函数，无 React 依赖，便于单元测试）。
 *
 * AI 回复里最常见的排版问题不是公式写错，而是 AI 把**数学公式塞进代码围栏/行内代码**，
 * 或者反过来把**代码片段写成裸文本**。渲染前必须先判定每一块内容的身份，
 * 才能分别交给代码卡（等宽 + 语言标签 + 复制）或 KaTeX（数学字体 + 居中）渲染。
 *
 * 判定原则：**默认是代码，只有强数学特征才改判为公式**。
 * 因为把真正的代码误判成公式会彻底毁掉可读性（C++ 代码渲染成斜体数学），
 * 而把公式留在代码框里只是"不够好看"。
 */

/**
 * 强数学记号：出现这些说明内容是**数学表达**，可以放心升级为 KaTeX 渲染。
 *
 * 覆盖三类：
 *   · LaTeX 语法（`\max`、`\frac`、`f_{i}`、`2^{k}`）
 *   · 排版级数学符号（Σ ∏ √ ≤ ≥ ≠ ∈ ∪ ∩ ← ∞ … 等）——AI 常直接用 Unicode 写公式，
 *     例如 `answer = Σ a[i] + (n-1) * min(a[i])`
 *   · Unicode 上下标字符（₀₁ᵢ ⁿ²，通常在管线入口已被归一化为 `_{}`/`^{}`）
 *
 * 刻意不含方括号/圆括号本身：`a[x] + a[x+1]`、`f(n)`、`O(n log n)` 这类纯括号 ASCII 记法
 * 既可能是代码也可能是数学，升级后会渲染成 `a` 下标 `[x+1]`（含义改变），因此保持原样。
 */
const STRONG_MATH_SYMBOLS =
  /∑|Σ|∏|Π|√|⌊|⌋|⌈|⌉|←|→|↔|⇔|⇒|≤|≥|≠|∞|∂|∇|∈|∉|∪|∩|⊆|⊇|⊕|⊗|∀|∃|·|…|[₀-₉₊₋₌₍₎ₐₑₒₓₕₖₗₘₙₚₛₜᵢⱼᵣᵤᵥ]|[⁰-⁹⁺⁻⁼⁽⁾ⁿⁱ]|²|³/

/** 复杂度记号：O(...) / Θ(...) / Ω(...)（注意不能匹配 C++ 的 operator() —— 那会先被 looksLikeCode 拦下） */
const COMPLEXITY = /[OΘΩ]\s*\(/

/**
 * LaTeX 语法特征：反斜杠命令（`\max`、`\frac`、`\le`）或花括号下标上标
 * （`f_{i}`、`2^{k}`，带不带前导标识符都算，例如 `\max_{j<i}`）。
 *
 * 这类记号说明内容确实是**排版出来的公式**。注意它只是"升级为公式"的充分条件之一 ——
 * AI 也常直接用 Unicode 写公式（`Σ a[i]`、`x ≤ y`），那部分由 STRONG_MATH 覆盖。
 */
export function looksLikeLatex(text: string): boolean {
  return /\\[a-zA-Z]+|\^\{|_\{/.test(text)
}

/** Unicode 下标字符 → 普通字符（含 U+2C7C 这类修饰字母，KaTeX 与等宽字体都不含其字形） */
const SUBSCRIPT_CHARS: Record<string, string> = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
  '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')',
  'ₐ': 'a', 'ₑ': 'e', 'ₒ': 'o', 'ₓ': 'x', 'ₕ': 'h', 'ₖ': 'k',
  'ₗ': 'l', 'ₘ': 'm', 'ₙ': 'n', 'ₚ': 'p', 'ₛ': 's', 'ₜ': 't',
  'ᵢ': 'i', 'ⱼ': 'j', 'ᵣ': 'r', 'ᵤ': 'u', 'ᵥ': 'v', 'ᵦ': 'b', 'ᵧ': 'y',
}

/** Unicode 上标字符 → 普通字符 */
const SUPERSCRIPT_CHARS: Record<string, string> = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
  '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')', 'ⁿ': 'n', 'ⁱ': 'i',
}

/** 连续下标字符序列（用于整体转换为 _{...}） */
const SUBSCRIPT_RUN = /[₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₕₖₗₘₙₚₛₜᵢⱼᵣᵤᵥᵦᵧ]+/g

/** 连续上标字符序列（用于整体转换为 ^{...}） */
const SUPERSCRIPT_RUN = /[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ]+/g

/** 修饰字母 / 上下标字符的整体范围（用于"整行是否只含公式字符"这类判定） */
export const SCRIPT_CHAR_RANGE = '₀-₉₊₋₌₍₎ₐₑₒₓₕₖₗₘₙₚₛₜᵢⱼᵣᵤᵥᵦᵧ⁰-⁹⁺⁻⁼⁽⁾ⁿⁱ'

/**
 * 把整段文本里的 Unicode 上下标字符提前归一化为 LaTeX 记法：
 *   `dpⱼ` → `dp_{j}`     `2ⁿ` → `2^{n}`     `a₁` → `a_{1}`
 *
 * 必须在管线一开始（代码区保护之前）做，因为这些字符会被后续逻辑当作普通文本，
 * 既匹配不到"裸数学"种子，也会在等宽/KaTeX 字体里渲染成方框（tofu）。
 * 代价是代码区里的上下标也会被改写 —— 但它们本来就是数学记法，转成 LaTeX 更清楚。
 */
export function normalizeMathScriptChars(text: string): string {
  return text
    .replace(SUBSCRIPT_RUN, (m) => `_{${[...m].map((c) => SUBSCRIPT_CHARS[c] ?? c).join('')}}`)
    .replace(SUPERSCRIPT_RUN, (m) => `^{${[...m].map((c) => SUPERSCRIPT_CHARS[c] ?? c).join('')}}`)
}

/**
 * 判断文本是否"看起来像真实代码"（而非数学公式）。
 * 命中任一典型代码特征即认为是代码——宁可把公式留在代码框里，也不要把代码渲染成公式。
 *
 * 关键是只认**无歧义的代码语法**：`f_i = f_{i-1} + 1` 这类等式虽然也像
 * "类型 + 变量名"，但那是数学，不能判成声明语句。
 */
export function looksLikeCode(text: string): boolean {
  return [
    // 语句结束符。排除 `\;` `\:` 这类 LaTeX 间距命令（公式里极常见，不是语句结束）：
    // 左负向断言要求分号前是偶数个连续反斜杠（0 个 → 真语句结束；1 个 → 转义，跳过）
    /(?<!\\)((?:\\\\)*);/,
    /#\s*(?:include|define|pragma|ifdef|ifndef)\b/, // 预处理指令（C/C++ 独有）
    /\b(?:function|const|let|var|def|class|struct|namespace|using|typedef|return|import|from|require|public|private|protected|template|printf|scanf|cout|cin|endl|std::|nullptr|malloc|free|lambda|elif|console\.|System\.out)\b/,
    /\b(?:if|for|while|switch|catch)\s*\(/, // 控制流
    /=>/, // 箭头函数 / lambda（`->` 与 `{}` 不判定：f_{i-1}、_{j} 这类数学写法极易误伤）
    /<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?>/, // 标签
    // 变量/函数声明。两处否定断言很关键，否则 `dp_i = \max…`、`dp[j] = x` 这类
    // 数学等式会被当成"类型 + 变量名 + 赋值"：
    //   (?<![_\]}])  变量名左侧不能是下标/上标的花括号或方括号（排除 a[i] = x、f_{i} = x）
    //   (?!\s*[[(])  变量名右侧不能紧跟 [ 或 (（排除 min(a) = x 这类函数调用）
    /\b(?:int|long|double|float|char|bool|void|string|auto|vector|pair|map|set|queue|unsigned|size_t)(?<![_\]}])\s+(?<![_\]}])\w+(?!\s*[[(])\s*[=;([]/,
    /\([^()\n]*\)\s*(?:->\s*[\w*&]+)?\s*;/, // 函数调用语句
  ].some((re) => re.test(text))
}

/**
 * 是否"强数学"——用于把行内代码 / 代码围栏改判为公式。
 * 只在出现明确的数学记号时返回真，避免 `dp_max`、`vis_cnt` 这类标识符被渲染成斜体公式。
 */
export function looksStronglyMath(text: string): boolean {
  return looksLikeLatex(text) || STRONG_MATH_SYMBOLS.test(text) || COMPLEXITY.test(text)
}

/** C/C++/Python 常见标准库标识符：单独出现（无任何数学记号）时按代码渲染 */
const CODE_IDENTIFIER =
  /^(?:std|push_back|pop_back|emplace_back|make_pair|lower_bound|upper_bound|sync_with_stdio|tie|ios|printf|scanf|sort|max_element|min_element|__int128|size_t|int64_t|uint64_t|NULL|nullptr|append|extend|strip|split|join|len|range|enumerate|zip)::?$/i

/**
 * 片段是否其实是「代码引用」而非公式。
 * 例如正文里提到的 g[prev].push_back(cur)、std::sort(a, a+n)、dp[i][j]、dp_max：
 * 这些含下划线/括号，会被数学种子命中，但它们属于代码，应渲染成行内代码。
 *
 * 注意要求片段内不含空格/逗号混排，避免把 `dp[i] + a[j]` 这类数学表达式整体标成代码。
 */
export function looksLikeCodeReference(fragment: string): boolean {
  const s = fragment.trim()
  // 含 LaTeX 命令或中文说明的一定不是代码引用
  if (!s || /\\[a-zA-Z]/.test(s) || /[\u4e00-\u9fff]/.test(s)) return false
  // 限定名（std::sort / a.b / a->b）可以带参数与空格：函数调用是代码
  if (/[A-Za-z_]\w*\s*(?:::|->|\.)\s*[A-Za-z_]\w*/.test(s)) return true
  // 其余形态含空格/逗号混排（`dp[i] + a[j]`、`f_i, c_j`）视为数学表达式
  if (/[\s,]/.test(s)) return false
  // 单个 snake_case 标识符（push_back / dp_max / max_element）是代码。
  // 但**单字母后缀**是数学下标：`dp_i`、`c_i`、`a_m` 必须走公式（否则会渲染成等宽代码，
  // 与同一句话里的 `f_{i-1}` 风格不一致）。所以要求后缀至少两个字符，
  // 或多段下划线（`sync_with_stdio`）。
  if (/^[A-Za-z]{2,}_[A-Za-z0-9]{2,}(?:_[A-Za-z0-9]+)*$/.test(s)) return true
  if (CODE_IDENTIFIER.test(s)) return true
  // 下标访问 a[...]：要求括号内还有标识符，排除 x[i] 这种数学下标
  const bracket = /[A-Za-z_]\w*\s*\[([^\]]*)\]/.exec(s)
  if (bracket && /[A-Za-z_]/.test(bracket[1]!)) return true
  return false
}

/** 数学代码围栏的语言标记：```math / ```latex / ```tex / ```equation / ```formula */
export const MATH_LANGS = new Set(['math', 'latex', 'tex', 'equation', 'formula', 'katex'])

/** Markdown 系围栏语言标记（含空标记）：这类围栏里装的其实是 Markdown 正文，不是代码 */
export const MARKDOWNISH_LANGS = new Set(['', 'markdown', 'md', 'gfm', 'commonmark'])

/** 围栏语言标记是否属于 Markdown（AI 整段回复误包 ```markdown 时用于剥离） */
export function isMarkdownishLang(lang: string): boolean {
  return MARKDOWNISH_LANGS.has(normalizeLang(lang))
}

/** 语言标记归一化：去 `language-` 前缀、取首个别名、小写 */
export function normalizeLang(raw: string): string {
  const first = raw.trim().split(/[\s:,]/)[0] ?? ''
  return first.replace(/^language-/i, '').toLowerCase()
}

/**
 * 围栏内容是否"自带代码注释"。注释是代码块的强特征：
 * 带注释的多行内容留在代码框里（注释里的中文、对齐空格在 KaTeX 里会变成怪异排版）。
 */
export function hasCodeComment(body: string): boolean {
  return /\/\/\s*\S|\/\*|(?:^|\s)#\s*[^\s#]/.test(body)
}

/** Unicode 数学符号 → LaTeX 命令（判定与渲染共用一份映射） */
const SYMBOL_MAP: Array<[RegExp, string]> = [
  [/Σ/g, '\\sum '], [/∑/g, '\\sum '], [/∏/g, '\\prod '], [/√/g, '\\sqrt '],
  [/≤/g, '\\le '], [/≥/g, '\\ge '], [/≠/g, '\\ne '], [/·/g, '\\cdot '], [/×/g, '\\times '],
  [/∈/g, '\\in '], [/∪/g, '\\cup '], [/∩/g, '\\cap '], [/∞/g, '\\infty '], [/←/g, '\\leftarrow '],
  [/→/g, '\\to '], [/…/g, '\\dots '], [/−/g, '-'],
]

/**
 * 把 Unicode 数学符号换成 LaTeX 命令，**供分类判定使用**。
 *
 * `Σ a[i]`、`n ≥ 3` 这类写法必须能被识别为数学；但 `Σ` 本身不是"强数学记号"
 * 覆盖的字符（`≥` 是），所以判定前先归一化，避免同一块内容被拆成
 * "有的行像公式、有的行不像"而整块退化成代码框。
 */
export function normalizeMathSymbolsForDetect(text: string): string {
  let out = text
  for (const [re, cmd] of SYMBOL_MAP) out = out.replace(re, cmd)
  return out
}

/**
 * 围栏代码块内容是否为数学公式。
 *
 * AI 经常把公式写进围栏（避免 Markdown 语法干扰），而且写法五花八门，判定顺序：
 *  1. 显式数学语言标记（```math / ```latex …）→ 公式
 *  2. 显式非数学语言标记（```cpp / ```python …）→ 代码
 *  3. 含代码特征（分号、关键字、控制流…）→ 代码
 *  4. 含 LaTeX 语法或强数学记号（`\frac`、`f_{i}`、`Σ`、`≤`、Unicode 上下标…）→ 公式
 *  5. 其余（`a[x] + a[x+1]`、`f(n)`、`O(n log n)` 这类纯括号 ASCII 记法）→ 代码
 *
 * **代码注释不算代码特征**：AI 常把公式连同解释一起写进围栏，例如
 *   `S = Σ a[i]   // 所有元素之和`
 * 这类内容本质是公式，之前因为"含注释"被误判成代码框（用户反馈"非代码内容被识别为代码块"）。
 * 注释由调用方在转换前剥掉。
 *
 * 多行内容额外要求"每一行都像公式"：避免"公式 + 普通说明行"整块被当公式。
 *
 * 第 5 条是刻意的取舍：把 `a[x+1]` 升级成 KaTeX 会渲染成 `a` 下标 `[x+1]`，
 * 与原文含义不同（用户截图里的"乱码"），宁可把它留在代码框里。
 */
export function shouldConvertFenceToMath(langRaw: string, body: string): boolean {
  const lang = normalizeLang(langRaw)
  const trimmed = body.trim()
  if (!trimmed) return false
  if (MATH_LANGS.has(lang)) return true
  if (lang && !MARKDOWNISH_LANGS.has(lang)) return false
  // 判定前先剥掉解释性注释、归一化 Unicode 数学符号：
  // 注释里的中文不是"代码"的证据，`Σ`/`≥` 则必须能被识别为数学
  const code = normalizeMathSymbolsForDetect(stripLineComments(trimmed)).trim()
  if (!code) return false
  if (looksLikeCode(code)) return false
  const lines = code.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return false
  // 单行：含强数学记号即可
  if (lines.length === 1) return looksStronglyMath(lines[0]!)
  // 多行：从宽 —— 只要**至少一行**含强数学记号，且包含该记号的行里没有普通说明文字，
  // 就整块按公式渲染。像 `n = 1 : a[0]` / `n ≥ 3 : S + M` 这种值表，
  // 部分行（`a[0]`）没有强数学记号，但它明显是公式而不是代码。
  const mathLines = lines.filter((l) => looksStronglyMath(l))
  if (mathLines.length === 0) return false
  return mathLines.every((l) => !/[\u4e00-\u9fff]/.test(l))
}

/**
 * 剥掉行尾解释性注释（`// 说明`）。
 *
 * 仅在注释符后面跟着空白或中文字符时才剥（`a // b`、`a // 说明`），
 * 避免把 `n//2` 这类整除、或 `http://` 误判。行内代码 span 里的内容保持不动。
 */
export function stripLineComments(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\s*\/\/\s*(?=[\s\u4e00-\u9fff]|$).*$/, ''))
    .join('\n')
}

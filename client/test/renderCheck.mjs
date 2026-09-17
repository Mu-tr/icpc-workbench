/**
 * 渲染结构验证（静态渲染，不需要浏览器 —— headless Chrome 在本沙箱会被进程级拦截）。
 *
 * 用法（在 client/ 下）：node test/renderCheck.mjs
 *
 * 步骤：
 *   1. 用 TypeScript 编译器 API 把 Markdown.tsx 编到 test/.render-out（不派生子进程，
 *      沙箱禁止 Node 通过管道 spawn 子进程；vite build 同样跑不了，所以只验证渲染结构）
 *   2. 注册 renderHooks.mjs 处理 .css / .ts 扩展名
 *   3. renderToStaticMarkup 出一段 HTML，对结构与可见文本做断言
 *
 * 断言技巧（都是踩过的坑）：
 *   · 「公式到底有没有被解析」用 katex.renderToString(body, { throwOnError: true })
 *     判定 —— 这是定位"公式源码被当普通文本显示"的唯一可靠手段；
 *     复用 markdownDiag.auditMathRender，与实际渲染走同一条 KaTeX 路径。
 *   · 数表头要数 `<th[ >]`，`<th[^>]*>` 会匹配到 `<thead>`。
 *   · KaTeX 在 `<annotation>` 里回显 TeX 源码，判断"可见文本里有没有残留源码"
 *     必须先剔除 annotation，否则永远为真。
 *   · 「修复前确实坏」不能靠猜：半截 `$$` / `\[` 在渲染层**不会**留下字面 `$$`
 *     （remark-math 把未闭合的 $$ 当到文件末尾的公式，我们的管线也会把未闭合的
 *     `\[` 换成不配对的 `$$`），此时要看的是**管线输出里公式区是否配对**、
 *     以及正文有没有被吞进公式区。
 */

import { register } from 'node:module'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const here = dirname(fileURLToPath(import.meta.url))
const clientRoot = resolvePath(here, '..')
const outDir = join(here, '.render-out')

/* ---------------------------- 1. 编译 ---------------------------- */

const hostFormatter = {
  getCanonicalFileName: (f) => f,
  getCurrentDirectory: () => clientRoot,
  getNewLine: () => '\n',
}

function compile() {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const options = {
    outDir,
    rootDir: join(clientRoot, 'src', 'components'),
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2023,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    // 需要真正产出 JS，所以必须关掉它（源码的 .ts 后缀由 renderHooks 改写）
    allowImportingTsExtensions: false,
    skipLibCheck: true,
    noEmitOnError: false,
    declaration: false,
    sourceMap: false,
  }
  const program = ts.createProgram([join(clientRoot, 'src', 'components', 'Markdown.tsx')], options)
  const { emitSkipped, diagnostics } = program.emit()
  if (emitSkipped) throw new Error(`tsc 未产出文件: ${ts.formatDiagnostics(diagnostics, hostFormatter)}`)
}

compile()
register('./renderHooks.mjs', import.meta.url)

const load = (name) => import(pathToFileURL(join(outDir, name)).href)
const { default: Markdown } = await load('Markdown.js')
const { repairStreamingMarkdown } = await load('markdownStream.js')
const { preprocessMath } = await load('markdownMath.js')
const { auditMathRender } = await load('markdownDiag.js')

/* ---------------------------- 断言工具 ---------------------------- */

/**
 * 取「用户能看到的文本」：去掉全部标签，并**先剔除 KaTeX 的 `<annotation>`**
 * （那里回显着 TeX 源码，不清掉会把"源码残留"判断变成恒真）。
 */
function visibleText(html) {
  return html
    .replace(/<annotation[\s\S]*?<\/annotation>/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

const render = (text, streaming) =>
  renderToStaticMarkup(React.createElement(Markdown, streaming === undefined ? { text } : { text, streaming }))

/** 数表头：`<th[ >]` —— 用 `<th[^>]*>` 会把 `<thead>` 也算进去 */
const tableHeaderCount = (html) => (html.match(/<th[ >]/g) ?? []).length

/**
 * 取管线输出里的 `$$…$$` 区：**未配对的 `$$` 之后的内容整体算一段**，
 * 用来暴露"半截公式把后面的正文吞进公式区"。
 */
function mathRegions(processed) {
  const regions = []
  let i = 0
  for (;;) {
    const at = processed.indexOf('$$', i)
    if (at === -1) break
    const close = processed.indexOf('$$', at + 2)
    regions.push({ body: close === -1 ? processed.slice(at + 2) : processed.slice(at + 2, close), closed: close !== -1 })
    i = close === -1 ? processed.length : close + 2
  }
  return regions
}

/** 渲染时的 KaTeX strict 警告（"Unicode text character 由 used in math mode" 这类） */
function collectWarnings(fn) {
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.map(String).join(' '))
  try {
    return { result: fn(), warnings }
  } finally {
    console.warn = original
  }
}

let failures = 0
let checks = 0

function check(name, fn) {
  checks += 1
  try {
    fn()
    console.log(`  ✔ ${name}`)
  } catch (e) {
    failures += 1
    console.log(`  ✖ ${name}\n      ${e.message}`)
  }
}

/* ---------------------------- [1] 流式补全 ---------------------------- */

console.log('\n[1] 流式补全：修复前 vs 修复后（同一段半成品文本）')

/**
 * 每条用例都先证明「修复前确实是坏的」，再证明「修复后是好的」。
 * before 证据二选一：
 *   · literals:   可见文本里残留的字面定界符
 *   · openRegion: 管线输出里 `$$` 不配对（公式区认不出来 / 吞掉正文）
 */
const STREAM_CASES = [
  {
    name: '加粗定界符写了一半',
    raw: '结论：**按位贪心可以证明',
    before: { literals: ['**'] },
    after: { literals: ['**'], html: ['<strong>'] },
  },
  {
    name: '斜体定界符写了一半',
    raw: '注意 *这里的边界',
    before: { literals: ['*'] },
    after: { literals: ['*'], html: ['<em>'] },
  },
  {
    name: '删除线写了一半',
    raw: '旧结论 ~~已经被推翻',
    before: { literals: ['~~'] },
    after: { literals: ['~~'], html: ['<del>'] },
  },
  {
    name: '行内代码里的 LaTeX 还没补反引号',
    raw: '递推式 `dp_{i-1}',
    before: { literals: ['`'] },
    after: { literals: ['`'], katex: 'inline' },
  },
  {
    name: '块级公式只写了一半（公式体里有 & 时后果可见）',
    raw: '推导：\n$$\nx_1 & x_2 + x_3',
    before: { openRegion: true, katexError: true },
    // `&` 在修复后会渲染成转义后的 & 号，所以这里只断言 `$$` 不再出现在可见文本里
    after: { literals: ['$$'], katex: 'display', html: ['katex-display'] },
  },
  {
    name: '引用块里的块级公式只写了一半（收尾要带 > 前缀）',
    raw: '> 推导：\n> $$\n> dp_i = dp_{i-1} + 1',
    before: { openRegion: true },
    after: { literals: ['$$'], katex: 'display', html: ['<blockquote>'] },
  },
  {
    name: '未闭合的 \\[ … \\] 换算（修复前会把正文吞进公式）',
    raw: '由定义 \\[f_i = f_{i-1} + a_i',
    before: { openRegion: true, swallowed: '由定义' },
    after: { literals: ['\\[', '\\]'], katex: 'display' },
  },
  {
    name: '未闭合的行内 $ 公式',
    raw: '转移为 $f_i = f_{i-1} + a_i',
    before: { literals: ['$'] },
    after: { literals: ['$'], katex: 'inline' },
  },
]

for (const c of STREAM_CASES) {
  // 修复前的渲染会触发 KaTeX 的 strict 警告（正文被吞进公式区时会报"中文出现在数学模式"），
  // 这里收集起来而不是让它打到 stderr：它本身就是"修复前确实坏"的旁证。
  const { result: beforeHtml, warnings: beforeWarnings } = collectWarnings(() => render(c.raw, false))
  const beforeText = visibleText(beforeHtml)
  const beforeProcessed = preprocessMath(c.raw)

  check(`${c.name} —— 修复前确实坏`, () => {
    for (const lit of c.before.literals ?? []) {
      assert.ok(beforeText.includes(lit), `修复前可见文本里没有 ${JSON.stringify(lit)}（用例前提不成立）: ${beforeText}`)
    }
    if (c.before.openRegion) {
      const regions = mathRegions(beforeProcessed)
      assert.ok(
        regions.some((r) => !r.closed),
        `修复前管线输出里的 $$ 竟然是配对的: ${JSON.stringify(beforeProcessed)}`,
      )
    }
    if (c.before.swallowed) {
      const regions = mathRegions(beforeProcessed)
      const swallowedIntoMath = regions.some((r) => !r.closed && r.body.includes(c.before.swallowed))
      const warned = beforeWarnings.some((w) => w.includes('unicodeTextInMathMode') || w.includes('math mode'))
      assert.ok(swallowedIntoMath || warned, `修复前正文没有被吞进公式区: ${JSON.stringify(beforeProcessed)}`)
    }
    if (c.before.katexError) {
      assert.ok(beforeHtml.includes('katex-error'), `修复前没有出现 katex-error（用例前提不成立）: ${beforeHtml.slice(0, 200)}`)
    }
  })

  const html = render(c.raw, true)
  const text = visibleText(html)
  const processed = preprocessMath(repairStreamingMarkdown(c.raw))

  check(`${c.name} —— 修复后可见文本干净`, () => {
    for (const lit of c.after.literals ?? []) {
      assert.ok(!text.includes(lit), `可见文本里仍残留 ${JSON.stringify(lit)}: ${text}`)
    }
    assert.ok(!html.includes('katex-error'), `仍出现 katex-error（源码被当文本显示）: ${html.slice(0, 200)}`)
  })
  check(`${c.name} —— 公式区配对且能被 KaTeX 严格解析`, () => {
    assert.ok(
      mathRegions(processed).every((r) => r.closed),
      `管线输出里仍有不配对的 $$: ${JSON.stringify(processed)}`,
    )
    const issues = auditMathRender(processed)
    assert.equal(issues.length, 0, `KaTeX 解析失败: ${JSON.stringify(issues)}`)
    if (c.after.katex === 'display') {
      assert.ok(html.includes('katex-display'), `没有渲染成块级公式: ${html.slice(0, 200)}`)
    } else if (c.after.katex === 'inline') {
      assert.ok(html.includes('class="katex"'), `没有渲染成行内公式: ${html.slice(0, 200)}`)
      assert.ok(!html.includes('katex-display'), '被误升级为块级公式')
    }
  })
  check(`${c.name} —— 附加结构断言`, () => {
    for (const frag of c.after.html ?? []) {
      assert.ok(html.includes(frag), `缺少结构 ${frag}: ${html.slice(0, 200)}`)
    }
  })
}

/* ---------------------------- [2] 不许越过红线 ---------------------------- */

console.log('\n[2] 流式补全不得越过这些红线（正文正常写法不能被"补"坏）')

const NO_TOUCH = [
  { name: '乘法算式 2 * 3 = 6', raw: '结果是 2 * 3 = 6', want: ['2 * 3 = 6'], noEmphasis: true },
  { name: '金额 $5', raw: '一共花了 $5', want: ['$5'] },
  { name: '无序列表标记 * item', raw: '* 第一项\n* 第二项', want: ['<ul>', '<li>第一项</li>'] },
  { name: 'snake_case 标识符 push_back', raw: '用 push_back 插入', want: ['push_back'], noKatax: true },
  // 说明：`dp[i]` 这类**单个下标记号**本轮已按数学渲染（用户截图反馈），
  // 所以它不在"原样保留"清单里，改在 [4] 里断言数学渲染；代码语句仍在这里。
  { name: '代码语句 dp[i] = dp[i-1] + 1;', raw: '转移就是 dp[i] = dp[i-1] + 1;', want: ['<code>dp[i] = dp[i-1] + 1</code>'] },
]

for (const c of NO_TOUCH) {
  check(`${c.name} —— 流式渲染后仍是普通文本`, () => {
    const html = render(c.raw, true)
    const text = visibleText(html)
    if (c.noEmphasis !== false) assert.ok(!html.includes('<em>') && !html.includes('<strong>'), `被当成强调: ${html.slice(0, 200)}`)
    assert.ok(!html.includes('class="katex"'), `被当成公式渲染: ${html.slice(0, 200)}`)
    for (const frag of c.want) {
      assert.ok(html.includes(frag), `缺少 ${frag}（记号被改写或吞掉）: ${html.slice(0, 200)} / 可见文本: ${text}`)
    }
  })
}

check('词内波浪号 20~25 被转义而不是变成删除线区间', () => {
  const html = render('区间 20~25 之间', true)
  assert.ok(!html.includes('<del>'), `被当成删除线: ${html.slice(0, 200)}`)
  assert.ok(visibleText(html).includes('20~25'), visibleText(html))
})

check('表格：公式（含未闭合写法）不会把表格拆散', () => {
  const html = render('| 状态 | 转移 |\n| --- | --- |\n| dp_i | $f_i = f_{i-1} + 1$ |', false)
  assert.ok(html.includes('<table>'), html.slice(0, 200))
  assert.equal(tableHeaderCount(html), 2, '表头数不对')
  assert.ok(!html.includes('katex-display'), '单元格里出现块级公式会拆散表格行')
})

/* ---------------------------- [3] 代码区不变量 ---------------------------- */

console.log('\n[3] 代码区不变量（分层渲染的地基）')

const CODE_CASES = [
  {
    name: '正文里的 g[prev].push_back(cur) 保持代码形态',
    raw: '调用 g[prev].push_back(cur) 追加边',
    want: ['<code>'],
    reject: ['$g[prev]', 'class="katex"'],
  },
  {
    name: 'ios::sync_with_stdio 不被包进公式',
    raw: '加 ios::sync_with_stdio(false) 加速',
    want: ['<code>'],
    reject: ['class="katex"'],
  },
  {
    name: '围栏代码块走代码卡，内容原样',
    raw: '```cpp\nint main() {\n  for (int i = 0; i < n; i++) dp[i] = i;\n  return 0;\n}\n```',
    want: ['md-code-card', 'md-code-lang', 'language-cpp', 'dp[i] = i;'],
    reject: ['class="katex"'],
  },
  {
    name: '正文里的 C++ 声明行（带数字下标）不被包进公式',
    raw: '开一个 int dp[100005]; 数组，转移写成 dp[i] = dp[i-1] + 1; 即可',
    // 声明里的数组名与代码语句都渲染成行内代码（修复前是 `int $dp[100005]$;` 斜体公式）
    want: ['<code>dp[100005]</code>', '<code>dp[i] = dp[i-1] + 1</code>'],
    reject: ['class="katex"'],
  },
  {
    name: '外链带 target=_blank rel=noreferrer',
    raw: '参考 [题解](https://example.com/a)',
    want: ['target="_blank"', 'rel="noreferrer noopener"'],
  },
]

for (const c of CODE_CASES) {
  check(`${c.name}`, () => {
    const html = render(c.raw, false)
    const processed = preprocessMath(c.raw)
    for (const frag of c.want) assert.ok(html.includes(frag), `缺少 ${frag}: ${html.slice(0, 300)}`)
    for (const frag of c.reject ?? []) {
      assert.ok(!html.includes(frag) && !processed.includes(frag), `出现不该有的 ${frag}`)
    }
  })
}

/* ---------------------------- [4] 说明正文里的数学（用户截图） ---------------------------- */

console.log('\n[4] 说明正文里的数学不再渲染成代码（用户截图场景）')

/** 用户截图里的那条消息（按截图重建） */
const EXPLANATION = [
  '### 1.1 位置与"偏移"的关系',
  '',
  '记行号为 `r`，列号为 `c`。',
  '格子里的数等价于',
  '',
  '```',
  'b[r][c] = a[(r - c) mod n]      // 这里的 mod 取非负余数',
  '```',
  '',
  '把 `offset = (r - c) mod n` 称为**偏移**，则格子的权值正是 `a[offset]`。',
  '',
  '- **向右**：`c←c+1`，`r` 不变 → `offset` 变为 `offset-1 (mod n)`',
  '- **向下**：`r←r+1`，`c` 不变 → `offset` 变为 `offset+1 (mod n)`',
  '',
  '所以路径在偏移环上进行一次步长为 `±1` 的随机游走，起点 `offset = 0`，终点也必须是 `0`。',
].join('\n')

check('公式行不再是代码卡，说明里的数学记号不再是行内代码', () => {
  const html = render(EXPLANATION, false)
  const text = visibleText(html)
  assert.ok(!html.includes('md-code-card'), `公式行仍被渲染成代码卡: ${html.slice(0, 300)}`)
  assert.ok(!html.includes('<code'), `说明正文里仍有行内代码 span: ${html.slice(0, 400)}`)
  assert.ok(html.includes('katex-display'), '公式行没有渲染成块级公式')
  // 说明里的数学都进了 KaTeX
  assert.ok(!text.includes('`') && !text.includes('$'), `可见文本里残留定界符: ${text}`)
  assert.ok(html.includes('katex'), '说明里的数学没有渲染成公式')
})

check('公式行的内容与说明都还在（不能静默丢内容）', () => {
  const html = render(EXPLANATION, false)
  // KaTeX 会重排空白并使用 Unicode 减号，所以按关键片段断言而不是整串比对
  const text = visibleText(html).replace(/\s+/g, ' ')
  assert.ok(text.includes('b[r][c]'), `公式左边丢了: ${text}`)
  assert.ok(text.includes('mod n]'), `公式右边丢了: ${text}`)
  assert.ok(text.includes('这里的 mod 取非负余数'), `行尾说明被丢掉: ${text}`)
  assert.ok(text.includes('记行号为') && text.includes('随机游走'), '正文被破坏')
})

check('每个公式都能被 KaTeX 严格解析（含 ±、\\bmod、\\text{中文}）', () => {
  const processed = preprocessMath(EXPLANATION)
  const issues = auditMathRender(processed)
  assert.equal(issues.length, 0, `KaTeX 解析失败: ${JSON.stringify(issues)}`)
  assert.ok(!render(EXPLANATION, false).includes('katex-error'), '出现 katex-error（源码被当文本显示）')
})

check('真代码红线：反引号里的代码标识符仍是代码', () => {
  const html = render('用 `push_back` 插入，比较 `a[x] + a[x+1]`，复杂度 `O(n log n)`。', false)
  for (const frag of ['<code>push_back</code>', '<code>a[x] + a[x+1]</code>', '<code>O(n log n)</code>']) {
    assert.ok(html.includes(frag), `缺少 ${frag}: ${html.slice(0, 300)}`)
  }
})

check('多行伪代码围栏保持代码卡，换行与缩进不丢（用户截图：代码粘连）', () => {
  // 回归：块里只要有一行含 `…`（强数学记号），整块伪代码曾被判成公式，
  // 换行被压成一行、缩进消失，KaTeX 还会吞掉词间空格（for i → fori）
  const raw = [
    '等价的写法是：',
    '',
    '```',
    'need = 0',
    'for i = 0…n :',
    '    if cnt[i] > 0 :',
    '        cnt[i]--, need++',
    'answer = i',
    '```',
    '',
    '### 1.4 大 k 的特例',
    '',
    '如果 k > 2·max(a_i) 则答案为普通 mex。',
  ].join('\n')
  const html = render(raw, false)
  assert.ok(html.includes('md-code-card'), `伪代码没有走代码卡: ${html.slice(0, 300)}`)
  // 只看代码卡内部：整条消息里的正文公式（`2·max(a_i)`）本来就该用 KaTeX
  const cardStart = html.indexOf('md-code-card')
  const card = html.slice(cardStart, html.indexOf('</pre>', cardStart) + 6)
  assert.ok(card.length > 20, `代码卡没抓到: ${html.slice(0, 200)}`)
  assert.ok(!card.includes('katex'), `代码卡里的伪代码被当成公式: ${card.slice(0, 300)}`)
  assert.ok(card.includes('need = 0\nfor i = 0…n :'), '代码卡里丢了换行')
  // 缩进按行首空格断言（`>` 在 HTML 里会转义成 &gt;，不比对整行）
  assert.ok(card.includes('\n    if cnt[i]'), '代码卡里丢了 4 空格缩进')
  assert.ok(card.includes('\n        cnt[i]--'), '代码卡里丢了 8 空格缩进')
  assert.ok(html.includes('<h3>1.4 大 k 的特例</h3>'), '章节标题没有渲染成标题')
  // 正文里的数学仍是公式
  assert.ok(html.includes('katex'), '正文里的 · max(a_i) 没有渲染成公式')
})

check('反引号里的中文术语与 Unicode 减号下标不再是代码', () => {
  const html = render('使它的 `价值` 为 0，或是 `k−a_i` 本身。', false)
  assert.ok(!html.includes('<code'), `仍有行内代码 span: ${html.slice(0, 300)}`)
  assert.ok(visibleText(html).includes('价值'), visibleText(html))
  assert.ok(html.includes('class="katex"'), 'k−a_i 没有渲染成公式')
})

check('折行的公式转成块级公式，同一段里的伪代码仍留在代码卡（用户截图 3）', () => {
  const raw = [
    '在一次查询中，针对当前的 k，对每个 i 我们可以使用的资源数为',
    '',
    '```',
    'avail(i) = cnt[i]                  // 直接保留 i',
    '         + (i != k-i ? cnt[k-i] : 0) // 变换得到 i（若 i 与 k-i 不同）',
    '```',
    '',
    '因为每件资源只能被使用一次，遍历 i 时把已经使用的资源从 cnt 中减掉即可。',
    '',
    '```',
    'need = 0            // 已经成功构造了 0..need-1',
    'for i = 0 … n:',
    '    if cnt[i] > 0:          cnt[i]--, need++',
    '    else break              // i 不能得到，mex = i',
    'answer = i',
    '```',
  ].join('\n')
  const html = render(raw, false)
  const text = visibleText(html).replace(/\s+/g, ' ')
  // KaTeX 会重排公式里的空白，所以去掉所有空白后再比对关键片段
  const flat = text.replace(/\s+/g, '')
  // 折行公式 → 块级公式（不是代码卡）
  assert.ok(html.includes('katex-display'), `折行公式没有渲染成块级公式: ${html.slice(0, 300)}`)
  assert.ok(flat.includes('avail(i)=cnt[i]'), `公式内容丢了: ${text.slice(0, 200)}`)
  assert.ok(flat.includes('i≠k−i') || flat.includes('i≠k-i'), `编程关系符没有转成数学不等号: ${flat.slice(0, 200)}`)
  assert.ok(text.includes('直接保留 i') && text.includes('变换得到 i'), `行尾说明被丢掉: ${text.slice(0, 200)}`)
  // 伪代码卡 → 仍是代码卡，换行与缩进都在；整条消息里只应剩这一张代码卡
  assert.equal((html.match(/class="md-code-card/g) ?? []).length, 1, '代码卡数量不对（应当只剩伪代码那一张）')
  assert.ok(html.includes('need = 0') && html.includes('\nfor i = 0 … n:'), '伪代码卡里丢了换行')
  assert.ok(html.includes('\n    if cnt[i]'), '伪代码卡里丢了缩进')
  assert.ok(html.includes('\nanswer = i'), '伪代码卡里丢了最后一行')
  // 全篇没有 KaTeX 解析失败
  assert.ok(!html.includes('katex-error'), '出现 katex-error')
  assert.equal(auditMathRender(preprocessMath(raw)).length, 0, '有公式无法被 KaTeX 解析')
})

check('裸写的单个下标记号按数学渲染（dp[i] / a[offset]）', () => {
  for (const raw of ['状态 dp[i] 表示前 i 个', '权值正是 a[offset]']) {
    const html = render(raw, false)
    assert.ok(html.includes('class="katex"'), `${raw} 没有渲染成公式: ${html.slice(0, 200)}`)
    assert.ok(!html.includes('<code'), `${raw} 被渲染成代码: ${html.slice(0, 200)}`)
  }
})

/* ---------------------------- [5] 失败可观测性 ---------------------------- */

console.log('\n[5] KaTeX 失败的可观测性（失败必须能被发现，而不是静默显示源码）')

check('写坏的公式会被 KaTeX 拒绝，并且渲染成 katex-error（红色源码）', () => {
  const broken = '$$\n\\frac{1}\n$$'
  const processed = preprocessMath(broken)
  const issues = auditMathRender(processed)
  assert.equal(issues.length, 1, `诊断应报出 1 处失败，实际 ${issues.length}`)
  assert.match(issues[0].message, /ParseError|KaTeX/)
  const html = render(broken, false)
  assert.ok(html.includes('katex-error'), `未渲染成红色源码: ${html.slice(0, 300)}`)
  assert.ok(visibleText(html).includes('\\frac{1}'), '失败公式的源码应当可见（这正是要诊断的现象）')
})

check('正常公式不会被诊断误报', () => {
  const good = '设 $dp_i$ 为最优解：\n\n$$\ndp_i = \\max_{j < i}(dp_j + 1)\n$$'
  assert.equal(auditMathRender(preprocessMath(good)).length, 0)
  assert.ok(!render(good, false).includes('katex-error'))
})

/* ---------------------------- [5] 逐帧流式性质 ---------------------------- */

console.log('\n[6] 逐字流式：真实回复的每一帧都不比"不补"更差')

/**
 * 可见文本里残留的字面定界符数量 —— 用户实际看到的"闪烁"就是这个。
 * 刻意**不把 katex-error 计入**：公式本身只写了一半（如 `\\frac{1}{`）时，
 * 补全也变不出合法公式，那是 dev 诊断（[4]）负责暴露的对象，不是补全的失职。
 */
const DELIMS = ['**', '$$', '~~', '`']
function badness(html) {
  const text = visibleText(html)
  return DELIMS.reduce((n, d) => n + text.split(d).length - 1, 0)
}

const STREAM_ANSWER = [
  '## 思路',
  '',
  '设 $dp_i$ 表示前 $i$ 个位置的最优解，则转移为：',
  '',
  '$$',
  'dp_i = \\max_{j < i}(dp_j + 1)',
  '$$',
  '',
  '其中 $j$ 满足 $a_j \\le a_i$，**注意边界**：$dp_1 = 1$。',
  '',
  '用 `push_back` 维护候选集合，复杂度 $O(n \\log n)$。',
  '',
  '```cpp',
  'int main() {',
  '  for (int i = 0; i < n; i++) dp[i] = 1;',
  '  return 0;',
  '}',
  '```',
  '',
  '- 第一步：离散化',
  '- 第二步：树状数组',
].join('\n')

check('整段回复（补全后）渲染完全干净', () => {
  const html = render(STREAM_ANSWER, true)
  assert.equal(badness(html), 0, `仍有残留定界符: ${visibleText(html).slice(-80)}`)
  assert.ok(!html.includes('katex-error'), '完整回复不该出现 katex-error')
  assert.ok(
    mathRegions(preprocessMath(repairStreamingMarkdown(STREAM_ANSWER))).every((r) => r.closed),
    '完整回复里公式区不配对',
  )
})

check('逐字流式的每一帧：补全后不比不补更差（单调性），且公式区始终配对', () => {
  const violations = []
  let improved = 0
  let repaired = 0
  let frames = 0
  for (let n = 1; n <= STREAM_ANSWER.length; n++) {
    const frame = STREAM_ANSWER.slice(0, n)
    frames += 1
    if (repairStreamingMarkdown(frame) !== frame) repaired += 1
    const raw = badness(render(frame, false))
    const fixed = badness(render(frame, true))
    if (fixed > raw) violations.push({ n, raw, fixed, tail: frame.slice(-25) })
    if (fixed < raw) improved += 1
    const regions = mathRegions(preprocessMath(repairStreamingMarkdown(frame)))
    if (regions.some((r) => !r.closed)) violations.push({ n, raw, fixed, tail: `公式区未配对: ${frame.slice(-25)}` })
  }
  console.log(`      （共 ${frames} 帧：${repaired} 帧内容被补全，其中 ${improved} 帧的可见残留定界符被消除）`)
  assert.equal(violations.length, 0, `违反性质的帧: ${JSON.stringify(violations.slice(0, 3))}`)
  assert.ok(repaired >= 10, `补全几乎没有触发（只改了 ${repaired} 帧）—— 用例可能没覆盖到半成品状态`)
  assert.ok(improved >= 5, `补全没有产生可见改善（只改善了 ${improved} 帧）`)
})

/* ---------------------------- [7] 排版间距 ---------------------------- */

console.log('\n[7] 排版间距（CSS 结构检查）')

/**
 * CSS 不会进入静态渲染结果，headless 浏览器又被沙箱拦在进程级，
 * 所以这里只做**结构检查**：括号配平（防止手改样式表改坏整份 CSS）+ 关键间距声明存在。
 * 真实视觉效果需要用户刷新页面确认。
 */
check('index.css 括号配平，且章节/段落/代码卡间距已放宽', () => {
  const css = readFileSync(join(clientRoot, 'src', 'index.css'), 'utf8')
  const open = (css.match(/\{/g) ?? []).length
  const close = (css.match(/\}/g) ?? []).length
  assert.equal(open, close, `花括号不配平: { ${open} 个 / } ${close} 个`)
  for (const decl of [
    'margin: 20px 0 8px;', // 标题上间距
    'margin-top: 26px;', // h1/h2 更大一层
    'margin: 8px 0;', // 段落
    'margin: 13px 0;', // 代码卡
    'margin: 15px 0;', // 块级公式
  ]) {
    assert.ok(css.includes(decl), `缺少间距声明: ${decl}`)
  }
})

/* ---------------------------- 收尾 ---------------------------- */

console.log(`\n${failures === 0 ? '全部通过' : '存在失败'}：${checks - failures}/${checks} 项断言组通过\n`)
if (failures > 0) process.exitCode = 1


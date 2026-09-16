/**
 * markdownMath.ts 预处理管线单元测试。
 * 用 node:test 运行（Node 22 内置，无需额外依赖）。
 *
 * 用例来源于真实 AI 消息（Permutation Inversions 讲解）中暴露的渲染 bug：
 * 代码块被公式逻辑污染、** 加粗定界符卷入公式、片段重叠导致文本重复、
 * Unicode 省略号/减号截断公式。
 *
 * 本轮重构新增「代码 / 公式 / 文字」三分判定，重点回归：
 *   · 代码区（围栏 + 行内）绝不被公式逻辑改写
 *   · 正文里的代码引用渲染成行内代码而非斜体公式
 *   · 数学围栏 / 缩进公式块仍能正确改判为公式
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  preprocessMath,
  stripOuterCodeFence,
  normalizeMathDelimiters,
  wrapBareMath,
} from '../src/components/markdownMath.ts'
import { shouldConvertFenceToMath, looksLikeCode, normalizeLang, stripLineComments } from '../src/components/markdownCode.ts'

// ---------- stripOuterCodeFence ----------

describe('stripOuterCodeFence', () => {
  it('剥离整段包裹的 ```markdown 围栏', () => {
    assert.equal(stripOuterCodeFence('```markdown\n# 标题\n内容\n```'), '# 标题\n内容\n')
  })
  it('cpp 等代码语言的围栏不剥离（整段是代码块）', () => {
    const text = '```cpp\nint x;\n```'
    assert.equal(stripOuterCodeFence(text), text)
  })
  it('内部嵌套围栏时不剥离', () => {
    const text = '```\n标题\n```cpp\nint x;\n```\n```'
    assert.equal(stripOuterCodeFence(text), text)
  })
  it('无围栏时原样返回', () => {
    assert.equal(stripOuterCodeFence('# 标题'), '# 标题')
  })
  it('围栏只是内容一部分时不剥离', () => {
    const text = '正文\n```\ncode\n```\n结尾'
    assert.equal(stripOuterCodeFence(text), text)
  })
  it('语言标记带空白或大小写时仍识别为 markdown', () => {
    assert.equal(stripOuterCodeFence('``` Markdown \n# 标题\n```'), '# 标题\n')
  })
})

// ---------- normalizeMathDelimiters ----------

describe('normalizeMathDelimiters', () => {
  it('\\(...\\) → $...$', () => {
    assert.equal(normalizeMathDelimiters('已知 \\(x < y\\) 求解'), '已知 $x < y$ 求解')
  })
  it('\\[...\\] → $$...$$（$$ 独占一行，否则 remark-math 会降级为行内公式）', () => {
    assert.equal(normalizeMathDelimiters('公式：\n\\[a + b = c\\]\n完毕'), '公式：\n$$\na + b = c\n$$\n完毕')
  })
  it('代码块内的 \\(...\\) 不转换', () => {
    const text = '`\\(x\\)` 是内联代码'
    assert.equal(normalizeMathDelimiters(text), text)
  })
  it('块级 LaTeX 定界符被归一化为 remark-math 可识别的 $$', () => {
    // $$ 必须独占一行：行内 $$...$$ 会被 remark-math 降级为行内公式（不居中、不换行）
    assert.ok(preprocessMath('\\[O(n \\log n)\\]').includes('$$\nO(n \\log n)\n$$'))
  })
  it('行内 \\(...\\) 归一化后仍为行内公式（不升级为块级）', () => {
    const out = preprocessMath('其中 \\(a_i\\) 为前缀和')
    assert.ok(out.includes('$a_i$'), out)
    assert.ok(!out.includes('$$'), out)
  })
})

// ---------- 代码块保护 ----------

describe('代码块不被公式逻辑污染', () => {
  it('C++ 代码块内的下划线标识符/箭头注释保持原样', () => {
    const code = [
      '```cpp',
      'ios::sync_with_stdio(false);',
      'g[prev].push_back(cur);',
      'priority_queue<int, vector<int>, greater<int>> pq;',
      '// 连 qj -> q(j+1)',
      'cout << p[i] << (i == n ? \'\\n\' : \' \');',
      '```',
    ].join('\n')
    const out = preprocessMath(code)
    assert.ok(out.includes('ios::sync_with_stdio(false);'), 'sync_with_stdio 被包进公式')
    assert.ok(out.includes('g[prev].push_back(cur);'), 'push_back 被包进公式')
    assert.ok(out.includes('priority_queue<int, vector<int>, greater<int>> pq;'), 'priority_queue 被包进公式')
    assert.ok(out.includes('// 连 qj -> q(j+1)'), '箭头注释被包进公式')
    // 代码围栏本身必须保留
    assert.ok(out.includes('```cpp'), '代码围栏被移除')
  })

  it('代码块内容不含任何 $ 包裹（代码区被完全保护）', () => {
    const out = preprocessMath('```cpp\nint dp_max = f_{i}; // a_i\n```')
    assert.ok(!out.includes('$'), `代码区出现公式定界符: ${out}`)
  })

  it('围栏内的 $$ 不会被当成公式定界符（内容是代码）', () => {
    const out = preprocessMath('```txt\n\\[x\\]\n```')
    assert.ok(out.includes('\\[x\\]'), out)
  })

  it('未闭合的行内反引号不破坏后续文本', () => {
    const out = preprocessMath('看 ` 这里 c_i 是下标')
    assert.ok(out.includes('$c_i$'), out)
  })

  it('行内代码 + 围栏混排时围栏语法不泄漏（占位符编号必须全局唯一）', () => {
    const text = '其中 w 用 `query_max` 维护。\n\n```cpp\nint dp_max[100005];\n```\n'
    const out = preprocessMath(text)
    assert.equal(out, text, `围栏/行内代码被破坏: ${out}`)
    assert.equal((out.match(/```/g) ?? []).length, 2, '围栏数量应为 2')
  })

  it('多段围栏与多个行内代码混排时各自保持原样', () => {
    const text = [
      '先 `push_back` 再 `pop_back`：',
      '',
      '```cpp',
      'g[prev].push_back(cur);',
      '```',
      '',
      '最后 `std::sort(a, a + n)`。',
      '',
      '```python',
      'def solve(n):',
      '    return n',
      '```',
    ].join('\n')
    const out = preprocessMath(text)
    assert.ok(out.includes('`push_back`') && out.includes('`pop_back`'), out)
    assert.ok(out.includes('`std::sort(a, a + n)`'), out)
    assert.equal((out.match(/```/g) ?? []).length, 4, `围栏数量应为 4: ${out}`)
    assert.ok(!out.includes('$'), `不应产生公式: ${out}`)
  })

  it('q1 → q2 链式文本不被包裹（→ 不是数学种子）', () => {
    const out = wrapBareMath('对每条约束，相邻两项连边：q1 → q2 → q3 → … → qk')
    assert.equal(out, '对每条约束，相邻两项连边：q1 → q2 → q3 → … → qk')
  })
})

// ---------- 正文中的代码引用 ----------

describe('正文里的代码引用渲染为行内代码', () => {
  it('g[prev].push_back(cur) 不进入公式，保持原样且只出现一次', () => {
    const out = preprocessMath('调用 g[prev].push_back(cur) 追加边')
    const occurrences = out.split('g[prev].push_back').length - 1
    assert.equal(occurrences, 1, `文本被重复输出: ${out}`)
    assert.ok(!out.includes('$g[prev]'), `代码引用被包进公式: ${out}`)
  })
  it('std::sort(a, a + n) 保持代码形态', () => {
    const out = preprocessMath('先 std::sort(a, a + n) 排序')
    assert.ok(out.includes('std::sort'), out)
    assert.ok(!/\$std::sort/.test(out), out)
  })
  it('dp[i][j] 下标访问保持代码形态', () => {
    const out = preprocessMath('状态 dp[i][j] 表示前 i 个')
    assert.ok(out.includes('dp[i][j]'), out)
    assert.ok(!/\$dp/.test(out), out)
  })
  it('裸 snake_case 标识符 push_back 按代码处理', () => {
    const out = wrapBareMath('用 push_back 插入')
    assert.ok(!/\$push_back\$/.test(out), out)
  })
  it('真正的数学下标 a_i 仍被包裹为公式', () => {
    assert.ok(preprocessMath('数列 a_i 的前缀和').includes('$a_i$'))
  })
  it('单字母下标的标识符按数学渲染（dp_i / c_i / a_m），与 f_{i-1} 风格一致', () => {
    for (const src of ['dp_i', 'c_i', 'a_m', 'f_i']) {
      const out = preprocessMath(`前缀 ${src} 后缀`)
      assert.ok(out.includes(`$${src}$`), `${src} 未进公式: ${out}`)
      assert.ok(!out.includes('`'), `${src} 被当成代码: ${out}`)
    }
  })
  it('多字母下标的标识符仍按代码渲染（push_back / dp_max）', () => {
    for (const src of ['push_back', 'dp_max', 'vis_cnt']) {
      const out = preprocessMath(`前缀 ${src} 后缀`)
      assert.ok(out.includes(`\`${src}\``), `${src} 未保持代码: ${out}`)
    }
  })
  it('公式里的绝对值 | … | 不被截断，且裸 | 表达式被识别', () => {
    assert.ok(preprocessMath('令 x = |a| + |b| 即可').includes('$|a| + |b|$'))
  })
})

// ---------- 行内代码 / 数学围栏的身份判定 ----------

describe('代码与公式的身份判定', () => {
  it('行内代码里的数学样式不再被改写成公式（保持代码）', () => {
    const out = preprocessMath('用 `dp_max` 记录最大值')
    assert.ok(out.includes('`dp_max`'), out)
    assert.ok(!out.includes('$dp_max$'), out)
  })
  it('行内代码一律保持代码（含纯公式写法，反引号是显式的代码标注）', () => {
    const out = preprocessMath('复杂度 `O(n log n)` 可行')
    assert.equal(out, '复杂度 `O(n log n)` 可行')
  })
  it('行内代码里的 ASCII 下标访问不被渲染成 a 下标 [x+1]（截图乱码回归）', () => {
    const text = '额外的代价只剩一次 `a[x] + a[x+1]`（其余抵消）。'
    assert.equal(preprocessMath(text), text)
  })
  it('行内代码里的 Unicode 下标被归一化并转为公式（字形兜底 + 样式统一）', () => {
    // ⱼ ₁ ₙ 这类字符在等宽字体与 KaTeX 基础字体里都缺字形，渲染成方框；
    // 管线入口统一转成 _{...}，随后被识别为 LaTeX 数学、剥掉反引号走公式渲染。
    const text = '相邻的两个元素 `a₁` 与 `a₁₈`（下标取模 `a₁₉`）的和。'
    assert.equal(
      preprocessMath(text),
      '相邻的两个元素 $a_{1}$ 与 $a_{18}$（下标取模 $a_{19}$）的和。',
    )
  })
  it('行内代码自带 $ 定界符时也保持代码（不剥反引号）', () => {
    const text = '源码写作 `$a_i + b_i$` 的形式'
    assert.equal(preprocessMath(text), text)
  })
  it('数学代码块被转为公式（· 不再截断片段）', () => {
    const out = preprocessMath('```\nO(n·3^{n/6})\n```')
    assert.ok(out.includes('$$\nO(n\\cdot 3^{n/6})\n$$'), out)
    assert.ok(!out.includes('```'), out)
  })
  it('```math 围栏即使内容是纯算式也改判为公式', () => {
    const out = preprocessMath('```math\nx = y + 1\n```')
    assert.ok(out.includes('x = y + 1'), out)
    assert.ok(!out.includes('```'), out)
  })
  it('多行推导块每行都是公式时整体转公式', () => {
    const out = preprocessMath('```\nf_i = f_{i-1} + f_{i-2}\ng_i = g_{i-1} · 2\n```')
    assert.ok(out.includes('$$'), out)
    assert.ok(out.includes('\\cdot'), out)
  })
  it('自然语言代码围栏保持代码（不因含下划线转公式）', () => {
    const block = '```python\ndef solve(n):\n    return n * 2\n```'
    const out = preprocessMath(block)
    assert.ok(out.includes('```python'), out)
    assert.ok(out.includes('def solve(n):'), out)
  })
  it('shouldConvertFenceToMath 判定符合预期', () => {
    assert.equal(shouldConvertFenceToMath('math', 'x + y'), true)
    assert.equal(shouldConvertFenceToMath('latex', 'a[x]'), true)
    assert.equal(shouldConvertFenceToMath('cpp', 'int x = a_i;'), false)
    assert.equal(shouldConvertFenceToMath('', 'f_{i} = f_{i-1} + 1'), true)
    assert.equal(shouldConvertFenceToMath('', 'hello world'), false)
    // AI 直接用 Unicode 写公式也必须升级（用户报告"公式被当成代码"的回归）
    assert.equal(shouldConvertFenceToMath('', 'answer = Σ a[i] + (n-1) * min(a[i])'), true)
    assert.equal(shouldConvertFenceToMath('', 'x ≤ y'), true)
    assert.equal(shouldConvertFenceToMath('', 'Σ a_i'), true)
    assert.equal(shouldConvertFenceToMath('', 'a₁ 与 a₁₈ 的和'), true)
    // 纯括号 ASCII 记法保持代码：升级成 KaTeX 会把 a[x+1] 渲染成 a 下标 [x+1]（含义改变）
    assert.equal(shouldConvertFenceToMath('', 'a[x] + a[x+1]'), false)
    assert.equal(shouldConvertFenceToMath('', 'f(n)'), false)
    assert.equal(shouldConvertFenceToMath('', 'g[i][j]'), false)
    // 复杂度记号 O(...) 无歧义，属于公式
    assert.equal(shouldConvertFenceToMath('', 'O(n log n)'), true)
    // 公式 + 代码注释混排：留在代码框（注释里的中文不能进 KaTeX）
    assert.equal(
      shouldConvertFenceToMath('', 'sum = a[0] + a[n-1]  // 每个元素至少出现一次\n     + n * min(a)  // 再额外一次'),
      false,
    )
    // 真实 C++：关键字特征优先于数学记号
    assert.equal(shouldConvertFenceToMath('', 'int main() {\n  int dp_max = 0;\n  return dp_max;\n}'), false)
  })
  it('looksLikeCode 识别常见语言特征', () => {
    assert.equal(looksLikeCode('#include <bits/stdc++.h>'), true)
    assert.equal(looksLikeCode('const int N = 1e5;'), true)
    assert.equal(looksLikeCode('for (int i = 0; i < n; i++)'), true)
    assert.equal(looksLikeCode('f_{i} = f_{i-1} + f_{i-2}'), false)
  })
  it('normalizeLang 归一化语言标记', () => {
    assert.equal(normalizeLang('C++'), 'c++')
    assert.equal(normalizeLang('language-Python'), 'python')
    assert.equal(normalizeLang(' cpp '), 'cpp')
  })
})

// ---------- 加粗 + 公式 ----------

describe('加粗定界符不卷入公式', () => {
  it('**p_{qi,1} < ... < p_{qi,k}** 渲染为加粗包裹公式', () => {
    const out = preprocessMath('**p_{qi,1} < p_{qi,2} < … < p_{qi,k}**')
    // ** 保留在公式外，remark-math 已验证可解析为 strong > inlineMath
    assert.ok(out.startsWith('**$'), `** 应在公式外: ${out}`)
    assert.ok(out.endsWith('$**'), `** 应在公式外: ${out}`)
    assert.ok(!out.includes('$**p_'), `公式内部不应含 **: ${out}`)
  })
})

// ---------- Unicode 数学符号 ----------

describe('Unicode 数学符号归一化', () => {
  it('Σ(ri − li + 1) ≤ 10^6 转为完整 LaTeX 公式', () => {
    const out = preprocessMath('所有测试的 Σ(ri − li + 1) ≤ 10^6。')
    // 公式不应在 − 或 … 处断开：应产生单个 $...$ 包裹
    assert.ok(out.includes('$\\sum (ri - li + 1) \\le  10^6$'), out)
  })
  it('… → \\dots', () => {
    const out = preprocessMath('设 x_{i} … 为序列')
    assert.ok(out.includes('\\dots'), out)
  })
  it('变体选择符被清除（避免 KaTeX 渲染出方框）', () => {
    const out = preprocessMath('求和 ∑\uFE0F 记为 S')
    assert.ok(!out.includes('\uFE0F'), out)
  })
})

// ---------- 独立成行的公式：升级为块级公式 ----------

describe('独立成行的公式升级为块级公式', () => {
  it('整行只有公式时升为 $$…$$（居中、独立成行）', () => {
    const out = preprocessMath('dp_i = \\max_{0 \\le j < i} (dp_j + (i - j))')
    assert.ok(out.includes('$$\n'), out)
    assert.ok(out.includes('\n$$'), out)
  })

  it('升为块级公式时不做行内包裹（避免 $$ 内嵌套 $…$）', () => {
    const out = preprocessMath('dp_i = \\max_{0 \\le j < i} (dp_j + (i - j))')
    const body = out.split('$$')[1] ?? ''
    assert.ok(!body.includes('$'), `块级公式内部不应有嵌套 $: ${out}`)
  })

  it('极短引导语 + 公式时也升级为块级（"于是得到 <公式>"）', () => {
    const out = preprocessMath('于是得到 dp_i = \\max_{0 \\le j < i} (dp_j - j)')
    assert.ok(out.includes('$$'), out)
    assert.ok(out.includes('于是得到'), '引导语应保留', out)
  })

  it('说明句里的公式保持行内（引导语较长时不整行升级）', () => {
    const out = preprocessMath('如果当前的划分方案满足前面所有这些条件，那么 dp_i 就等于最大值')
    assert.ok(!out.includes('$$'), out)
  })

  it('列表项里的条件公式保持行内', () => {
    const out = preprocessMath('- 若 $Y_i \\ge 0$ 且 $B_j \\le B_i$，则取最大值 $dp_j - j$')
    assert.ok(!out.includes('$$'), out)
  })

  it('等式不再被拆成 $dp_i =$ $\\max…$ 两段', () => {
    const out = preprocessMath('于是得到 dp_i = \\max_{0 \\le j < i} (dp_j - j)')
    assert.ok(!/\$[^$\n]*\$\s+\$/.test(out), `出现相邻公式碎片: ${out}`)
  })

  it('短句 "令 x = 5 即可" 不被公式化', () => {
    const out = preprocessMath('令 x = 5 即可')
    assert.equal(out, '令 x = 5 即可')
  })

  it('LaTeX 间距命令 \\; 不截断公式（归一化为 \\,）', () => {
    const out = preprocessMath('dp_i = \\max_{0 \\le j < i,\\; Y_j \\le Y_i} (dp_j - j)')
    assert.ok(!out.includes('\\;'), out)
    assert.ok(out.includes('\\,'), out)
    // 整条公式必须保持完整（不出现 $ 碎片）
    assert.ok(!/\$[^$\n]*\$\s*\$/m.test(out.replace(/\$\$/g, '')), out)
  })

  it('非表格行里公式内的竖线不被截断（绝对值）', () => {
    const out = preprocessMath('dp_i = \\max\\left(dp_{i-1}, i, i + |\\max_{k}(dp_k - k)|\\right)')
    assert.ok(out.includes('|\\max'), `竖线把公式截断了: ${out}`)
    // 公式必须完整：两端是同一个 $…$ / $$…$$ 区
    assert.ok(!/\$[^$\n]*\|\s*\$/.test(out), out)
  })
})

// ---------- 公式排版增强（本轮反馈 1/2/3） ----------

describe('公式排版增强', () => {
  it('大运算符补 \\limits：范围不再挤在右下角', () => {
    const out = preprocessMath('dp_i = \\max_{Y_j \\le Y_i, B_j \\le B_i}(dp_j - j)')
    assert.ok(out.includes('\\max\\limits_'), out)
  })
  it('已是 \\limits 的不重复补', () => {
    const out = preprocessMath('dp_i = \\max\\limits_{j}(dp_j)')
    assert.equal((out.match(/\\limits/g) ?? []).length, 1, out)
  })
  it('\\min / \\sum / \\lim 同样补 \\limits', () => {
    assert.ok(preprocessMath('x = \\min_{i} a_i').includes('\\min\\limits'))
    assert.ok(preprocessMath('x = \\lim_{n} a_n').includes('\\lim\\limits'))
  })
  it('公式含高结构时 \\{ \\} 升级为 \\left\\{ \\right\\}（大括号随内容放大）', () => {
    const out = preprocessMath('dp_i = \\max\\{dp_{i-1}, i, \\max_{Y_j}(dp_j - j)\\}')
    assert.ok(out.includes('\\left\\{'), out)
    assert.ok(out.includes('\\right\\}'), out)
  })
  it('公式不含高结构时不动花括号（短公式保持紧凑）', () => {
    const out = preprocessMath('S = \\{a, b\\}')
    assert.ok(out.includes('\\{a, b\\}'), out)
    assert.ok(!out.includes('\\left\\{'), out)
  })
  it('已有 \\left\\{ 的不重复处理', () => {
    const out = preprocessMath('x = \\max\\left\\{a, \\frac{1}{2}\\right\\}')
    assert.equal((out.match(/\\left\\{/g) ?? []).length, 1, out)
    assert.equal((out.match(/\\right\\}/g) ?? []).length, 1, out)
  })
  it('正文里的普通花括号文本不受影响', () => {
    const out = preprocessMath('用 {a, b} 表示集合 S_1')
    assert.ok(!out.includes('\\left\\{'), out)
  })
})

// ---------- Unicode 上下标字符归一化 ----------

describe('Unicode 上下标字符归一化', () => {
  it('修饰字母下标 dpⱼ → dp_{j}（数学字体渲染，不再是方框）', () => {
    const out = preprocessMath('长度为 dpⱼ 的前缀')
    assert.ok(out.includes('$dp_{j}$'), out)
    assert.ok(!/[\u2C7C]/.test(out), out)
  })
  it('数字下标 a₁₈ → a_{18}', () => {
    const out = preprocessMath('元素 a₁₈ 的值')
    assert.ok(out.includes('$a_{18}$'), out)
  })
  it('上标 2ⁿ → 2^{n}', () => {
    const out = preprocessMath('共 2ⁿ 种方案')
    assert.ok(out.includes('$2^{n}$'), out)
  })
  it('已是 LaTeX 写法的不受影响', () => {
    const out = preprocessMath('公式 $dp_j$ 与 $2^k$')
    assert.equal(out, '公式 $dp_j$ 与 $2^k$')
  })
})

// ---------- 公式源码清理（本轮反馈：源码被当文本显示） ----------

describe('公式源码清理', () => {
  it('去掉 \\Biggl\\left 这类非法嵌套（KaTeX 会因此解析失败并回退显示源码）', () => {
    const out = preprocessMath('dp_i = \\max\\Biggl\\left\\{a, b\\Biggr\\right\\}')
    assert.ok(!out.includes('\\Biggl'), out)
    assert.ok(!out.includes('\\Biggr'), out)
    assert.ok(out.includes('\\left\\{') && out.includes('\\right\\}'), out)
  })
  it('合法的手动尺寸命令保留（\\Bigl( 后面不跟 \\left）', () => {
    const out = preprocessMath('f\\Bigl(x\\Bigr) = x')
    assert.ok(out.includes('\\Bigl('), out)
  })
  it('围栏正文的空行被压掉（空行会提前终止 $$ 块）', () => {
    const out = preprocessMath('```latex\n\\boxed{a,\n\nb}\n```')
    assert.equal((out.match(/\$\$/g) ?? []).length, 2, out)
    assert.ok(!/\$\$[\s\S]*\n\s*\n[\s\S]*\$\$/.test(out), `块级公式内部出现空行: ${out}`)
  })
  it('围栏正文的折行被合并为单行', () => {
    const out = preprocessMath('```latex\n\\boxed{a,\nb,\nc}\n```')
    const body = out.match(/\$\$\n([\s\S]*?)\n\$\$/)?.[1] ?? ''
    assert.ok(body.includes('a, b, c'), out)
    assert.ok(!body.includes('\n'), out)
  })
  it('块级公式仍保持「$$ 独占一行」结构', () => {
    const out = preprocessMath('\\[O(n \\log n)\\]')
    assert.equal(out, '$$\nO(n \\log n)\n$$')
    assert.ok(!/^\$\$[^\n]/m.test(out), `$$ 后面不应紧跟内容: ${out}`)
  })
})

// ---------- 表格结构保护（本轮反馈：表格退化成纯文本） ----------

describe('表格结构保护', () => {
  it('无空行、单元格紧贴的表格不被公式化', () => {
    const table = [
      '|转移|说明|',
      '|---|---|',
      '|dp_i ← dp_{i-1}|直接把第 i 个位置当作单点|',
      '|若 Y_i ≥ 0 且 B_i ≥ 0，则 dp_i ← i|整段 [1, i] 本身就是红色|',
    ].join('\n')
    const out = preprocessMath(table)
    // 结构必须原样：行数、分隔线、竖线位置都不变
    assert.equal(out.split('\n').length, 4, out)
    assert.equal(out.split('\n')[1], '|---|---|', out)
    assert.equal((out.match(/\|/g) ?? []).length, (table.match(/\|/g) ?? []).length, out)
  })

  it('表格单元格内的公式仍被包裹', () => {
    const out = preprocessMath('|a|b|\n|---|---|\n|dp_{i-1}|dp_i|')
    assert.ok(out.includes('$dp_{i-1}$'), out)
    assert.ok(out.includes('$dp_i$'), out)
  })

  it('表格外的绝对值 |…| 仍进公式', () => {
    const out = preprocessMath('令 x = |a| + |b| 即可')
    assert.ok(out.includes('$|a| + |b|$'), out)
  })
})

// ---------- 行内代码里的公式（本轮反馈：dp_i 仍是字面文本） ----------

describe('行内代码里的数学被转回公式', () => {
  it('反引号包住的 LaTeX 下标转公式（AI 常误加反引号）', () => {
    const out = preprocessMath('保持 `dp_{i-1}`、整段 `[1, i]`、')
    assert.ok(out.includes('$dp_{i-1}$'), out)
    assert.ok(out.includes('`[1, i]`'), '非 LaTeX 内容应保持代码', out)
  })
  it('单字母下标的反引号内容也转公式（与 dp_{i-1} 风格统一）', () => {
    const out = preprocessMath('于是 `dp_i` 等于 `dp_{i-1}` 加一')
    assert.ok(out.includes('$dp_i$'), out)
    assert.ok(out.includes('$dp_{i-1}$'), out)
    assert.ok(!out.includes('`dp'), out)
  })
  it('真代码的反引号内容保持代码', () => {
    for (const src of ['push_back', 'vis_cnt', 'a[x] + a[x+1]', 'g[prev].push_back(cur)', 'dp[i][j]']) {
      const out = preprocessMath(`前缀 \`${src}\` 后缀`)
      assert.ok(out.includes(`\`${src}\``), `${src} 被误转公式: ${out}`)
    }
  })
})

// ---------- 公式块不被标成代码（本轮反馈） ----------

describe('公式块不被识别为代码', () => {
  it('公式 + 行尾注释的围栏转为公式（注释被剥掉）', () => {
    const out = preprocessMath('```\nS = Σ a[i]   // 所有元素之和\nM = min_{0≤i<n}( a[i] + a[(i+1) mod n] )   // 相邻两数之和最小值\n```')
    assert.ok(out.includes('$$'), out)
    assert.ok(!out.includes('```'), out)
    assert.ok(!out.includes('//'), `注释应被剥掉: ${out}`)
  })
  it('多行值表转为公式（部分行没有强数学记号也可以）', () => {
    const out = preprocessMath('```\nn = 1 :  a[0]\nn = 2 :  S + min(a[0], a[1])\nn ≥ 3 :  S + M\n```')
    assert.ok(out.includes('$$'), out)
    assert.ok(!out.includes('```'), out)
  })
  it('真 C++ 带注释的围栏仍是代码', () => {
    const text = '```cpp\nint x = 1;   // 初始化\nreturn x;\n```'
    assert.equal(preprocessMath(text), text)
  })
  it('stripLineComments 不误伤整除与 URL', () => {
    assert.equal(stripLineComments('a = n//2'), 'a = n//2')
    assert.equal(stripLineComments('见 http://example.com 说明'), '见 http://example.com 说明')
    assert.equal(stripLineComments('S = Σ a[i]   // 求和'), 'S = Σ a[i]')
  })
})

// ---------- 引用块里的公式（本轮反馈：渲染有问题） ----------

describe('引用块里的公式', () => {
  const quoted = [
    '> \\[',
    '> dp_i=\\max\\Bigl\\{dp_{i-1},\\ i+\\max_{\\substack{0\\le j<i}}\\bigl(dp_j-j\\bigr)\\Bigr\\},',
    '> \\qquad dp_0=0.',
    '> \\]',
  ].join('\n')

  it('引用块里的 \\[...\\] 转成块级公式，且每行保留 > 前缀', () => {
    const out = preprocessMath(quoted)
    const lines = out.split('\n')
    // `$$` 必须带引用前缀，否则会脱离引用块
    assert.ok(lines.some((l) => l === '> $$'), `$$ 行缺少引用前缀: ${out}`)
    assert.equal((out.match(/> \$\$/g) ?? []).length, 2, out)
  })

  it('公式主体本身不含引用符（KaTeX 收到的是剥掉前缀后的内容）', () => {
    const out = preprocessMath(quoted)
    const math = out.match(/> \$\$\n([\s\S]*?)\n> \$\$/)?.[1] ?? ''
    assert.ok(math.length > 0, out)
    // 每行可能带 Markdown 引用前缀（渲染器会剥掉，这是引用块语法的一部分），
    // 但**剥掉前缀后的公式主体**里不能再出现 `> `，否则才是真正的解析失败
    const body = math
      .split('\n')
      .map((l) => l.replace(/^[ \t]*>[ \t]?/, ''))
      .join('\n')
    assert.ok(!body.includes('>'), `公式主体残留引用符: ${body}`)
    assert.ok(body.includes('dp_i'), body)
  })

  it('修复 \\Bigl\\left 非法嵌套（KaTeX 会因此解析失败、回退显示源码）', () => {
    const out = preprocessMath('dp_i=\\max\\Bigl\\left\\{x\\Bigr\\right\\}')
    assert.ok(!out.includes('\\Bigl'), out)
    assert.ok(!out.includes('\\Bigr'), out)
    assert.ok(out.includes('\\left\\{') && out.includes('\\right\\}'), out)
    // \\left 与 \\right 必须成对
    assert.equal((out.match(/\\left\b/g) ?? []).length, (out.match(/\\right\b/g) ?? []).length, out)
  })

  it('大括号升级后也要成对（\\Bigl\\{ → \\left\\{ … \\right\\}）', () => {
    const out = preprocessMath('dp_i=\\max\\Bigl\\{dp_{i-1},\\ \\max_{j}(dp_j-j)\\Bigr\\}')
    assert.equal((out.match(/\\left\b/g) ?? []).length, (out.match(/\\right\b/g) ?? []).length, out)
    assert.ok(!out.includes('\\Bigl'), out)
    assert.ok(!out.includes('\\Bigr'), out)
  })

  it('合法的手动尺寸命令（\\Bigl( 无嵌套）不被改动', () => {
    const out = preprocessMath('f\\Bigl(x\\Bigr) = x')
    assert.ok(out.includes('\\Bigl(') && out.includes('\\Bigr)'), out)
  })

  it('引用块里的行内公式保持行内', () => {
    const out = preprocessMath('> 说明：\\(a_i\\) 是变量')
    assert.ok(out.includes('> 说明：$a_i$ 是变量'), out)
    assert.ok(!out.includes('$$'), out)
  })
})

// ---------- 表格中的数学公式 ----------

describe('表格中的数学公式', () => {
  it('表格单元格里已有的 $...$ 公式不被破坏', () => {
    const text = [
      '| 步骤 | 复杂度 |',
      '| --- | --- |',
      '| 排序 | $O(n \\log n)$ |',
      '| DP | $O(n)$ |',
    ].join('\n')
    const out = preprocessMath(text)
    assert.ok(out.includes('$O(n \\log n)$'), out)
    assert.ok(out.includes('$O(n)$'), out)
    // 表格结构（行/分隔线）必须完整保留
    assert.equal(out.split('\n').length, 4, out)
    assert.ok(out.split('\n')[1]!.includes('---'), out)
  })

  it('表格单元格里的 \\(...\\) 归一化为行内公式', () => {
    const text = '| a | b |\n| --- | --- |\n| \\(f_i\\) | \\(g_i\\) |'
    const out = preprocessMath(text)
    assert.ok(out.includes('$f_i$') && out.includes('$g_i$'), out)
    assert.ok(!out.includes('\\('), out)
  })

  it('表格单元格里的裸数学被包裹为行内公式', () => {
    const text = '| A | B |\n| --- | --- |\n| 裸公式 a_i | 2^k |'
    const out = preprocessMath(text)
    assert.ok(out.includes('$a_i$'), out)
    assert.ok(out.includes('$2^k$'), out)
  })

  it('单元格内公式不产生块级公式（$$ 会拆散表格）', () => {
    const text = '| a | b |\n| --- | --- |\n| \\[x_i\\] | y |'
    const out = preprocessMath(text)
    assert.ok(!out.includes('$$'), `单元格内不应出现块级公式: ${out}`)
  })

  it('单元格内的行内代码保持代码（不转公式）', () => {
    const text = '| a | b |\n| --- | --- |\n| `a[x]` | `dp_max` |'
    assert.equal(preprocessMath(text), text)
  })

  it('单元格内的转义竖线不破坏表格结构', () => {
    const text = '| 表达式 | 说明 |\n| --- | --- |\n| $a \\| b$ | 按位或 |'
    const out = preprocessMath(text)
    assert.equal(out.split('\n').length, 3, out)
    assert.ok(out.includes('$a \\| b$'), out)
  })
})

// ---------- 外层围栏剥离的边界 ----------

describe('外层围栏剥离', () => {
  it('空标记围栏里是代码时保留围栏', () => {
    for (const text of ['```\na[x] + a[x+1]\n```', '```\nint x = 1;\n```', '```\ng[prev].push_back(cur);\n```']) {
      assert.equal(stripOuterCodeFence(text), text, text)
      assert.equal(preprocessMath(text), text, text)
    }
  })

  it('空标记围栏里是 Unicode 数学写法时升级为公式', () => {
    const out = preprocessMath('```\na₁ 与 a₁₈ 的和\n```')
    assert.ok(out.includes('$$') && !out.includes('```'), out)
  })

  it('空标记围栏里是 Markdown 正文时剥掉围栏', () => {
    const out = stripOuterCodeFence('```\n# 标题\n- 列表项\n```')
    assert.ok(out.startsWith('# 标题'), out)
  })

  it('```markdown 围栏始终剥掉', () => {
    assert.equal(stripOuterCodeFence('```markdown\n普通正文\n```'), '普通正文\n')
  })
})

// ---------- 原有能力回归 ----------

describe('原有能力回归', () => {
  it('裸下标 c_i 被包裹', () => {
    assert.ok(preprocessMath('复杂度与 c_i 有关').includes('$c_i$'))
  })
  it('裸上标 2^k 被包裹', () => {
    assert.ok(preprocessMath('枚举 2^k 个子集').includes('$2^k$'))
  })
  it('LaTeX 命令 \\frac{...}{...} 被包裹', () => {
    const out = preprocessMath('答案是 \\frac{n(n+1)}{2}')
    assert.ok(out.includes('$\\frac{n(n+1)}{2}$'), out)
  })
  it('已有 $...$ 公式内部不被二次处理', () => {
    const out = preprocessMath('已知 $a_i + b_i$ 求和')
    assert.equal(out, '已知 $a_i + b_i$ 求和')
  })
  it('预处理是幂等的（对已处理结果再跑一次不改变结构）', () => {
    const once = preprocessMath('设 f_{i} = f_{i-1} + a_i，复杂度 O(n log n)')
    const twice = preprocessMath(once)
    assert.equal(twice, once)
  })
})

import { memo, useCallback, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { CaretRightOutlined, CheckOutlined, CopyOutlined } from '@ant-design/icons'
import { preprocessMath } from './markdownMath.ts'
import { normalizeLang } from './markdownCode.ts'

/**
 * Markdown 渲染（AI 回复 / 模板思路 / 笔记 / 题单描述）：
 * 默认转义 HTML，支持 GFM 表格、任务列表、删除线与数学公式。
 *
 * 三类内容分开渲染，视觉上必须一眼可辨：
 *   · 代码 —— 代码卡：语言标签 + 悬停复制 + 超长内容折叠（等宽字体、缩进底）
 *   · 公式 —— KaTeX：块级公式居中并带横向滚动，行内公式与正文基线对齐
 *   · 文字 —— 常规排版：标题层级、列表、引用、表格
 * 「代码 / 公式 / 文字」的身份判定在 preprocessMath + markdownCode 中完成，
 * 本组件只负责把它们渲染成对应的外观。
 */

/** 代码卡内超过该行数时折叠，避免 AI 贴几百行代码把消息撑爆 */
const COLLAPSE_LINES = 24

interface CodeChildProps {
  className?: string
  children?: React.ReactNode
}

/** 从 react-markdown 注入的 className（language-xxx）里取语言标记 */
function langFromClassName(className?: string): string {
  const m = /language-([\w+#.-]+)/.exec(className ?? '')
  return m ? normalizeLang(m[1]!) : ''
}

/** `<pre>` 内提取纯文本（用于复制），并识别语言标记 */
function extractPre(children: React.ReactNode): { lang: string; code: string } {
  const arr = Array.isArray(children) ? children : [children]
  for (const child of arr) {
    if (child && typeof child === 'object' && 'props' in child) {
      const props = (child as { props: CodeChildProps }).props
      const raw = props.children
      const code = Array.isArray(raw) ? raw.join('') : typeof raw === 'string' ? raw : String(raw ?? '')
      return { lang: langFromClassName(props.className), code: code.replace(/\n$/, '') }
    }
  }
  return { lang: '', code: '' }
}

/** 代码卡：语言标签 + 复制按钮 + 超长折叠 */
function CodeCard({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const lineCount = code ? code.split('\n').length : 0
  const collapsible = lineCount > COLLAPSE_LINES

  const copy = useCallback(() => {
    const p = navigator.clipboard?.writeText(code)
    if (!p) return
    p.then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    }).catch(() => {
      /* 剪贴板不可用（非安全上下文/权限拒绝）：静默忽略，用户仍可手动选择复制 */
    })
  }, [code])

  return (
    <div className={`md-code-card${expanded ? ' is-expanded' : ''}`}>
      <div className="md-code-head">
        <span className="md-code-lang">{lang || 'code'}</span>
        <button type="button" className="md-code-copy" onClick={copy} title="复制代码">
          {copied ? <CheckOutlined /> : <CopyOutlined />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <pre className="md-code-pre" data-collapsible={collapsible ? 'true' : undefined}>
        <code className={lang ? `language-${lang}` : undefined}>{code}</code>
      </pre>
      {collapsible && (
        <button
          type="button"
          className="md-code-toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          <CaretRightOutlined rotate={expanded ? 90 : 0} />
          {expanded ? '收起' : `展开全部 ${lineCount} 行`}
        </button>
      )}
    </div>
  )
}

function MarkdownInner({ text }: { text: string }) {
  const processed = preprocessMath(text)
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
        components={{
          // 代码块统一走代码卡（header 在 <pre> 之外，所以必须整体替换 <pre>）
          pre: ({ children }) => {
            const { lang, code } = extractPre(children)
            return <CodeCard lang={lang} code={code} />
          },
          // 行内代码走 .markdown-body code 的内联样式，不替换
          // 表格：外层包裹以便窄屏横向滚动，不破坏表格自身布局
          table: ({ children, node: _node, ...rest }) => (
            <div className="md-table-wrap">
              <table {...rest}>{children}</table>
            </div>
          ),
          a: ({ href, children, node: _node, ...rest }) => (
            <a href={href} target="_blank" rel="noreferrer noopener" {...rest}>
              {children}
            </a>
          ),
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  )
}

/**
 * 导出即 memo：AI 流式输出时每一帧都会重渲染，而历史消息内容不变，
 * memo 按 text 引用比较即可跳过全部历史消息的 Markdown 解析与 KaTeX 排版。
 */
const Markdown = memo(MarkdownInner)

export default Markdown

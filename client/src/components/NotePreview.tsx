import { useEffect, useRef, useState } from 'react'
import Markdown from './Markdown'

/**
 * 笔记预览（复习库 / 模板库卡片内）：完整 Markdown 渲染 + 折叠开关，两种折叠形态：
 *
 * - `clip`（默认，模板库）：限高露出前 220px，渐隐 mask 暗示「下面还有内容」，
 *   超高时给「展开 / 收起」—— 卡片列表里贴了大图或长文时不至于把整页撑爆。
 * - `hidden`（复习库，issue #27 讨论定稿）：折叠时**整段隐藏**，只在卡片右下角留
 *   「展开」按钮，点开才渲染笔记；每次进入页面默认收起，列表保持紧凑一屏一题。
 */
export default function NotePreview({ text, collapseMode = 'clip' }: { text: string; collapseMode?: 'clip' | 'hidden' }) {
  const [expanded, setExpanded] = useState(false)
  const [clippable, setClippable] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  // 测量回调里要读最新的 expanded：展开态下 max-height 被放开，
  // scrollHeight === clientHeight，此时重算会把 clippable 错杀成 false（「收起」按钮消失）。
  // ref 镜像让 ResizeObserver 回调始终拿到当前值，不必反复解绑/重绑观察器。
  const expandedRef = useRef(false)
  expandedRef.current = expanded

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      if (!expandedRef.current) setClippable(el.scrollHeight > el.clientHeight + 2)
    }
    measure()
    // 内容高度会异步变化（图片加载完、KaTeX 字体就位后才到位）：只测挂载这一次，
    // 含图笔记会量出偏小的高度，折叠按钮永远不出现（issue #27）。
    // 同时观察容器与内容元素：容器在折叠态被 max-height 钉住、内容再长也不变尺寸，
    // 只观察容器会漏掉「内容长高」；观察内容才能在图片加载后补测。
    const content = el.firstElementChild
    if (typeof ResizeObserver !== 'function') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (content && content !== el) ro.observe(content)
    return () => ro.disconnect()
  }, [text])

  // hidden 形态折叠时不渲染 Markdown（点开才渲染，也免掉图片异步加载的测量问题）
  const hideWhenCollapsed = collapseMode === 'hidden'
  return (
    <div className={`note-preview${hideWhenCollapsed ? ' note-preview--hidden' : ''}`} data-expanded={expanded || undefined}>
      {(!hideWhenCollapsed || expanded) && (
        <div
          ref={ref}
          className="note-preview-md"
          data-clipped={!hideWhenCollapsed && clippable && !expanded ? '' : undefined}
        >
          <Markdown text={text} />
        </div>
      )}
      {(hideWhenCollapsed || clippable) && (
        <button type="button" className="note-preview-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </div>
  )
}

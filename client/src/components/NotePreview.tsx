import { useEffect, useRef, useState } from 'react'
import Markdown from './Markdown'

/**
 * 笔记预览（复习库 / 模板库卡片内）：完整 Markdown 渲染，超高时折叠并给
 * 「展开 / 收起」开关 —— 卡片列表里贴了大图或长文时不至于把整页撑爆。
 * 折叠态用渐隐 mask 暗示「下面还有内容」，展开按钮只在确实超高时出现。
 */
export default function NotePreview({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const [clippable, setClippable] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (el) setClippable(el.scrollHeight > el.clientHeight + 2)
  }, [text])

  return (
    <div className="note-preview" data-expanded={expanded || undefined}>
      <div ref={ref} className="note-preview-md" data-clipped={clippable && !expanded ? '' : undefined}>
        <Markdown text={text} />
      </div>
      {clippable && (
        <button type="button" className="note-preview-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </div>
  )
}

/**
 * 「卡在哪」入口：用户在题目页一次性声明卡点，写入 submission_intents。
 *
 * 为什么需要它：题源标签一题多标签是常态（实测 75.7% 的题有 ≥2 个标签），
 * 且低难度题的标签严重膨胀（贪心/数学各占 ~40%），因此从题目反推「用户哪个知识点不熟」
 * 是无解的。用户自己声明是唯一无歧义的归因来源。
 *
 * 交互刻意做到最小摩擦：Popover + 一次点击即写入，不做弹窗问卷。
 */
import { useState } from 'react'
import { Button, Popover, Select, Space, Typography } from 'antd'
import { post } from '../api'
import {
  buildIntentBody,
  intentPath,
  INTENT_OPTIONS,
  type IntentOutcome,
} from '../intentOptions'

interface Props {
  platform: string
  problemKey: string
  /** 该题的知识点 code 候选（可留空 = 不指定知识点） */
  codeOptions?: ReadonlyArray<{ value: string; label: string }>
  /** 写入成功回调（通常用于刷新当前页） */
  onDone?: () => void
  /** 成功提示回调（沿用调用方的 AntdApp.useApp() 实例，避免脱离 ConfigProvider） */
  onSuccess?: (msg: string) => void
  onError?: (msg: string) => void
}

export default function IntentPopover({
  platform,
  problemKey,
  codeOptions = [],
  onDone,
  onSuccess,
  onError,
}: Props) {
  const [open, setOpen] = useState(false)
  const [outcome, setOutcome] = useState<IntentOutcome>('wrong_approach')
  const [code, setCode] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    setSaving(true)
    try {
      await post(intentPath(platform, problemKey), buildIntentBody(outcome, code))
      onSuccess?.('已记录卡点，弱项判断会据此更准')
      setOpen(false)
      onDone?.()
    } catch (e) {
      onError?.((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const content = (
    <Space direction="vertical" size={8} style={{ width: 240 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        这题卡在哪？（一次点击即可，不必填完整）
      </Typography.Text>
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        {INTENT_OPTIONS.map((o) => (
          <Button
            key={o.value}
            size="small"
            block
            type={outcome === o.value ? 'primary' : 'default'}
            onClick={() => setOutcome(o.value)}
            title={o.hint}
          >
            {o.label}
          </Button>
        ))}
      </Space>
      <Select
        allowClear
        size="small"
        style={{ width: '100%' }}
        placeholder="哪个知识点？（可跳过）"
        value={code}
        onChange={setCode}
        options={codeOptions as { value: string; label: string }[]}
      />
      <Button type="primary" size="small" block loading={saving} onClick={() => void submit()}>
        记录
      </Button>
    </Space>
  )

  return (
    <Popover content={content} title="卡在哪" trigger="click" open={open} onOpenChange={setOpen}>
      <Button size="small" type="text">卡在哪</Button>
    </Popover>
  )
}

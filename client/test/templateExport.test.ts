import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  TEMPLATE_EXPORT_OPTIONS,
  type TemplateExportFormat,
} from '../src/templateExport.ts'

describe('template export options', () => {
  it('exposes Markdown and PDF through one export entry', () => {
    const formats = TEMPLATE_EXPORT_OPTIONS.map((option) => option.format)

    assert.deepEqual(formats satisfies TemplateExportFormat[], ['markdown', 'pdf'])
    assert.deepEqual(
      TEMPLATE_EXPORT_OPTIONS.map((option) => option.label),
      ['Markdown 文件', 'PDF 文件'],
    )
  })
})

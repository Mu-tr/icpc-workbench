export type TemplateExportFormat = 'markdown' | 'pdf'

export interface TemplateExportOption {
  format: TemplateExportFormat
  label: string
}

export const TEMPLATE_EXPORT_OPTIONS: readonly TemplateExportOption[] = [
  { format: 'markdown', label: 'Markdown 文件' },
  { format: 'pdf', label: 'PDF 文件' },
]

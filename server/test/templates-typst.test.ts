import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileTypstToPdf, renderTemplatesTypst } from '../src/templates/typst.ts';
import type { ExportBundle } from '../src/routes/templates.ts';

function bundle(overrides: Partial<ExportBundle> = {}): ExportBundle {
  return {
    version: 1,
    exportedAt: '2026-09-17T12:00:00.000Z',
    customCount: 1,
    builtinNoteCount: 0,
    customTemplates: [
      {
        id: 'c-1',
        category: '基础算法',
        name: '标题 "X" # $ \\ path',
        difficulty: 3,
        tags: ['二分', '前缀和'],
        code: 'int x = 1;\n#set text(size: 10pt)',
        idea: '区间 "最值"',
        complexity: 'O(log n)',
        url: 'https://example.com/a?x=1&y=2',
        status: 'mastered',
        note: '注意 $ 与 #',
      },
    ],
    builtinNotes: [],
    ...overrides,
  };
}

test('renderTemplatesTypst safely renders user text and code', () => {
  const source = renderTemplatesTypst(bundle());

  assert.match(source, /#set text\(\n  font:/);
  assert.ok(source.includes('#text("1. 标题 \\"X\\" # $ \\\\ path")'));
  assert.ok(source.includes('#raw("int x = 1;\\n#set text(size: 10pt)", lang: "cpp")'));
  assert.ok(source.includes('#text("注意 $ 与 #")'));
  assert.match(source, /#counter\(page\)\.display/);
});

test('compileTypstToPdf produces a real PDF from the generated source', async () => {
  const pdf = await compileTypstToPdf(renderTemplatesTypst(bundle()));

  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
});

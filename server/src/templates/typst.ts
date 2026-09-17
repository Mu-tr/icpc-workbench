import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { ExportBundle } from '../routes/templates.ts';

export const TYPST_VERSION = '0.15.1';

const EXPORT_STATUS_LABEL: Record<string, string> = {
  todo: '未学',
  learning: '学习中',
  mastered: '已掌握',
};

const difficultyStars = (difficulty: number): string =>
  '★'.repeat(difficulty) + '☆'.repeat(5 - difficulty);

/** Typst 字符串字面量转义：用户内容只作为 text/raw 的字符串参数，不参与 Typst 标记解析。 */
export function typstString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, (ch) =>
      `\\u{${ch.charCodeAt(0).toString(16)}}`,
    );
  return `"${escaped}"`;
}

const text = (value: string): string => `#text(${typstString(value)})`;

const typstBinaryName = process.platform === 'win32' ? 'typst.exe' : 'typst';

let bundledTypst: Buffer | null = null;

/** SEA 启动时注入内嵌的 Typst 二进制；开发模式不需要调用。 */
export function setBundledTypstBinary(data: Buffer): void {
  bundledTypst = Buffer.from(data);
}

function platformKey(): string {
  const key = `${process.platform}-${process.arch}`;
  if (
    key === 'win32-x64' ||
    key === 'win32-arm64' ||
    key === 'darwin-arm64' ||
    key === 'darwin-x64' ||
    key === 'linux-x64' ||
    key === 'linux-arm64'
  ) {
    return key;
  }
  throw new Error(`当前平台暂不支持 Typst 导出：${key}`);
}

function vendoredTypstPath(): string {
  const serverRoot = path.resolve(import.meta.dirname, '..', '..');
  return path.join(serverRoot, 'vendor', 'typst', platformKey(), `v${TYPST_VERSION}`, typstBinaryName);
}

function extractBundledTypst(dataDir: string): string {
  const targetDir = path.join(dataDir, 'typst-bin', `v${TYPST_VERSION}-${process.platform}-${process.arch}`);
  const target = path.join(targetDir, typstBinaryName);
  if (fs.existsSync(target)) return target;

  fs.mkdirSync(targetDir, { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, bundledTypst!);
  if (process.platform !== 'win32') fs.chmodSync(temp, 0o755);
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    if (fs.existsSync(target)) {
      fs.rmSync(temp, { force: true });
      return target;
    }
    throw error;
  }
  return target;
}

/** 依次查找显式配置、SEA 内嵌、开发目录中的 Typst 可执行文件。 */
export function resolveTypstBinary(dataDir: string = path.join(os.tmpdir(), 'icpc-typst')): string {
  const explicit = process.env.TYPST_BIN?.trim();
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`TYPST_BIN 指向的文件不存在：${explicit}`);
    return explicit;
  }
  if (bundledTypst) return extractBundledTypst(dataDir);

  const vendored = vendoredTypstPath();
  if (fs.existsSync(vendored)) return vendored;

  throw new Error(
    `未找到 Typst ${TYPST_VERSION} 编译器。开发环境请先运行 npm run prepare:typst。`,
  );
}

function runTypst(binary: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const detail = String(stderr ?? '').trim().slice(-2000);
        reject(new Error(detail ? `Typst 编译失败：${detail}` : `Typst 编译失败：${error.message}`));
      },
    );
  });
}

/** 将 Typst 源编译成 PDF 字节；临时目录无论成功失败都会清理。 */
export async function compileTypstToPdf(
  source: string,
  options: { dataDir?: string; typstBin?: string; timeoutMs?: number } = {},
): Promise<Buffer> {
  const binary = options.typstBin ?? resolveTypstBinary(options.dataDir);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-typst-'));
  const input = path.join(dir, 'templates.typ');
  const output = path.join(dir, 'templates.pdf');
  try {
    fs.writeFileSync(input, source, 'utf8');
    await runTypst(
      binary,
      ['compile', '--root', dir, input, output],
      dir,
      options.timeoutMs ?? 60_000,
    );
    return fs.readFileSync(output);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 将模板导出 bundle 直接渲染为 Typst 文档。
 *
 * 这里刻意不从 Markdown 再解析：模板正文包含任意 C++、反引号以及 Typst 标记字符，
 * 直接使用 bundle 可以把用户内容全部放进字符串参数，避免被解释成布局指令。
 */
export function renderTemplatesTypst(bundle: ExportBundle): string {
  const exportedAt = new Date(bundle.exportedAt).toLocaleString('zh-CN', { hour12: false });
  const out: string[] = [
    '#set page(',
    '  paper: "a4",',
    '  margin: (x: 18mm, y: 18mm),',
    '  footer: context [',
    '    #set align(center)',
    '    #set text(size: 8pt, fill: luma(120))',
    '    #counter(page).display("第 1 页 / 共 1 页", both: true)',
    '  ],',
    ')',
    '#set text(',
    '  font: ("Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "SimSun", "DejaVu Sans"),',
    '  size: 10pt,',
    '  lang: "zh",',
    '  region: "cn",',
    ')',
    '#set par(justify: true, leading: 0.75em)',
    '#show raw.where(block: true): block.with(',
    '  width: 100%,',
    '  inset: 10pt,',
    '  radius: 4pt,',
    '  fill: luma(245),',
    '  stroke: 0.5pt + luma(220),',
    ')',
    '',
    `#heading(level: 1)[${text('ICPC 算法模板库 · 导出')}]`,
    '',
    text(`导出时间：${exportedAt}`),
    text(`自建模板：${bundle.customCount} 篇 · 内置模板笔记：${bundle.builtinNoteCount} 篇`),
    '',
    '#line(length: 100%, stroke: 0.5pt + luma(210))',
    '',
  ];

  if (bundle.customCount === 0 && bundle.builtinNoteCount === 0) {
    out.push(text('暂无可导出的模板 —— 你还没有自建模板，也没有在内置课程条目里写入模板内容。'), '');
    return out.join('\n');
  }

  let index = 0;
  if (bundle.customCount > 0) {
    out.push(`#heading(level: 2)[${text(`一、自建模板（${bundle.customCount} 篇）`)}]`, '');
    for (const item of bundle.customTemplates) {
      index += 1;
      out.push(`#heading(level: 3)[${text(`${index}. ${item.name}`)}]`, '');
      out.push(`- *分类：* ${text(item.category)}`);
      out.push(`- *难度：* ${text(`${difficultyStars(item.difficulty)}（${item.difficulty}/5）`)}`);
      if (item.tags.length) out.push(`- *标签：* ${text(item.tags.join('、'))}`);
      if (item.complexity) out.push(`- *复杂度：* ${text(item.complexity)}`);
      if (item.url) out.push(`- *出处：* ${text(item.url)}`);
      if (item.status !== 'todo') {
        out.push(`- *状态：* ${text(EXPORT_STATUS_LABEL[item.status] ?? item.status)}`);
      }
      if (item.note) out.push(`- *笔记：* ${text(item.note)}`);
      out.push('');
      if (item.idea.trim()) {
        out.push(`*思路与备注*`, '', text(item.idea.trim()), '');
      }
      if (item.code.trim()) {
        out.push(`*模板代码*`, '', `#raw(${typstString(item.code.trimEnd())}, lang: "cpp")`, '');
      }
      out.push('#line(length: 100%, stroke: 0.3pt + luma(225))', '');
    }
  }

  if (bundle.builtinNoteCount > 0) {
    const section = bundle.customCount > 0 ? '二' : '一';
    out.push(
      `#heading(level: 2)[${text(`${section}、内置模板笔记（${bundle.builtinNoteCount} 篇）`)}]`,
      '',
    );
    let builtinIndex = 0;
    for (const item of bundle.builtinNotes) {
      builtinIndex += 1;
      out.push(`#heading(level: 3)[${text(`${builtinIndex}. ${item.name}`)}]`, '');
      out.push(`- *分类：* ${text(item.category)}`);
      out.push(`- *难度：* ${text(`${difficultyStars(item.difficulty)}（${item.difficulty}/5）`)}`);
      if (item.tags.length) out.push(`- *标签：* ${text(item.tags.join('、'))}`);
      if (item.complexity) out.push(`- *复杂度：* ${text(item.complexity)}`);
      if (item.url) out.push(`- *参考链接：* ${text(item.url)}`);
      if (item.status !== 'todo') {
        out.push(`- *状态：* ${text(EXPORT_STATUS_LABEL[item.status] ?? item.status)}`);
      }
      if (item.note) out.push(`- *笔记：* ${text(item.note)}`);
      out.push('');
      out.push(`*大纲要点*`, '', text(item.outline), '');
      if (item.idea?.trim()) out.push(`*我的思路*`, '', text(item.idea.trim()), '');
      if (item.code?.trim()) {
        out.push(`*我的模板*`, '', `#raw(${typstString(item.code.trimEnd())}, lang: "cpp")`, '');
      }
      out.push('#line(length: 100%, stroke: 0.3pt + luma(225))', '');
    }
  }

  return out.join('\n');
}

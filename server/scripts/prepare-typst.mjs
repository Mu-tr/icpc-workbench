import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TYPST_VERSION = '0.15.1';

const DEFAULT_MIRRORS = ['https://ghfast.top', 'https://gh-proxy.com'];
const OFFICIAL_TIMEOUT_MS = 10_000;
const MIRROR_TIMEOUT_MS = 120_000;

const ASSETS = {
  'win32-x64': {
    file: `typst-x86_64-pc-windows-msvc.zip`,
    sha256: '19ce3551153c2fe7ee9fa2f95208310c8f4d3209fedb699e0333faf8913f6736',
  },
  'win32-arm64': {
    file: `typst-aarch64-pc-windows-msvc.zip`,
    sha256: '4ab28e1b71ec3184d38d580ab797f499b6770d952b6b19167be5cea5c2662e14',
  },
  'darwin-arm64': {
    file: `typst-aarch64-apple-darwin.tar.xz`,
    sha256: '48f62ed034aa3a7978309579ac6ca00045e2ef0da73114e8af27cfd8e74dc05a',
  },
  'darwin-x64': {
    file: `typst-x86_64-apple-darwin.tar.xz`,
    sha256: '7f9fdd9584866245de9a79e0add8f9236fae6f40a8a45e2c4771ccc14db4e0fa',
  },
  'linux-x64': {
    file: `typst-x86_64-unknown-linux-musl.tar.xz`,
    sha256: 'a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c',
  },
  'linux-arm64': {
    file: `typst-aarch64-unknown-linux-musl.tar.xz`,
    sha256: '5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee',
  },
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

export function currentPlatformKey() {
  const key = `${process.platform}-${process.arch}`;
  if (!ASSETS[key]) throw new Error(`当前平台暂不支持 Typst 导出：${key}`);
  return key;
}

export function typstBinaryPath(key = currentPlatformKey()) {
  const name = key.startsWith('win32-') ? 'typst.exe' : 'typst';
  return path.join(serverRoot, 'vendor', 'typst', key, `v${TYPST_VERSION}`, name);
}

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function mirrorPrefixes(env = process.env.ICPC_TYPST_MIRRORS) {
  const raw = (env ?? '').trim();
  const list = raw ? raw.split(',').map((value) => value.trim()).filter(Boolean) : DEFAULT_MIRRORS;
  return list.map((value) => value.replace(/\/+$/, ''));
}

export function candidateUrls(url, mirrors = mirrorPrefixes()) {
  return [
    { label: 'GitHub 官方源', url, timeoutMs: OFFICIAL_TIMEOUT_MS },
    ...mirrors.map((prefix) => ({
      label: `镜像 ${new URL(prefix).hostname}`,
      url: `${prefix}/${url}`,
      timeoutMs: MIRROR_TIMEOUT_MS,
    })),
  ];
}

export async function downloadVerifiedArchive(url, expectedSha256, { quiet = false, fetchFn = fetch } = {}) {
  const failures = [];

  for (const candidate of candidateUrls(url)) {
    if (!quiet) console.log(`[typst] 尝试 ${candidate.label} ...`);

    try {
      const response = await fetchFn(candidate.url, {
        headers: { 'User-Agent': 'icpc-workbench-build' },
        redirect: 'follow',
        signal: AbortSignal.timeout(candidate.timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const archive = Buffer.from(await response.arrayBuffer());
      const actual = sha256(archive);
      if (actual !== expectedSha256) {
        throw new Error(`SHA256 不匹配（期望 ${expectedSha256}，实际 ${actual}）`);
      }

      if (!quiet) console.log(`[typst] ${candidate.label} 下载并校验通过`);
      return archive;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${candidate.label}: ${message}`);
      if (!quiet) console.warn(`[typst] ${candidate.label} 失败：${message}`);
    }
  }

  throw new Error(`下载 Typst 失败，所有候选源均不可用：\n- ${failures.join('\n- ')}`);
}

/** 下载并校验当前平台的官方 Typst CLI，返回可执行文件绝对路径。 */
export async function ensureTypstBinary({ quiet = false } = {}) {
  const key = currentPlatformKey();
  const target = typstBinaryPath(key);
  if (fs.existsSync(target)) {
    if (!quiet) console.log(`[typst] 已就绪: ${target}`);
    return target;
  }

  const asset = ASSETS[key];
  const url = `https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/${asset.file}`;
  const archiveDir = path.join(serverRoot, 'vendor', 'typst', '.cache');
  const archivePath = path.join(archiveDir, asset.file);
  fs.mkdirSync(archiveDir, { recursive: true });

  if (!quiet) console.log(`[typst] 下载 v${TYPST_VERSION} (${key}) ...`);
  const archive = await downloadVerifiedArchive(url, asset.sha256, { quiet });
  fs.writeFileSync(archivePath, archive);

  const extractDir = fs.mkdtempSync(path.join(archiveDir, 'extract-'));
  try {
    execFileSync('tar', ['-xf', archivePath, '-C', extractDir], { stdio: 'inherit' });
    const expectedName = key.startsWith('win32-') ? 'typst.exe' : 'typst';
    const found = walkFiles(extractDir).find((file) => path.basename(file) === expectedName);
    if (!found) throw new Error(`Typst 压缩包中未找到 ${expectedName}`);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(found, target);
    if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }

  if (!quiet) console.log(`[typst] 校验通过: ${target}`);
  return target;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  ensureTypstBinary().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

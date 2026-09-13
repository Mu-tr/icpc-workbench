/**
 * SEA 运行时的用户数据目录解析（数据库、AtCoder 缓存、知识点 JSONL 都落在这里）。
 *
 * 默认仍然是「可执行文件旁的 data/」——Windows 便携版依赖这个位置
 * （整个文件夹拷走即可带走数据），这里刻意不动。
 *
 * macOS 例外：桌面版的 SEA 核心作为 sidecar 位于
 * `icpc-workbench.app/Contents/MacOS/icpc-core`，沿用「exe 旁」就等于把
 * 用户数据写进应用包内部，带来两个真实故障：
 *   1. 写包内任何文件都会让 .app 的代码签名失效 → 用户看到
 *      「已损坏，无法打开」（issue #14 的同款现象）；
 *   2. 应用包在覆盖安装新版时被整体替换 → 练习数据跟着丢。
 * 因此 macOS 上落到 ~/Library/Application Support/icpc-workbench/data
 * （Apple 官方规定的应用数据位置），并由 shell 用 ICPC_DATA_DIR 显式指定。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 显式覆盖：桌面壳（Tauri）在 macOS 上用这个变量把数据目录挪出应用包。 */
const DATA_DIR_ENV = 'ICPC_DATA_DIR';

/** macOS 默认落点（~/Library/Application Support/<name>/data）。 */
const MACOS_APP_DIR_NAME = 'icpc-workbench';

/**
 * 解析数据目录（纯函数，便于测试）。
 *
 * 优先级：ICPC_DATA_DIR > macOS 用户目录 > 可执行文件旁 data/
 *
 * @param env       环境变量表，默认 process.env
 * @param platform  目标平台，默认 process.platform
 * @param execPath  Node 可执行文件路径，默认 process.execPath
 * @param home      用户主目录（macOS 用），默认取 $HOME
 */
export function resolveDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
  home: string | undefined = env.HOME,
): string {
  const explicit = (env[DATA_DIR_ENV] ?? '').trim();
  if (explicit) return path.resolve(explicit);

  // macOS：绝不写进 .app 包内（签名失效 + 覆盖安装丢数据）
  if (platform === 'darwin' && home && home.trim()) {
    return path.join(home.trim(), 'Library', 'Application Support', MACOS_APP_DIR_NAME, 'data');
  }

  // win32 显式用 path.win32：宿主为 Linux（CI 测试）时也能得到正确的 Windows 路径语义
  const impl = platform === 'win32' ? path.win32 : path;
  return impl.join(impl.dirname(execPath), 'data');
}

/**
 * 老版本（把数据写进应用包内部的 nightly）升级迁移：目标目录尚不存在、
 * 而 exe 旁 data/ 有内容时，整目录复制一次。
 *
 * 复制而非移动：exe 旁那份目录在 macOS 上位于只读的应用包内，删不掉，
 * 留着也不会再被读写（新路径已生效），用户数据则以新目录为准。
 *
 * @returns 是否发生了迁移
 */
export function migrateLegacyDataDir(
  execPath: string,
  dataDir: string,
): boolean {
  if (fs.existsSync(dataDir)) return false; // 已有数据（或已迁移过）：不覆盖

  const legacyDir = path.join(path.dirname(execPath), 'data');
  if (path.resolve(legacyDir) === path.resolve(dataDir)) return false; // Windows 便携版：本就是同一个位置
  if (!fs.existsSync(legacyDir)) return false;

  try {
    fs.mkdirSync(path.dirname(dataDir), { recursive: true });
    fs.cpSync(legacyDir, dataDir, { recursive: true });
    console.log(`[data] 已把旧数据目录迁移到 ${dataDir}`);
    return true;
  } catch (e) {
    // 迁移失败不能挡住启动：退回继续用旧目录也能跑（只是仍旧在包内）
    console.error(`[data] 旧数据目录迁移失败（改用新目录，数据需手动搬运）: ${(e as Error).message}`);
    return false;
  }
}

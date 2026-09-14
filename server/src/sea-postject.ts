/**
 * SEA 注入参数（postject）——按目标平台生成，供打包脚本与回归测试共用。
 *
 * Node 官方约定（docs/api/single-executable-applications.md
 * 「Single executable application creation process」）规定了 blob 该落在哪：
 *   - PE（Windows）：资源 NODE_SEA_BLOB
 *   - Mach-O（macOS）：**NODE_SEA 段**里的 NODE_SEA_BLOB 节
 *   - ELF（Linux）：note NODE_SEA_BLOB
 *
 * postject 的 Mach-O 段名默认是 `__POSTJECT`，与官方要求的 `NODE_SEA` 不一致：
 * 不传 `--macho-segment-name NODE_SEA` 时 blob 会注入到 __POSTJECT 段，
 * Node 的加载器按约定在 NODE_SEA 段里找不到它，于是启动即崩
 * （EXC_BAD_ACCESS / SIGSEGV，栈顶落在 SeaDeserializer::ReadArithmetic）——
 * 这正是 issue #14 里 mac 版「后台核心崩溃、窗口打不开」的原因。
 * Windows / Linux 不需要该参数。
 */

/** Node 用来判断「这个可执行文件是否被注入过」的哨兵 fuse。 */
export const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/** blob 在可执行文件里的资源/节名。 */
export const SEA_BLOB_NAME = 'NODE_SEA_BLOB';

/** macOS 上必须使用的 Mach-O 段名（postject 默认是 __POSTJECT，不可用）。 */
export const MACHO_SEA_SEGMENT = 'NODE_SEA';

/**
 * 生成 postject 的参数数组。
 *
 * @param exePath  注入目标（node 可执行文件的副本）
 * @param blobPath 由 `node --experimental-sea-config` 生成的前置 blob
 * @param isMac    目标是否为 macOS（Mach-O）
 * @param overwrite 目标已存在同名资源时是否覆盖
 */
export function buildPostjectArgs(
  exePath: string,
  blobPath: string,
  isMac: boolean,
  overwrite = false,
): string[] {
  const args = [
    exePath,
    SEA_BLOB_NAME,
    blobPath,
    '--sentinel-fuse',
    SEA_FUSE,
  ];
  // macOS 专属：把 blob 放进 Node 约定的 NODE_SEA 段
  if (isMac) {
    args.push('--macho-segment-name', MACHO_SEA_SEGMENT);
  }
  if (overwrite) {
    args.push('--overwrite');
  }
  return args;
}

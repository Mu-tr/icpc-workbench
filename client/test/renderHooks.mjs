/**
 * 静态渲染用的 ESM 解析钩子（仅测试脚本使用，不参与应用构建）。
 *
 * 两点映射：
 *   1. `*.css` → 空模块（Node 里没有 CSS loader；Markdown.tsx 会 import katex 的样式）
 *   2. 相对导入里的 `.ts` / `.tsx` → tsc 产物里的同名 `.js`
 *      （源码用 bundler 风格显式带扩展名，`allowImportingTsExtensions` 在
 *       需要产出 JS 的这次编译里必须关掉，于是产物里的收尾扩展名要在这里改写）
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.css')) {
    return { url: 'data:text/javascript,', shortCircuit: true }
  }
  if (specifier.startsWith('.') && /\.tsx?$/.test(specifier)) {
    return nextResolve(specifier.replace(/\.tsx?$/, '.js'), context)
  }
  return nextResolve(specifier, context)
}

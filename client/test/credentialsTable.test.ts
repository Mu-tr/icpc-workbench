/**
 * 凭据字段表的「唯一真相」守卫（node:test）。
 *
 * 背景缺陷（2026-09 实测）：Cookie 字段表被上移到 shared/src/credentials.ts 后，
 * 设置页仍保留一份本地 COOKIE_FORM，其中 QOJ 还是旧的三字段口径（session/clearance/ua）。
 * 结果保存 QOJ 时前端发出已废弃的 `session` 字段，服务端按共享表校验直接 400
 * 「未知 Cookie 字段: session」——保存按钮失效，且界面渲染出与说明文字矛盾的三个输入框。
 *
 * 服务端拒绝是正确的守卫（禁止旧字段名写坏数据）；修复方向是客户端消费同一份表，
 * 并在此钉住「客户端不得再定义字段表」，避免同类分叉再次静默发生。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cookieFieldsOf, cookieOnlyFieldsOf, PLATFORMS } from '../../shared/src/index.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = path.resolve(__dirname, '..', 'src')

/** 递归收集目录下的 .ts/.tsx 源文件 */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

test('客户端不得再定义 Cookie 字段表（唯一真相在 shared/src/credentials.ts）', () => {
  const offenders = sourceFiles(CLIENT_SRC)
    .filter((f) => /cookieName\s*:/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(path.resolve(__dirname, '..'), f))
  assert.deepEqual(
    offenders,
    [],
    `发现本地 Cookie 字段表定义（字段表只能有一份，位于 shared/src/credentials.ts）：\n  ${offenders.join('\n  ')}`,
  )
})

test('QOJ 字段口径：两项 Cookie 按名分框（UOJSESSID / cf_clearance）+ 浏览器 UA', () => {
  const defs = cookieFieldsOf('qoj')
  assert.deepEqual(defs.map((d) => d.key), ['uojsessid', 'clearance', 'ua'])
  // 两个 Cookie 都是「按名分框」的普通字段——不使用 raw 透传（raw 的整段保留语义假定每平台只有一个 raw 框）
  assert.ok(!defs.some((d) => d.raw === true), 'QOJ 两项 Cookie 不得用 raw：双 raw 会让未修改项把整段已存头重复推入')
  assert.deepEqual(cookieOnlyFieldsOf('qoj').map((d) => d.key), ['uojsessid', 'clearance'])
  // 已移除的旧键名不得复活（服务端会以「未知 Cookie 字段」拒绝）
  assert.ok(!defs.some((d) => d.key === 'session'))
})

test('计蒜客两个 Cookie 也按名分框（本次不改其 raw 口径）', () => {
  assert.deepEqual(cookieFieldsOf('jisuanke').map((d) => d.key), ['s', 'jskuss'])
  assert.deepEqual(cookieOnlyFieldsOf('jisuanke').map((d) => d.cookieName), ['s', 'JSKUSS'])
})

test('各平台字段定义自洽：key 唯一、cookieName 非空', () => {
  for (const p of PLATFORMS) {
    const defs = cookieFieldsOf(p.id)
    const keys = defs.map((d) => d.key)
    assert.equal(new Set(keys).size, keys.length, `${p.id} 的字段 key 有重复：${keys.join(',')}`)
    for (const d of defs) {
      assert.ok(d.key !== '' && d.cookieName !== '', `${p.id} 存在空 key/cookieName`)
    }
  }
})

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

test('QOJ 字段口径：整段 Cookie + 浏览器 UA 两项，不得再出现已移除的 session 字段', () => {
  const keys = cookieFieldsOf('qoj').map((d) => d.key)
  assert.deepEqual(keys, ['clearance', 'ua'])
  assert.ok(!keys.includes('session'), 'session（单列 UOJSESSID）已在共享表中移除，客户端不得再提交')
  // 整段 Cookie 必须按 raw 透传（含 cf_clearance 与 UOJSESSID 多项），UA 为仅配置项不进 Cookie 头
  assert.equal(cookieFieldsOf('qoj')[0]!.raw, true)
  assert.deepEqual(cookieOnlyFieldsOf('qoj').map((d) => d.key), ['clearance'])
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

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { qrDataUrl, qrPng } from '../lib/qr.js'

const root = fileURLToPath(new URL('../', import.meta.url))

test('二维码在零外部依赖下也能画出来（issue #64 的回归）', () => {
  const text = 'https://passport.bilibili.com/x/passport-login/web/qrcode/scan?key=fixture'
  const url = qrDataUrl(text, { width: 220, margin: 2 })
  assert.match(url, /^data:image\/png;base64,/)
  const png = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64')
  // 真 PNG：签名 + IHDR 里的宽高，别只断言"有个字符串"
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR')
  const side = png.readUInt32BE(16)
  assert.equal(png.readUInt32BE(20), side)
  assert.ok(side >= 100 && side <= 400, '边长应落在合理范围，实际 ' + side)
})

test('同一段文本两次生成结果一致（确定性，便于缓存与比对）', () => {
  const a = qrDataUrl('https://example.invalid/stable', { width: 220, margin: 2 })
  const b = qrDataUrl('https://example.invalid/stable', { width: 220, margin: 2 })
  assert.equal(a, b)
})

test('没有裸 qrcode 依赖：源码与 package.json 都不许再引用它', () => {
  // 宿主（DSH）对裸 CJS 依赖的解析会把模块 stub 成空对象，
  // 一旦重新引入 `qrcode`，扫码登录就会再次"生成失败"。
  const bare = /(?:from\s+|require\(\s*)['"]qrcode['"]/
  for (const dir of ['lib', 'tools']) {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name)
      return e.isDirectory() ? walk(p) : [p]
    })
    for (const file of walk(path.join(root, dir))) {
      if (!/\.(?:js|mjs|cjs)$/.test(file)) continue
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), bare, file)
    }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal((pkg.dependencies || {}).qrcode, undefined)
  assert.equal((pkg.devDependencies || {}).qrcode, undefined)
})

test('vendor 的二维码实现本身不含任何外部导入', () => {
  const src = fs.readFileSync(path.join(root, 'vendor/qrcode/qrcode.mjs'), 'utf8')
  assert.doesNotMatch(src, /^\s*import\s/m)
  assert.doesNotMatch(src, /\brequire\s*\(/)
  assert.doesNotMatch(src, /\bfrom\s+['"]/)
})

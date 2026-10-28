import { guardedFetch as fetch } from '../lib/traffic.mjs'
// Post ONE image dynamic. Does not delete anything — the caller decides.
//
//   node bili-dynamic-image.mjs --image <path> [--text "..."] --dry | --go
//
// dry: reads the image locally, prints type/size/dimensions and the exact
//      requests that would be sent. Uploads nothing.
// go : uploads via x/dynamic/feed/draw/upload_bfs, then posts create/dyn with
//      scene=2 and one pics entry. Prints the dyn_id and link.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
// 2026-10-21 修（外部审计）：下面 --go 路径里调了 gate()，但从来没导入过 ✗
//   一跑到那儿就是 ReferenceError（danmaku.mjs 早就踩过同一个坑，这次补齐三条）
import { gate, record } from '../lib/quota-gate.mjs'

const argv = process.argv.slice(2)
const args = new Map()
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) args.set(a.slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true)
}
const imagePath = args.get('image')
const text = args.get('text') ?? ''
const atMid = args.get('at')          // 要 @ 的用户 mid
const atName = args.get('at-name')    // 显示名（拼进 raw_text）
const isDry = args.has('dry')
const isGo = args.has('go')

if (!imagePath || typeof imagePath !== 'string') { console.error('需要 --image <路径>'); process.exit(2) }
if (isDry === isGo) { console.error('必须且只能给一个 --dry 或 --go'); process.exit(2) }
if (!fs.existsSync(imagePath)) { console.error(`图片不存在: ${imagePath}`); process.exit(2) }

// ---- image sniffing --------------------------------------------------------
const buf = fs.readFileSync(imagePath)
function kindOf(b) {
  if (b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length > 6 && b.toString('latin1', 0, 3) === 'GIF') return 'gif'
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return 'unknown'
}
function dimsOf(b, kind) {
  if (kind === 'png') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  if (kind === 'gif') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
  if (kind === 'jpg') {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i += 1; continue }
      const marker = b[i + 1]
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
      }
      const len = b.readUInt16BE(i + 2)
      i += 2 + len
    }
    return null
  }
  return null
}
const kind = kindOf(buf)
const dims = dimsOf(buf, kind)
console.log('=== 图片 ===')
console.log(`  路径: ${imagePath}`)
console.log(`  类型: ${kind}   ${(buf.length / 1024).toFixed(1)} KiB   ${dims ? `${dims.width}x${dims.height}` : '尺寸未解析'}`)
if (!['png', 'jpg', 'gif'].includes(kind)) {
  console.error(`\n✗ 该接口只收 jpg / png / gif，当前是 ${kind}。`)
  // PR #21 follow-up: do not interpolate filenames into copyable shell commands.
  console.error('  请用图片编辑器转换为 PNG 后重试。')
  process.exit(5)
}
if (!dims) { console.error('✗ 没解析出尺寸，无法组装 pics'); process.exit(5) }

// ---- credentials -----------------------------------------------------------
const credPath = path.join((process.env.USERPROFILE || process.env.HOME || '/'), '.bili-ai', 'credentials.json')
if (!fs.existsSync(credPath)) { console.error(`缺少凭据文件: ${credPath}`); process.exit(3) }
const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'))
for (const k of ['sessdata', 'bili_jct', 'buvid3']) {
  if (!cred[k] || String(cred[k]).trim() === '') { console.error(`凭据文件缺少 ${k}`); process.exit(3) }
}
const cookieHeader = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REF = 'https://t.bilibili.com/'

const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))
async function wbi(params) {
  const d = await (await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: cookieHeader },
  })).json()
  const img = d?.data?.wbi_img?.img_url, sub = d?.data?.wbi_img?.sub_url
  if (!img || !sub) return ''
  const mixin = MIXIN_TAB.map((i) => (keyOf(img) + keyOf(sub))[i]).join('').slice(0, 32)
  const wts = Math.round(Date.now() / 1000)
  const clean = (v) => String(v).replace(/[!'()*]/g, '')
  const q = Object.keys({ ...params, wts }).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(k === 'wts' ? wts : params[k]))}`).join('&')
  return `${q}&w_rid=${crypto.createHash('md5').update(q + mixin).digest('hex')}`
}

console.log('\n=== 登录态 ===')
const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', {
  headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: cookieHeader },
})).json()
if (nav.code !== 0) { console.error(`  登录态无效 code=${nav.code} ${nav.message}`); process.exit(4) }
console.log(`  账号: ${nav.data.uname} (mid ${nav.data.mid})  手机绑定=${nav.data.mobile_verified ? '是' : '否'}`)

console.log('\n=== 计划 ===')
console.log('  1) POST https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs')
console.log(`     multipart: file_up=<图片>  category=daily  csrf=***csrf***   cookie=SESSDATA=***`)
console.log('  2) POST https://api.bilibili.com/x/dynamic/feed/create/dyn?wts=..&w_rid=..（csrf 在 URL 参数，已脱敏）')
console.log(`     JSON: scene=2（带图）, pics=[{img_src:<上一步返回>, img_width:${dims.width}, img_height:${dims.height}, img_size:<KB>}]`)
console.log(`     正文: ${text ? `「${text.replace(/\n/g, ' / ')}」(${text.length} 字)` : '（空）'}`)
if (atMid) console.log(`     @节点: raw_text="@${atName ?? ''} "  type=2  biz_id=${atMid}`)

if (isDry) { console.log('\n[dry] 未上传、未发布（上传本身也是写操作，所以 dry 阶段一次请求都不发）。'); process.exit(0) }

// 2026-10-21 修（外部审计 #9）：闸门必须在【上传图片之前】——
//   上传本身就是写操作；先传后拦，等于图已经上去了才说"不行" ✗
if (!gate({ type: 'dynamic', target: 'dynamic', auto: process.argv.includes('--auto') })) {
  console.error('拒绝：限额闸不通过（额度 / 名单）—— 还没上传图片，未产生任何写入 ✓')
  process.exit(2)
}

console.log('\n[1/2] 上传图片…')
const fd = new FormData()
const mime = kind === 'png' ? 'image/png' : kind === 'jpg' ? 'image/jpeg' : 'image/gif'
fd.append('file_up', new Blob([buf], { type: mime }), `upload.${kind}`)
fd.append('category', 'daily')
fd.append('csrf', String(cred.bili_jct))
const up = await fetch('https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs', {
  method: 'POST',
  headers: { 'user-agent': UA, referer: REF, cookie: cookieHeader },
  body: fd,
})
const upJson = await up.json()
console.log(`     HTTP ${up.status}  code=${upJson.code} ${upJson.message ?? ''}`)
if (upJson.code !== 0) { console.error(`     上传失败: ${JSON.stringify(upJson).slice(0, 300)}`); process.exit(6) }
const { image_url: imgSrc, image_width: w, image_height: h, img_size: kb } = upJson.data ?? {}
console.log(`     image_url=${imgSrc}  ${w}x${h}  ${kb}KB`)

console.log('\n[2/2] 发布图文动态…')
const contents = []
if (text) contents.push({ raw_text: (atMid && !/\s$/.test(text)) ? `${text}\n` : text, type: 1, biz_id: '' })
if (atMid) contents.push({ raw_text: `@${atName ?? ''} `, type: 2, biz_id: String(atMid) })
const dynReq = {
  pics: [{ img_src: imgSrc, img_width: w, img_height: h, img_size: kb }],
  scene: 2,
  meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } },
}
if (contents.length) dynReq.content = { contents }
const body = JSON.stringify({ dyn_req: dynReq })
console.log(`     content.contents = ${JSON.stringify(contents)}`)
const qs = await wbi({ csrf: String(cred.bili_jct) }) || new URLSearchParams({ csrf: String(cred.bili_jct) }).toString()
// 闸门已在上传前过 ✓（2026-10-21 挪走，见上）
const r = await fetch(`https://api.bilibili.com/x/dynamic/feed/create/dyn?${qs}`, {
  method: 'POST',
  waitWriteMs: 180000,
  headers: { 'user-agent': UA, referer: REF, origin: 'https://t.bilibili.com', 'content-type': 'application/json', cookie: cookieHeader },
  body,
}).catch(() => { console.error('发布失败或结果未知，请先回读核查'); process.exit(1) })
const out = await r.json().catch(() => null)
if (!out || typeof out.code !== 'number') { console.error('发布结果未知，请先回读核查'); process.exit(1) }
console.log(`     HTTP ${r.status}  code=${out.code}`)
if (out.code === 0) {
  const id = out.data?.dyn_id_str ?? out.data?.dyn_id
  record({type:'dynamic',target:'dynamic:'+id,note:String(text).slice(0,40),auto:process.argv.includes('--auto')})
  console.log(`\n✅ 已发布（未删除，等你确认）  dyn_id=${id}`)
  console.log(`   https://t.bilibili.com/${id}`)
  console.log(`   复核: node bili-dynamic.mjs check --id ${id}`)
  console.log(`   撤掉: node bili-dynamic.mjs rm --id ${id} --go`)
} else {
  console.log('  发布失败，请检查接口状态')
}

process.exit(r.ok && out.code===0 ? 0 : 1)

import { HOME } from '../lib/paths.mjs'
import { guardedFetch as fetch } from '../lib/traffic.mjs'
// 删除自己发的一条评论。用法:
//   node comment-del.mjs --oid <aid> --rpid <rpid> --bvid <BV> --dry | --go
// 文档: docs/comment-add.md「删除评论」（x/v2/reply/del，只能删自己的）
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const args = new Map()
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) args.set(a.slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true)
}
const oid = args.get('oid')
const rpid = args.get('rpid')
const bvid = args.get('bvid')
const isDry = args.has('dry')
const isGo = args.has('go')
if (!oid || !rpid) { console.error('需要 --oid <aid> --rpid <rpid>'); process.exit(2) }
if (isDry === isGo) { console.error('必须且只能给一个 --dry 或 --go'); process.exit(2) }

const cred = JSON.parse(fs.readFileSync(path.join((HOME), '.bili-ai', 'credentials.json'), 'utf8'))
const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

console.log('=== 将删除 ===')
console.log(`  POST https://api.bilibili.com/x/v2/reply/del`)
console.log(`  type=1  oid=${oid}  rpid=${rpid}  csrf=***csrf***   cookie=SESSDATA=***`)
if (bvid) console.log(`  referer=https://www.bilibili.com/video/${bvid}/`)
if (isDry) { console.log('\n[dry] 未删除。'); process.exit(0) }

const r = await fetch('https://api.bilibili.com/x/v2/reply/del', {
  method: 'POST',
  headers: {
    'user-agent': UA,
    referer: bvid ? `https://www.bilibili.com/video/${bvid}/` : 'https://www.bilibili.com/',
    origin: 'https://www.bilibili.com',
    'content-type': 'application/x-www-form-urlencoded',
    cookie,
  },
  body: new URLSearchParams({ type: '1', oid: String(oid), rpid: String(rpid), csrf: String(cred.bili_jct) }).toString(),
})
const out = await r.json()
const hints = { 0: '成功', '-101': '未登录', '-111': 'csrf 不对', '-403': '权限不足（不是自己的评论）', '-404': '无此项', 12022: '已经被删除了' }
console.log(`\n[go] HTTP ${r.status}  code=${out.code} ${out.message ?? ''}   ${hints[out.code] ?? ''}`)
process.exit(out.code === 0 ? 0 : 1)

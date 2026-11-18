import { HOME } from '../lib/paths.mjs'
import { cacheComments } from '../lib/ai-share.mjs'
import { apiGet } from '../lib/bili-api.mjs'
// 拉一条视频的热评 / 最新评论（只读）——「看完的人怎么看」那一路，从 debrief 里拆出来单用。
//
// 用法: node comments.mjs <BV> [--ps 20] [--pn 1] [--sort hot|time] [--json] [--max-chars 200]
//   产物: 终端摘要（默认）/ JSON（--json，给宿主或模型结构化消费）
//
// 为什么单独拆出来：
//   · debrief 是"六路一条龙"，只想看评论时它太重（要下封面、拉字幕、算弹幕）；
//   · 日报类场景（scroll 的每日挑片）只需要「标题 + 热评」就能判断值不值得看；
//   · 拆成独立命令后，CLI（whale 那种 agent 自己跑）和 MCP（scroll 那种白名单工具）**共用同一份实现**。
//
// ⚠️ 两个实测口径：
//   1. 热评接口是 `/x/v2/reply?type=1&oid=<aid>&sort=2`（sort=2 才是热度序；sort=0 是时间序）；
//      oid 是 **aid**，不是 BV ⇒ 先 `view?bvid=` 换一次。
//   2. 这个接口**匿名可读**（不需要登录），但匿名拿不到"只有登录才可见"的楼层；
//      写操作（发/删评论）另见 comment.mjs，那是另一套（WBI + bili_jct）。
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const bvid = argv.find((a) => !a.startsWith('--'))
if (!bvid) { console.error('用法: node comments.mjs <BV> [--ps 20] [--pn 1] [--sort hot|time] [--json] [--max-chars 200]'); process.exit(2) }
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const next = argv[i + 1]
  // ⚠️ 末尾的布尔开关（如 `--json`）没有下一个参数：必须当成 true。
  //    whale 其它命令的写法是 `opt[k] = argv[i+1]?.startsWith('--') ? true : argv[++i]` ——
  //    末尾开关会被赋成 undefined（`--no-frames` 因此失效）。这里按正确语义写。
  if (next === undefined || next.startsWith('--')) { opt[a.slice(2)] = true } else { opt[a.slice(2)] = next; i += 1 }
}
const PS = Math.min(50, Math.max(1, Number(opt.ps ?? 20) || 20))
const PN = Math.max(1, Number(opt.pn ?? 1) || 1)
const SORT = String(opt.sort ?? 'hot') === 'time' ? 0 : 2
const MAXC = Math.max(40, Number(opt['max-chars'] ?? 200) || 200)
const AS_JSON = Boolean(opt.json)

// 凭据：**没有也能跑**（这个接口匿名可读）。有就用上，拿到的楼层更全。
// （search.mjs / subtitles.mjs 是硬读的；这里刻意容错，免得 PoC 之外的环境直接崩。）
let cred = {}
try {
  cred = JSON.parse(fs.readFileSync(path.join((HOME), '.bili-ai', 'credentials.json'), 'utf8'))
} catch { /* 匿名 */ }
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const cookie = cred.sessdata ? `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct ?? ''}; buvid3=${cred.buvid3 ?? ''}` : ''
const H = { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bvid}/`, ...(cookie ? { cookie } : {}) }
const jget = u => apiGet(u, H)

const view = await jget(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)
if (view.code !== 0) {
  const msg = `view 失败 code=${view.code} ${view.message ?? ''}`
  if (AS_JSON) console.log(JSON.stringify({ ok: false, error: msg, bvid }, null, 2))
  else console.error(msg)
  process.exit(3)
}
const d = view.data
const aid = d.aid

const rep = await jget(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=${SORT}&ps=${PS}&pn=${PN}`)
if (rep.code !== 0) {
  const msg = `reply 失败 code=${rep.code} ${rep.message ?? ''}`
  if (AS_JSON) console.log(JSON.stringify({ ok: false, error: msg, bvid, aid }, null, 2))
  else console.error(msg)
  process.exit(4)
}

const one = (r, tag = '') => ({
  rpid: String(r.rpid ?? ''),
  user: String(r.member?.uname ?? '匿名'),
  mid: String(r.member?.mid ?? ''),
  like: Number(r.like ?? 0),
  replies: Number(r.rcount ?? 0),
  time: r.ctime ? new Date(Number(r.ctime) * 1000).toLocaleString('zh-CN', { hour12: false }) : '',
  text: String(r.content?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, MAXC),
  ...(tag ? { tag } : {}),
})

const top = [
  ...(Array.isArray(rep.data?.top) ? rep.data.top.map((r) => one(r, '置顶')) : []),
  ...(rep.data?.upper?.top ? [one(rep.data.upper.top, 'UP置顶')] : []),
]
const list = [
  ...top,
  ...(Array.isArray(rep.data?.replies) ? rep.data.replies.map((r) => one(r)) : []),
]

if (PN === 1) { try { cacheComments(bvid, aid, SORT === 2 ? "hot" : "time", list) } catch {} }

if (AS_JSON) {
  console.log(JSON.stringify({
    ok: true,
    bvid,
    aid,
    title: String(d.title ?? ''),
    total: Number(rep.data?.page?.count ?? d.stat?.reply ?? 0),
    sort: SORT === 2 ? 'hot' : 'time',
    page: PN,
    count: list.length,
    items: list,
  }, null, 2))
  process.exit(0)
}

console.log(`评论「${d.title}」`)
console.log(`BV=${bvid}  aid=${aid}  总评论≈${rep.data?.page?.count ?? d.stat?.reply ?? '?'}  sort=${SORT === 2 ? '热度' : '时间'}  pn=${PN}  本页 ${list.length} 条`)
if (!list.length) console.log('（这一页没有评论：可能关了评论区，或页码超了）')
for (const [i, c] of list.entries()) {
  const tag = c.tag ? `【${c.tag}】` : ''
  console.log(`\n[${i + 1}] ${tag}♥${c.like}  ${c.user}（mid ${c.mid}）  ${c.time}  rpid=${c.rpid}`)
  console.log(`    ${c.text}`)
  if (c.replies) console.log(`    └ 楼中楼 ${c.replies} 条`)
}

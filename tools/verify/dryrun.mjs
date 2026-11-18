// Dry-run preparation for one comment. Read-only, no credentials.
//  1. BV -> aid via the public view API (oid for the comment area)
//  2. video facts + comment-area state + top comments (to read the room)
//  3. WBI signing material from the public nav endpoint (newer endpoints want it)
import { apiGet } from '../lib/bili-api.mjs'
import { localDay } from '../lib/local-date.mjs'

const BVID = process.argv[2]
const H = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  referer: `https://www.bilibili.com/video/${BVID}/`,
}
// 2026-10-22 迁到 apiGet：拿到节流（≥300ms）+ 熔断（撞 412 就停）+ 结构化错误 ✓
//   recon 查的是 view / x/v2/reply —— 都在 CACHEABLE 白名单里，因此还能吃缓存 ✓
const get = async (url) => await apiGet(url, H)

const view = await get(`https://api.bilibili.com/x/web-interface/view?bvid=${BVID}`)
if (view.code !== 0) {
  console.log(`view API code=${view.code} message=${view.message}`)
  process.exit(4)   // 2026-10-21 修（外部审计 #7）：接口失败不该 exit 0
}
const d = view.data
console.log('=== 视频 ===')
console.log(`  bvid    : ${d.bvid}`)
console.log(`  aid(oid): ${d.aid}          <- 评论要用这个，不是 BV 号`)
console.log(`  title   : ${d.title}`)
console.log(`  UP      : ${d.owner.name} (mid ${d.owner.mid})`)
console.log(`  pubdate : ${localDay(d.pubdate * 1000)}   时长 ${d.duration}s`)
console.log(`  stat    : 播放 ${d.stat.view}  弹幕 ${d.stat.danmaku}  评论 ${d.stat.reply}  点赞 ${d.stat.like}`)
console.log(`  rights  : ${JSON.stringify(d.rights)}`)
console.log(`  desc    : ${(d.desc ?? '').split('\n')[0].slice(0, 120)}`)

console.log('\n=== 评论区状态 + 热门评论（读读空气） ===')
const rep = await get(`https://api.bilibili.com/x/v2/reply?type=1&oid=${d.aid}&pn=1&ps=5&sort=2`)
console.log(`  reply API code=${rep.code} message=${rep.message}`)
if (rep.code === 0 && rep.data) {
  const r = rep.data
  console.log(`  page    : count=${r.page?.count} size=${r.page?.size}`)
  console.log(`  upperTop: ${r.upper?.top ? 'UP 置顶存在' : '无'}`)
  const list = r.replies ?? []
  console.log(`  got ${list.length} comments, top 3 by like:`)
  for (const c of list.slice(0, 3)) {
    console.log(`    [${c.like}赞] ${c.member?.uname}: ${String(c.content?.message ?? '').replace(/\n/g, ' ').slice(0, 80)}`)
  }
}

console.log('\n=== WBI 签名材料（公开接口即可取得） ===')
const nav = await get('https://api.bilibili.com/x/web-interface/nav')
console.log(`  nav code=${nav.code} (${nav.code === -101 ? '未登录，正常：这里只要 wbi keys' : nav.message})`)
const img = nav.data?.wbi_img?.img_url
const sub = nav.data?.wbi_img?.sub_url
if (!img || !sub) {
  console.log('  没拿到 wbi_img，稍后重试')
} else {
  const key = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))
  const raw = key(img) + key(sub)
  const TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
  const mixin = TAB.map((i) => raw[i]).join('').slice(0, 32)
  console.log(`  img_key : ${key(img)}`)
  console.log(`  sub_key : ${key(sub)}`)
  console.log(`  mixin   : ${mixin}   (32 位，签名用)`)
}

console.log('\n=== 将要构造的请求（占位符待你确认文案/@昵称） ===')
console.log(`  POST https://api.bilibili.com/x/v2/reply/add`)
console.log(`  content-type: application/x-www-form-urlencoded`)
console.log(`  body(示意): type=1&oid=${d.aid}&message=<URL编码后的 "@昵称 你的评论">&plat=1&csrf=<bili_jct>`)
console.log(`  cookie    : SESSDATA / bili_jct / buvid3（你放进本机文件，我不看值）`)
console.log(`  headers   : 上面的 UA + referer ${H.referer}`)
console.log(`  可选(w_rid/wts): 若接口要求 WBI 签名，就用上面算出的 mixin 对同一串参数签名，一并带上`)

import { HOME } from '../lib/paths.mjs'
import { guardedFetch as fetch } from '../lib/traffic.mjs'
import { apiGet } from '../lib/bili-api.mjs'
// Reconstruct what a video is about without watching it.
//   metadata + cover + subtitles (if any) + tags + the repo it links to
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const BVID = process.argv[2]
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
// [2026-10-14] 字幕必须带登录 cookie 且走 WBI 签名，否则拿到的 subtitle_url 缺 auth_key → CDN 403
const cred = JSON.parse(fs.readFileSync(path.join((HOME), '.bili-ai', 'credentials.json'), 'utf8'))
const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))
const navForWbi = await apiGet('https://api.bilibili.com/x/web-interface/nav', { 'user-agent': UA, cookie })
const wbiRaw = keyOf(navForWbi.data?.wbi_img?.img_url ?? '') + keyOf(navForWbi.data?.wbi_img?.sub_url ?? '')
const wbiMixin = MIXIN_TAB.map((i) => wbiRaw[i]).join('').slice(0, 32)
function wbiQuery(params) {
  const wts = Math.round(Date.now() / 1000)
  const q = Object.keys({ ...params, wts }).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(k === 'wts' ? wts : params[k]).replace(/[!'()*]/g, ''))}`).join('&')
  return `${q}&w_rid=${crypto.createHash('md5').update(q + wbiMixin).digest('hex')}`
}
const get = (url, extra = {}) => apiGet(url, { 'user-agent': UA, referer: `https://www.bilibili.com/video/${BVID}/`, cookie, ...extra })

const view = await get(`https://api.bilibili.com/x/web-interface/view?bvid=${BVID}`)
if (!view || view.code !== 0) { console.error('view failed', view?.code, view?.message); process.exit(3) }
const d = view.data
const cid = d.pages?.[0]?.cid
console.log('=== 元信息 ===')
console.log(`  ${d.title}`)
console.log(`  UP ${d.owner.name} | ${d.tname} | ${d.duration}s | 发布 ${new Date(d.pubdate * 1000).toLocaleString('zh-CN')}`)
console.log(`  aid=${d.aid} cid=${cid}`)
console.log(`  简介原文:\n${(d.desc ?? '').split('\n').map((l) => '    ' + l).join('\n')}`)
console.log(`  封面: ${d.pic}`)

const tag = await get(`https://api.bilibili.com/x/tag/archive/tags?bvid=${BVID}`)
if (tag?.code === 0) console.log('  标签: ' + tag.data.map((t) => t.tag_name).join(' / '))

console.log('\n=== 字幕（有的话就等于读到了台词） ===')
const player = await get(`https://api.bilibili.com/x/player/wbi/v2?${wbiQuery({ bvid: BVID, cid })}`, { cookie })
const subs = player?.data?.subtitle?.subtitles ?? []
console.log(`  player code=${player?.code} 字幕条数=${subs.length}`)
for (const s of subs) console.log(`    ${s.lan_doc} (${s.lan}) auth_key=${String(s.subtitle_url).includes('auth_key') ? '有' : '无(会403)'} -> ${s.subtitle_url}`)
if (subs.length) {
  const pick = subs.find((s) => s.lan === 'ai-zh') ?? subs.find((s) => s.lan === 'zh-CN') ?? subs[0]
  const first = await get(String(pick.subtitle_url).startsWith('http') ? pick.subtitle_url : 'https:' + pick.subtitle_url, { cookie: '' })
  const body = first?.body ?? []
  console.log(`  字幕行数=${body.length}（轨道 ${pick.lan}），前 40 行：`)
  for (const line of body.slice(0, 40)) console.log(`    [${line.from.toFixed(1)}s] ${line.content}`)
  if (body.length > 40) console.log(`    …（还有 ${body.length - 40} 行；要全文用 bili.mjs subtitles ${BVID}）`)
} else {
  console.log('  (无官方字幕轨道——这种视频只把字幕烧进画面，要走 bili.mjs watch-video 看 SUBS 图)')
}

console.log('\n=== 弹幕（26 秒的视频，量少但能看出关键词） ===')
const dm = await (async () => {
  const r = await fetch(`https://comment.bilibili.com/${cid}.xml`, { headers: { 'user-agent': UA } })
  if (!r.ok) return null
  const x = await r.text()
  const items = [...x.matchAll(/<d p="[^"]*">([^<]*)<\/d>/g)].map((m) => m[1])
  return items
})()
console.log(dm ? `  弹幕 ${dm.length} 条: ${dm.slice(0, 20).join(' | ')}` : '  没取到弹幕')

// 2026-10-21 修（外部审计 #3）：这里原来写死 const repo = 'T-Auto/dsh-ops'，
// 无论看什么视频都会去拉那个不相干仓库的 README —— 作者自用侦查脚本的残留 ✗
// 改成：只有显式给 --repo <owner/name> 才查，否则跳过 ✓
const wantRepo = (process.argv.find((a) => a.startsWith('--repo=')) ?? '').split('=')[1]
  || (process.argv.includes('--repo') ? process.argv[process.argv.indexOf('--repo') + 1] : '')
if (!wantRepo) {
  console.log('\n=== 仓库信息（跳过）===')
  console.log('  要给就加 --repo <owner/name>；不给就不猜 ✓')
} else {
  const repo = wantRepo
  const meta = await (await fetch(`https://api.github.com/repos/${repo}`, { headers: { 'user-agent': 'dsh-recon' } })).json()
  if (!meta.full_name) {
    console.log(`  取不到 ${repo}（code=${meta.message ?? '?'}）`)
  } else {
    console.log(`  ${meta.full_name}  ★${meta.stargazers_count}  ${meta.pushed_at?.slice(0, 10)}  license=${meta.license?.spdx_id ?? '-'}`)
    console.log(`  ${meta.description ?? ''}`)
    try {
      const readme = await (await fetch(`https://raw.githubusercontent.com/${repo}/${meta.default_branch}/README.md`, { headers: { 'user-agent': 'dsh-recon' } })).text()
      const lines = readme.split('\n').filter((l) => l.trim() !== '')
      console.log('  README 前 25 行非空内容:')
      for (const l of lines.slice(0, 25)) console.log('    ' + l.slice(0, 130))
    } catch (e) {
      console.log('  README 取不到：' + String(e.message).slice(0, 60))
    }
  }
}

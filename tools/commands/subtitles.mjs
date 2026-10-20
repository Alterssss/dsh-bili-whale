// 拉 B 站官方字幕（带时间戳）——"看视频"里最省的一条腿：先拿文字，再决定要不要抽帧看画面。
//
// 用法: node subtitles.mjs <BV> [--lan ai-zh] [--out 目录] [--print 12]
//   产物: <out>/<BV>-<lan>.json（原始）/ .txt（带 [mm:ss] 时间戳）/ -plain.txt（纯文本，适合直接喂模型）
//
// ⚠️ 关键（2026-10-14 从 BiliSub / bilibili-video-summary 的实测笔记里学到的）：
//   1. 必须走 WBI 签名的 `/x/player/wbi/v2`。用旧的 `/x/player/v2` 也能拿到 subtitle_url，
//      但那个 URL **缺 auth_key** → CDN 会返回 403 或错误内容（本仓库 video-content.mjs 原来就踩这个）。
//   2. subtitle_url 里的 auth_key 是**分钟级有效** → 拿到就得马上下载，且 **URL 不能截断**
//      （尾部还有 `-0-<32位hex>`，截了同样 403）。
//   3. 匿名拿不到 AI 字幕（返回 0 条）→ 必须带登录 cookie。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { dshPath } from '../lib/paths.mjs'


const argv = process.argv.slice(2)
const bvid = argv.find((a) => !a.startsWith('--'))
if (!bvid) { console.error('用法: node subtitles.mjs <BV> [--lan ai-zh] [--out 目录] [--print 12]'); process.exit(2) }
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i]
}
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`

const cred = JSON.parse(fs.readFileSync(path.join((process.env.USERPROFILE || process.env.HOME || '/'), '.bili-ai', 'credentials.json'), 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
const H = { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bvid}/`, cookie }
const jget = async (u) => (await fetch(u, { headers: H })).json()

// WBI 签名（各脚本里重复了一份，保持一致；要改就一起改）
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))
const nav = await jget('https://api.bilibili.com/x/web-interface/nav')
const raw = keyOf(nav.data?.wbi_img?.img_url ?? '') + keyOf(nav.data?.wbi_img?.sub_url ?? '')
const mixin = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)
const clean = (v) => String(v).replace(/[!'()*]/g, '')
function wbi(params) {
  const wts = Math.round(Date.now() / 1000)
  const q = Object.keys({ ...params, wts }).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(k === 'wts' ? wts : params[k]))}`).join('&')
  return `${q}&w_rid=${crypto.createHash('md5').update(q + mixin).digest('hex')}`
}

const view = await jget(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)
if (view.code !== 0) { console.error(`view 失败 code=${view.code} ${view.message}`); process.exit(3) }
const { aid, cid, title, duration } = view.data
console.log(`标题: ${title}`)
console.log(`UP: ${view.data.owner.name}   时长: ${duration}s   aid=${aid} cid=${cid}`)

// ① 主端点：WBI 签名（这一步决定 subtitle_url 里有没有 auth_key）
const p1 = await jget(`https://api.bilibili.com/x/player/wbi/v2?${wbi({ bvid, cid })}`)
let subs = p1?.data?.subtitle?.subtitles ?? []
let src = 'x/player/wbi/v2'
const aiStatus = p1?.data?.subtitle?.ai_status

// ② 兜底：播放器实际调用的那个端点（同样要 cookie）
if (!subs.length) {
  const ext = encodeURIComponent(JSON.stringify({ video_type: 1 }))
  const p2 = await jget(`https://api.bilibili.com/x/v2/subtitle/web/view?oid=${aid}&pid=${aid}` +
    `&context_ext=${ext}&type=1&cur_production_type=0&preferred_language=ai-zh&playlist_switch=0`)
  const s2 = p2?.data?.subtitle?.subtitles ?? []
  if (s2.length) { subs = s2; src = 'x/v2/subtitle/web/view' }
  else console.log(`两个端点都没字幕：wbi/v2 code=${p1?.code} ai_status=${aiStatus ?? '-'}；web/view code=${p2?.code}`)
}
console.log(`字幕来源: ${src}   轨道数=${subs.length}   ai_status=${aiStatus ?? '-'}（0=无AI字幕 1=有 2=生成中）`)
for (const s of subs) {
  console.log(`   ${String(s.lan).padEnd(6)} ${String(s.lan_doc ?? '').padEnd(10)} auth_key=${String(s.subtitle_url).includes('auth_key') ? '有' : '无(会403)'}`)
}

const pick = subs.find((s) => s.lan === (typeof opt.lan === 'string' ? opt.lan : 'ai-zh'))
  ?? subs.find((s) => s.lan === 'zh-CN')
  ?? subs.find((s) => String(s.lan).startsWith('zh'))
  ?? subs[0]
if (!pick) { console.log('\n没有可用字幕轨道——这视频大概率只把字幕烧进了画面（那种要走 watch-video + SUBS）'); process.exit(0) }
console.log(`选定: ${pick.lan} (${pick.lan_doc ?? ''})`)

const url = String(pick.subtitle_url).startsWith('http') ? pick.subtitle_url : 'https:' + pick.subtitle_url
const r = await fetch(url, { headers: { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bvid}/` } })
if (!r.ok) { console.error(`下载字幕失败 HTTP ${r.status}——auth_key 分钟级过期，重跑一次即可`); process.exit(4) }
const rawText = await r.text()
let body = []
try { body = JSON.parse(rawText).body ?? [] } catch { console.error('字幕不是 JSON: ' + rawText.slice(0, 120)); process.exit(5) }
if (!body.length) { console.error('字幕 JSON 里 body 是空的'); process.exit(5) }
console.log(`字幕行数: ${body.length}   覆盖 ${fmt(body[0].from)} → ${fmt(body.at(-1).to ?? body.at(-1).from)}`)

const outDir = typeof opt.out === 'string' ? opt.out : dshPath('shots', 'subs')
fs.mkdirSync(outDir, { recursive: true })
const base = path.join(outDir, `${bvid}-${pick.lan}`)
fs.writeFileSync(base + '.json', rawText)
fs.writeFileSync(base + '.txt', `${title}\n${view.data.owner.name}  ${bvid}  ${duration}s\n\n` +
  body.map((l) => `[${fmt(l.from)}] ${l.content}`).join('\n'))
fs.writeFileSync(base + '-plain.txt', body.map((l) => l.content).join('\n'))
console.log(`\nJSON : ${base}.json（原始）`)
console.log(`TXT  : ${base}.txt（带 [mm:ss] 时间戳，适合复述成时间线）`)
console.log(`PLAIN: ${base}-plain.txt（纯文本，适合直接喂模型）`)

const n = Number(opt.print ?? 12)
console.log(`\n--- 前 ${n} 行 ---`)
for (const l of body.slice(0, n)) console.log(`[${fmt(l.from)}] ${l.content}`)

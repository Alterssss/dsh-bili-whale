import { guardedFetch as fetch } from '../lib/traffic.mjs'
import { apiGet } from '../lib/bili-api.mjs'
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
  if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true
}
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`

const cred = JSON.parse(fs.readFileSync(path.join((process.env.USERPROFILE || process.env.HOME || '/'), '.bili-ai', 'credentials.json'), 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
const H = { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bvid}/`, cookie }
// ⚠️ 不能直接 `.json()`：B 站有些端点（尤其没字幕时的兜底 /x/v2/subtitle/web/view）会回 HTML，
//    一旦 parse 失败就抛 SyntaxError，整个命令崩掉 —— 明明只是"这条视频没有字幕"。
//    这里统一兜成 JSON：非 JSON 就返回 { code: -1, message: 'non-JSON …' }，让下游按"没有"处理。
const jget = u => apiGet(u, H)

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

// ── 分P视频：「合集只读第一集」）──────────────
//   默认只抓第 1 集；要全部就显式加 --all-pages；--page N 指定某一集。
//   理由：80 集的教程逐集抓要两分钟，探针和 debrief 都被它拖慢。
// M 集采样 = 第 1 集 + 等间隔（合集/M 取整）
//   例如 80 集、M=4 → P1, P21, P41, P61
// ── ── [改动说明] 2026-10-31 ─────────────────────────────
// 改了什么：分P 视频默认只采 M 集（第 1 集 + 等间隔），--all-pages 才逐集全抓。
// 为什么改：跟 debrief 用同一套规则，避免"深读只读第一集、探针却读了全部"这种不一致。
// 不改会怎样：探针调 subtitles 时会把 80 集全读一遍，单条视频 128 秒，整轮大部分时间都耗在等字幕上。
// ────────────────────────────────────────────────
export const SAMPLE_M = Number(process.env.BW_SUBS_SAMPLE_MAX ?? 1)
// 先查原生字幕（10 秒超时），超时或没有原生 → 再查 AI 字幕
const timedJget = (url, ms = 20000) => Promise.race([
  jget(url),
  new Promise((res) => setTimeout(() => res(null), ms)),
])

const samplePages = (parts, m = SAMPLE_M) => {
  if (parts.length <= m) return parts
  const step = Math.floor(parts.length / m)
  const out = []
  for (let i = 0; i < m; i += 1) {
    const idx = Math.min(parts.length - 1, i * step)
    if (!out.includes(parts[idx])) out.push(parts[idx])
  }
  return out
}
const _pl = await jget(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`)
const _parts = Array.isArray(_pl?.data) ? _pl.data : []
if (_parts.length > 1 || typeof opt.page === 'string') {
  const wantPage = typeof opt.page === 'string' ? Number(opt.page) : null
  const allPages = process.argv.includes('--all-pages')
  const targets = wantPage
    ? _parts.filter((p) => p.page === wantPage)
    : (allPages ? _parts : samplePages(_parts))
  console.log(`\n分P视频：共 ${_parts.length} 集${wantPage ? `，只看第 ${wantPage} 集` : allPages ? '，逐集抓字幕' : '，按 M 集采样（默认 4 集：第 1 集 + 等间隔；要全部加 --all-pages）'}`)
  const outDir0 = typeof opt.out === 'string' ? opt.out : dshPath('shots', 'subs')
  fs.mkdirSync(outDir0, { recursive: true })
  const all = []
  let anyTimeout = false
  // 2026-10-30：显式 --lan 时按指定语言；否则走 中文 → ai-zh → ai-en → 任意 ai-*
  const wantLan = typeof opt.lan === 'string' ? opt.lan : null
  for (const p of targets) {
    const j = await timedJget(`https://api.bilibili.com/x/player/wbi/v2?${wbi({ bvid, cid: p.cid })}`, 20000)
    const subs = j?.data?.subtitle?.subtitles ?? []
    const native = subs.find((s) => s.lan === 'zh-CN') ?? subs.find((s) => /^zh(-|$)/.test(String(s.lan)) && s.lan !== 'ai-zh')
    const aiZh = subs.find((s) => s.lan === 'ai-zh')
    const aiEn = subs.find((s) => s.lan === 'ai-en')
    const aiAny = subs.find((s) => String(s.lan).startsWith('ai-'))
    const pick = (wantLan && subs.find((s) => s.lan === wantLan)) ?? native ?? aiZh ?? aiEn ?? aiAny ?? subs[0]
    if (!pick) {
      // 2026-10-30：超时和"真没字幕"分开报，上层据此决定要不要重试
      if (j === null) {
        anyTimeout = true
        console.log(`  P${p.page} ⏱ 请求超时（20 秒没回来）`)
      } else {
        console.log(`  P${p.page} 无字幕（ai_status=${j?.data?.subtitle?.ai_status ?? '-'}）`)
      }
      continue
    }
    const u = String(pick.subtitle_url).startsWith('http') ? pick.subtitle_url : 'https:' + pick.subtitle_url
    const rr = await fetch(u, { headers: { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bvid}/` } })
    if (!rr.ok) { console.log(`  P${p.page} 下载失败 HTTP ${rr.status}`); continue }
    let bd = []
    try { bd = (JSON.parse(await rr.text()).body) ?? [] } catch {}
    if (!bd.length) { console.log(`  P${p.page} 空字幕`); continue }
    all.push({ page: p.page, title: p.part, dur: p.duration, lang: pick.lan, body: bd })
    console.log(`  P${p.page} ${String(p.part).slice(0, 18)} — ${bd.length} 行 → ${fmt(bd.at(-1).to ?? bd.at(-1).from)}`)
    await new Promise((res) => setTimeout(res, 700))
  }
  const base0 = path.join(outDir0, `${bvid}-allparts`)
  fs.writeFileSync(base0 + '.txt', [
    `${title}`, `${view.data.owner.name}  ${bvid}  共 ${_parts.length} 集  ${duration}s`, '',
    ...all.flatMap((x) => [`## P${x.page} ${x.title}`, ...x.body.map((l) => `[${fmt(l.from)}] ${l.content}`), ''])
  ].join('\n'))
  fs.writeFileSync(base0 + '-plain.txt', all.flatMap((x) => [`## P${x.page} ${x.title}`, ...x.body.map((l) => l.content), '']).join('\n'))
  console.log(`\n抓到 ${all.length}/${targets.length} 集，合计 ${all.reduce((a, x) => a + x.body.length, 0)} 行`)
  console.log(`TXT  : ${base0}.txt`)
  console.log(`PLAIN: ${base0}-plain.txt`)
  process.exit(0)
}

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

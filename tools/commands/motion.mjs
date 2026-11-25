import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { apiGet } from '../lib/bili-api.mjs'
import { requireFfmpeg } from '../lib/ffmpeg.mjs'
import { whaleStatePath } from '../lib/whale-home.mjs'

// 沙箱里 spawnSync 的 pipe 会被拒（EPERM，匿名管道被禁），所以 stdout/stderr 走临时文件。
// metadata=print 的输出走 stdout，ffmpeg 的日志走 stderr，两个都要拿。
function capture(file, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-motion-'))
  const outPath = path.join(dir, 'stdout')
  const errPath = path.join(dir, 'stderr')
  const fds = []
  try {
    fds.push(fs.openSync(outPath, 'wx', 0o600), fs.openSync(errPath, 'wx', 0o600))
    const r = spawnSync(file, args, { timeout: 600000, windowsHide: true, stdio: ['ignore', ...fds] })
    for (const fd of fds.splice(0)) fs.closeSync(fd)
    return {
      status: r.status,
      error: r.error,
      stdout: fs.readFileSync(outPath, 'utf8'),
      stderr: fs.readFileSync(errPath, 'utf8'),
    }
  } finally {
    for (const fd of fds) { try { fs.closeSync(fd) } catch {} }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

// motion：画面的骨架（2026-11-21 加）
//   抽帧只看得到"某一格长什么样"，看不到"上一格到这一格动了多少"——运镜、打斗、追赶、走位全在帧间差里。
//     ① 每秒运动强度（signalstats 的 YDIF，帧间 Y 平均绝对差）  ② 最动的时段  ③ 长时间静止段  ④ 淡入淡出
//   零模型、零依赖，ffmpeg 自带。
//
// 用法: node motion.mjs --bvid BV… [--page 1] [--keep] [--top 5] [--fps 2] [--json]

const argv = process.argv.slice(2)
const args = new Map()
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) args.set(a.slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true)
}
const bvid = args.get('bvid') && args.get('bvid') !== true ? String(args.get('bvid')) : null
if (!bvid) { console.error('motion 需要 --bvid BV…'); process.exit(2) }
const page = Number(args.get('page') ?? 1)
const keep = args.has('keep')
const asJson = args.has('json')
const FPS = Math.max(1, Math.min(10, Number(args.get('fps') ?? 5)))
const TOP = Number(args.get('top') ?? 5)

const FFMPEG = requireFfmpeg()
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const credPath = whaleStatePath('bili-ai/credentials.json')
let cred = {}
try { cred = JSON.parse(fs.readFileSync(credPath, 'utf8')) } catch {}
const cookie = cred.sessdata ? `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}` : ''
const H = { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bvid}`, cookie }

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`

let lastDiag = ''

// ---- 元信息 ----------------------------------------------------------------
const view = await apiGet(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}&p=${page}`, H)
if (view.code !== 0) { console.error(`view 失败 code=${view.code} ${view.message ?? ''}`); process.exit(3) }
const { cid, title, duration } = view.data

// ---- 找画面源：优先复用 bili-watch 下过的原片，没有才下低清 dash 视频 ------
// 运动强度只看帧间差，不需要高清；274p/366p 足够，下载量是原片的几十分之一。
const shotsDir = whaleStatePath('shots/video')
let source = null
try {
  const hit = fs.readdirSync(shotsDir).find((f) => f.startsWith(`${bvid}-${cid}-`) && f.endsWith('.mp4'))
  if (hit) source = { kind: '本地原片', file: path.join(shotsDir, hit) }
} catch {}

if (!source) {
  const play = await apiGet(
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&fnval=16&fourk=1`, H)
  const vids = (play?.data?.dash?.video ?? []).filter((v) => v.baseUrl ?? v.base_url)
  const low = vids.filter((v) => (v.height ?? 0) <= 480).sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
  const pick = low[0] ?? vids.sort((a, b) => (a.bandwidth ?? 0) - (b.bandwidth ?? 0))[0]
  const url = pick?.baseUrl ?? pick?.base_url
  if (play.code !== 0 || !url) {
    console.error(`拿不到画面流（code=${play.code}）——这条可能只有付费/大会员清晰度；可以先跑 bili-watch 下原片再试`)
    process.exit(4)
  }
  const dir = whaleStatePath('motion')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${bvid}-${cid}.mp4`)
  const r = await fetch(url, { headers: { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bvid}/` } })
  if (!r.ok) { console.error(`画面下载失败 HTTP ${r.status}`); process.exit(4) }
  const buf = Buffer.from(await r.arrayBuffer())
  fs.writeFileSync(file, buf)
  source = { kind: `dash 画面 ${pick.height ?? '?'}p ${(buf.length / 1048576).toFixed(1)} MB`, file }
}

// ---- 采样 + signalstats：每帧给 YDIF（帧间差）和 YAVG（平均亮度）-----------
function frameStats(file) {
  const r = capture(FFMPEG, ['-hide_banner', '-nostats', '-i', file,
    '-vf', `fps=${FPS},tmix=frames=3,signalstats,metadata=print:file=-`, '-f', 'null', '-'])
  if (r.error) { lastDiag = `启动 ffmpeg 失败（${r.error.code ?? r.error.message}）——沙箱禁了子进程？`; return [] }
  if (!r.stdout) { lastDiag = `ffmpeg 退出码 ${r.status}，没有拿到 metadata 输出`; return [] }
  const frames = []
  let cur = null
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.startsWith('frame:')) { if (cur && cur.YDIF !== undefined) frames.push(cur); cur = {}; continue }
    const m = line.match(/lavfi\.signalstats\.(YDIF|YAVG)=(-?[\d.]+)/)
    if (m && cur) cur[m[1]] = Number(m[2])
  }
  if (cur && cur.YDIF !== undefined) frames.push(cur)
  if (!frames.length) lastDiag = `有 ${r.stdout.length} 字节输出，但没解析到 YDIF`
  return frames
}

const frames = frameStats(source.file)
if (!frames.length) { console.error(`没解析到画面数据：${lastDiag || '未知原因'}`); process.exit(5) }

// ---- 按秒聚合：YDIF 取中位数（雨/风扇/头发飘这类高频抖动会被压掉）----------
const bySec = new Map()
for (let i = 0; i < frames.length; i += 1) {
  const sec = Math.floor(i / FPS)
  if (!bySec.has(sec)) bySec.set(sec, [])
  bySec.get(sec).push(frames[i])
}
const secs = [...bySec.keys()].sort((a, b) => a - b)
const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const secData = secs.map((s) => {
  const arr = bySec.get(s)
  return {
    t: s,
    ydif: med(arr.map((f) => f.YDIF)),
    yavg: arr.reduce((a, f) => a + (f.YAVG ?? 0), 0) / arr.length,
  }
})

// ---- 淡入淡出：整屏一起变 → 帧间差 ≈ 亮度变化量；人/镜头在动时两者对不上 ----------
// 逐秒判：亮度变化够大（≥3）+ 帧差与亮度变化接近（差值在 35% 以内）→ 这一秒是渐变
const fadeSecs = new Set()
for (let i = 1; i < secData.length; i += 1) {
  const dY = secData[i].yavg - secData[i - 1].yavg
  const y = secData[i].ydif
  if (Math.abs(dY) >= 3 && Math.abs(y - Math.abs(dY)) <= Math.max(1.5, Math.abs(dY) * 0.35)) {
    fadeSecs.add(secData[i].t)
  }
}
const fades = []
{
  let start = null
  let end = null
  const flush = () => {
    if (start === null) return
    const a = secData.find((z) => z.t === start)?.yavg ?? 0
    const b = secData.find((z) => z.t === end)?.yavg ?? 0
    const delta = b - a
    if (Math.abs(delta) >= 8) fades.push({ from: start, to: end, delta })
    start = null
    end = null
  }
  for (const x of secData) {
    if (fadeSecs.has(x.t)) { if (start === null) start = x.t; end = x.t }
    else flush()
  }
  flush()
}
const inFade = new Set()
for (const f of fades) for (let s = f.from; s <= f.to; s += 1) inFade.add(s)

// ---- 先扣掉本片基线，再换算成 0-100 ----------------------------------------
// 为什么不能直接用绝对值：AI 生成的每一帧都有细微闪动（flicker），把整条的底噪抬高，
// 于是"对白日常"也会显得处处在动（实测 AI 短片平均 59、静止只占 1%，而真人片同样内容只有 37）。
// 做法：拿本片帧间差的中位数当基线，只有明显超过基线的部分才算运动。
const live = secData.filter((x) => !inFade.has(x.t))
const baseY = live.length ? med(live.map((x) => x.ydif)) : 1
// 基线两倍算"大动"；下限 4 是防止极干净的片子（基线接近 0）被一点点风吹草动刷满 100 分
const HI_REL = Math.max(4, baseY * 2)
const scoreOf = (y) => Math.min(100, Math.round((100 * Math.max(0, y - baseY)) / HI_REL))
for (const x of secData) x.score = inFade.has(x.t) ? null : scoreOf(x.ydif)

const liveScores = secData.filter((x) => x.score !== null).map((x) => x.score)
const avgScore = liveScores.length ? liveScores.reduce((a, b) => a + b, 0) / liveScores.length : 0
// "静"= 帧间差没比基线高出多少（不是绝对分数低）——这样 AI 片的 1% 会被纠正回来
const isStill = (x) => x.score !== null && x.ydif <= baseY * 1.25
const staticRatio = live.length ? live.filter(isStill).length / live.length : 0

// ---- 最动的时段：15 秒滑窗平均，互隔 ≥30 秒 ---------------------------------
const WIN = 15
const scoreAt = new Map(secData.map((x) => [x.t, x.score]))
const winOf = new Map()
for (const k of secs) {
  let sum = 0
  let n = 0
  for (let d = 0; d < WIN; d += 1) {
    const v = scoreAt.get(k + d)
    if (v !== undefined && v !== null) { sum += v; n += 1 }
  }
  if (n) winOf.set(k, sum / n)
}
const wKeys = [...winOf.keys()].sort((a, b) => a - b)
const localMax = []
for (const k of wKeys) {
  const v = winOf.get(k)
  const l = winOf.get(k - 1)
  const r = winOf.get(k + 1)
  if ((l === undefined || v >= l) && (r === undefined || v >= r)) localMax.push({ t: k, score: v })
}
localMax.sort((a, b) => b.score - a.score)
const peaks = []
for (const p of localMax) {
  if (peaks.every((c) => Math.abs(c.t - p.t) >= 30)) peaks.push(p)
  if (peaks.length >= TOP) break
}
peaks.sort((a, b) => a.t - b.t)

// ---- 静止段：连续 ≥5 秒 score < 8 ------------------------------------------
const stills = []
{
  let start = null
  for (const x of secData) {
    const quiet = isStill(x)
    if (quiet && start === null) start = x.t
    if (!quiet && start !== null) { if (x.t - start >= 5) stills.push({ from: start, to: x.t, dur: x.t - start }); start = null }
  }
  if (start !== null) {
    const end = secData[secData.length - 1].t
    if (end - start >= 5) stills.push({ from: start, to: end, dur: end - start })
  }
}

const kindOf = avgScore >= 40 ? '动作密集：打斗/跑跳/快剪'
  : avgScore < 15 && staticRatio > 0.5 ? '静态为主：对话/定场/PPT'
  : '动静交替：有铺垫有高潮'

if (asJson) {
  console.log(JSON.stringify({ bvid, title, duration, source: source.kind, fps: FPS, avgScore, staticRatio, kind: kindOf, peaks, stills, fades, perSec: secData.map((x) => ({ t: x.t, score: x.score, ydif: Number(x.ydif.toFixed(2)) })) }, null, 2))
  if (!keep && source.kind.startsWith('dash')) { try { fs.unlinkSync(source.file) } catch {} }
  process.exit(0)
}

console.log(`=== ${bvid} 「${title}」 ===`)
console.log(`  时长 ${fmt(duration)}   采样 ${FPS} fps（${frames.length} 帧）   画面源 ${source.kind}`)
console.log(`  平均运动 ${avgScore.toFixed(0)}/100   静止占比 ${(staticRatio * 100).toFixed(0)}%   → ${kindOf}`)
console.log(`  本片基线 ${baseY.toFixed(2)}（3 帧时间平滑后的底噪；AI 生成片会明显偏高，已扣除）\n`)

if (peaks.length) {
  console.log(`最动的 ${peaks.length} 个时段（每段 ${WIN} 秒）`)
  for (const p of peaks) {
    const bar = '█'.repeat(Math.max(1, Math.round((p.score / 100) * 24)))
    console.log(`  ${fmt(p.t)}–${fmt(p.t + WIN)}  ${String(Math.round(p.score)).padStart(3)}  ${bar}`)
  }
}

const longStill = stills.sort((a, b) => b.dur - a.dur).slice(0, 6).sort((a, b) => a.from - b.from)
if (longStill.length) {
  console.log('\n静止段（≥5 秒几乎不动：定场、对话、PPT、静止空镜）')
  for (const s of longStill) console.log(`  ${fmt(s.from)}–${fmt(s.to)}   ${s.dur} 秒`)
}

if (fades.length) {
  console.log('\n淡入淡出（整屏渐变，已从运动里剔除）')
  for (const f of fades.slice(0, 6)) {
    console.log(`  ${fmt(f.from)}–${fmt(f.to)}   平均亮度 ${f.delta > 0 ? '升' : '降'} ${Math.abs(f.delta).toFixed(0)}`)
  }
}

console.log('\n  怎么用：最动的地方通常是打斗/运镜/转场，和抽帧对得上"动的是什么"；')
console.log('          长静止段适合写"镜头停在那里"；动和响同时炸=真正的高潮。要逐秒数据加 --json。')

if (!keep && source.kind.startsWith('dash')) { try { fs.unlinkSync(source.file) } catch {} }

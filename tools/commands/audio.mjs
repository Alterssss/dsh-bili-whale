import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { apiGet } from '../lib/bili-api.mjs'
import { requireFfmpeg } from '../lib/ffmpeg.mjs'
import { credentialsPath, dshPath } from '../lib/paths.mjs'
// 下载 dash 音频也走交通守卫：否则这条请求不受预算/暂停保护（tests/traffic.test.mjs 会拦这个）
import { guardedFetch as fetch } from '../lib/traffic.mjs'
import {
  fmt, parseLoudness, parseSilence, perSecond, stats, detectJumps, findPeaks, classify, FLOOR, WIN,
} from '../lib/audio-parse.mjs'

// 沙箱里 spawnSync 的 pipe 会被拒（EPERM，匿名管道被禁），所以 stdout/stderr 走临时文件。
// 同 lib/capture.mjs 的思路；区别是这里 stderr 才是主输出（ffmpeg 的日志），成功时也要拿。
function capture(file, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-audio-'))
  const outPath = path.join(dir, 'stdout')
  const errPath = path.join(dir, 'stderr')
  const fds = []
  try {
    fds.push(fs.openSync(outPath, 'wx', 0o600), fs.openSync(errPath, 'wx', 0o600))
    const r = spawnSync(file, args, { timeout: 300000, windowsHide: true, stdio: ['ignore', ...fds] })
    for (const fd of fds.splice(0)) fs.closeSync(fd)
    return {
      status: r.status,
      error: r.error,
      signal: r.signal,
      stderr: fs.readFileSync(errPath, 'utf8'),
    }
  } finally {
    for (const fd of fds) { try { fs.closeSync(fd) } catch {} }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

// audio：声音的骨架（2026-11-21 加）
//   不给"说了什么"（那是 ASR 的事），给"什么时候安静、什么时候炸"：
//     ① 每秒响度曲线  ② 长时间静音段（停顿/留白）  ③ 突然变响的点（笑点/爆点/音效）
//   零模型、零依赖，只要有 ffmpeg。
//
// 用法: node audio.mjs --bvid BV… [--page 1] [--keep] [--top 8] [--json]

const argv = process.argv.slice(2)
const args = new Map()
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) args.set(a.slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true)
}
const bvid = args.get('bvid') && args.get('bvid') !== true ? String(args.get('bvid')) : null
if (!bvid) { console.error('audio 需要 --bvid BV…'); process.exit(2) }
const page = Number(args.get('page') ?? 1)
const keep = args.has('keep')
const asJson = args.has('json')

const FFMPEG = requireFfmpeg()
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const credPath = credentialsPath
let cred = {}
try { cred = JSON.parse(fs.readFileSync(credPath, 'utf8')) } catch {}
const cookie = cred.sessdata ? `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}` : ''
const H = { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bvid}`, cookie }

// fmt 从 lib/audio-parse.mjs 来

// ---- 元信息 ----------------------------------------------------------------
const view = await apiGet(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}&p=${page}`, H)
if (view.code !== 0) { console.error(`view 失败 code=${view.code} ${view.message ?? ''}`); process.exit(3) }
const { cid, title, duration } = view.data

// ---- 找音源：先复用 bili-watch 下过的原片，没有再下 dash 音频 ----------------
const shotsDir = dshPath('shots', 'video')
let source = null
try {
  const hit = fs.readdirSync(shotsDir).find((f) => f.startsWith(`${bvid}-${cid}-`) && f.endsWith('.mp4'))
  if (hit) source = { kind: '本地原片', file: path.join(shotsDir, hit) }
} catch {}

if (!source) {
  const play = await apiGet(
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&fnval=16&fourk=1`, H)
  const dash = play?.data?.dash
  const aud = dash?.audio?.[0] ?? dash?.dolby?.audio?.[0] ?? dash?.flac?.audio
  const url = aud?.baseUrl ?? aud?.base_url
  if (play.code !== 0 || !url) {
    console.error(`拿不到音频流（code=${play.code}）——有些视频要登录或只有视频流；可以先跑 bili-watch 下原片再试`)
    process.exit(4)
  }
  const dir = dshPath('shots', 'audio')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${bvid}-${cid}.m4a`)
  const r = await fetch(url, { headers: { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bvid}/` } })
  if (!r.ok) { console.error(`音频下载失败 HTTP ${r.status}`); process.exit(4) }
  const buf = Buffer.from(await r.arrayBuffer())
  fs.writeFileSync(file, buf)
  source = { kind: `dash 音频 ${(buf.length / 1048576).toFixed(1)} MB`, file }
}

// ---- ① 响度曲线（ebur128，每 100ms 一个 M 值）--------------------------------
let lastDiag = ''
function loudnessCurve(file) {
  const r = capture(FFMPEG, ['-hide_banner', '-nostats', '-loglevel', 'verbose', '-i', file, '-af', 'ebur128=framelog=verbose', '-f', 'null', '-'])
  if (r.error) { lastDiag = `启动 ffmpeg 失败（${r.error.code ?? r.error.message}）——沙箱禁了子进程？`; return [] }
  if (!r.stderr) { lastDiag = `ffmpeg 退出码 ${r.status}，日志是空的`; return [] }
  const { points, diag } = parseLoudness(r.stderr)
  if (diag) lastDiag = diag
  return points
}

// ---- ② 静音段（silencedetect）----------------------------------------------
function silenceSpans(file, noise = '-40dB', minDur = 1.2) {
  const r = capture(FFMPEG, ['-hide_banner', '-nostats', '-i', file,
    '-af', `silencedetect=noise=${noise}:d=${minDur}`, '-f', 'null', '-'])
  return parseSilence(r.stderr, duration)
}

const curve = loudnessCurve(source.file)
if (!curve.length) { console.error(`没解析到响度数据：${lastDiag || '这条可能没有音轨'}`); process.exit(5) }
const spans = silenceSpans(source.file)

// 每秒聚合 → 统计 → 突响 → 响度峰，全在 lib/audio-parse.mjs 里（纯函数，可测）
const { secs, loud } = perSecond(curve)
const { avg, maxDb, minDb, std } = stats(loud)
const jumps = detectJumps(loud, secs)
const peaks = findPeaks(loud, secs, Number(args.get('top') ?? 5))

const longSil = spans.filter((s) => s.dur >= 1.5).sort((a, b) => b.dur - a.dur).slice(0, 8)
const perMin = jumps.length / Math.max(1, duration / 60)
const kindOf = classify(std, perMin)

if (asJson) {
  console.log(JSON.stringify({ bvid, title, duration, source: source.kind, avg, maxDb, minDb, spans, jumps: jumps.slice(0, 20), perSec: secs.map((k) => ({ t: k, db: Math.round(loud.get(k)) })) }, null, 2))
  if (!keep && source.kind.startsWith('dash')) { try { fs.unlinkSync(source.file) } catch {} }
  process.exit(0)
}

console.log(`=== ${bvid} 「${title}」 ===`)
console.log(`  时长 ${fmt(duration)}   音源 ${source.kind}`)
console.log(`  平均 ${avg.toFixed(1)} LUFS   最响 ${maxDb.toFixed(1)}   最静 ${minDb.toFixed(1)}   动态范围 ${(maxDb - minDb).toFixed(1)} dB`)
console.log(`  起伏 ±${std.toFixed(1)} dB   突响 ${jumps.length} 次（${perMin.toFixed(1)} 次/分）   静音段 ${longSil.length} 段  → ${kindOf}`)
console.log(`  （动态范围单独看会骗人：BGM 铺满的剧情片最小值被抬高，十几 dB 也可能很"炸"；这里看起伏和突响密度）\n`)

if (peaks.length) {
  console.log(`最响的 ${peaks.length} 个时段（每段 ${WIN} 秒）`)
  const pLo = Math.max(FLOOR, Math.min(...peaks.map((p) => p.db)))
  const pSpan = Math.max(1, Math.max(...peaks.map((p) => p.db)) - pLo)
  for (const p of peaks) {
    const bar = '█'.repeat(Math.max(1, Math.round(((p.db - pLo) / pSpan) * 24)))
    console.log(`  ${fmt(p.t)}–${fmt(p.t + WIN)}  ${p.db.toFixed(1).padStart(6)}  ${bar}`)
  }
}

const showCurve = args.has('curve')
if (showCurve) {
  const bucketN = Math.max(1, Math.ceil(secs.length / 40))
  const buckets = []
  for (let i = 0; i < secs.length; i += bucketN) {
    const slice = secs.slice(i, i + bucketN).map((k) => loud.get(k))
    buckets.push({ t: secs[i], db: slice.reduce((a, x) => a + x, 0) / slice.length })
  }
  const lo = Math.max(FLOOR, minDb)
  const uspan = Math.max(1, maxDb - lo)
  console.log(`\n响度曲线（每格 ${bucketN} 秒；条越长越响）`)
  for (const b of buckets) {
    const ratio = (b.db - lo) / uspan
    const bar = '█'.repeat(Math.max(1, Math.round(ratio * 40)))
    const mark = b.db <= -45 ? '  ← 很安静' : b.db >= maxDb - 3 ? '  ← 最响' : ''
    console.log(`  ${fmt(b.t).padStart(6)}  ${b.db.toFixed(1).padStart(6)}  ${bar}${mark}`)
  }
}

if (longSil.length) {
  console.log('\n静音段（≥1.5 秒；音乐铺底时可能测不出来）')
  for (const s of longSil) console.log(`  ${fmt(s.from)}–${fmt(s.to)}   ${s.dur.toFixed(1)} 秒`)
}

jumps.sort((a, b) => b.delta - a.delta)
const topJ = jumps.slice(0, Number(args.get('jumps') ?? 3))
if (topJ.length) {
  console.log('\n突然变响（比前 3 秒高 ≥8dB：笑点、音效、BGM 进来）')
  for (const j of topJ) console.log(`  ${fmt(j.t)}   +${j.delta.toFixed(1)} dB   (到 ${j.db.toFixed(1)} LUFS)`)
}

console.log('\n  怎么用：响度峰 + 弹幕变密 = 那一段真的戳中了；两者错开时，响度是音乐、弹幕是画面；')
console.log('          长静音段适合写"停了两秒"这种细节。要整条曲线加 --curve。')
if (!keep && source.kind.startsWith('dash')) { try { fs.unlinkSync(source.file) } catch {} }

import { watchOptions } from '../lib/watch-options.mjs'
import { guardedFetch as fetch } from '../lib/traffic.mjs'
import { apiGet } from '../lib/bili-api.mjs'
// 让 agent 真"看"视频：取直链 → 下载 → ffmpeg 抽帧拼成一张九宫格 → 输出图片路径（再交给 read_image 看）
//
// 用法: node bili-watch.mjs <BV号> [列x行，默认 3x3] [outDir] [--from 8:10] [--to 10:00]
//   例: node bili-watch.mjs BV1iLYm6VET3            → 3x3 九宫格（全片）
//       node bili-watch.mjs BV1iLYm6VET3 4x4        → 16 格，看得更细
//       node bili-watch.mjs BV1iLYm6VET3 4x4 --from 8:00 --to 10:00   → 只抽这 2 分钟（7.5 秒一帧）
//
// 2026-11-02 加 --from/--to：整片均分对长视频太粗（18.6 分钟的片子 4x4 = 每 70 秒一帧），
//   正确用法是"debrief 概览全片 → 从字幕里挑 2-3 句关键话 → 对那几段用 --from/--to 放大"。
//   同时把时间码烧在每帧左上角，她看图就知道第几格是第几分钟。
//
// 依赖：ffmpeg（查找顺序见 lib/ffmpeg.mjs：$FFMPEG → PATH → bin/ → ~/.dsh/bili-whale/bin → 本机剪映）
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from '../lib/capture.mjs'
import { requireFfmpeg } from '../lib/ffmpeg.mjs'
import { dshPath } from '../lib/paths.mjs'
import { whaleDataPath, whaleStatePath } from '../lib/whale-home.mjs'


let FFMPEG
try { FFMPEG = requireFfmpeg() } catch (e) { console.error(String(e.message)); process.exit(2) }
let parsed
try { parsed = watchOptions(process.argv.slice(2), whaleStatePath('shots','video')) } catch(e) { console.error(e.message); process.exit(2) }
const {bvid,grid,outDir,tile:TILE,fromSec,toSec} = parsed
if (!bvid) { console.error('用法: node bili-watch.mjs <BV号> [列x行] [outDir] [--from 8:10] [--to 10:00]'); process.exit(2) }
const [cols, rows] = grid.split('x').map(Number)
if (!cols || !rows) { console.error('格子格式应是 3x3 这样'); process.exit(2) }
const N = cols * rows

const cred = JSON.parse(fs.readFileSync(whaleDataPath('credentials.json'), 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const H = { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}` }

const view = await apiGet(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, H)
if (view.code !== 0) { console.error(`view 失败 code=${view.code} ${view.message}`); process.exit(3) }
const { cid, title, duration, owner } = { ...view.data, owner: view.data.owner?.name }
console.log(`标题: ${title}`)
console.log(`UP: ${owner}   时长: ${duration}s   cid=${cid}`)

// 画质实测（2026-10-14）：html5 + qn=32 会被压到 360p（返回 quality=16，界面小字全糊）；
// 改 platform=pc + qn=80 可拿到 720p（返回 quality=64），依旧是普通 mp4 直链，不必碰 dash。
const p = await apiGet(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=1&platform=pc&high_quality=1`, H)
const url = p.data?.durl?.[0]?.url
if (!url) { console.error(`没拿到直链（code=${p.code} ${p.message ?? ""}）——有些视频要登录或只有 dash 流`); process.exit(4) }
const QN = { 16: '360P', 32: '480P', 64: '720P', 80: '1080P' }
console.log(`实际画质: ${QN[p.data.quality] ?? p.data.quality}`)

fs.mkdirSync(outDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const sheet = path.join(outDir, `${bvid}-${stamp}-${cols}x${rows}.jpg`)

// 2026-11-02 补：同一支片子换参数重抽时复用已有原片。
//   原来 --from/--to 每换一段就重下一遍（18 分钟 720p = 72MB），一轮夜跑能白烧几百 MB。
//   只复用 7 天内、大于 1MB 的同 BV 文件；想强制重下就先把旧 mp4 删掉。
// 2026-11-02 修：文件名带上 cid —— 多分P 视频换 P 时会复用错片（同名不同内容）。
const reused = (() => {
  try {
    const cands = fs.readdirSync(outDir)
      .filter((f) => f.startsWith(`${bvid}-${cid}-`) && f.endsWith('.mp4'))
      .map((f) => ({ f: path.join(outDir, f), s: fs.statSync(path.join(outDir, f)) }))
      .filter((x) => x.s.size > 1024 * 1024 && Date.now() - x.s.mtimeMs < 7 * 864e5)
      .sort((a, b) => b.s.mtimeMs - a.s.mtimeMs)
    return cands[0]?.f ?? null
  } catch { return null }
})()

let mp4
if (reused) {
  mp4 = reused
  console.log(`复用原片: ${path.basename(mp4)}  (${(fs.statSync(mp4).size / 1024 / 1024).toFixed(2)} MB，省一次下载)`)
} else {
  mp4 = path.join(outDir, `${bvid}-${cid}-${stamp}.mp4`)
  const r = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', range: 'bytes=0-' } })
  if (!r.ok) { console.error(`下载失败 HTTP ${r.status}`); process.exit(5) }
  // 2026-10-21 修（外部审计 #6）：原来是 Buffer.from(await r.arrayBuffer()) ——
  //   一条两小时 720p 视频就是 1–2GB 内存峰值 ✗ 改成流式写盘，内存占用恒定 ✓
  if (!r.body) { console.error('下载失败：响应没有 body'); process.exit(5) }
  const { pipeline } = await import('node:stream/promises')
  const { Readable } = await import('node:stream')
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(mp4))
  console.log(`已下载: ${mp4}  (${(fs.statSync(mp4).size / 1024 / 1024).toFixed(2)} MB)`)
}

// ── 取帧方式：优先"画面变化点"，不够再退回等间隔（2026-10-14 参考 K3 的做法）
// 画面变化由 ffmpeg 的 scene 过滤器给出：空跑一次，把 pts_time 抓出来，再从中均匀挑 N 个。
// 好处：等间隔会漏掉"只出现一两秒的关键画面"，画面变化点天然落在场景切换处。
function sceneTimes(file, th) {
  try {
    // 2026-11-02：段模式下只扫这一段（长视频能省掉大部分解码时间）
    const pre = SEG_START > 0 ? ['-ss', String(SEG_START)] : []
    const post = SEGMENTED ? ['-t', String(SEG_LEN)] : []
    const out = execFileSync(FFMPEG, ['-hide_banner', ...pre, '-i', file, ...post, '-vf',
      `select='gt(scene,${th})',metadata=print:file=-`, '-an', '-f', 'null', '-'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024, timeout: 600_000 })
    const ts = [...out.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1]))
    // 段模式下 pts 相对于段起点，补回绝对时间
    return [...new Set(ts)].map((t) => t + SEG_START).filter((t) => t > 0.2)
  } catch { return [] }
}
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const pickEvenly = (list, n) =>
  n <= 1 ? [list[0]] : Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))])

// ── 2026-11-02：--from/--to 只抽一段 ──
const SEG_START = Math.max(0, Math.min(fromSec ?? 0, duration))
const SEG_END = Math.max(SEG_START, Math.min(toSec ?? duration, duration))
const SEG_LEN = SEG_END - SEG_START
if (!(SEG_LEN > 0)) { console.error('时间段为空：--from 必须小于视频时长'); process.exit(2) }
if (SEG_LEN < N * 0.5) {
  console.error(`段太短：${SEG_LEN.toFixed(1)} 秒里抽 ${N} 帧（平均不到 0.5 秒一帧）——请缩小 grid 或放宽 --from/--to`)
  process.exit(2)
}
const SEGMENTED = fromSec !== null || toSec !== null
if (SEGMENTED) console.log(`只抽这一段: ${fmt(SEG_START)} → ${fmt(SEG_END)}（${SEG_LEN.toFixed(0)} 秒，每 ${(SEG_LEN / N).toFixed(1)} 秒一帧）`)

const uniform = Array.from({ length: N }, (_, i) => SEG_START + ((i + 0.5) * SEG_LEN) / N)
let times = uniform
let how = `等间隔（每 ${(SEG_LEN / N).toFixed(1)} 秒一帧）`
if (!process.argv.includes('--uniform')) {
  // 阈值阶梯：录屏/讲解类画面变化平缓，0.3 常只检出几处 → 逐级放宽
  let st = [], used = 0.3
  for (const th of [0.3, 0.15, 0.08]) { used = th; st = sceneTimes(mp4, th); if (st.length >= N) break }

  if (st.length > 0) {
    // 关键设计（2026-10-14 踩过两次才定）：
    //   ① 只按"变化点里均匀挑"会出事——转场全挤在开头，中段 50 秒一帧没有，叙事线直接断
    //   ② 只按等间隔会漏掉"只闪一两秒的关键画面"
    //   ⇒ 用**等间隔当骨架保证覆盖**，再把每帧**吸附到 ±半格内最近的变化点**（吸不到就保持等间隔）
    const half = SEG_LEN / N / 2
    let snapped = 0
    times = uniform.map((u) => {
      const near = st.filter((s) => Math.abs(s - u) <= half)
      if (!near.length) return u
      snapped += 1
      return near.reduce((b, s) => (Math.abs(s - u) < Math.abs(b - u) ? s : b), near[0])
    })
    how = `等间隔骨架（保覆盖）+ 吸附画面变化点（阈值 ${used} 检出 ${st.length} 处；${snapped}/${N} 帧吸到了变化点）`
  } else {
    how = `纯等间隔（阈值 0.08 也未检出变化 → 每 ${(SEG_LEN / N).toFixed(1)} 秒一帧）`
  }
}
console.log(`取帧方式: ${how}`)
console.log(`时间点  : ${times.map((t, i) => `${i + 1}=${fmt(t)}`).join('  ')}`)
console.log(`格号↔时间: ${times.map((t, i) => `第${i + 1}格=${fmt(t)}`).join(' · ')}（图上左上角也烧了这个时间）`)

// 抽帧：每个时间点各抽一张原始分辨率，再拼图——这样 SHEET 与 SUBS 干净地共用同一批帧
const tmp = path.join(outDir, `.frames-${stamp}`)
fs.mkdirSync(tmp, { recursive: true })
try {
  // 2026-11-02：把时间码烧在每帧左上角 —— 否则她看拼图不知道第几格是第几分钟
  // 字体用 Windows 自带的 consola.ttf（等宽，数字不会抖）；路径里的冒号在 filter 里要转义成 \:
  const FONT = 'C\\:/Windows/Fonts/consola.ttf'
  // 2026-11-02 实测：drawtext 的 text 里的冒号必须写成 \:（否则 filtergraph 把它当 option 分隔符，
  //   报 "No option name near '07:x=10…'"）。试过 4 种写法，只有 text='08\:07' 能过。
  const stampOf = (t) =>
    `drawtext=fontfile='${FONT}':text='${fmt(t).replace(/:/g, '\\:')}':x=10:y=10:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=6`
  times.forEach((t, i) => {
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', mp4,
      '-frames:v', '1', '-vf', stampOf(t), '-q:v', '2', path.join(tmp, `f${String(i).padStart(2, '0')}.jpg`)], { stdio: 'inherit' })
  })
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(tmp, 'f%02d.jpg'), '-vf',
    `scale=${TILE}:-1,tile=${cols}x${rows}`, '-frames:v', '1', sheet], { stdio: 'inherit' })
  if (!fs.existsSync(sheet)) throw new Error('九宫格没生成')
  console.log(`\nSHEET: ${sheet}`)
} catch (e) {
  console.error('ffmpeg 抽帧失败：' + e.message); process.exit(6)
}

// 字幕条版：裁掉画面、只留底部字幕带再放大，竖着拼 N 条。
// 依据（2026-10-14 实测）：这类"讲解型"视频字幕就是全部信息量，全画幅九宫格会把字幕压糊；
// 同样预算下只留字幕带，9 条字幕能全部读清。用的是同一批帧。
const subs = path.join(outDir, `${bvid}-${stamp}-subs.jpg`)
try {
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(tmp, 'f%02d.jpg'), '-vf',
    `crop=iw:ih*0.17:0:ih*0.83,scale=1280:-1,tile=1x${N}`, '-frames:v', '1', subs], { stdio: 'inherit' })
  if (fs.existsSync(subs)) console.log(`SUBS:  ${subs}\n（同一批帧的底部字幕带，竖排 ${N} 条）`)
} catch {
  console.log('（字幕条版生成失败，忽略——不影响 SHEET）')
}
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`（原片留着: ${mp4}；换参数重抽不必重新下载。加 --uniform 可强制等间隔）`)
console.log('（提示：这条视频若有官方字幕，先跑 `node bili.mjs subtitles <BV>` 更省也更准——' +
  '抽帧是给"字幕没官方轨、或要看画面/界面"的情况用的）')

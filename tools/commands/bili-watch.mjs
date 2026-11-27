import { writeTimecode } from '../lib/frame-timecode.mjs'
import { HOME } from '../lib/paths.mjs'
import { downloadVideo } from '../lib/video-download.mjs'
import { segmentFrames } from '../lib/video-frames.mjs'
import { watchOptions } from '../lib/watch-options.mjs'
import { guardedFetch as fetch } from '../lib/traffic.mjs'
import { apiGet } from '../lib/bili-api.mjs'
// 让 agent 真"看"视频：取直链 → 下载 → ffmpeg 抽帧拼成一张九宫格 → 输出图片路径（再交给 read_image 看）
//
// 用法: node bili-watch.mjs <BV号> [列x行=3x3] [outDir]
//   --from / --to     只抽这一段（秒数 / 12:34 / 1:02:03）
//   --full-download   强制整片下载后抽帧（默认直链分段取帧，不落原片）
//   --refresh         已有同名原片也重下（配合固定文件名 <bvid>-<cid>.mp4）
//   --uniform         纯等间隔，不做画面变化点吸附
//   --tile N          单格边长（240–1280，默认 720）
//   例: node bili-watch.mjs BV1iLYm6VET3            → 3x3 九宫格
//       node bili-watch.mjs BV1iLYm6VET3 4x4        → 16 格，看得更细
//
// 依赖：ffmpeg（查找顺序见 lib/ffmpeg.mjs：$FFMPEG → PATH → bin/ → ~/.dsh/bili-whale/bin → 本机剪映）
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from '../lib/capture.mjs'
import { requireFfmpeg } from '../lib/ffmpeg.mjs'
import { dshPath } from '../lib/paths.mjs'


let FFMPEG
try { FFMPEG = requireFfmpeg() } catch (e) { console.error(String(e.message)); process.exit(2) }
let parsed
try { parsed = watchOptions(process.argv.slice(2), dshPath('shots','video')) } catch(e) { console.error(e.message); process.exit(2) }
const {bvid,grid,outDir,tile:TILE} = parsed
if (!bvid) { console.error('用法: node bili-watch.mjs <BV号> [列x行=3x3] [outDir] [--from 8:10] [--to 10:00] [--full-download] [--refresh] [--uniform] [--tile 720]'); process.exit(2) }
const [cols, rows] = grid.split('x').map(Number)
if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols * rows > 64) { console.error('格子格式应是 3x3 这样'); process.exit(2) }
const N = cols * rows

const cred = JSON.parse(fs.readFileSync(path.join((HOME), '.bili-ai', 'credentials.json'), 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const H = { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}` }

const view = await apiGet(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, H)
if (view.code !== 0) { console.error(`view 失败 code=${view.code} ${view.message}`); process.exit(3) }
const { title, owner } = { ...view.data, owner: view.data.owner?.name }
const cid = view.data.pages?.[0]?.cid ?? view.data.cid
const duration = Number(view.data.pages?.[0]?.duration ?? view.data.duration)
if (!Number.isFinite(duration) || duration <= 0) { console.error('视频时长无效'); process.exit(3) }
const start = parsed.fromSec ?? 0
const end = Math.min(parsed.toSec ?? duration, duration)
const span = end - start
const ranged = parsed.fromSec !== undefined || parsed.toSec !== undefined
if (ranged && span < N * 0.5) {
  console.error('时间段为空或太短，请调整 --from / --to 或缩小格子')
  process.exit(2)
}
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
// 同一条视频（bvid + cid 一起作键，分P 与重新投稿都不会串）只留一份原片：
// 文件名固定，重复分析时按大小校验后复用。时间戳只用在输出图上。
// 这样既不会每次重跑都堆一个几十 MB 的 mp4，也让「要不要清原片」变成一个可选问题。
const mp4 = path.join(outDir, `${bvid}-${cid}.mp4`)
const sheet = path.join(outDir, `${bvid}-${stamp}-${cols}x${rows}.jpg`)

const tmp = path.join(outDir, '.frames-' + stamp)
fs.mkdirSync(tmp, {recursive:true})
const uniform = Array.from({length:N}, (_, i) => start + ((i + 0.5) * span) / N)
let times = uniform
let segmented = false
if (!parsed.fullDownload) {
  try {
    await segmentFrames({ffmpeg:FFMPEG,url,times:uniform,directory:tmp,duration,uniform:ranged || process.argv.includes('--uniform')})
    segmented = true
    console.log('取帧方式: 分段直取，覆盖第一分 P 的 ' + N + ' 个时间位置')
  } catch {
    console.log('分段抽帧未完成，尝试完整下载后抽帧')
  }
}
if (!segmented) {
  const source = p.data.durl[0]
  const expected = Number(source.size) || 0
  const have = fs.existsSync(mp4) ? fs.statSync(mp4).size : 0
  if (!parsed.refresh && have > 0 && (!expected || have === expected)) {
    console.log('复用上次下载: ' + mp4 + ' (' + (have / 1024 / 1024).toFixed(2) + ' MB；--refresh 可强制重下)')
  } else {
    try {
      const result = await downloadVideo(source, mp4, {headers:{'user-agent':UA,referer:'https://www.bilibili.com/'}})
      console.log('已下载: ' + mp4 + ' (' + (result.size / 1024 / 1024).toFixed(2) + ' MB)')
    } catch(error) {
      fs.rmSync(tmp,{recursive:true,force:true})
      console.error(error.message); process.exit(5)
    }
  }

  // ── 取帧方式：优先"画面变化点"，不够再退回等间隔（2026-10-14 参考 K3 的做法）
  // 画面变化由 ffmpeg 的 scene 过滤器给出：空跑一次，把 pts_time 抓出来，再从中均匀挑 N 个。
  // 好处：等间隔会漏掉"只出现一两秒的关键画面"，画面变化点天然落在场景切换处。
  function sceneTimes(file, th) {
    try {
      const out = execFileSync(FFMPEG, ['-hide_banner', '-i', file, '-vf',
        `select='gt(scene,${th})',metadata=print:file=-`, '-an', '-f', 'null', '-'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024, timeout: 600_000 })
      const ts = [...out.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1]))
      return [...new Set(ts)].filter((t) => t > 0.2)
    } catch { return [] }
  }
  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  const pickEvenly = (list, n) =>
    n <= 1 ? [list[0]] : Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))])

  let how = `等间隔（每 ${(span / N).toFixed(1)} 秒一帧）`
  if (!ranged && !process.argv.includes('--uniform')) {
    // 阈值阶梯：录屏/讲解类画面变化平缓，0.3 常只检出几处 → 逐级放宽
    let st = [], used = 0.3
    for (const th of [0.3, 0.15, 0.08]) { used = th; st = sceneTimes(mp4, th); if (st.length >= N) break }

    if (st.length > 0) {
      // 关键设计（2026-10-14 踩过两次才定）：
      //   ① 只按"变化点里均匀挑"会出事——转场全挤在开头，中段 50 秒一帧没有，叙事线直接断
      //   ② 只按等间隔会漏掉"只闪一两秒的关键画面"
      //   ⇒ 用**等间隔当骨架保证覆盖**，再把每帧**吸附到 ±半格内最近的变化点**（吸不到就保持等间隔）
      const half = duration / N / 2
      let snapped = 0
      times = uniform.map((u) => {
        const near = st.filter((s) => Math.abs(s - u) <= half)
        if (!near.length) return u
        snapped += 1
        return near.reduce((b, s) => (Math.abs(s - u) < Math.abs(b - u) ? s : b), near[0])
      })
      how = `等间隔骨架（保覆盖）+ 吸附画面变化点（阈值 ${used} 检出 ${st.length} 处；${snapped}/${N} 帧吸到了变化点）`
    } else {
      how = `纯等间隔（阈值 0.08 也未检出变化 → 每 ${(span / N).toFixed(1)} 秒一帧）`
    }
  }
  console.log(`取帧方式: ${how}`)
  console.log(`时间点  : ${times.map((t, i) => `${i + 1}=${fmt(t)}`).join('  ')}`)

}

// 抽帧：每个时间点各抽一张原始分辨率，再拼图——这样 SHEET 与 SUBS 干净地共用同一批帧
try {
  if (!segmented) times.forEach((t, i) => {
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', mp4,
      '-frames:v', '1', '-pix_fmt', 'yuvj420p', '-q:v', '2', path.join(tmp, `f${String(i).padStart(2, '0')}.jpg`)], { stdio: 'inherit' })
  })
  const inputs = ['-i',path.join(tmp,'f%02d.jpg')]
  const scale = `scale=${TILE}:-1,format=yuvj420p`
  const tile = `tile=${cols}x${rows}`
  let filters = ['-vf',scale+','+tile]
  if (ranged) {
    const stamps = times.map(t => [Math.floor(t / 60), Math.floor(t % 60)].map(n => String(n).padStart(2,'0')).join(':'))
    console.log('格号与时间 ' + stamps.map((t,i) => (i+1)+'='+t).join('  '))
    const digits = Math.max(...stamps.map(s => s.length))
    stamps.forEach((stamp,i) => writeTimecode(path.join(tmp,'stamp'+String(i).padStart(2,'0')+'.png'),stamp,digits,{scale:5,pad:6}))
    inputs.push('-i',path.join(tmp,'stamp%02d.png'))
    // 右下角：避开 UP 主水印与标题；半透明黑底保证亮画面也能读
    filters = ['-filter_complex',`[0:v]${scale}[base];[base][1:v]overlay=W-w-12:H-h-12,${tile}`]
  }
  execFileSync(FFMPEG, ['-y','-loglevel','error',...inputs,...filters,'-frames:v','1',sheet])
  if (!fs.existsSync(sheet)) throw new Error('九宫格没生成')
  console.log(`\nSHEET: ${sheet}`)
} catch (e) {
  fs.rmSync(tmp,{recursive:true,force:true}); console.error('ffmpeg 抽帧失败：' + e.message); process.exit(6)
}

// 字幕条版：裁掉画面、只留底部字幕带再放大，竖着拼 N 条。
// 依据（2026-10-14 实测）：这类"讲解型"视频字幕就是全部信息量，全画幅九宫格会把字幕压糊；
// 同样预算下只留字幕带，9 条字幕能全部读清。用的是同一批帧。
const subs = path.join(outDir, `${bvid}-${stamp}-subs.jpg`)
try {
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(tmp, 'f%02d.jpg'), '-vf',
    `crop=iw:ih*0.17:0:ih*0.83,scale=1280:-1,format=yuvj420p,tile=1x${N}`, '-frames:v', '1', subs], { stdio: 'inherit' })
  if (fs.existsSync(subs)) console.log(`SUBS:  ${subs}\n（同一批帧的底部字幕带，竖排 ${N} 条）`)
} catch {
  console.log('（字幕条版生成失败，忽略——不影响 SHEET）')
}
fs.rmSync(tmp, { recursive: true, force: true })
if (!segmented) console.log(`（原片留着: ${mp4}；换参数重抽不必重新下载。加 --uniform 可强制等间隔）`)
console.log('（提示：这条视频若有官方字幕，先跑 `node bili.mjs subtitles <BV>` 更省也更准——' +
  '抽帧是给"字幕没官方轨、或要看画面/界面"的情况用的）')

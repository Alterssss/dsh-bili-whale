// segment-watch.mjs —— LOCAL：只下需要的片段来抽帧（省 95% 流量）
// 新方法默认用；它失效才回退上游的「整片下载」，并报「新方法失效，请排查」。
//
// 原理差异：
//   上游  一次直链 → 整片落地（376MB）→ 本地抽九帧
//   这里  一次直链 → ffmpeg 远程 -ss/-t -c copy 只拉九小段（每段约 5–8 秒，共几 MB）→ 抽帧 → 删段
//
// 用法：node tools/local/segment-watch.mjs <BV> [grid=3x3] [--tile 720] [--outDir 目录]
// 输出：打印 SHEET: <jpg 路径>（跟上游 bili-watch 的格式一致，好让上层照旧解析）
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { dshPath } from '../lib/paths.mjs'
import { CONFIG } from './search-config.mjs'
import { recordTimeout } from './timeout-log.mjs'
import { RETRY_DELAY_MS } from './retry.mjs'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '../..')
const LIB = 'file:///' + path.join(REPO, 'tools/lib/').replace(/\\/g, '/')
let apiGet, signWbi, requireFfmpeg
try {
  ({ apiGet, signWbi } = await import(LIB + 'bili-api.mjs'))
  ;({ requireFfmpeg } = await import(LIB + 'ffmpeg.mjs'))
} catch (e) { console.error('依赖加载失败：' + e.message); process.exit(2) }

const argv = process.argv.slice(2)
const bvid = argv.find((a) => /^BV[0-9A-Za-z]{10}$/.test(a))
const grid = (argv.find((a) => /^\d+x\d+$/.test(a)) ?? '3x3').toLowerCase()
const tileIdx = argv.indexOf('--tile')
const TILE = tileIdx >= 0 ? Number(argv[tileIdx + 1]) : 720
const outIdx = argv.indexOf('--outDir')
const outDir = outIdx >= 0 ? argv[outIdx + 1] : path.join(HOME, '.dsh', 'shots', 'video')
if (!bvid) { console.error('用法：node segment-watch.mjs <BV> [3x3] [--tile 720]'); process.exit(2) }
const [cols, rows] = grid.split('x').map(Number)
const N = cols * rows
const SEG = Number(CONFIG.frameSegmentSeconds ?? 10)   // 段长统一从 search-config 读

const FFMPEG = requireFfmpeg()
const H = { 'user-agent': 'Mozilla/5.0', referer: `https://www.bilibili.com/video/${bvid}/` }

function cookieHeader() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(HOME, '.bili-ai/credentials.json'), 'utf8'))
    return ['SESSDATA=' + c.sessdata, 'bili_jct=' + c.bili_jct, c.buvid3 ? 'buvid3=' + c.buvid3 : ''].filter(Boolean).join('; ')
  } catch { return '' }
}

// 2026-10-29 修：每段 ffmpeg 必须设超时 —— 不设的话远程请求一卡就无限等（实测卡过十分钟）
const SEG_TIMEOUT_MS = 20 * 1000      // 单次 ffmpeg 调用上限（90 → 50 → 30）
const SEG_BUDGET_MS = 140 * 1000      // 每段总预算：所有尝试加起来超过它就放弃这段
const run = (args, opts = {}) => spawnSync(FFMPEG, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: SEG_TIMEOUT_MS, ...opts })

// 1) 元信息 + 直链（各一次请求）
const view = await apiGet(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, H, { noCache: true })
const d = view?.data ?? {}
// 合集只抽第一集）：
//   合集的 d.duration 是"全部集数加起来"（95 集 → 56 小时），
//   而流只下第一集的，按总时长算位置会全错。所以一律用 pages[0]。
const firstPage = d.pages?.[0]
const cid = firstPage?.cid ?? d.cid
const duration = Number(firstPage?.duration ?? d.duration ?? 0)
const isMulti = Number(d.videos ?? 1) > 1
if (!cid || !duration) { console.error('拿不到 cid/duration'); process.exit(4) }
const pu = await apiGet(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=1&platform=pc`, { ...H, cookie: cookieHeader() }, { noCache: true })
const url = pu?.data?.durl?.[0]?.url
if (!url) { console.error(`没拿到直链（code=${pu?.code}）`); process.exit(4) }

// 2) 九个小段（头中尾均分），每段 6 秒
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')
const tmp = path.join(outDir, `.seg-${bvid}-${stamp}`)
fs.mkdirSync(tmp, { recursive: true })
const headers = `Referer: https://www.bilibili.com/video/${bvid}/\r\nUser-Agent: Mozilla/5.0\r\n`

let bytes = 0
const frameFiles = []
let timeouts = 0
try {
  // 并发池：同时跑 CONC 段（默认 3 路，可在 search-config 里改）
  let CONC = Number(process.env.SEG_CONC ?? CONFIG.segmentConcurrency ?? 3)   // 读配置，环境变量可临时覆盖
  const jobs = Array.from({ length: N }, (_, i) => i)
  const results = new Array(N)

  async function oneSegment(i) {
    // 的取帧法：一次调用里同时留"段首帧"和"变化帧"
    //   select='eq(n,0)+gt(scene,0.1)'  → 第一帧必留，有变化点就顺带留下
    //   -frames:v 2 最多出两张；有第二张用变化帧，没有就用段首帧
    //   这样静态片段也不用再连一次去取中点
    const startedAt = Date.now()
    const overBudget = () => Date.now() - startedAt > SEG_BUDGET_MS
    // 2026-10-30 修：超时改用"耗时"判断 —— Windows 上被 kill 的进程退出码常常是 1 而不是 null，
    //   以前会把它当成"读流失败"，日志里记不到超时。
    const trackRun = (args) => {
      const t0 = Date.now()
      const r = run(args)
      const cost = Date.now() - t0
      const isTimeout = cost >= SEG_TIMEOUT_MS * 0.9
      if (isTimeout) {
        timeouts += 1
        recordTimeout(bvid, '抽帧', Math.round(SEG_TIMEOUT_MS / 1000)).catch(() => {})
        return { ok: false, timeout: true }
      }
      return { ok: r.status === 0, timeout: false }
    }

    const mid = (duration * (i + 0.5)) / N
    const start = Math.max(0, mid - SEG / 2)
    const prefix = path.join(tmp, `f${String(i).padStart(2, '0')}`)
    for (const f of fs.readdirSync(tmp)) if (f.startsWith(`f${String(i).padStart(2, '0')}`)) fs.rmSync(path.join(tmp, f), { force: true })

    let how = ''
    let size = 0

    // ① 直取：段首帧 + 变化帧，一次连接；失败或超时重试一次（）
    const directArgs = ['-y', '-loglevel', 'error', '-headers', headers, '-ss', start.toFixed(2), '-t', String(SEG), '-i', url,
      '-vf', `select='eq(n,0)+gt(scene,0.1)',scale=${TILE}:-1`, '-frames:v', '2', '-q:v', '2', `${prefix}_%d.jpg`]

    const tryAttempt = () => {
      for (const f of fs.readdirSync(tmp)) if (f.startsWith(`f${String(i).padStart(2, '0')}_`)) fs.rmSync(path.join(tmp, f), { force: true })
      const res = trackRun(directArgs)
      const first = `${prefix}_1.jpg`
      const second = `${prefix}_2.jpg`
      if (fs.existsSync(second) && fs.statSync(second).size > 3000) { how = '变化帧(直取)'; fs.renameSync(second, `${prefix}.jpg`); if (fs.existsSync(first)) fs.rmSync(first, { force: true }); return { ok: true, timeout: false } }
      if (fs.existsSync(first) && fs.statSync(first).size > 3000) { how = '段首帧'; fs.renameSync(first, `${prefix}.jpg`); return { ok: true, timeout: false } }
      return { ok: false, timeout: !!res?.timeout }
    }

    let firstTry = null
    if (!overBudget()) firstTry = tryAttempt()

    // 非超时失败 → 5 秒后重试一次；再错就不管（不再多重试）
    if (!how && !overBudget()) {
      if (firstTry?.timeout) console.log(`（第 ${i + 1} 段超时，重试一次）`)
      else console.log(`（第 ${i + 1} 段读流失败，${RETRY_DELAY_MS() / 1000} 秒后重试一次）`)
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS()))
      if (!overBudget()) {
        const second = tryAttempt()
        if (!how && !second?.timeout) console.log(`（第 ${i + 1} 段重试仍失败，放弃这一段）`)
      }
    }

    // ② 兜底：先下这 10 秒，再从落地文件里挑（还是"段首帧+变化帧"同一次）
    if (!how && !overBudget()) {
      const seg = path.join(tmp, `s${String(i).padStart(2, '0')}.mp4`)
      trackRun(['-y', '-loglevel', 'error', '-headers', headers, '-ss', start.toFixed(2), '-t', String(SEG), '-i', url, '-c', 'copy', seg])
      if (!fs.existsSync(seg) || fs.statSync(seg).size < 20000) {
        trackRun(['-y', '-loglevel', 'error', '-headers', headers, '-ss', start.toFixed(2), '-t', String(SEG), '-i', url, '-an', '-vf', `scale=${TILE}:-1`, seg])
      }
      if (fs.existsSync(seg) && fs.statSync(seg).size >= 20000) {
        size = fs.statSync(seg).size
        trackRun(['-y', '-loglevel', 'error', '-i', seg, '-vf', `select='eq(n,0)+gt(scene,0.1)',scale=${TILE}:-1`, '-frames:v', '2', '-q:v', '2', `${prefix}_%d.jpg`])
        const first = `${prefix}_1.jpg`
        const second = `${prefix}_2.jpg`
        if (fs.existsSync(second) && fs.statSync(second).size > 3000) { how = '变化帧(落地)'; fs.renameSync(second, `${prefix}.jpg`); if (fs.existsSync(first)) fs.rmSync(first, { force: true }) }
        else if (fs.existsSync(first) && fs.statSync(first).size > 3000) { how = '段首帧(落地)'; fs.renameSync(first, `${prefix}.jpg`) }
      }
    }

    const jpg = `${prefix}.jpg`
    if (!how || !fs.existsSync(jpg)) {
      const err = new Error(`第 ${i + 1} 段抽不出帧（重试后仍失败）`)
      err.frameFail = true
      throw err
    }
    return { jpg, how, size }
  }

  for (let k = 0; k < jobs.length; k += CONC) {
    const batch = jobs.slice(k, k + CONC)
    const done = await Promise.all(batch.map((i) => oneSegment(i).then((r) => [i, r])))
    for (const [i, r] of done) results[i] = r
  }

  for (const r of results) { bytes += r.size; frameFiles.push({ jpg: r.jpg, how: r.how }) }
  if (frameFiles.length !== N) throw new Error(`只抽到 ${frameFiles.length}/${N} 帧`)

  const sheet = path.join(outDir, `${bvid}-${stamp}-${grid}.jpg`)
  const r3 = run(['-y', '-loglevel', 'error', '-i', path.join(tmp, 'f%02d.jpg'), '-vf', `tile=${cols}x${rows}`, '-frames:v', '1', sheet])
  if (!fs.existsSync(sheet)) throw new Error('九宫格没拼出来')

  const hows = frameFiles.map((f) => f.how)
  const changed = hows.filter((h) => String(h).startsWith('变化帧')).length
  const landed = hows.filter((h) => String(h).includes('落地')).length
  const mode = landed > 0 ? `${landed} 段落地，共 ${(bytes / 1048576).toFixed(1)} MB` : '全程未落地（直取）'
  // 单集 5 分钟以内的短片九段挤在一起，并发只会互相挤 → 串行跑
  const SHORT_SERIAL = 300
  if (!isMulti && duration < SHORT_SERIAL && CONC > 1) { CONC = 1 }
  if (isMulti) console.log(`（合集 ${d.videos} P，只抽第一集，时长 ${duration}s）`)
  console.log(`取帧方式: 分段 ${SEG} 秒 × ${N} · ${changed}/${N} 帧挑到变化点 · ${mode}${timeouts ? ` · ⚠ 超时 ${timeouts} 次` : ''}`)
console.log(`SHEET: ${sheet}`)
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(0)
} catch (e) {
  fs.rmSync(tmp, { recursive: true, force: true })
  if (e && e.frameFail) {
    console.error(`抽帧失败：${bvid} —— ${String(e.message).slice(0, 120)}`)
    console.error('（文字部分已完成，这条视频没有画面帧；日记里要写明抽帧失败）')
    process.exit(7)
  }
  console.error('新下载方法失效，请进行排查：' + String(e.message).slice(0, 160))
  process.exit(1)
}

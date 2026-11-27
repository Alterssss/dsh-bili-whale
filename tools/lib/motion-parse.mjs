// motion 的解析层：把 ffmpeg 的 metadata 输出变成每秒运动分。
//
// 跟 audio-parse.mjs 同理：输入是字符串/数组，输出是数字，不碰网络和进程，
// 所以能脱离 ffmpeg 测试。命令文件（commands/motion.mjs）只负责取数据、调这些函数、排版。
//
// 从 commands/motion.mjs 抽出来的（2026-11-26），逻辑一字未改。

export const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }

export const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`

// signalstats + metadata=print 的输出长这样（每帧一段）：
//   frame:0    pts:0       pts_time:0
//   lavfi.signalstats.YDIF=0.123
//   lavfi.signalstats.YAVG=87.4
// 只有同时拿到 YDIF 的帧才算数（YAVG 缺了按 0 记，只影响淡入淡出判定）。
export function parseFrames(stdout) {
  const frames = []
  let cur = null
  let sawFrame = 0
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (line.startsWith('frame:')) { sawFrame += 1; if (cur && cur.YDIF !== undefined) frames.push(cur); cur = {}; continue }
    const m = line.match(/lavfi\.signalstats\.(YDIF|YAVG)=(-?[\d.]+)/)
    if (m && cur) cur[m[1]] = Number(m[2])
  }
  if (cur && cur.YDIF !== undefined) frames.push(cur)
  return {
    frames,
    diag: frames.length ? '' : (sawFrame ? `有 ${sawFrame} 个 frame: 行，但没解析到 YDIF` : '输出里没有 frame: 行'),
  }
}

// 按秒聚合：YDIF 取**中位数**。
// 雨、风扇、头发飘这类高频抖动会把平均值抬高，中位数能压掉。
export function bySecond(frames, fps) {
  const buckets = new Map()
  for (let i = 0; i < frames.length; i += 1) {
    const sec = Math.floor(i / fps)
    if (!buckets.has(sec)) buckets.set(sec, [])
    buckets.get(sec).push(frames[i])
  }
  const secs = [...buckets.keys()].sort((a, b) => a - b)
  return secs.map((s) => {
    const arr = buckets.get(s)
    return {
      t: s,
      ydif: med(arr.map((f) => f.YDIF)),
      yavg: arr.reduce((a, f) => a + (f.YAVG ?? 0), 0) / arr.length,
    }
  })
}

// 淡入淡出：整屏一起变 → 帧间差 ≈ 亮度变化量；有人/镜头在动时两者对不上。
// 逐秒判：亮度变化够大（≥3）+ 帧差与亮度变化接近（差值在 35% 以内）→ 这一秒是渐变。
export const FADE_MIN_DELTA = 3
export const FADE_REL = 0.35
export const FADE_MIN_ABS = 1.5
export const FADE_MIN_TOTAL = 8

export function detectFades(secData) {
  const fadeSecs = new Set()
  for (let i = 1; i < secData.length; i += 1) {
    const dY = secData[i].yavg - secData[i - 1].yavg
    const y = secData[i].ydif
    if (Math.abs(dY) >= FADE_MIN_DELTA && Math.abs(y - Math.abs(dY)) <= Math.max(FADE_MIN_ABS, Math.abs(dY) * FADE_REL)) {
      fadeSecs.add(secData[i].t)
    }
  }
  const fades = []
  let start = null
  let end = null
  const flush = () => {
    if (start === null) return
    const a = secData.find((z) => z.t === start)?.yavg ?? 0
    const b = secData.find((z) => z.t === end)?.yavg ?? 0
    const delta = b - a
    if (Math.abs(delta) >= FADE_MIN_TOTAL) fades.push({ from: start, to: end, delta })
    start = null
    end = null
  }
  for (const x of secData) {
    if (fadeSecs.has(x.t)) { if (start === null) start = x.t; end = x.t } else flush()
  }
  flush()
  const inFade = new Set()
  for (const f of fades) for (let s = f.from; s <= f.to; s += 1) inFade.add(s)
  return { fades, inFade, fadeSecs }
}

// 扣本片基线再换算成 0-100。
//
// 为什么不能直接用绝对值：AI 生成的每一帧都有细微闪动（flicker），把整条底噪抬高，
// 于是"对白日常"也会显得处处在动（实测 AI 短片平均 59、静止只占 1%，而真人片同样内容只有 37）。
// 做法：拿本片帧间差的中位数当基线，只有明显超过基线的部分才算运动。
//   基线两倍算"大动"；下限 4 是防止极干净的片子（基线接近 0）被一点风吹草动刷满 100 分。
export const HI_MIN = 4

export function scoreMotion(secData, inFade) {
  const live = secData.filter((x) => !inFade.has(x.t))
  const baseY = live.length ? med(live.map((x) => x.ydif)) : 1
  const HI_REL = Math.max(HI_MIN, baseY * 2)
  const scoreOf = (y) => Math.min(100, Math.round((100 * Math.max(0, y - baseY)) / HI_REL))
  for (const x of secData) x.score = inFade.has(x.t) ? null : scoreOf(x.ydif)
  const liveScores = live.map((x) => x.score)
  const avgScore = liveScores.length ? liveScores.reduce((a, b) => a + b, 0) / liveScores.length : 0
  // "静"= 帧间差没比基线高出多少（不是绝对分数低）——这样 AI 片的 1% 会被纠正回来
  const isStill = (x) => x.score !== null && x.ydif <= baseY * 1.25
  const staticRatio = live.length ? live.filter(isStill).length / live.length : 0
  return { baseY, HI_REL, live, avgScore, staticRatio, isStill }
}

// 最动的时段：15 秒滑窗平均，互隔 ≥30 秒。
export const WIN = 15
export const MIN_GAP = 30

export function peakWindows(secData, secs, top = 5) {
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
    // score 已经是"减去本片基线后"的量，0 分表示这一段根本没超过底噪。
    // 整片静止时每个点都是"局部最大"，不拦掉的话"最动的地方"会指向一堆静止段。
    if (p.score <= 0) break
    if (peaks.every((c) => Math.abs(c.t - p.t) >= MIN_GAP)) peaks.push(p)
    if (peaks.length >= top) break
  }
  peaks.sort((a, b) => a.t - b.t)
  return peaks
}

// 静止段：连续 ≥5 秒几乎不动（定场、对话、PPT、静止空镜）。
export const STILL_MIN = 5

export function stillSpans(secData, isStill) {
  const stills = []
  let start = null
  for (const x of secData) {
    const quiet = isStill(x)
    if (quiet && start === null) start = x.t
    if (!quiet && start !== null) { if (x.t - start >= STILL_MIN) stills.push({ from: start, to: x.t, dur: x.t - start }); start = null }
  }
  if (start !== null) {
    const end = secData[secData.length - 1].t
    if (end - start >= STILL_MIN) stills.push({ from: start, to: end, dur: end - start })
  }
  return stills
}

export function classify(avgScore, staticRatio) {
  if (avgScore >= 40) return '动作密集：打斗/跑跳/快剪'
  if (avgScore < 15 && staticRatio > 0.5) return '静态为主：对话/定场/PPT'
  return '动静交替：有铺垫有高潮'
}

// audio 的解析层：把 ffmpeg 的文本日志变成数字。
//
// 为什么要单独一个文件：这些函数的输入就是一段字符串，输出就是数组/Map，
// 不碰网络、不碰文件、不 spawn 进程 —— 也就是说**可以脱离 ffmpeg 测试**。
// 命令文件（commands/audio.mjs）只负责拿日志、调这些函数、排版输出。
//
// 从 commands/audio.mjs 抽出来的（2026-11-26），逻辑一字未改，只是搬了位置。

export const FLOOR = -70 // 静音底：-120.7 这类数字 clamp 到这里

export const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`

// ebur128 的逐帧输出：
//   [Parsed_ebur128_0 @ …] t: 12.3    TARGET:-23 LUFS    M: -22.4 S: -21.9     I: -23.1 LUFS ...
// 注意 `M:` 只在 `-loglevel verbose` 下才有（默认 info 只有最后一行汇总）。
// 静音帧给的是 -120.7 这种数字而不是 -inf，所以要 clamp 到 −70，否则整条曲线被拉平。
const LOUD_RE = /t:\s*([\d.]+)\s+TARGET:.*?M:\s*(-?(?:[\d.]+|inf))\s+S:\s*(-?(?:[\d.]+|inf))/g

export function parseLoudness(out) {
  const pts = []
  if (!out) return { points: pts, diag: '日志是空的' }
  LOUD_RE.lastIndex = 0
  let m
  while ((m = LOUD_RE.exec(out)) !== null) {
    const t = Number(m[1])
    const raw = m[2]
    const n = raw.includes('inf') ? FLOOR : Number(raw)
    const db = n < FLOOR ? FLOOR : n
    if (Number.isFinite(t)) pts.push({ t, db })
  }
  return { points: pts, diag: pts.length ? '' : `日志有 ${out.length} 字节，但没有一行响度（M:）` }
}

// silencedetect 的成对输出：
//   [silencedetect @ …] silence_start: 366.1
//   [silencedetect @ …] silence_end: 367.9 | silence_duration: 1.8
// 结尾处可能只有 start 没有 end → 用视频时长补齐。
export function parseSilence(out, duration) {
  const spans = []
  let start = null
  for (const line of String(out ?? '').split(/\r?\n/)) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/)
    if (s) { start = Number(s[1]); if (start < 0) start = 0; continue }
    const e2 = line.match(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/)
    if (e2 && start !== null) { spans.push({ from: start, to: Number(e2[1]), dur: Number(e2[2]) }); start = null }
  }
  if (start !== null) spans.push({ from: start, to: duration, dur: duration - start })
  return spans
}

// 每秒聚合：取该秒所有 M 值的**中位数**（不是平均）。
// 平均会被一声咳嗽拉高，中位数不会。
export function perSecond(curve) {
  const buckets = new Map()
  for (const p of curve) {
    const k = Math.floor(p.t)
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(p.db)
  }
  const secs = [...buckets.keys()].sort((a, b) => a - b)
  const loud = new Map()
  for (const k of secs) {
    const arr = buckets.get(k).sort((a, b) => a - b)
    loud.set(k, arr[Math.floor(arr.length / 2)])
  }
  return { secs, loud }
}

export function stats(loud) {
  const vals = [...loud.values()]
  if (!vals.length) return { avg: 0, maxDb: 0, minDb: 0, std: 0 }
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length
  const std = Math.sqrt(vals.reduce((a, v) => a + (v - avg) ** 2, 0) / vals.length)
  return { avg, maxDb: Math.max(...vals), minDb: Math.min(...vals), std }
}

// 突然变响：比前 3 秒均值高 8dB 以上，且绝对值不低（避免静音后恢复被误报）。
// 前 3 秒里沉默（-70）的点不计入基线，否则安静之后的正常说话会被判成爆炸。
export const JUMP_DB = 8
export const JUMP_FLOOR = -40

export function detectJumps(loud, secs) {
  const jumps = []
  for (const k of secs) {
    if (k < 3) continue
    const prev = [k - 1, k - 2, k - 3].map((x) => loud.get(x)).filter((x) => x !== undefined && x > FLOOR)
    if (prev.length < 2) continue
    const base = prev.reduce((a, b) => a + b, 0) / prev.length
    const now = loud.get(k)
    if (now - base >= JUMP_DB && now > JUMP_FLOOR) jumps.push({ t: k, delta: now - base, db: now })
  }
  return jumps
}

// 响度峰：15 秒滑动平均的局部最大，至少隔 30 秒，取最响的 N 个。
export const WIN = 15
export const MIN_GAP = 30

export function findPeaks(loud, secs, top = 5) {
  const vals = [...loud.values()]
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : FLOOR
  const winAvg = new Map()
  for (const k of secs) {
    const arr = []
    for (let d = 0; d < WIN; d++) { const v = loud.get(k + d); if (v !== undefined) arr.push(v) }
    if (arr.length) winAvg.set(k, arr.reduce((a, b) => a + b, 0) / arr.length)
  }
  const localMax = []
  const winKeys = [...winAvg.keys()].sort((a, b) => a - b)
  for (const k of winKeys) {
    const v = winAvg.get(k)
    const l = winAvg.get(k - 1)
    const rr = winAvg.get(k + 1)
    if ((l === undefined || v >= l) && (rr === undefined || v >= rr)) localMax.push({ t: k, db: v })
  }
  localMax.sort((a, b) => b.db - a.db)
  const peaks = []
  for (const p of localMax) {
    // 整片同响度（念稿、纯 BGM、全程静音）时每个点都是"局部最大"，但那不是峰。
    // 峰必须比全片均值更响，否则输出会变成一串平坦区的假峰。
    if (p.db <= avg) break
    if (peaks.every((c) => Math.abs(c.t - p.t) >= MIN_GAP)) peaks.push(p)
    if (peaks.length >= top) break
  }
  peaks.sort((a, b) => a.t - b.t)
  return peaks
}

// 一句话归类：靠「起伏」和「突响密度」两条一起判，单看动态范围会骗人
//（BGM 铺满的剧情片最小值被抬高，十几 dB 也可能很"炸"）。
export function classify(std, perMin) {
  if (std < 4 && perMin < 0.5) return '念稿/对谈：声音很平'
  if (std >= 6 && perMin >= 1.5) return '剧情/剪辑：有铺垫也有爆发'
  if (std >= 6) return '起伏大但爆发稀疏：长片/讲座/素材拼接'
  if (perMin >= 2) return '节奏快但幅度不大：口播/快剪'
  return '混合：有起伏但不极端'
}

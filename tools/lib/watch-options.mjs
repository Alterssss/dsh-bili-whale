// 抽帧选项解析 —— 2026-11-02 加 --from / --to（只抽一段）
//
// 为什么加：整片均分抽帧对长视频太粗（18.6 分钟的片子 4x4 = 每 70 秒一帧，快剪段落全丢）。
// 有了 --from/--to 就能"先概览全片、再对重点段放大"：同一支片子，重点段可以做到 7.5 秒一帧。
//
// 时间写法三种都认：89.5（秒）/ 12:34 / 1:02:03
function parseClock(value, flag) {
  if (value === undefined) return null
  const s = String(value).trim()
  if (!s) throw Error(`${flag} 需要一个时间（如 8:10 或 490 秒）`)
  if (/^\d+(\.\d+)?$/.test(s) && Number.isFinite(Number(s))) return Number(s)
  const parts = s.split(':').map(Number)
  if (!/^\d+(?::[0-5]\d){1,2}(?:\.\d+)?$/.test(s) || !Number.isFinite(parts[0] * 3600)) {
    throw Error(`${flag} 的时间格式应为 12:34 / 1:02:03 / 秒数`)
  }
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0]
}

export function watchOptions(args, defaultDir) {
  const positional = []
  let tile = 720
  let fromSec = null
  let toSec = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--tile' || arg.startsWith('--tile=')) {
      const value = arg === '--tile' ? args[++i] : arg.slice(7)
      tile = Number(value)
      if (!Number.isInteger(tile) || tile < 240 || tile > 1280) throw Error('--tile 必须是 240–1280 的整数')
    } else if (arg === '--from' || arg.startsWith('--from=')) {
      const raw = arg === '--from' ? args[++i] : arg.slice(7)
      if (raw === undefined || raw === '') throw Error('--from 后面需要一个时间（如 8:10）')
      fromSec = parseClock(raw, '--from')
    } else if (arg === '--to' || arg.startsWith('--to=')) {
      const raw = arg === '--to' ? args[++i] : arg.slice(5)
      if (raw === undefined || raw === '') throw Error('--to 后面需要一个时间（如 10:00）')
      toSec = parseClock(raw, '--to')
    } else if (!arg.startsWith('--')) positional.push(arg)
    else if (arg !== '--uniform' && arg !== '--full-download') throw Error('未知抽帧选项：' + arg)
  }
  if (fromSec !== null && toSec !== null && toSec <= fromSec) throw Error('--to 必须大于 --from')
  return {
    bvid: positional[0],
    grid: (positional[1] ?? '3x3').toLowerCase(),
    outDir: positional[2] ?? defaultDir,
    tile,
    ...(fromSec !== null && {fromSec}),
    ...(toSec !== null && {toSec}),
    ...(args.includes('--full-download') && {fullDownload:true}),
  }
}

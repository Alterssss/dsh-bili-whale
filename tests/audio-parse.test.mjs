import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fmt, parseLoudness, parseSilence, perSecond, stats, detectJumps, findPeaks, classify, FLOOR,
} from '../tools/lib/audio-parse.mjs'

// 真实 ffmpeg 的 ebur128=framelog=verbose 输出形状（-loglevel verbose 下每 100ms 一行）
const loudLine = (t, m, s = '-120.7') =>
  `[Parsed_ebur128_0 @ 0000021c] t: ${t.toFixed(1)}   TARGET:-23 LUFS    M: ${m} S:${s}     I: -23.1 LUFS       LRA:   0.0 LU`

test('parses M/S pairs from ebur128 verbose log', () => {
  const out = [loudLine(0.1, -22.4), loudLine(0.2, -21.0), 'unrelated line'].join('\n')
  const { points, diag } = parseLoudness(out)
  assert.equal(points.length, 2)
  assert.deepEqual(points[0], { t: 0.1, db: -22.4 })
  assert.equal(diag, '')
})

test('M:-inf and the -120.7 silence sentinel both clamp to the floor', () => {
  const out = [loudLine(1.0, '-inf'), loudLine(1.1, '-120.7'), loudLine(1.2, -55)].join('\n')
  const { points } = parseLoudness(out)
  assert.deepEqual(points.map((p) => p.db), [FLOOR, FLOOR, -55])
  // 关键：不 clamp 的话 -120.7 会把整条曲线的动态范围拉爆
  assert.ok(points.every((p) => p.db >= FLOOR))
})

test('empty or loudness-free logs report a diagnostic instead of silently returning nothing', () => {
  assert.match(parseLoudness('').diag, /空/)
  const r = parseLoudness('[silencedetect @ 1] silence_start: 1.2\n')
  assert.equal(r.points.length, 0)
  assert.match(r.diag, /没有一行响度/)
})

test('parses paired silence_start/silence_end lines', () => {
  const out = [
    '[silencedetect @ 1] silence_start: 366.1',
    '[silencedetect @ 1] silence_end: 367.9 | silence_duration: 1.8',
  ].join('\n')
  assert.deepEqual(parseSilence(out, 600), [{ from: 366.1, to: 367.9, dur: 1.8 }])
})

test('a trailing silence without silence_end is closed with the video duration', () => {
  const out = '[silencedetect @ 1] silence_start: 590.5\n'
  assert.deepEqual(parseSilence(out, 600), [{ from: 590.5, to: 600, dur: 9.5 }])
})

test('negative silence_start is clamped to zero', () => {
  const out = [
    '[silencedetect @ 1] silence_start: -0.2',
    '[silencedetect @ 1] silence_end: 2.0 | silence_duration: 2.2',
  ].join('\n')
  assert.equal(parseSilence(out, 10)[0].from, 0)
})

test('perSecond takes the median, so one cough does not lift the whole second', () => {
  const curve = [
    { t: 1.0, db: -30 }, { t: 1.1, db: -30 }, { t: 1.2, db: -30 },
    { t: 1.3, db: -30 }, { t: 1.4, db: -6 }, // 咳嗽
  ]
  const { secs, loud } = perSecond(curve)
  assert.deepEqual(secs, [1])
  assert.equal(loud.get(1), -30, '中位数应当是 -30，不是被咳嗽拉高的平均值')
})

test('stats reports average, extremes and spread', () => {
  const loud = new Map([[0, -40], [1, -20], [2, -30]])
  const s = stats(loud)
  assert.equal(s.avg, -30)
  assert.equal(s.maxDb, -20)
  assert.equal(s.minDb, -40)
  assert.ok(Math.abs(s.std - 8.1649) < 0.01)
})

test('a jump needs 8 dB over the previous 3s AND a loud absolute level', () => {
  // 安静 → 炸：算
  const a = new Map([[0, -45], [1, -45], [2, -45], [3, -20]])
  const ja = detectJumps(a, [0, 1, 2, 3])
  assert.equal(ja.length, 1)
  assert.equal(ja[0].t, 3)
  assert.equal(ja[0].delta, 25)

  // 同样跳 25 dB，但从静音恢复说话（绝对值仍低于 -40）：不算
  const b = new Map([[0, -70], [1, -70], [2, -70], [3, -55]])
  assert.equal(detectJumps(b, [0, 1, 2, 3]).length, 0, '静音之后的正常音量不该算爆炸')

  // 涨了 5 dB：不够
  const c = new Map([[0, -45], [1, -45], [2, -45], [3, -40]])
  assert.equal(detectJumps(c, [0, 1, 2, 3]).length, 0)
})

test('silent seconds are not used as the jump baseline', () => {
  // 前 3 秒全是 -70（沉默），第 4 秒 -35：只有 2 个有效基线点，不判为爆炸
  const m = new Map([[0, -70], [1, -70], [2, -35], [3, -35]])
  assert.equal(detectJumps(m, [0, 1, 2, 3]).length, 0)
})

test('findPeaks enforces the 15s window and the 30s minimum gap', () => {
  const loud = new Map()
  const secs = []
  for (let k = 0; k < 200; k += 1) {
    secs.push(k)
    loud.set(k, k >= 100 && k < 115 ? -15 : -40) // 只有 100–115 秒响
  }
  const peaks = findPeaks(loud, secs, 3)
  assert.equal(peaks.length, 1)
  assert.equal(peaks[0].t, 100)
  assert.ok(peaks[0].db > -25)
})

test('findPeaks keeps at most N peaks that are at least 30s apart', () => {
  const loud = new Map()
  const secs = []
  for (let k = 0; k < 400; k += 1) {
    secs.push(k)
    loud.set(k, -40)
  }
  // 两个响区，只隔 10 秒 → 只能留一个
  for (let k = 100; k < 115; k += 1) loud.set(k, -15)
  for (let k = 125; k < 140; k += 1) loud.set(k, -18)
  const peaks = findPeaks(loud, secs, 5)
  assert.equal(peaks.length, 1, '相隔不足 30 秒的两个峰应当合并成一个')
})

test('classify separates flat talk from explosive editing', () => {
  assert.match(classify(2, 0.1), /念稿/)
  assert.match(classify(9, 2.0), /剧情/)
  assert.match(classify(9, 0.2), /爆发稀疏/)
  assert.match(classify(3, 3.0), /节奏快/)
  assert.match(classify(5, 1.0), /混合/)
})

test('fmt renders mm:ss and pads both halves', () => {
  assert.equal(fmt(0), '00:00')
  assert.equal(fmt(6.9), '00:06')
  assert.equal(fmt(366.1), '06:06')
  assert.equal(fmt(3785), '63:05')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fmt, med, parseFrames, bySecond, detectFades, scoreMotion, peakWindows, stillSpans, classify,
  WIN, STILL_MIN, HI_MIN,
} from '../tools/lib/motion-parse.mjs'

// 真实 signalstats + metadata=print 的输出形状（-vf fps,tmix,signalstats,metadata=print:file=-）
const frameBlock = (i, ydif, yavg) => [
  `frame:${i}    pts:${i * 200000}       pts_time:${(i * 0.2).toFixed(3)}`,
  `lavfi.signalstats.YDIF=${ydif}`,
  `lavfi.signalstats.YAVG=${yavg}`,
].join('\n')

test('parses YDIF/YAVG pairs grouped by frame: markers', () => {
  const out = [frameBlock(0, '0.50', '80.1'), frameBlock(1, '1.25', '80.4')].join('\n')
  const { frames, diag } = parseFrames(out)
  assert.equal(frames.length, 2)
  assert.deepEqual(frames[0], { YDIF: 0.5, YAVG: 80.1 })
  assert.deepEqual(frames[1], { YDIF: 1.25, YAVG: 80.4 })
  assert.equal(diag, '')
})

test('frames without YDIF are dropped, and their absence is diagnosable', () => {
  const out = ['frame:0', 'lavfi.signalstats.YAVG=80', 'frame:1', 'lavfi.signalstats.YDIF=2', 'lavfi.signalstats.YAVG=81'].join('\n')
  const { frames } = parseFrames(out)
  assert.equal(frames.length, 1, '第一帧只有 YAVG，不算')
  assert.equal(frames[0].YDIF, 2)

  const empty = parseFrames('frame:0\nframe:1\n')
  assert.equal(empty.frames.length, 0)
  assert.match(empty.diag, /没解析到 YDIF/)

  const none = parseFrames('[info] nothing here')
  assert.match(none.diag, /没有 frame/)
})

test('bySecond groups frames by fps and takes the median YDIF', () => {
  const frames = [
    { YDIF: 0.2, YAVG: 10 }, { YDIF: 0.2, YAVG: 10 }, { YDIF: 9.0, YAVG: 10 }, // 1 秒 3 帧（fps=3）
    { YDIF: 2.0, YAVG: 20 }, { YDIF: 2.0, YAVG: 20 }, { YDIF: 2.0, YAVG: 20 },
  ]
  const secs = bySecond(frames, 3)
  assert.deepEqual(secs.map((s) => s.t), [0, 1])
  assert.equal(secs[0].ydif, 0.2, '一帧抖动不该抬高中位数')
  assert.equal(secs[1].ydif, 2)
  assert.equal(secs[1].yavg, 20)
})

test('detects a full-screen fade: brightness and frame diff move together', () => {
  // 亮度每秒 +4，帧差也正好 4 → 整屏一起变 = 渐变（从 t=0 的 50 到 t=4 的 66，共同侧变化 12）
  const secData = [50, 54, 58, 62, 66].map((yavg, i) => ({ t: i, ydif: 4, yavg }))
  const { fades, inFade } = detectFades(secData)
  assert.equal(fades.length, 1)
  assert.equal(fades[0].from, 1)
  assert.equal(fades[0].to, 4)
  assert.equal(fades[0].delta, 12)
  assert.deepEqual([...inFade].sort((a, b) => a - b), [1, 2, 3, 4])
})

test('subject motion is not mistaken for a fade: diff and brightness disagree', () => {
  // 亮度 +4，但帧差 10（人在动）→ 对不上，不算渐变
  const secData = [50, 54, 58, 62].map((yavg, i) => ({ t: i, ydif: 10, yavg }))
  assert.equal(detectFades(secData).fades.length, 0)
})

test('a fade shorter than 8 total brightness levels is discarded', () => {
  // 亮度只变了 3，帧差也是 3 → 逐秒满足，但整段 delta 不到 8
  const secData = [{ t: 0, ydif: 0, yavg: 50 }, { t: 1, ydif: 3, yavg: 53 }]
  assert.equal(detectFades(secData).fades.length, 0)
})

test('subtracting the film baseline is what makes AI footage score like live footage', () => {
  // 真人片：底噪 1.5。4.5 的帧差 = 明显在动
  const live = Array.from({ length: 20 }, (_, i) => ({ t: i, ydif: i === 10 ? 4.5 : 1.5, yavg: 80 }))
  const liveScore = scoreMotion(live, new Set())
  assert.equal(liveScore.baseY, 1.5)
  const livePeak = live[10].score
  assert.ok(livePeak >= 70, `真人片 4.5 应当得高分，实际 ${livePeak}`)

  // AI 片：底噪 6.3（每帧都在微抖）。同样 4.5 的帧差还**没到基线**，不算动
  const ai = Array.from({ length: 20 }, (_, i) => ({ t: i, ydif: i === 10 ? 4.5 : 6.3, yavg: 80 }))
  const aiScore = scoreMotion(ai, new Set())
  assert.equal(aiScore.baseY, 6.3)
  assert.equal(ai[10].score, 0, 'AI 片里 4.5 低于基线，必须判成"没动"')
  assert.ok(aiScore.staticRatio > 0.9, 'AI 片应当被判为绝大部分静止')
})

test('baseline floor keeps a spotless film from maxing out the scale', () => {
  // 底噪接近 0 的干净片子：一点点抖动不该刷出 100 分
  const clean = Array.from({ length: 10 }, (_, i) => ({ t: i, ydif: i === 5 ? 0.5 : 0, yavg: 80 }))
  scoreMotion(clean, new Set())
  assert.ok(clean[5].score <= 100)
  assert.equal(HI_MIN, 4)
  // 0.5 的帧差、基线为 0 → 100*0.5/4 = 12 分，没到满
  assert.equal(clean[5].score, 13)
})

test('faded seconds get no score at all', () => {
  const secData = [{ t: 0, ydif: 1, yavg: 50 }, { t: 1, ydif: 25, yavg: 60 }]
  scoreMotion(secData, new Set([1]))
  assert.equal(secData[1].score, null, '渐变段不算运动')
})

test('peakWindows averages over 15s and enforces a 30s gap', () => {
  const secData = []
  for (let t = 0; t < 120; t += 1) {
    secData.push({ t, score: t >= 40 && t < 55 ? 90 : 0 })
  }
  const peaks = peakWindows(secData, secData.map((s) => s.t), 5)
  assert.equal(peaks.length, 1, '整片只有一段在动，就只该报一个峰')
  assert.ok(Math.abs(peaks[0].t - 40) <= 2, `峰应当落在 40 秒附近，实际 ${peaks[0].t}`)
  assert.equal(WIN, 15)
})

test('an all-static film reports no peaks at all', () => {
  const secData = Array.from({ length: 60 }, (_, t) => ({ t, score: 0 }))
  assert.deepEqual(peakWindows(secData, secData.map((s) => s.t), 5), [])
})

test('stillSpans only reports runs of at least 5 seconds', () => {
  const still = (t) => ({ t, ydif: 1, score: 0 })
  const moving = (t) => ({ t, ydif: 50, score: 90 })
  const secData = [
    moving(0),
    still(1), still(2), still(3), still(4), still(5), still(6), // 6 秒 → 算
    moving(7),
    still(8), still(9), still(10), // 3 秒 → 不算
    moving(11),
  ]
  const isStill = (x) => x.score === 0
  const spans = stillSpans(secData, isStill)
  assert.equal(spans.length, 1)
  assert.deepEqual(spans[0], { from: 1, to: 7, dur: 6 })
  assert.equal(STILL_MIN, 5)
})

test('a still run reaching the end of the clip is closed with the last timestamp', () => {
  const secData = [{ t: 0, score: 90 }, ...[1, 2, 3, 4, 5, 6].map((t) => ({ t, score: 0 }))]
  const spans = stillSpans(secData, (x) => x.score === 0)
  assert.deepEqual(spans[0], { from: 1, to: 6, dur: 5 })
})

test('classify separates action-heavy from static footage', () => {
  assert.match(classify(55, 0.1), /动作密集/)
  assert.match(classify(10, 0.8), /静态为主/)
  assert.match(classify(25, 0.3), /动静交替/)
})

test('med and fmt behave', () => {
  assert.equal(med([3, 1, 2]), 2)
  assert.equal(med([4, 1, 3, 2]), 3)
  assert.equal(fmt(75), '01:15')
})

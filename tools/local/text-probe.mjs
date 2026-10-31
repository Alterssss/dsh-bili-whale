// text-probe.mjs —— LOCAL：字幕 / 评论 / 弹幕 三类探针，各 30 秒超时，失败返回空
// 2026-10-30：三类都 30s 超时，失败就给空，保证后续不炸；
//   某类读到空 → 这条视频评级降低（不全废，只是降级）。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 仓库位置按本文件位置反推，不写死本机路径
const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PROBE_TIMEOUT_MS = 30 * 1000
// 2026-10-30：不再用视频级总超时去杀字幕/评论（内部的每次请求已有 20 秒兜底）
export const PROBE_TOTAL_MS = 15 * 60 * 1000
// 2026-10-30：超时要落账（开关跟 timing.enabled 共用）
const timeoutLog = await import('./timeout-log.mjs')
const { withRetry } = await import('./retry.mjs')

/** 跑一条 bili 命令，超时/失败返回空串 */
function run(args, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let out = ''
    let done = false
    let killed = false
    const child = spawn(process.execPath, ['bili.mjs', ...args], { cwd: TOOLS, stdio: ['ignore', 'pipe', 'pipe'] })
    const finish = (v) => { if (!done) { done = true; resolve({ out: v, ms: Date.now() - t0, killed, status }) } }
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { out += d.toString() })
    const timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL') } catch {} finish('') }, timeoutMs)
    let status = null
    child.on('close', (code) => { status = code; clearTimeout(timer); finish(out) })
    child.on('error', () => { clearTimeout(timer); finish('') })
  })
}

// 2026-10-30 换掉假数据：原来探针调的是直播间弹幕（需要 --room），对视频无效。
//   这里改成按 cid 取旧版 XML 弹幕流（comment.bilibili.com/<cid>.xml），15 秒超时。
const LIB = 'file:///' + TOOLS.replace(/\\/g, '/') + '/lib/'
async function videoDanmaku(bvid, timeoutMs = 15000) {
  const t0 = Date.now()
  try {
    const { apiGet } = await import(LIB + 'bili-api.mjs')
    const { loadCred } = await import(LIB + 'cred.mjs').catch(() => ({ loadCred: null }))
    const H = { 'user-agent': 'Mozilla/5.0', referer: `https://www.bilibili.com/video/${bvid}/` }
    try {
      const c = loadCred?.()
      if (c?.sessdata) H.cookie = ['SESSDATA=' + c.sessdata, 'bili_jct=' + c.bili_jct].filter(Boolean).join('; ')
    } catch {}
    const v = await apiGet(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, H, { noCache: true })
    const cid = v?.data?.cid
    if (!cid) return { out: '', ms: Date.now() - t0 }
    const r = await Promise.race([
      fetch(`https://comment.bilibili.com/${cid}.xml`, { headers: H }).then((x) => (x.ok ? x.text() : '')),
      new Promise((res) => setTimeout(() => res(''), timeoutMs)),
    ])
    return { out: String(r || ''), ms: Date.now() - t0 }
  } catch { return { out: '', ms: Date.now() - t0 } }
}

const hasText = (s, minLen = 12) => String(s ?? '').replace(/\s+/g, '').length >= minLen
// 2026-10-30 修：原来的 /0 条/ 会误伤「10 条」→ 用数字边界；超时/失败在 run() 里已经返回空串
const looksMissing = (s) => /没有字幕|无字幕|拿不到|没有弹幕|没有评论|读取失败/.test(String(s ?? ''))
const zeroCount = (s) => /(?<!\d)0\s*条/.test(String(s ?? ''))

/**
 * 三类并行探针。返回：
 *   { sub, cmt, dm, subOk, cmtOk, dmOk, quality: 'A'|'B'|'C', missing: [...] }
 * quality：三样齐 = A；缺一样 = B；缺两样及以上 = C
 */
export async function probeText(bvid, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  // 三类都走统一重试（失败等 5 秒再来一次，再错就返回空）
  const wrap = (stage, fn) => withRetry({
    bv: bvid, stage, timeoutMs,
    attempt: async (ms) => {
      const r = await fn(ms)
      const n = (r && typeof r === 'object') ? r : { out: String(r ?? ''), ms: 0, status: 0 }
      // 2026-10-30 修：命令正常退出（status 0）就算成功——"这条视频没有字幕"是正常结果，
      //   以前把它当失败，导致没字幕的视频白等 5 秒再重试一遍。
      // 2026-10-30：区分「真没字幕」和「请求超时」——
      //   命令正常退出且有 SUBTITLES_TIMEOUT=1 标记 → 是超时，算失败要重试；
      //   正常退出且没有该标记 → 就是这条视频没字幕，算成功，不重试。
      const timedOutMark = String(n.out || '').includes('SUBTITLES_TIMEOUT=1')
      const normalExit = n.status === 0 && !n.killed
      const ok = normalExit && !timedOutMark
      return { ok, value: n, error: ok ? null : new Error(timedOutMark ? 'subtitle request timeout' : 'non-zero exit') }
    },
  }).then((x) => x.ok ? x.value : { out: '', ms: x.cost })

  const [subR, cmtR, dmR] = await Promise.all([
    wrap('字幕(含AI)', (ms) => run(['subtitles', bvid], PROBE_TOTAL_MS)),
    wrap('评论', (ms) => run(['comments', bvid, '--ps', '10', '--sort', 'hot'], PROBE_TOTAL_MS)),
    // 2026-10-30：弹幕没有就算了 —— 不为它等满 20 秒再重试，给 8 秒、不重试
    videoDanmaku(bvid, 8000),
  ])
  const sub = subR.out
  const cmt = cmtR.out
  const dm = dmR.out
  const ms = { sub: subR.ms, cmt: cmtR.ms, dm: dmR.ms }
  if (subR.killed) await timeoutLog.recordTimeout(bvid, '字幕(含AI)', Math.round(subR.ms / 1000))
  if (cmtR.killed) await timeoutLog.recordTimeout(bvid, '评论', Math.round(cmtR.ms / 1000))
  if (dmR.killed) await timeoutLog.recordTimeout(bvid, '弹幕', Math.round(dmR.ms / 1000))
  const subOk = hasText(sub) && !looksMissing(sub)
  const cmtOk = hasText(cmt) && !looksMissing(cmt) && !zeroCount(cmt)
  const dmOk = hasText(dm) && !looksMissing(dm) && !zeroCount(dm)
  const missing = []
  if (!subOk) missing.push('字幕')
  if (!cmtOk) missing.push('评论')
  if (!dmOk) missing.push('弹幕')
  const quality = missing.length === 0 ? 'A' : missing.length === 1 ? 'B' : 'C'
  return { sub, cmt, dm, subOk, cmtOk, dmOk, quality, missing, ms }
}

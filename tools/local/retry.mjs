// retry.mjs —— LOCAL：统一的"失败重试一次"逻辑（）
//   规则：跑一次 → 失败（超时或报错）→ 等 retryDelaySec 秒 → 重试一次 → 再错就放弃
//   超时判断用"耗时 ≥ timeoutMs 的 90%"（Windows 上被 kill 的退出码不可靠）
//   用到的场景：读字幕 / 读 AI 字幕 / 读评论 / 读弹幕 / 分段抽帧
import { CONFIG } from './search-config.mjs'
import { recordTimeout } from './timeout-log.mjs'

export const RETRY_DELAY_MS = () => Number(CONFIG.retryDelaySec ?? 5) * 1000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {object} o
 * @param {string} o.bv        哪条视频
 * @param {string} o.stage     阶段名（字幕 / 评论 / 弹幕 / 抽帧）
 * @param {number} o.timeoutMs 单次超时
 * @param {(ms:number)=>Promise<any>} o.attempt  执行一次；返回 {ok, value?, error?}
 */
export async function withRetry({ bv, stage, timeoutMs, attempt }) {
  const results = []
  for (let i = 0; i < 2; i += 1) {
    const t0 = Date.now()
    let r
    try { r = await attempt(timeoutMs) } catch (e) { r = { ok: false, error: e } }
    const cost = Date.now() - t0
    const timedOut = cost >= timeoutMs * 0.9
    results.push({ ...r, cost, timedOut })
    if (r?.ok) return { ok: true, value: r.value, cost, attempts: i + 1, timedOut: false }
    if (timedOut) { try { await recordTimeout(bv, stage, Math.round(timeoutMs / 1000)) } catch {} }
    if (i === 0) await sleep(RETRY_DELAY_MS())
  }
  const last = results[results.length - 1]
  return { ok: false, error: last?.error, cost: last?.cost ?? 0, attempts: results.length, timedOut: !!last?.timedOut }
}

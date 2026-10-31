// timeout-log.mjs —— LOCAL：超时记录（跟 timing.enabled 共用开关）
// 每次超时记下 bv / 标题 / 合集数 / 总时长 / 哪一项超时 / 超时几秒，
// 最后在收尾单独一行输出。开关关掉（timing.enabled=false）就什么都不写。
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const FILE = path.join(HOME, '.dsh/bili-whale/timeout-log.jsonl')
const TOOLS = path.join(HOME, 'Documents/deepseek-harness/default-workspace/dsh-bili-whale/tools')
const LIB = 'file:///' + TOOLS.replace(/\\/g, '/') + '/lib/'

let enabledCache = null
export function timingOn() {
  if (enabledCache !== null) return enabledCache
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HOME, '.dsh/bili-whale.config.json'), 'utf8'))
    enabledCache = j?.timing?.enabled !== false
  } catch { enabledCache = true }
  return enabledCache
}

const metaCache = new Map()
async function videoMeta(bv) {
  if (metaCache.has(bv)) return metaCache.get(bv)
  let m = { title: '', parts: 1, durMin: 0 }
  try {
    const { apiGet } = await import(LIB + 'bili-api.mjs')
    const H = { 'user-agent': 'Mozilla/5.0', referer: `https://www.bilibili.com/video/${bv}/` }
    const v = await Promise.race([
      apiGet(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, H, { noCache: true }),
      new Promise((r) => setTimeout(() => r(null), 5000)),
    ])
    const d = v?.data ?? {}
    m = {
      title: String(d.title ?? ''),
      parts: Number(d.videos ?? 1),
      durMin: Math.round(Number(d.duration ?? 0) / 60),
    }
  } catch {}
  metaCache.set(bv, m)
  return m
}

/** 记一次超时。stage: 字幕 / 评论 / 弹幕 / 抽帧 */
export async function recordTimeout(bv, stage, timeoutSec) {
  if (!timingOn()) return
  try {
    const m = await videoMeta(bv)
    const row = { at: new Date().toISOString(), bv, title: m.title, parts: m.parts, durMin: m.durMin, stage, timeoutSec }
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.appendFileSync(FILE, JSON.stringify(row) + '\n')
  } catch {}
}

/** 读某个时刻之后的记录 */
export function readTimeouts(sinceIso) {
  try {
    return fs.readFileSync(FILE, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter((r) => r && r.at >= sinceIso)
  } catch { return [] }
}

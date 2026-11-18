import { HOME } from './paths.mjs'
import {diagnose} from './diagnostics.mjs'
import { guardedFetch as fetch } from './traffic.mjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = u => String(u).split('/').at(-1).split('.')[0]

export function signWbi(params, images, now = Date.now()) {
  const raw = keyOf(images?.img_url ?? '') + keyOf(images?.sub_url ?? '')
  if (raw.length !== 64) throw new Error('WBI 签名密钥缺失，请稍后重试或检查登录状态')
  const key = MIXIN.map(i => raw[i]).join('').slice(0, 32)
  const values = { ...params, wts: Math.floor(now / 1000) }
  delete values.w_rid
  const query = Object.keys(values).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(values[k]).replace(/[!'()*]/g, ''))}`).join('&')
  return `${query}&w_rid=${crypto.createHash('md5').update(query + key).digest('hex')}`
}

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-22：三样保护（社区实测报告：B站 的 412 是 IP 级限流，换接口救不了）
//   ① 缓存    同一份元信息 24 小时内只问一次 B站
//   ② 退避    撞到 412/风控码就熔断一段时间，不再硬闯
//   ③ 节流    两次请求之间至少隔 300ms
// 背景数字：一轮「刷 5 条 + 深读 2~3」原本要打 25~30 次，而且同一条视频的
//   view 会被 recon/debrief/video/comments/subtitles/quota 各查一遍 ✗
// ─────────────────────────────────────────────────────────────────────────────
const CACHE_FILE = path.join(HOME, '.bili-ai', 'api-cache.json')
const BAN_FILE = path.join(HOME, '.bili-ai', 'api-ban.json')
const CACHE_TTL_MS = 24 * 3600 * 1000
// 2026-10-22：请求日志 —— 回答「这一趟到底打了几次网络、命中几次缓存」
//   主人问「她那次只查了一次缓存吗」✗ 当时只有「缓存写了几条」这个间接指标 ✗
//   日志按行追加：时间 命中/未命中 路径（不含 cookie、不含响应正文）
const REQ_LOG = path.join(HOME, '.bili-ai', 'api-requests.log')
const logReq = (hit, p) => {
  if (noCacheEnv()) return
  try { fs.appendFileSync(REQ_LOG, `${new Date().toISOString()} ${hit ? 'HIT ' : 'NET '} ${p}\n`) } catch(e) { diagnose('api-optional-write',e) }
}

// 只缓存「静态一点的元信息」✗ 动态内容（评论/收件箱/动态流/点赞）绝不能缓存 ✓
const CACHEABLE = [
  /^\/x\/web-interface\/(wbi\/)?view$/,           // 视频元信息
  /^\/x\/space\/wbi\/acc\/info$/,                 // 用户信息
  // 字幕/播放地址含短期授权，关注关系会变化，必须实时获取。
]
// nav 只缓存 10 分钟（wbi 密钥会轮换），别放进 CACHE_TTL 那套 ✓
const NAV_TTL_MS = 10 * 60 * 1000
// 风控码：撞到就熔断
const BAN_CODES = new Set([-412, -352, -799, -509, -10403])

// 播放接口的 -412 原因不能仅凭路径确定，按风控信号暂停。

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch(e) { if(e.code!=='ENOENT'){diagnose('api-state-read',e);if(file===BAN_FILE)throw Error('风控状态损坏，停止请求')}return fallback }
}
function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value))
  } catch(e) { diagnose('api-optional-write',e);if(file===BAN_FILE)throw Error('风控状态保存失败，停止请求') }
}

// 缓存键：去掉每次都变的签名参数（wts / w_rid）和排序，才可能命中 ✓
function cacheKey(url, headers) {
  const u = new URL(url)
  if (u.pathname === '/x/web-interface/view') u.pathname = '/x/web-interface/wbi/view'
  const params = [...u.searchParams.entries()]
    .filter(([k]) => k !== 'wts' && k !== 'w_rid')
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))
  const h = new Headers(headers)
  const account = crypto.createHash('sha256').update(h.get('cookie') ?? '').update('\0').update(h.get('authorization') ?? '').digest('hex')
  return account + ':' + u.hostname + u.pathname + '?' + new URLSearchParams(params).toString()
}
const cacheable = (url) => {
  const u = new URL(url)
  return u.hostname === 'api.bilibili.com' && CACHEABLE.some((re) => re.test(u.pathname))
}
const isNav = (url) => {
  const u = new URL(url)
  return u.hostname === 'api.bilibili.com' && u.pathname === '/x/web-interface/nav'
}

// 2026-10-22：BILI_NO_CACHE=1 → 关掉缓存与熔断（测试用；排障时也能强制走真网络）
const noCacheEnv = () => process.env.BILI_NO_CACHE === "1"   // 每次调用时读（测试里会中途设）

let lastRequestAt = 0
let requestQueue = Promise.resolve()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function throttle() {
  const turn = requestQueue.then(async () => {
    const gap = Date.now() - lastRequestAt
    if (gap < 300) await sleep(300 - gap)
    lastRequestAt = Date.now()
  })
  requestQueue = turn.catch(() => {})
  return turn
}

function bannedUntilNow() {
  const b = readJson(BAN_FILE, {})
  return Number(b.until ?? 0) > Date.now() ? Number(b.until) : 0
}
function setBan(ms, why) {
  writeJson(BAN_FILE, { until: Date.now() + ms, why, at: new Date().toISOString() })
}

// 说明：读失败仍返回 {code, message} 这种形状，让每个调用方自己决定
// 「元信息必需」还是「可选」。cookie 和响应正文永远不会进日志。
export async function apiGet(input, headers = {}, opts = {}) {
  const url = new URL(input)
  const ttl = opts.ttlMs ?? CACHE_TTL_MS
  const noCache = opts.noCache === true
  // ⚠️ 缓存键必须在【改写路径之前】就算好：
  //   「读」用的是原始 /x/web-interface/view?bvid=…，
  //   「写」如果等 url 被改成 /wbi/view?…&w_rid=…（每次都不同）就永远命中不了 ✗
  const key = cacheKey(url.href, headers)
  const canCache = cacheable(url.href) || isNav(url.href)
  const biliHost = url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com')
  // Only stable metadata may be served stale, for at most seven days. Never
  // return old nav identity, relations, or expiring media URLs during a ban.
  const stale = () => {
    if (noCache || noCacheEnv() || !cacheable(url.href)) return null
    const hit = readJson(CACHE_FILE, {})[key]
    return hit?.data?.code === 0 && Date.now() - Number(hit.at ?? 0) < 7 * CACHE_TTL_MS
      ? { ...hit.data, _cached: true, _stale: true } : null
  }

  // ① 熔断中：不再打网络，直接给「等多久」的清楚原因 ✗
  //    （除了 nav —— 它要用来刷新签名密钥，但熔断时也别打 ✓）
  const banned = noCacheEnv() || !biliHost ? 0 : bannedUntilNow()
  if (banned) {
    const mins = Math.max(1, Math.round((banned - Date.now()) / 60000))
    // 熔断期间：能吃到缓存就吃 ✓ 吃不到就明确失败 ✓
    const hit = stale()
    if (hit) return hit
    return { code: -412, message: `HTTP 412 —— 本机被 B站 限流了，约 ${mins} 分钟后自动恢复（期间用缓存过日子）` }
  }

  // ② 缓存命中
  if (!noCache && canCache && !noCacheEnv()) {
    const hit = readJson(CACHE_FILE, {})[key]
    const useTtl = isNav(url.href) ? NAV_TTL_MS : ttl
    if (hit && Date.now() - Number(hit.at ?? 0) < useTtl) { logReq(true, url.pathname); return { ...hit.data, _cached: true } }
  }

  try {
    const signedPaths = {
      '/x/web-interface/view': '/x/web-interface/wbi/view',
      '/x/player/playurl': '/x/player/wbi/playurl',
    }
    if (url.hostname === 'api.bilibili.com' && signedPaths[url.pathname]) {
      const nav = await apiGet('https://api.bilibili.com/x/web-interface/nav', headers, { noCache })
      if (!nav.data?.wbi_img) return { code: -1, message: `WBI 签名不可用：${nav.message || 'nav 未返回密钥'}` }
      url.pathname = signedPaths[url.pathname]
      url.search = signWbi(Object.fromEntries(url.searchParams), nav.data.wbi_img)
    }

    // ③ 节流：两次请求至少隔 300ms（贴脸连打正是被限流的典型特征 ✗）
    await throttle()
    if (biliHost && !noCacheEnv() && bannedUntilNow()) return stale() ?? { code: -412, message: 'B站风控退避中，请稍后重试' }

    logReq(false, url.pathname)
    const response = await fetch(url.href, { headers, signal: AbortSignal.timeout(30000) })

    // HTTP 412/429：平台级风控 → 熔断（默认 5 分钟，指数退避封顶 30 分钟）
    if (biliHost && (response.status === 412 || response.status === 429)) {
      const prev = readJson(BAN_FILE, {})
      const streak = Number(prev.streak ?? 0) + 1
      const mins = Math.min(30, 5 * 2 ** (streak - 1))
      if (!noCacheEnv()) setBan(mins * 60_000, `HTTP ${response.status}`)
      if (!noCacheEnv()) writeJson(BAN_FILE, { ...readJson(BAN_FILE, {}), streak, endpoint: url.pathname })
      const hit = stale()
      if (hit) return hit
      return { code: -412, message: `HTTP ${response.status}（B站 风控）—— 已熔断 ${mins} 分钟，别再打了` }
    }
    if (!response.ok) return { code: -1, message: `HTTP ${response.status}（B站风控或接口异常，请稍后重试；见 README 排障）` }

    const text = await response.text()
    let data
    try {
      data = JSON.parse(text)
      if (!data || typeof data !== 'object') throw new Error('invalid JSON payload')
    } catch {
      return { code: -1, message: `非 JSON 响应（HTTP ${response.status}），可能是风控或接口变更；见 README 排障` }
    }

    // 接口层风控码：同样熔断（B站 有时 HTTP 200 但 code=-412）
    if (biliHost && BAN_CODES.has(Number(data.code))) {
      const prev = readJson(BAN_FILE, {})
      const streak = Number(prev.streak ?? 0) + 1
      const mins = Math.min(30, 5 * 2 ** (streak - 1))
      if (!noCacheEnv()) writeJson(BAN_FILE, { until: Date.now() + mins * 60_000, why: `code=${data.code}`, at: new Date().toISOString(), streak, endpoint: url.pathname })
      return { ...data, message: `${data.message ?? ''}（B站 风控 ${data.code}）—— 已熔断 ${mins} 分钟` }
    }
    // 成功了：清掉退避计数，并写缓存
    if (Number(data.code) === 0) {
      const b = readJson(BAN_FILE, {})
      if (!noCacheEnv() && b.streak && b.endpoint === url.pathname) writeJson(BAN_FILE, { ...b, streak: 0 })
      if (!noCache && canCache && !noCacheEnv()) {
        const store = readJson(CACHE_FILE, {})
        store[key] = { at: Date.now(), data }
        // 缓存别无限长（保留最近 400 条）
        const keys = Object.keys(store)
        if (keys.length > 400) {
          keys.sort((a, b2) => Number(store[a].at ?? 0) - Number(store[b2].at ?? 0))
          for (const k of keys.slice(0, keys.length - 400)) delete store[k]
        }
        writeJson(CACHE_FILE, store)
      }
    }
    return data
  } catch (error) {
    return { code: -1, message: error.name === 'TimeoutError' ? '请求超时（30 秒）' : error.code === 'BILI_TRAFFIC_PAUSED' ? error.message : '请求失败（网络异常或 WBI 签名密钥无效）' }
  }
}

// 给「依赖体检 / 排障」用的现状
export function apiState() {
  const ban = readJson(BAN_FILE, {})
  const cache = readJson(CACHE_FILE, {})
  const until = Number(ban.until ?? 0)
  return {
    banned: until > Date.now(),
    banMinutesLeft: until > Date.now() ? Math.ceil((until - Date.now()) / 60000) : 0,
    banWhy: ban.why ?? null,
    cacheEntries: Object.keys(cache).length,
  }
}

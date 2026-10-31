// discover.mjs —— LOCAL：多入口找片器（只负责"上哪找 + 怎么筛"，不碰上游）
// 规则（2026-10-29 定）：
//   1) 默认走新路径；凑不够才由 round 兜底走老路径
//   2) 搜索侧时间窗梯次 3→7→30→365→730→1095 天，凑够就停
//   3) 筛选统一走 filter.mjs（看过没 / 质量下限 / 时间上限），新老入口共用一套
//   4) 配额：N ÷ 兴趣数；小于 1 的每个兴趣先给 1；带小数取整数
//   5) 每个兴趣按配额随机抽（不是永远抽最高的）
//   6) 热搜保底：至少 minHotCount 条热搜来源；热搜不够就保持实际数，
//      差额用兴趣池随机补回，总数仍是 N
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG } from './search-config.mjs'
import { filterList, makeSeenSet } from './filter.mjs'
import { VideoItem } from './video-entry.mjs'
import { cv } from './bw-config.mjs'
import { dshPath, configPath, homePath } from '../lib/paths.mjs'

// 仓库位置按本文件位置反推，不写死本机路径
const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(here, '../..')
const BILI = homePath('.bili-ai')
const LOGDIR = dshPath('whale-work', 'discover-logs')

const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const argsAll = (k) => argv.reduce((a, v, i) => (v === k && argv[i + 1] ? a.concat(argv[i + 1]) : a), [])
const N = Number(argOf('--n') ?? 10)
const JSON_ONLY = argv.includes('--json')
const MIN_HOT = Number(argOf('--min-hot') ?? CONFIG.minHotCount)

const LIB = 'file:///' + path.join(REPO, 'tools/lib/').replace(/\\/g, '/')
const { apiGet, signWbi } = await import(LIB + 'bili-api.mjs')

function cookieHeader() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(BILI, 'credentials.json'), 'utf8'))
    return ['SESSDATA=' + c.sessdata, 'bili_jct=' + c.bili_jct, c.buvid3 ? 'buvid3=' + c.buvid3 : ''].filter(Boolean).join('; ')
  } catch { return '' }
}
const H = { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/', cookie: cookieHeader() }

// 偏好词来源（2026-10-30 修）：先读配置文件里的 preferences.like
//   —— 那才是设置页/命令行改的那份；日记里的「爱看」只作老格式兜底
function prefsFromConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const like = j?.preferences?.like
    if (Array.isArray(like) && like.length) return like.map((s) => String(s).trim()).filter(Boolean)
  } catch {}
  try {
    const t = fs.readFileSync(dshPath('whale-diary.md'), 'utf8')
    const m = t.match(/^-\s*\*\*爱看\*\*：(.+)$/m)
    if (m) return m[1].split(/[·、,，]/).map((s) => s.trim()).filter(Boolean)
  } catch {}
  return []
}
const KEYWORDS = argsAll('--kw').length ? argsAll('--kw') : prefsFromConfig()
if (!KEYWORDS.length) { console.error('没有偏好词：用 --kw，或改配置文件（bili-whale.config.json）的 preferences.like'); process.exit(2) }

const SEEN = (() => {
  let diary = ''
  try { diary = fs.readFileSync(dshPath('whale-diary.md'), 'utf8') } catch {}
  const extra = []
  try { extra.push(fs.readFileSync(path.join(BILI, 'audit.md'), 'utf8').match(/\bBV[0-9A-Za-z]{10}\b/g) ?? []) } catch {}
  for (const f of ['favorites.json', 'feedback.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(BILI, f), 'utf8'))
      for (const x of (j.items ?? [])) if (x?.bv) extra.push([x.bv])
      for (const e of (j.events ?? [])) if (e?.bv) extra.push([e.bv])
    } catch {}
  }
  return makeSeenSet(diary, extra)
})()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shuffle = (a) => { const x = a.slice(); for (let i = x.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]] } return x }
// 2026-10-30：搜索/榜单结果统一装进 VideoItem，时长和 UP 都随对象走
const fmt = (r, extra = {}) => new VideoItem({
  bv: r.bvid ?? r.bv,
  title: r.title,
  play: r.play ?? r.stat?.view,
  dm: r.danmaku ?? r.stat?.danmaku,
  dur: r.duration,
  parts: 1,
  up: r.author ?? r.owner?.name,
  pubdate: r.pubdate ? new Date(Number(r.pubdate) * 1000).toISOString().slice(0, 10) : '',
  // 2026-10-31：view 接口的 tname 现在是空的，分区名改从搜索结果的 typename 拿
  region: r.typename ?? r.tname ?? '',
  ...extra,
})

// 2026-10-31：没有登录凭据时给明确的提示，而不是让 WBI 报一个看不懂的错。
//   远端用户刚装好、还没登录，这是最常见的第一步卡点。
const NEED_LOGIN_HINT = '未检测到 B站 登录凭据（~/.bili-ai/credentials.json）。\n' +
  '  请先在插件设置页登录（或粘贴 Cookie），再运行本轮。\n' +
  '  体检命令：node bili.mjs deps'
if (!H.cookie) {
  console.error(NEED_LOGIN_HINT)
  process.exit(3)
}

const nav = await apiGet('https://api.bilibili.com/x/web-interface/nav', H, { noCache: true })
const wbiImg = nav?.data?.wbi_img
if (!wbiImg) {
  // 拿到 nav 但没有 wbi：多半是登录态失效（未登录/风控时 B站 会返回 code=-1）
  console.error('登录态似乎已失效（nav code=' + (nav?.code ?? '?') + '）。')
  console.error(NEED_LOGIN_HINT)
  process.exit(3)
}
const now = Math.floor(Date.now() / 1000)

async function searchPage(kw, days, page) {
  const q = signWbi({ search_type: 'video', keyword: kw, order: 'click', page, page_size: 20, pubtime_begin_s: now - days * 86400, pubtime_end_s: now }, wbiImg)
  try {
    const j = await apiGet('https://api.bilibili.com/x/web-interface/wbi/search/type?' + q, H, { noCache: true })
    return (j?.data?.result ?? []).filter((x) => x.bvid).map(fmt)
  } catch { return [] }
}

// ── 第一段：按兴趣搜（先筛，不够就降级窗口）──────────────────────
const K = KEYWORDS.length
const base = Math.floor(N / K)
const QUOTA = base >= 1 ? base : 1
const takenBvs = new Set()
const picked = []
const trace = []
const warnings = []

for (const kw of KEYWORDS) {
  const pool = []
  for (const days of CONFIG.windows) {
    if (pool.length >= CONFIG.perKeywordPool) break
    for (let page = 1; page <= 2; page += 1) {
      const raw = await searchPage(kw, days, page)
      if (!raw.length) break
      const { passed } = filterList(raw, { seen: SEEN, maxAgeDays: days })
      for (const r of passed) {
        if (takenBvs.has(r.bv) || pool.some((p) => p.bv === r.bv)) continue
        pool.push(r.withPool(kw, days))
      }
      await sleep(600)
      if (pool.length >= CONFIG.perKeywordPool) break
    }
  }
  const take = shuffle(pool).slice(0, QUOTA)
  for (const r of take) { takenBvs.add(r.bv); picked.push(r) }
  trace.push({ kw, 候选: pool.length, 取: take.length, 配额: QUOTA })
  if (pool.length === 0) warnings.push(`兴趣词「${kw}」在所有时间窗里都没搜到够格的视频 —— 建议换一个更准的标签`)
}

// ── 第二段：热搜保底（先筛，再汇总）──────────────────────────────
let hotCount = 0
const needHot = MIN_HOT > 0 && N > K ? MIN_HOT : 0
if (needHot > 0 || picked.length < N) {
  const rawHot = []
  try {
    const j = await apiGet('https://api.bilibili.com/x/web-interface/popular?pn=1&ps=20', H, { noCache: true })
    for (const it of (j?.data?.list ?? [])) rawHot.push(fmt(it, { kw: '热门', window: '热搜' }))
  } catch {}
  await sleep(500)
  try {
    const j = await apiGet('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', H, { noCache: true })
    for (const it of (j?.data?.list ?? [])) rawHot.push(fmt(it, { kw: '排行', window: '热搜' }))
  } catch {}

  const shuffled = shuffle(rawHot)
  const hotTaken = []
  // 2026-10-29：缺口大于 minHotCount 时按缺口补，热搜数可以多于保底数
  const want = Math.max(needHot, N - picked.length)
  for (const maxDays of CONFIG.filterWindows) {
    if (hotTaken.length >= want) break
    const { passed } = filterList(shuffled, { seen: SEEN, maxAgeDays: maxDays })
    for (const r of passed) {
      if (hotTaken.length >= want) break
      if (takenBvs.has(r.bv)) continue
      hotTaken.push(r); takenBvs.add(r.bv)
    }
  }
  for (const r of hotTaken) picked.push(r)
  hotCount = hotTaken.length
  trace.push({ 来源: '热搜', 要: want, 实得: hotCount, 可选: rawHot.length })
}

// ── 补分P信息（2026-10-30）：合集的播放量要按「总播放 ÷ 分P」算，
//    所以对选中的这一批（最多 N 条）各查一次 view，拿 videos 数和单集时长
for (const it of picked.slice(0, N)) {
  try {
    const v = await apiGet('https://api.bilibili.com/x/web-interface/view?bvid=' + it.bv, H, { noCache: true })
    const dd = v?.data ?? {}
    if (Number(dd.videos) > 1) {
      it.parts = Number(dd.videos)
      it.totalPlay = Number(dd.stat?.view ?? it.totalPlay ?? 0)
      it.durSec = Number(dd.pages?.[0]?.duration ?? it.durSec)   // 单集时长
    }
  } catch {}
  await sleep(350)
}

// ── 合集限流（2026-10-31）────────────────────────────────────
//   一轮里合集（分P > bw_cfg_multiPartThreshold）允许出现 bw_cfg_multiPartPerRound 个，
//   超过就把后面的合集直接筛掉。每轮由 round 重置计数。
let multiPartSeen = 0
{
  const TH = cv('multiPartThreshold')
  const MAX = cv('multiPartPerRound')
  const kept = []
  for (const it of picked) {
    const isMulti = Number(it.parts ?? 1) > TH
    if (isMulti) {
      if (multiPartSeen >= MAX) { trace.push({ 筛掉: it.bv, 原因: '本轮合集数已达上限 ' + MAX }); continue }
      multiPartSeen += 1
    }
    kept.push(it)
  }
  picked.length = 0
  picked.push(...kept)
}

// ── 第三段：不够 N 用兴趣池随机补回（保持总数 N）─────────────────
let refill = 0
if (picked.length < N) {
  const extraPool = []
  for (const kw of KEYWORDS) {
    for (const days of CONFIG.windows) {
      if (extraPool.length >= 12) break
      const raw = await searchPage(kw, days, 1)
      const { passed } = filterList(raw, { seen: SEEN, maxAgeDays: days })
      for (const r of passed) {
        if (takenBvs.has(r.bv) || extraPool.some((p) => p.bv === r.bv)) continue
        extraPool.push(r.withPool(kw, days))
      }
      await sleep(500)
    }
  }
  for (const r of shuffle(extraPool)) {
    if (picked.length >= N) break
    if (takenBvs.has(r.bv)) continue
    takenBvs.add(r.bv); picked.push(r); refill += 1
  }
  trace.push({ 来源: '兴趣补位', 取: refill })
}

const result = {
  at: new Date().toISOString(), n: N, keywords: KEYWORDS, quota: QUOTA,
  minHotCount: MIN_HOT, hotActual: hotCount,
  windows: CONFIG.windows, filterWindows: CONFIG.filterWindows,
  shortfall: Math.max(0, N - picked.length),
  warnings,
  trace, items: picked.slice(0, N).map((x) => (typeof x.toJSON === 'function' ? x.toJSON() : x)),
}

if (JSON_ONLY) console.log(JSON.stringify(result, null, 2))
else {
  console.log('[本轮参数]')
  console.log(`  N              ${N}`)
  console.log(`  兴趣词(${K})       ${KEYWORDS.join(' · ')}`)
  console.log(`  每词配额        ${QUOTA}`)
  console.log(`  minHotCount    ${MIN_HOT}（实际热搜 ${hotCount} 条）`)
  console.log(`  搜索侧时间      ${CONFIG.windows.join(' → ')} 天`)
  console.log(`  筛选侧时间      ${CONFIG.filterWindows.join(' → ')} 天`)
  console.log(`  质量下限        播放 ≥ ${CONFIG.minPlay} 且 弹幕 ≥ ${CONFIG.minDm}`)
  console.log('')
  for (const t of trace) {
    if (t.kw) console.log(`  ${t.kw}: 候选 ${t.候选} → 取 ${t.取}（配额 ${t.配额}）`)
    else console.log(`  ${t.来源}: ${Object.entries(t).filter(([k]) => k !== '来源').map(([k, v]) => `${k} ${v}`).join(' · ')}`)
  }
  if (warnings.length) {
    console.log('⚠ 需要你处理的警告：')
    for (const w of warnings) console.log('   · ' + w)
    console.log('')
  }
  picked.slice(0, N).forEach((r, i) => {
    const src = r.window === '热搜' ? `热搜·${r.kw}` : `${r.window}天·${r.kw}`
    console.log(`${String(i + 1).padStart(2)}. ${r.bv}  ${String(r.play).padStart(9)} 播放  ${r.pubdate}  【${src}】  ${String(r.title).slice(0, 40)}`)
  })
}

try {
  fs.mkdirSync(LOGDIR, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')
  fs.writeFileSync(path.join(LOGDIR, `discover-${stamp}.json`), JSON.stringify(result, null, 2))
} catch {}

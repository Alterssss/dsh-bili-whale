import { HOME } from '../lib/paths.mjs'
import { latestFeedback } from '../lib/dm-feedback.mjs'
import { apiGet } from '../lib/bili-api.mjs'
// 对外发言的「限额闸」—— B 档"限额自主"的代码强制部分（2026-10-14 主人选 B 档）。
//
// 为什么不靠自觉：主人明确要求"限频写进代码，不是写进你的自觉里"。
// 数据文件: ~/.bili-ai/quota.json
//   { daily: 2, scope: ["uid:<你的mid>", "room:<房间号>", "BV19GaU63EZy"], log: [{ at, type, target, note }] }
//
// 用法:
//   node quota.mjs status                        今天用了多少 / 上限 / 剩余 / 白名单 / 最近记录
//   node quota.mjs check --type comment [--target "BVxxx"]    超限或不在白名单 → **退出码 2**（调用方据此拒绝发言）
//   node quota.mjs record --type comment --target "BVxxx" [--note "…"]   记账
//   node quota.mjs set --daily 3                 改额度
//   node quota.mjs allow "room:<房间号>"         往白名单加一项（也支持 --remove 删除）
//
// 约定：check 只挡"发言类"动作（comment / dynamic / danmaku）；读操作永远不受限。
import fs from 'node:fs'
import path from 'node:path'
import { newReplies } from '../lib/feedback.mjs'
import { config } from '../lib/config.mjs'
import { NODE_EXE } from '../lib/nodebin.mjs'   // 2026-10-21：别用 process.execPath（Electron 里它是主程序 ✗）

const FILE = path.join((HOME), '.bili-ai', 'quota.json')
// 额度与白名单优先来自统一配置（lib/config.mjs）；本文件自己的 quota.json 仍是运行账本
const DEFAULTS = { daily: config().quota?.daily ?? 2, scope: config().quota?.scope ?? [], shareDaily: config().quota?.shareDaily ?? 3, log: [] }
// fail-closed（2026-10-17 加，Kimi 评审指出）：账本**读不出来**时不能当"今天没发过" ✗
//   · 文件不存在 = 全新安装 → 用默认值 ✓
//   · 文件存在但 JSON 坏了 = 状态未知 → **拒绝发言**（check 退出 2），让人来修
//     （以前是 catch 后直接 DEFAULTS → 坏一次额度就重置，等于闸门失效）
let corrupt = false
const load = () => {
  let raw = {}
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { if (fs.existsSync(FILE)) corrupt = true }
  // ⚠️ 只认 log（2026-10-17，Kimi 评审 #4）：daily/scope/shareDaily 永远来自 config（实时）；
  //   以前 load 会把 quota.json 里固化的旧值盖在新配置上 → 设置页改了不生效且无提示 ✗
  return { ...DEFAULTS, log: Array.isArray(raw.log) ? raw.log : [] }
}
const save = (q) => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify({ log: q.log ?? [] }, null, 2) + '\n') }
// ── 沉默衰减（2026-10-18 加，主人定）────────────────────────────────
// 反馈的定义：**任何表态都算**（回她的评论 / 点赞 / 在微信里说一句 / 让她做点事…）
// 都没有 = 沉默。沉默 ≥ silentAfterDays(3) 天开始降，到 silentStopDays(7) 降到 0
// 扣到 0 就停止分享；**但两本日记照常写**（那是她的日子，不是发言）。
const FEEDBACK = path.join((HOME), '.bili-ai', 'feedback.json')
const loadFeedback = () => { try { return JSON.parse(fs.readFileSync(FEEDBACK, 'utf8')) } catch { return { last: null, events: [] } } }
// 2026-10-20：按 BV 取视频标题（带本地缓存）—— 模块级，供 react 记录时用
const TITLE_CACHE = path.join((HOME), '.bili-ai', 'liked-videos.json')
const loadTitleCache = () => { try { return JSON.parse(fs.readFileSync(TITLE_CACHE, 'utf8')) } catch { return {} } }
const saveTitleCache = (m) => { try { fs.writeFileSync(TITLE_CACHE, JSON.stringify(m, null, 2)) } catch {} }
async function titleOf(bv, cache) {
  if (!bv) return ''
  if (cache[bv]) return cache[bv]
  try {
    const j = await apiGet('https://api.bilibili.com/x/web-interface/view?bvid=' + bv, { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' })
    const t = String(j?.data?.title ?? '')
    if (t) cache[bv] = t
    return t
  } catch { return '' }
}

const saveFeedback = (f) => { fs.mkdirSync(path.dirname(FEEDBACK), { recursive: true }); fs.writeFileSync(FEEDBACK, JSON.stringify(f, null, 2) + '\n') }
/** 沉默天数：从来没反馈过就从"第一次分享"算；返回 { days, cap } */
function silence() {
  const fb = loadFeedback()
  fb.last = latestFeedback(fb.last, config().owner?.mid)
  const base = fb.last ?? (q.log.find((x) => x.share)?.at ?? null)   // 没反馈过 → 从第一次分享算
  const days = base ? Math.floor((Date.now() - new Date(base).getTime()) / 86_400_000) : 0
  const after = Number(config().share?.silentAfterDays ?? 3)     // 3 天开始衰减
  const stopAt = Math.max(after + 1, Number(config().share?.silentStopDays ?? 7))  // 7 天完全停
  const baseCap = Number(q.shareDaily ?? 3)
  // 2026-10-18 主人定：3 天开始降、**7 天降到 0**（不再是"扣到 0 为止"的算法 ✗）
  //   day3=3 → day4=2 → day5=1 → day6=1 → day7+=0 ✓（线性降，不低于 1 直到第 7 天 ✓）
  let cap
  if (days < after) cap = baseCap
  else if (days >= stopAt) cap = 0
  else cap = Math.max(1, Math.floor((baseCap * (stopAt - days)) / (stopAt - after)))
  const penalty = baseCap - cap
  // 2026-10-20：把"沉默"升级成"情绪档位"（主人定：她要自己觉得安静，不是被代码拦住）
  const band = days < after ? 'normal' : days < stopAt ? 'quiet' : 'faint'
  const asked = !!(fb.askedAt && (!fb.last || new Date(fb.askedAt) > new Date(fb.last)))
  return { days, last: fb.last, penalty, cap, band, asked, askedAt: fb.askedAt ?? null }
}
const today = () => new Date().toLocaleDateString('sv-SE')           // YYYY-MM-DD（本地时区）
// ⚠️ 2026-10-18 修：账本里的 at 是 **UTC** ISO 串，`startsWith(today())` 拿本地日期去比 →
//   本地 00:00–08:00 发的全被算成"昨天"（生物钟凌晨窗口正好踩在这条洞里 → 额度会凭空回血 ✗）
//   → 统一先把时间戳转成本地日期再比。
const dayOf = (at) => new Date(at).toLocaleDateString('sv-SE')
const usedToday = (q) => q.log.filter((x) => dayOf(x.at) === today()).length

const argv = process.argv.slice(2)
const cmd = argv[0]
const opt = {}
for (let i = 1; i < argv.length; i += 1) {
  // ⚠️ 2026-10-18 修：裸旗标放在**最后**时 argv[i+1] 是 undefined →
  //   旧写法把 opt 设成 undefined（不是 true），`--share` 就被静默吞掉：
  //   comment.mjs 内部把 --share 放在参数末尾 → 限额闸当成"主人授权"、7 天内重复检查也不跑 ✗
  if (argv[i].startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
    else { opt[argv[i].slice(2)] = v; i += 1 }
  }
  else if (!opt._a) opt._a = argv[i]
}
const q = load()

if (cmd === 'status') {
  const used = usedToday(q)
  const usedAuto = q.log.filter((x) => dayOf(x.at) === today() && x.auto && !x.share).length
  const usedShare = q.log.filter((x) => dayOf(x.at) === today() && x.share).length
  console.log(`今日对外发言: 共 ${used} 条（**分享型** ${usedShare}/${q.shareDaily ?? 3} · 自主发言不设条数上限 ✓ · 主人授权 ${used - usedAuto - usedShare} 条）   日期 ${today()}`)
  console.log(`缰绳：分享 ≤${q.shareDaily ?? 3}/天 · 评分卡 ≥${config().share?.minScore ?? 13}/20 · 同一视频 7 天一次 · 署名复核 · 事后报备`)
  console.log(`已删除（2026-10-18 主人定）：白名单 ✗ · 「自主 N 条」独立额度 ✗`)
  const recent = q.log.slice(-5)
  console.log(recent.length ? '最近记录:' : '最近记录: (无)')
  for (const r of recent) console.log(`  ${r.at}  ${r.type}  ${r.target ?? '-'}  ${r.note ?? ''}`)
  process.exit(0)
}

if (cmd === 'check') {
  // fail-closed：账本坏了就什么都别发（状态未知 ≠ 没发过）
  if (corrupt) {
    console.log('✗ 额度账本损坏（quota.json 不是合法 JSON）→ 状态未知，拒绝发言。')
    console.log(`   修法：检查 ${FILE}；确认无误后可删掉它（⚠️ 删 = 当天额度从 0 重算）`)
    process.exit(2)
  }
  const auto = !!opt.auto
  const usedAuto = q.log.filter((x) => dayOf(x.at) === today() && x.auto && !x.share).length
  const target = typeof opt.target === 'string' ? opt.target : ''
  const share = !!opt.share
  const shareDaily = q.shareDaily ?? 3
  const usedShare = q.log.filter((x) => dayOf(x.at) === today() && x.share).length
  const SEVEN = 7 * 24 * 3600 * 1000
  // ── 分享型（2026-10-17 主人定）：目的是"把看到的好东西 @ 主人" ──────────────
  // 它**不看白名单**（因为不是去跟陌生人互动，是给主人递东西），但三条硬限制：
  //   ① 每天合计 ≤ shareDaily（跨多次醒来共享）② 同一视频 7 天内只能一次 ③ 正文必须 @ 主人
  if (share) {
    if (config().share?.enabled === false) { console.error("分享已关闭"); process.exit(2) }
    const sil = silence()
    const effCap = Math.min(shareDaily, sil.cap)
    if (sil.penalty > 0) console.log(`  [沉默衰减] ${sil.days} 天没有任何表态 → 分享上限 ${shareDaily} → ${effCap}${effCap === 0 ? '（已停止分享；日记照常）' : ''}`)
    if (usedShare >= effCap) {
      console.log(`✗ 分享额度已用完：今天已经 @ 了 ${usedShare} 条（有效上限 ${effCap}）—— 剩下的留给明天，别硬发。`)
      process.exit(2)
    }
    if (target) {
      const dup = q.log.find((x) => x.share && String(x.target ?? '') === target && Date.now() - new Date(x.at).getTime() < SEVEN)
      if (dup) {
        console.log(`✗ 这个视频 7 天内已经分享过了：${dup.at}（${dup.target}）`)
        process.exit(2)
      }
    }
    console.log(`✓ 分享额度内（${usedShare}/${shareDaily}）${target ? `，target=${target}` : ''} —— 分享型不看白名单，但同一视频 7 天内只能一次`)
    process.exit(0)
  }
  // 语义（2026-10-14 定；**2026-10-18 简化**：删除「自主 2 条」这个独立额度 ✗ —— 主人定：基本没用 ✓）
  //   现在的缰绳只有这些：分享型 ≤shareDaily/天（上面那条分支 ✓）· 评分卡 · 同一视频 7 天一次 · 事后报备。
  //   **非分享**的自主发言**不再设每日条数额度** —— 但仍必须 dry→go→署名复核→报备主人 ✓
  //   （`--auto` 依旧要带：它标记"这是她自己决定说的"，影响的是**报备与审计**，不是额度 ✓）
  if (!auto) {
    console.log('（非自主发言：不拦截）主人授权的发言不受限，但照旧 dry→go→复核')
    process.exit(0)
  }
  console.log(`✓ 通过（分享型额度另算；自主发言已不设每日条数上限 —— 2026-10-18 主人定）${target ? `· target=${target}` : ''}`)
  process.exit(0)
}

if (cmd === 'record') {
  const type = typeof opt.type === 'string' ? opt.type : 'unknown'
  q.log.push({ at: new Date().toISOString(), type, auto: !!opt.auto || !!opt.share, share: !!opt.share, target: opt.target ?? null, note: opt.note ?? null })
  save(q)
  const usedAuto = q.log.filter((x) => dayOf(x.at) === today() && x.auto && !x.share).length
  const usedShare = q.log.filter((x) => dayOf(x.at) === today() && x.share).length
  console.log(`已记账：${type}${opt.share ? '（分享型·@主人）' : opt.auto ? '（自主）' : '（主人授权）'}${opt.target ? ' → ' + opt.target : ''}   今日分享 ${usedShare}/${q.shareDaily ?? 3}（自主发言不设上限 ✓）`)
  process.exit(0)
}

// 自动识别反馈（2026-10-18 加，主人要求；2026-10-18 夜补 likes）：
//   能自动的两半边：
//     ① 主人回了她的评论 → 收件箱「回复我的」（comment-digest）
//     ② 主人**赞**了她 → 「收到的赞」`likes --owner`（B站确实给 who ✓，此前以为看不到 ✗）
//   自动不了：跨端表态（微信/桌面…各端互不可见 ✗）→ 那半边靠收到的人当场 `quota react --note`
//   所以是 best-effort：查到就记，查不到就明说"没检测到"（可能是跨端表态）
// 2026-10-20：她"主动问一次"之后记一笔 —— 避免 3-6 天档反复追问（只问一次 ✓）
if (cmd === 'ask') {
  const fb = loadFeedback()
  fb.askedAt = new Date().toISOString()
  fb.events = [...(fb.events ?? []), { at: fb.askedAt, note: opt.note ? String(opt.note).slice(0, 80) : '主动问了一次' }].slice(-200)
  saveFeedback(fb)
  console.log('✓ 已记下「问过一次」（这轮沉默里不再问 ✓）')
  process.exit(0)
}

if (cmd === 'react' && opt.auto) {
  try {
    const { execFileSync } = await import('../lib/capture.mjs')
    const here = (f) => decodeURIComponent(new URL(f, import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
    const hours = String(opt.hours ?? 72)
    const found = []
    // ① 回复
    try {
      // 2026-10-22 修（Issue #14）：以前拿人类可读文本做子串匹配 ✗
      //   统计行/标签行里出现主人名也会命中 → 误记反馈 → 沉默衰减被清零 ✗
      //   现在读 --json 的结构化结果，按 mid 精确比对 ✓
      const out = execFileSync(NODE_EXE, [here('./comment-digest.mjs'), '--hours', hours, '--pages', '1', '--json'], { encoding: 'utf8' })
      const ownerName = String(config().owner?.name ?? '')
      const ownerMid = String(config().owner?.mid ?? '')
      // 从结构化结果里取「主人回了几条」✓
      let digest = null
      try { digest = JSON.parse(String(out).trim().split(/\r?\n/).pop() ?? '') } catch {}
      const ownerReplyCount = Number(digest?.ownerReplies ?? 0)
      if (ownerReplyCount > 0) {
        // 只把"和主人有关"的行拿去算哈希（内容变了才继续算新表态 ✓）
        const lines = (digest?.ownerReplyItems ?? []).map((r) => `${r.time} [${r.kind}] ${r.who}：「${r.text}」`)
        const { createHash } = await import('node:crypto')
        found.push({ kind: 'reply', label: '回复', items: digest.ownerReplyItems, hash: createHash('sha1').update(lines.join('\n')).digest('hex') })
      }
    } catch { /* 收件箱失败不影响点赞这一路 */ }
    // ② 点赞（--json 里 ownerLiked 是确定数字，比抠文本稳）
    try {
      const js = execFileSync(NODE_EXE, [here('./likes.mjs'), '--owner', '--json', '--hours', hours], { encoding: 'utf8' })
      const o = JSON.parse(js)
      const ownerMid2 = String(config().owner?.mid ?? '')
      if (Number(o.ownerLiked ?? 0) > 0) {
        // 取"主人点过的那几条"里最新的 like_time —— 只有比上次记的更新才算新表态 ✓
        let maxTime = 0
        const liked = []
        for (const it of (o.items ?? [])) {
          const mine = (it.users ?? []).some((u) => String(u.mid) === ownerMid2)
          if (!mine) continue
          const t = Number(it.like_time ?? 0)
          maxTime = Math.max(maxTime, t)
          // 2026-10-20 加：item.uri 里有视频地址、item.title 是评论原文 → 存下来 ✓
          const uri = String(it.item?.uri ?? '')
          const bv = (uri.match(/BV[0-9A-Za-z]{10}/) ?? [])[0] ?? ''
          liked.push({ bv, comment: String(it.item?.title ?? '').slice(0, 140), likeTime: t })
        }
        found.push({ kind: 'like', label: `点赞×${o.ownerLiked}`, count: Number(o.ownerLiked), maxTime, liked })
      }
    } catch { /* 同上 */ }
    // ⚠️ 2026-10-20 修（社区+实测）：以前只要 48h 内有赞就记 → 同一个赞每轮都记 ✗
    //   → 沉默永远清零 → 衰减实际要 5 天才开始（设计是 3 天）✗
    //   现在：点赞按 like_time 去重（只有更新的赞才算"新表态"）✓
    //        回复按"主人相关行的哈希"去重（内容没变就不算新）✓
    if (found.length) {
      const fb = loadFeedback()
      const nowIso = new Date().toISOString()
      let changed = false
      let newest = Number.isFinite(Date.parse(fb.last)) ? Date.parse(fb.last) : 0
      fb.events = [...(fb.events ?? [])]
      for (const f of found) {
        if (f.kind === 'like') {
          const prev = Number(fb.lastLikeTime ?? 0)
          if (f.maxTime > prev) {
            fb.lastLikeTime = f.maxTime
            newest = Math.max(newest, Math.min(Date.now(), f.maxTime * 1000))
            // 只有"这次新出现的"才记（比上次 maxTime 新的那些）✓
            const fresh = (f.liked ?? []).filter((x) => x.likeTime > prev)
            if (fresh.length) {
              // 补视频标题（她写「偏好校准」和 feed 加权都要用 ✓）
              const cache = loadTitleCache()
              for (const x of fresh) x.videoTitle = await titleOf(x.bv, cache)
              saveTitleCache(cache)
              for (const x of fresh) {
                fb.events.push({
                  at: nowIso,
                  kind: 'like',
                  bv: x.bv,
                  videoTitle: x.videoTitle ?? '',
                  comment: x.comment,
                  note: x.bv
                    ? `主人赞了你在 ${x.bv} 的那条评论：${x.comment.slice(0, 60)}`
                    : `主人赞了你的评论：${x.comment.slice(0, 60)}`,
                })
              }
            } else {
              fb.events.push({ at: nowIso, note: `auto: 检测到主人（点赞×${f.count}）` })
            }
            changed = true
          }
        } else if (f.kind === 'reply') {
          const reply = newReplies(f.items, fb)
          const migrated = !fb.lastReplyTime && fb.lastReplyHash === f.hash
          fb.lastReplyHash = f.hash
          fb.lastReplyTime = reply.time
          fb.replyIds = reply.ids
          if (reply.fresh.length && !migrated) {
            newest = Math.max(newest, reply.time)
            fb.events.push({ at: new Date(reply.time).toISOString(), note: 'auto: 检测到主人（回复）' })
            changed = true
          }
        }
      }
      fb.events = fb.events.slice(-200)
      if (changed) {
        fb.last = new Date(newest).toISOString()
        saveFeedback(fb)
        const names = found.filter((f) => (f.kind === 'like' ? f.maxTime > Number(fb.lastLikeTime ?? 0) - 1 : true)).map((f) => f.label)
        console.log(`✓ 自动识别到主人的【新】表态（${names.join(' / ') || found.map((f) => f.label).join(' / ')}）→ 已记一次反馈（沉默清零）`)
      } else {
        saveFeedback(fb) // Persist migrated IDs even without a new reaction.
        console.log('（近 ' + hours + ' 小时有主人的表态，但都是【已经记过的】→ 不重复记 ✓ 沉默继续累计）')
      }
    } else {
      console.log(`（近 ${hours} 小时：没有主人的回复，也没有主人的点赞）—— 沉默继续累计`)
      console.log('  ⚠️ 跨端表态（微信/桌面…）这边看不见 → 需要收到的那一端当场 `quota react --note "…"`')
    }
  } catch (e) {
    console.log('自动识别失败：' + String(e.message).slice(0, 160))
  }
  process.exit(0)
}

if (cmd === 'react') {
  const fb = loadFeedback()
  fb.last = new Date().toISOString()
  fb.events = [...(fb.events ?? []), { at: fb.last, note: opt.note ?? '' }].slice(-200)
  saveFeedback(fb)
  const sil = silence()
  console.log(`已记一次反馈（现在沉默 0 天）· 分享上限回到 ${sil.cap}`)
  process.exit(0)
}

if (cmd === 'silence') {
  const sil = silence()
  if (opt.json) { console.log(JSON.stringify({ days: sil.days, last: sil.last, cap: sil.cap, band: sil.band, asked: sil.asked })); process.exit(0) }
  console.log(`沉默天数: ${sil.days} 天（最后一次表态 ${sil.last ?? '从未'}）`)
  console.log(`档位: ${sil.band === 'normal' ? '正常' : sil.band === 'quiet' ? '安静（有点想他）' : '心慌（不敢打扰）'}${sil.asked ? ' · 已问过一次' : ''}`)
  console.log(`衰减: -${sil.penalty} → 分享上限 ${sil.cap}${sil.cap === 0 ? '（已停止分享，但日记照常写）' : ''}`)
  process.exit(0)
}

// 2026-10-18 删除：set / allow 是**死代码** ✗（save() 只持久化 {log}，改了 daily/scope 也存不下来；
// 而且"白名单"和"自主 N 条"都已按主人要求删除 ✗）—— 留着只会误导，删掉 ✓

console.log('用法:')
console.log('  node quota.mjs status')
console.log('  node quota.mjs check --type comment [--target "BVxxx"]')
console.log('  node quota.mjs record --type comment --target "BVxxx" [--note "…"]')
// （set / allow 已删除 ✓）

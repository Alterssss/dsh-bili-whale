import { HOME } from '../lib/paths.mjs'
// comment-digest.mjs —— "今天谁找过人家"：给主人的日终汇报（只读，一句都不回）
//
// 用途：她过完一天（或主人睡前）时跑一遍，把结果推给主人看 ——
//   回复陌生人要过闸门/要主人点头，**她自己不回**，只负责"让主人知道"。
//
// 数据源（都不需要维护线程清单）：
//   · /x/msgfeed/reply  「回复我的」
//   · /x/msgfeed/at     「@我的」
// ⚠️ 收件箱的 title/source 字段语义不可靠（实测多条 title 是同一句）→
//    **正文一律回读楼层核实**（lib/msgfeed.mjs 的 resolveLatestReply）。
//
// 用法:
//   node bili.mjs comment-digest [--hours 24] [--pages 2] [--only-unread] [--max-resolve 20] [--raw]
//     --raw          不核实正文，直接用收件箱字段（快，但可能不准）
import fs from 'node:fs'
import { config } from '../lib/config.mjs'
import path from 'node:path'
import { makeHeaders, pullFeed, resolveLatestReply } from '../lib/msgfeed.mjs'

const args = process.argv.slice(2)
const get = (k, d) => {
  const i = args.indexOf('--' + k)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d
}
const HOURS = Number(get('hours', '24'))
const PAGES = Math.max(1, Number(get('pages', '2')))
const MAX_RESOLVE = Number(get('max-resolve', '20'))
const ONLY_UNREAD = args.includes('--only-unread')
const RAW = args.includes('--raw')
// 2026-10-22 加（Issue #14）：结构化输出，给 quota 判定用 ✓
//   以前 quota 拿人类可读文本做子串匹配 → 统计行里出现主人名也会误命中 ✗
const JSON_OUT = args.includes('--json')

const cred = JSON.parse(fs.readFileSync(path.join((HOME), '.bili-ai', 'credentials.json'), 'utf8'))
const H = makeHeaders(cred)
const hhmm = (t) => (t ? new Date(t * 1000).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '时间未知')

const now = Math.floor(Date.now() / 1000)
const since = now - HOURS * 3600
const reply = await pullFeed('reply', { headers: H, pages: PAGES }).catch((e) => ({ items: [], err: e.message, lastView: 0 }))
const at = await pullFeed('at', { headers: H, pages: PAGES }).catch((e) => ({ items: [], err: e.message, lastView: 0 }))
if (reply.err) console.error(`（回复收件箱读不到：${reply.err}）`)
if (at.err) console.error(`（@收件箱读不到：${at.err}）`)

let all = [...reply.items, ...at.items].filter((x) => x.t === 0 || x.t >= since)
if (config().listen?.onlyOwner) all = all.filter(x => String(x.mid) === String(config().owner?.mid ?? ''))
if (ONLY_UNREAD) {
  const lv = Math.max(reply.lastView ?? 0, at.lastView ?? 0)
  if (lv) all = all.filter((x) => x.t >= lv)
}
all.sort((a, b) => a.t - b.t)

const replies = all.filter((x) => x.kind === 'reply')
const ats = all.filter((x) => x.kind === 'at')
const say = (...a) => { if (!JSON_OUT) console.log(...a) }
say(`【B 站 · 谁找过人家】最近 ${HOURS} 小时`)
say(`共 ${all.length} 条 —— 回复 ${replies.length} · @ ${ats.length}${ONLY_UNREAD ? '（只看未读）' : ''}${RAW ? '（未核实正文）' : ''}`)
if (!all.length) {
  if (JSON_OUT) {
    const ownerMid0 = String(config().owner?.mid ?? '')
    console.log(JSON.stringify({ ok: !reply.err && !at.err, errors: [reply.err, at.err].filter(Boolean), hours: HOURS, count: 0, reply: 0, at: 0, ownerReplies: 0, ownerReplyItems: [], items: [], ownerMid: ownerMid0 }))
  } else console.log('\n安静得很，没人找。')
  process.exit(0)
}

// 回读楼层核实正文（同一楼同一人只查一次）
const cache = new Map()
let resolved = 0
async function realText(x) {
  // source_content 才是我要的正文（title 是不可靠的陈旧字段）；为空才回读楼层兜底
  if (x.source || x.title) return { text: (x.source || x.title).replace(/\n/g, ' '), rpid: x.parent }
  if (RAW || x.kind !== 'reply' || resolved >= MAX_RESOLVE) return { text: '', rpid: x.parent }
  const key = `${x.business}|${x.oid}|${x.root}|${x.mid}|${x.parent}`
  if (cache.has(key)) return cache.get(key)
  resolved += 1
  const r = await resolveLatestReply({ business: x.business, oid: x.oid, root: x.root, mid: x.mid, parentRpid: x.parent, headers: H }).catch(() => null)
  const out = { text: (r?.text ?? '').replace(/\n/g, ' '), rpid: r?.rpid || x.parent, ctime: r?.ctime }
  cache.set(key, out)
  return out
}

const rows = []
say('')
for (const x of all) {
  const tag = x.kind === 'reply' ? '回复' : '@ '
  const real = await realText(x)
  const text = (real.text || '(读不到正文)').slice(0, 80)
  rows.push({
    id: x.id, kind: x.kind, who: x.who, mid: String(x.mid ?? ''),
    time: new Date((real.ctime || x.t) * 1000).toISOString(),
    text, rpid: String(real?.rpid || x.parent || ''),
    oid: x.oid, root: x.root, business: x.business, uri: x.uri,
  })
  say(`· ${hhmm(real.ctime || x.t)} [${tag}] ${x.who}`)
  say(`    「${text}」`)
  if (x.uri) say(`    位置：${x.uri}`)
  if (x.kind === 'reply') say(`    坐标：type=${x.business} oid=${x.oid} root=${x.root} parent=${real?.rpid || x.parent}`)
}

if (JSON_OUT) {
  // 主人回了几条：按 mid 精确比对（没有 mid 才退回昵称）✓ 绝不做子串匹配 ✗
  const cfg = config()
  const oMid = String(cfg.owner?.mid ?? '')
  const oName = String(cfg.owner?.name ?? '')
  const ownerItems = rows.filter((r) => (oMid && r.mid === oMid) || (!oMid && oName && r.who === oName))
  console.log(JSON.stringify({
    ok: !reply.err && !at.err, errors: [reply.err, at.err].filter(Boolean), hours: HOURS,
    count: rows.length, reply: rows.filter((r) => r.kind === 'reply').length, at: rows.filter((r) => r.kind === 'at').length,
    ownerMid: oMid, ownerReplies: ownerItems.length, ownerReplyItems: ownerItems,
    items: rows,
  }))
  process.exit(0)
}

const byWho = new Map()
for (const x of all) byWho.set(x.who, (byWho.get(x.who) ?? 0) + 1)
const multi = [...byWho.entries()].filter(([, n]) => n > 1)
if (multi.length) console.log(`\n话最多的：` + multi.map(([w, n]) => `${w}（${n} 条）`).join(' · '))
console.log(`\n⚠️ 这是"别人找我们"，回不回由主人定（回复要过 quota 闸门；陌生人不在白名单）。`)

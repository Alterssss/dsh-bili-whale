import { HOME } from '../lib/paths.mjs'
// comment-await.mjs —— 评论版"叫我起床"
//
// 为什么这么设计：agent 收不到"被动事件"，但**后台任务结束会通知 agent** ✓
//   → 所以让一个**廉价进程**（不调模型、0 token）每 N 秒看一眼"回复我的"，
//     一旦发现有新回复就 **退出**，用"任务结束"把 agent 叫醒。
//   → 没人回我们 → 整晚 0 token（这才是省钱的关键）
//
// 数据源：B 站官方的「回复我的」 `/x/msgfeed/reply`（全站一网打尽，不用维护线程清单）
//
// 用法:
//   node bili.mjs comment-await [--minutes 180] [--interval 300] [--only-owner] [--since <unix秒>] [--quiet]
//     --minutes N    最多守 N 分钟（默认 180；0 = 一直守）
//     --interval S   每 S 秒看一次（默认 300 = 5 分钟；别小于 60，免得像刷接口）
//     --only-owner   只认主人的号（mid 999999003）的回复，观众的一律忽略
//     --since T      baseline（unix 秒）；默认 = 启动那一刻，只报"这之后"的新回复
//     --quiet        不打印每轮心跳（只打印命中/超时）
//
// 命中时打印一行 `COMMENT_HIT` 和一条完整的"回复坐标"（直接能拿去发 comment）
// 退出码: 0 = 有命中 / 3 = 守到超时没命中 / 1 = 出错
import fs from 'node:fs'
import { config } from '../lib/config.mjs'
import path from 'node:path'
import { makeHeaders, pullFeed, resolveLatestReply, ME, OWNER } from '../lib/msgfeed.mjs'

const args = process.argv.slice(2)
const get = (k, d) => {
  const i = args.indexOf('--' + k)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d
}
// 守多久 —— 2026-10-18 接线（主人定：设置页那个「全天（我睡着时也回）」开关要真生效 ✓）
//   ① listen.allDay = true → 0（一直守，直到有新回复 / 被叫停）
//   ② 否则 → 守到**当前作息窗口结束**（最少 10 分钟）；不在任何窗口里 → 退回 180 分钟
function defaultMinutes() {
  const L = config().listen ?? {}
  if (L.allDay) return 0
  const wins = Array.isArray(config().night?.windows) && config().night.windows.length
    ? config().night.windows
    : [{ start: '20:00', end: '24:00' }]
  const now = new Date()
  const nowMin = now.getHours() * 60 + now.getMinutes()
  for (const w of wins) {
    const [sh, sm] = String(w.start ?? '20:00').split(':').map(Number)
    const [eh, em] = String(w.end ?? '24:00').split(':').map(Number)
    const s = (sh === 24 ? 1440 : sh * 60) + (sm || 0)
    const e = (eh === 24 ? 1440 : eh * 60) + (em || 0)
    if (nowMin >= s && nowMin < e) return Math.max(10, e - nowMin)
  }
  return 180
}
const MINUTES = Number(get('minutes', String(defaultMinutes())))
// 设置页的「倾听间隔」真的生效（2026-10-18 修，Kimi 评审：以前配置写了没人读 ✗）
const INTERVAL = Math.max(60, Number(get('interval', String(config().listen?.commentIntervalSec ?? 300))))
const ONLY_OWNER = args.includes('--only-owner')
const QUIET = args.includes('--quiet')

const cred = JSON.parse(fs.readFileSync(path.join((HOME), '.bili-ai', 'credentials.json'), 'utf8'))
const H = makeHeaders(cred)

const startedAt = Number(get('since', String(Math.floor(Date.now() / 1000))))
const deadline = MINUTES > 0 ? Date.now() + MINUTES * 60_000 : Infinity
const hhmm = (t) => new Date(t * 1000).toLocaleString('zh-CN', { hour12: false })

// 2026-10-18 接线：设置页「只回」= 直接回我的 / 也回 @我的
//   config.listen.scope = 'reply' | 'both'；命令行 --scope 可覆盖 ✓
const SCOPE = String(get('scope', String(config().listen?.scope ?? 'both')))
const WITH_AT = SCOPE !== 'reply'

async function poll() {
  const { items } = await pullFeed('reply', { headers: H, pages: 1 })
  if (!WITH_AT) return items
  try {
    const at = await pullFeed('at', { headers: H, pages: 1 })
    // 两个收件箱的字段结构一致（lib/msgfeed 已归一）→ 合并去重就行
    const byId = new Map()
    for (const x of [...items, ...at.items]) byId.set(`${x.kind}:${x.id}`, x)
    return [...byId.values()]
  } catch {
    return items   // @ 收件箱挂了不影响「回复我的」那半边 ✓
  }
}

console.log(`[评论守望] 起守 ${new Date().toLocaleString('zh-CN', { hour12: false })}`)
console.log(`  每 ${INTERVAL} 秒看一次 · ${MINUTES > 0 ? `最多守 ${MINUTES} 分钟` : '一直守'} · ${ONLY_OWNER ? '只认主人的号' : '认所有回给我们的'} · ${WITH_AT ? '回复我的 + @我的' : '只看回复我的'}`)
console.log(`  baseline=${startedAt} (${hhmm(startedAt)}) —— 只报这之后的新回复`)

let rounds = 0
for (;;) {
  rounds += 1
  try {
    const items = await poll()
    const fresh = items.filter((x) => x.t > startedAt && (!ONLY_OWNER || x.mid === OWNER))
    if (fresh.length) {
      // 最老的那条先报（按时间正序，方便一条条处理）
      fresh.sort((a, b) => a.t - b.t)
      console.log(`\nCOMMENT_HIT ${fresh.length} 条（第 ${rounds} 轮）\n`)
      for (const [i, x] of fresh.entries()) {
        // 字段真相（2026-10-14 实测）：
        //   source_content = 他说的话 ✓   source_id = 他这条评论的 rpid（回他时用它当 parent）✓
        //   title          = 不可靠的陈旧字段 ✗（多条 item 常常是同一句，别用）
        // 只有 source_content 为空时才回读楼层兜底。
        let text = (x.source || x.title || '').replace(/\n/g, ' ')
        let parent = x.parent
        if (!text) {
          const real = await resolveLatestReply({ business: x.business, oid: x.oid, root: x.root, mid: x.mid, parentRpid: x.parent, headers: H }).catch(() => null)
          if (real) { text = real.text.replace(/\n/g, ' '); parent = real.rpid }
        }
        console.log(`[${i + 1}] ${hhmm(x.t)} · ${x.who}（mid ${x.mid}）`)
        console.log(`     说：${text || '(读不到正文，去楼层看看)'}`)
        console.log(`     回复坐标：type=${x.business} oid=${x.oid} root=${x.root} parent=${parent}`)
        if (x.uri) console.log(`     位置：${x.uri}`)
      }
      process.exit(0)
    }
    if (!QUIET) console.log(`  [${rounds}] ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} 无新回复（最近一条 ${items[0] ? hhmm(items[0].t) : '无'}）`)
  } catch (e) {
    console.log(`  [${rounds}] 这一轮失败：${e.message}（继续守）`)
  }
  if (Date.now() >= deadline) {
    console.log(`\nNO_HIT 守到时限（${MINUTES} 分钟 / ${rounds} 轮），期间没人回我们 —— 可以安心睡`)
    process.exit(3)
  }
  await new Promise((s) => setTimeout(s, INTERVAL * 1000))
}

// 「她的一天」—— 让主人看得见她做了什么（可见性层，2026-10-14 主人问"我怎么知道她做了什么"）
//
// 用法:
//   node diary.mjs show [--days 1]      人读摘要：今天看了什么 / 想了什么 / 发了什么 / 额度还剩多少
//   node diary.mjs log <kind> [--target X] [--note "…"]   记一条结构化事件到 ~/.dsh/whale-log.jsonl
//   node diary.mjs tail [--n 20]        最近的结构化事件
//
// 三个数据源（各司其职）：
//   ~/.dsh/whale-diary.md      叙事（她自己的话：看过的、想法池、谁回过她）—— 给人读
//   ~/.bili-ai/quota.json      发言账（每条对外发言，含"自主/主人授权"标记）—— 给闸门与审计用
//   ~/.dsh/whale-log.jsonl     事件流（看/想/发/被回… 结构化）—— 给程序与其他端用
//
// 关键约定（写进 AGENTS.md）：**自主发言之后必须主动通知主人**（notify_wechat），
// 因为"她自己决定的对外动作"必须让主人事后可见 —— 这是 B 档能成立的前提。
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../lib/config.mjs'
import { dshPath } from '../lib/paths.mjs'


const argv = process.argv.slice(2)
// 设置页的「日记总开关」真的生效（2026-10-18 修）：关掉就什么都不记
if (config().diary?.enabled === false) { console.log('（日记总开关关着 —— 这次不记）'); process.exit(0) }
const cmd = argv[0]
const opt = {}
for (let i = 1; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i]
  else if (!opt._a) opt._a = argv[i]
}
const HOME = (process.env.USERPROFILE || process.env.HOME || '/')
const DIARY = dshPath('whale-diary.md')
const QUOTA = path.join(HOME, '.bili-ai', 'quota.json')
const LOG = dshPath('whale-log.jsonl')
const today = () => new Date().toLocaleDateString('sv-SE')
const hhmm = (iso) => String(iso).slice(11, 16)

if (cmd === 'log') {
  const kind = opt._a ?? 'event'
  fs.mkdirSync(path.dirname(LOG), { recursive: true })
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), kind, target: opt.target ?? null, note: opt.note ?? null }) + '\n')
  console.log(`已记：${kind}${opt.target ? ' → ' + opt.target : ''}`)
  process.exit(0)
}

if (cmd === 'tail') {
  const n = Number(opt.n ?? 20)
  let lines = []
  try { lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) } catch {}
  if (!lines.length) { console.log('（还没有事件记录）'); process.exit(0) }
  for (const l of lines.slice(-n)) {
    try { const e = JSON.parse(l); console.log(`  ${String(e.at).slice(0, 16).replace('T', ' ')}  ${e.kind}  ${e.target ?? ''}  ${e.note ?? ''}`) }
    catch { console.log('  ' + l) }
  }
  process.exit(0)
}

if (cmd === 'show' || !cmd) {
  const days = Number(opt.days ?? 1)
  const since = new Date(Date.now() - (days - 1) * 86400000).toLocaleDateString('sv-SE')
  const title = config().persona?.diaryTitle ?? '今日摘要'
  console.log(`════════ ${title}（${since} ~ ${today()}）════════\n`)

  // ① 叙事部分：解析日记
  let text = ''
  try { text = fs.readFileSync(DIARY, 'utf8') } catch { console.log(`（读不到日记 ${DIARY}）`) }
  if (text) {
    const sections = {}
    let cur = null
    for (const line of text.split('\n')) {
      const h = line.match(/^##\s+(.+)$/)
      if (h) { cur = h[1].trim(); sections[cur] = []; continue }
      if (cur) sections[cur].push(line)
    }
    // 看过的：表格里日期匹配的
    const seenKey = Object.keys(sections).find((k) => k.includes('看过')) ?? ''
    const rows = (sections[seenKey] ?? []).filter((l) => l.startsWith('|') && !/^\|\s*-+/.test(l) && !l.includes('| 时间 |'))
    const hit = rows.filter((r) => r.includes(since) || r.includes(today()))
    console.log(`【看过 ${hit.length} 条】`)
    for (const r of hit) {
      const c = r.split('|').map((s) => s.trim()).filter(Boolean)
      console.log(`  · ${c[2] ?? c[0]}  ${String(c[3] ?? '').slice(0, 46)}`)
      if (c[4]) console.log(`      她的想法：${String(c[4]).slice(0, 120)}`)
    }
    // 想法池
    const wantKey = Object.keys(sections).find((k) => k.includes('想说')) ?? ''
    const wants = (sections[wantKey] ?? []).filter((l) => l.trim().startsWith('-') && !/^-\s*（空/.test(l.trim()))
    console.log(`\n【想说但还没说 ${wants.length} 条】`)
    for (const w of wants) console.log('  ' + w.trim().replace(/^-\s*/, '  · ').slice(0, 150))
  }

  // ② 发言账（她真的对外说了什么）
  console.log('\n【对外发言（今天）】')
  try {
    const q = JSON.parse(fs.readFileSync(QUOTA, 'utf8'))
    const todayLog = (q.log ?? []).filter((x) => String(x.at).startsWith(today()))
    const auto = todayLog.filter((x) => x.auto).length
    console.log(`  共 ${todayLog.length} 条（自主 ${auto}/${q.daily}，主人授权 ${todayLog.length - auto}）`)
    for (const x of todayLog) console.log(`  · ${hhmm(x.at)}  ${x.type}${x.auto ? '（自主）' : ''}  ${x.target ?? ''}  ${x.note ?? ''}`)
    if (!todayLog.length) console.log('  （今天一条都没发）✓')
  } catch { console.log('  （还没有发言记录 —— 发第一条时 `quota record` 会自动建 quota.json）✓') }

  // ③ 事件流
  console.log('\n【最近事件】')
  let lines = []
  try { lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) } catch {}
  if (!lines.length) console.log('  （还没有事件记录 —— `diary log` 会往这里写）')
  for (const l of lines.slice(-6)) {
    try { const e = JSON.parse(l); console.log(`  · ${String(e.at).slice(5, 16).replace('T', ' ')}  ${e.kind}  ${e.target ?? ''}  ${e.note ?? ''}`) } catch {}
  }
  console.log('\n（她是主动来找你的：自主发言后必须 notify_wechat —— 见 AGENTS.md「日子」一节）')
  process.exit(0)
}

console.log('用法: node diary.mjs show [--days 1] | log <kind> [--target X] [--note "…"] | tail [--n 20]')

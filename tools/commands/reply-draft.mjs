import { HOME } from '../lib/paths.mjs'
// 待审回复（2026-10-18 主人选 B 档：**发前审核**）——
//
// 她的回复**不再直接发** ✗，而是：
//   ① 她把草稿写进 `~/.bili-ai/pending-replies.json`（本脚本 add ✓）
//   ② 设置页「待审核」里主人看得到 → 点「发」/「删」
//   ③ 点「发」时插件才真的跑 `comment --go`（带 --auto ✓ 会报备 ✓）
//
// 为什么这么设计：回复是"先去碰别人" ✓ 比分享那句 @ 主人更需要一道人际上的缓冲 ✓
// 而且主人能顺手否掉"太冲/太软/答偏了"的那种 ✓ —— 否掉的也会进她的「偏好校准」✓（学会分寸）
//
// 用法:
//   node reply-draft.mjs add --oid 123 --bvid BVxxx --root 456 --parent 789 \
//        --who 对方昵称示例 --message "…" [--src "他说的话"]
//   node reply-draft.mjs list [--json]
//   node reply-draft.mjs drop <id>
//   node reply-draft.mjs take <id>        （插件审批时用：取出参数并从队列删掉）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { NODE_EXE } from '../lib/nodebin.mjs'   // 2026-10-21：别用 process.execPath（Electron 里它是主程序 ✗）

const FILE = path.join(HOME, '.bili-ai', 'pending-replies.json')

const argv = process.argv.slice(2)
const cmd = argv[0]
const opt = {}
for (let i = 1; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
    else { opt[argv[i].slice(2)] = v; i += 1 }
  } else if (!opt._a) opt._a = argv[i]
}

const load = () => {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { items: Array.isArray(j.items) ? j.items : [] } }
  catch { return { items: [] } }
}
const save = (o) => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(o, null, 2) + '\n') }

if (cmd === 'add') {
  const { oid, bvid, root, parent, who, message, src } = opt
  if (!oid || !message) { console.error('需要 --oid 和 --message'); process.exit(2) }
  if (!root || !parent) { console.error('回复要有 --root 和 --parent（坐标从 comment-digest 拿）'); process.exit(2) }
  const text = String(message).trim()
  if (text.length > 500) { console.error('草稿太长（>500），砍短'); process.exit(2) }
  const db = load()
  // 同一个 parent 不重复排队 ✓
  if (db.items.some((x) => String(x.parent) === String(parent))) {
    console.log('（这个 parent 已经在队列里了，没重复加 ✓）')
    process.exit(0)
  }
  const item = {
    id: crypto.randomBytes(4).toString('hex'),
    at: new Date().toISOString(),
    oid: String(oid), bvid: bvid ? String(bvid) : '', root: String(root), parent: String(parent),
    who: who ? String(who) : '', src: src ? String(src).slice(0, 300) : '',
    message: text,
  }
  db.items.push(item)
  save(db)
  console.log(`✓ 已进待审队列：${item.id} → ${item.who || '（对方）'} · ${text.length} 字`)

  // 2026-10-18 主人定：**需要审核的回复直接推送给主人** ✓（不做设置页 UI ✗）
  // best-effort：推送失败不影响入队 ✓
  try {
    const summary = [
      `【等你审核 1 条回复】→ ${item.who || '对方'}`,
      item.src ? `他说：${item.src}` : '',
      `你要回：${text}`,
      '回我「发」就发 ✓ 回「不发」就撤掉 ✓（也可以直接给我改一版）',
    ].filter(Boolean).join('\n')
    const notifier = path.join(path.dirname(fileURLToPath(import.meta.url)), 'notify.mjs')
    execFile(NODE_EXE, [notifier, summary, '--title', '待审回复'],
      { windowsHide: true, timeout: 60000 }, () => {})
  } catch {}
  process.exit(0)
}

if (cmd === 'list') {
  const db = load()
  if (argv.includes('--json')) { console.log(JSON.stringify(db, null, 2)); process.exit(0) }
  if (!db.items.length) { console.log('（队列是空的 ✓ 没有等审的回复）'); process.exit(0) }
  console.log(`待审 ${db.items.length} 条：`)
  for (const x of db.items) {
    // 2026-10-18 修：原来直接切 ISO 串 = 显示的是 UTC ✗（本地 08:15 显示成 00:15 ✗）
    const t = new Date(x.at).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    console.log(`  ${x.id}  ${t}  → ${x.who || '?'}  「${x.message.slice(0, 40)}${x.message.length > 40 ? '…' : ''}」`)
  }
  process.exit(0)
}

if (cmd === 'show') {
  // 只读：看一条的完整内容（不删！）—— 2026-10-18 加，防止"take 出来才发现内容没截全" ✗
  const id = opt._a
  if (!id) { console.error('用法: node reply-draft.mjs show <id>'); process.exit(2) }
  const db = load()
  const hit = db.items.find((x) => x.id === id)
  if (!hit) { console.error(`没有这个 id：${id}`); process.exit(2) }
  if (argv.includes('--json')) { console.log(JSON.stringify(hit, null, 2)); process.exit(0) }
  console.log(`id      : ${hit.id}`)
  console.log(`对方    : ${hit.who || '?'}`)
  console.log(`对方说  : ${hit.src || '（未记录）'}`)
  console.log(`坐标    : oid=${hit.oid} bvid=${hit.bvid} root=${hit.root} parent=${hit.parent}`)
  console.log(`你要回  : ${hit.message}`)
  process.exit(0)
}

if (cmd === 'drop' || cmd === 'take') {
  const id = opt._a
  if (!id) { console.error('用法: node reply-draft.mjs drop <id>'); process.exit(2) }
  const db = load()
  const hit = db.items.find((x) => x.id === id)
  if (!hit) { console.error(`没有这个 id：${id}`); process.exit(2) }
  db.items = db.items.filter((x) => x.id !== id)
  save(db)
  if (cmd === 'take') console.log(JSON.stringify(hit))
  else console.log(`✓ 已删掉 ${id}`)
  process.exit(0)
}

console.log('用法: node reply-draft.mjs add … | list [--json] | drop <id> | take <id>')

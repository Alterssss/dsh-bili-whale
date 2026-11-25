import fs from 'node:fs'
import path from 'node:path'
import { dshPath } from '../lib/paths.mjs'

// memory：在写过的东西里找一句话
//   只搜 markdown（两本日记 + 记忆索引），纯 fs 逐行匹配：
//   不建索引、不联网、不调模型、零依赖。
//
// 为什么需要它
//   日记是写给以后看的，不是每天整本重读的。日记写多了以后，回答
//   「你答应过我什么」「上次那个工具叫什么」这类问题，要么整本 read
//   （几十 KB、几万 token），要么靠上下文里残留的印象猜。
//   猜会编。这个工具的用途就是把「猜」换成「查证」——
//   猜错的代价是编出一句他没说过的话，查证的成本是读一个文件。
//
// 用法:
//   node memory.mjs search 抽帧 [--limit 20] [--context 2] [--json]
//   node memory.mjs search 主人 答应 --any     # 任一命中（默认是同一行都要有）
//   node memory.mjs stats
//   node memory.mjs search 答应 --dir D:/backup/whale-life
//
// 搜索范围
//   默认 DSH_HOME/whale-life（日记由 life-store 渲染到 whale-life/<账号指纹>/whale-diary.md）。
//   可用环境变量 WHALE_MEMORY_DIR 或参数 --dir 覆盖。
//   只搜这三类文件名：whale-diary.md / whale-diary-private.md / whale-memory-index.md。
//
// 用法提醒（重要，别被假阴性骗了）
//   - 多个词**默认要求同一行都出现**。日记一行几十字，跨行的意思就搜不到。
//   - 所以搜「主人是不是答应过我什么」这种：先只搜一个词（答应 / 承诺 / 说好），
//     或者加 --any 放宽成「任一词出现就算」。
//   - 搜不到**不等于没这回事**——只说明搜索范围内没有这样的字面。
//     对话记录不在搜索范围。

const NAMES = ['whale-diary.md', 'whale-diary-private.md', 'whale-memory-index.md']
const LABELS = {
  'whale-diary.md': '浏览日记',
  'whale-diary-private.md': '私人日记',
  'whale-memory-index.md': '记忆索引',
}

const argv = process.argv.slice(2)
const mode = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'search'
const rest = argv.slice(mode === argv[0] ? 1 : 0)

const args = new Map()
const words = []
for (let i = 0; i < rest.length; i += 1) {
  const a = rest[i]
  if (a.startsWith('--')) {
    const next = rest[i + 1]
    if (next === undefined || next.startsWith('--')) { args.set(a.slice(2), true) }
    else { args.set(a.slice(2), next); i += 1 }
  } else {
    words.push(a)
  }
}

const asJson = args.has('json')

// Windows 上管道/重定向时 process.exit 会丢掉还没 flush 的 stdout，
// 先让出一次事件循环再退（否则「没找到」这类单行输出会凭空消失）。
const done = async (code = 0) => { await new Promise((r) => setImmediate(r)); process.exit(code) }

function rootDir() {
  const given = args.get('dir')
  if (typeof given === 'string' && given) return path.resolve(given)
  const env = process.env.WHALE_MEMORY_DIR
  if (env) return path.resolve(env)
  return dshPath('whale-life')
}

/** 在根目录下找三类文件（深度 2，够覆盖 whale-life/<指纹>/ 这一层）。 */
function collect(root, depth = 2) {
  const out = []
  const walk = (dir, level) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (level > 0) walk(p, level - 1); continue }
      if (NAMES.includes(e.name)) out.push(p)
    }
  }
  walk(root, depth)
  return out
}

function load(root) {
  const out = []
  for (const p of collect(root)) {
    let text = null
    try { text = fs.readFileSync(p, 'utf8') } catch { continue }
    const name = path.basename(p)
    out.push({
      name,
      label: LABELS[name] ?? name,
      // 同一个文件名在不同账号目录下会有多份，用相对路径区分
      where: path.relative(root, p).split(path.sep).join('/'),
      path: p,
      lines: text.split(/\r?\n/),
      chars: text.length,
    })
  }
  return out
}

const root = rootDir()

if (mode === 'stats') {
  const docs = load(root)
  if (asJson) {
    console.log(JSON.stringify(docs.map((d) => ({ file: d.where, lines: d.lines.length, chars: d.chars })), null, 2))
    await done(0)
  }
  console.log(`搜索范围：${root}`)
  if (!docs.length) console.log('（这里没有找到任何日记或记忆索引）')
  for (const d of docs) {
    console.log(`  ${d.label.padEnd(4)} ${String(d.lines.length).padStart(5)} 行  ${String(d.chars).padStart(7)} 字  ${d.where}`)
  }
  await done(0)
}

if (mode !== 'search') {
  console.error('用法: memory search <关键词…> [--limit 20] [--context 1] [--any] [--json] [--dir 目录] | memory stats')
  await done(2)
}
if (!words.length) {
  console.error('search 需要至少一个关键词（多个词之间是「都要出现」）')
  await done(2)
}

const limit = Math.max(1, Number(args.get('limit') ?? 20))
const context = Math.max(0, Number(args.get('context') ?? 1))
const docs = load(root)
if (!docs.length) {
  console.error(`搜索范围内没有日记或记忆索引：${root}`)
  console.error('用 --dir 指定目录，或设环境变量 WHALE_MEMORY_DIR。')
  await done(3)
}

const anyMode = args.has('any')
const testLine = (low) => (anyMode
  ? words.some((w) => low.includes(w.toLowerCase()))
  : words.every((w) => low.includes(w.toLowerCase())))

const hits = []
for (const d of docs) {
  d.lines.forEach((line, i) => {
    if (testLine(line.toLowerCase())) hits.push({ doc: d, i })
  })
}

if (!hits.length) {
  console.log(`没找到「${words.join(' ')}」。`)
  if (!anyMode && words.length > 1) {
    console.log(`提示：${words.length} 个词默认要求同一行都出现——这行里没有同时满足，不代表没这回事。`)
    console.log('      加 --any 放宽成「任一词出现就算」，或者一次只搜一个词（答应 / 承诺 / 说好）。')
  }
  console.log('提示：只搜写过的 markdown（两本日记 + 记忆索引），不搜对话记录。')
  await done(0)
}

const shown = hits.slice(0, limit)
if (asJson) {
  console.log(JSON.stringify(shown.map((h) => ({ file: h.doc.where, line: h.i + 1, text: h.doc.lines[h.i].trim() })), null, 2))
  await done(0)
}

console.log(`找到 ${hits.length} 处「${words.join(' ')}」${anyMode && words.length > 1 ? '（任一命中）' : ''}（显示前 ${shown.length} 处）\n`)
let lastDoc = null
for (const h of shown) {
  if (h.doc !== lastDoc) {
    console.log(`── ${h.doc.label}（${h.doc.where}）`)
    lastDoc = h.doc
  }
  const from = Math.max(0, h.i - context)
  const to = Math.min(h.doc.lines.length - 1, h.i + context)
  for (let k = from; k <= to; k += 1) {
    console.log(`${k === h.i ? '>>' : '  '} ${String(k + 1).padStart(5)}  ${h.doc.lines[k]}`)
  }
  console.log('')
}
if (hits.length > shown.length) console.log(`…还有 ${hits.length - shown.length} 处，用 --limit 调大`)

// config.mjs —— LOCAL：不开设置页也能看/改养鱼的配置
// 2026-10-30（设置里「养鱼」那一块没显示）：给一条命令行通道。
//
// 用法：
//   node bili.mjs config                     看全部（按键分组）
//   node bili.mjs config get night.maxVideos 取某一个
//   node bili.mjs config set night.maxVideos 10
//   node bili.mjs config like                看兴趣词
//   node bili.mjs config like add 新词
//   node bili.mjs config like rm 新词
//   node bili.mjs config dislike add 带货
//
// 配置写在与设置页同一份文件里（可用 DSH_HOME / BILI_WHALE_CONFIG 改位置），改动立即生效
import fs from 'node:fs'
import { configPath } from '../lib/paths.mjs'

const FILE = configPath

const load = () => JSON.parse(fs.readFileSync(FILE, 'utf8'))
const save = (j) => fs.writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n')

const getPath = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
function setPath(obj, p, val) {
  const keys = p.split('.')
  let cur = obj
  for (const k of keys.slice(0, -1)) {
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {}
    cur = cur[k]
  }
  cur[keys.at(-1)] = val
}

const argv = process.argv.slice(2)
const [cmd, a1, a2] = argv
const cfg = load()

const coerce = (v) => {
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return v
}

if (!cmd || cmd === 'show') {
  console.log(`配置文件：${FILE}\n`)
  for (const [k, v] of Object.entries(cfg)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      console.log(`[${k}]`)
      for (const [k2, v2] of Object.entries(v)) {
        const shown = Array.isArray(v2) ? v2.join(' · ') : typeof v2 === 'object' ? JSON.stringify(v2) : String(v2)
        console.log(`  ${k2.padEnd(20)} ${shown.slice(0, 90)}`)
      }
    } else {
      console.log(`[${k}] ${JSON.stringify(v).slice(0, 120)}`)
    }
  }
  process.exit(0)
}

if (cmd === 'get') {
  const v = getPath(cfg, a1)
  console.log(`${a1} = ${JSON.stringify(v)}`)
  process.exit(0)
}

if (cmd === 'set') {
  if (!a1 || a2 === undefined) { console.error('用法: config set <键路径> <值>'); process.exit(2) }
  setPath(cfg, a1, coerce(a2))
  save(cfg)
  console.log(`✓ ${a1} = ${JSON.stringify(getPath(cfg, a1))}`)
  process.exit(0)
}

if (cmd === 'like' || cmd === 'dislike') {
  const field = cmd === 'like' ? 'like' : 'dislike'
  const list = (cfg.preferences ??= {})[field] ?? []
  if (!a1) { list.forEach((x, i) => console.log(`${i + 1}. ${x}`)); process.exit(0) }
  if (a1 === 'add' && a2) {
    if (!list.includes(a2)) list.push(a2)
    cfg.preferences[field] = list
    save(cfg)
    console.log(`✓ ${field} 加了「${a2}」，现在 ${list.length} 条`)
  } else if ((a1 === 'rm' || a1 === 'del') && a2) {
    cfg.preferences[field] = list.filter((x) => x !== a2)
    save(cfg)
    console.log(`✓ ${field} 删了「${a2}」，现在 ${cfg.preferences[field].length} 条`)
  } else {
    console.error(`用法: config ${cmd} add|rm <词>`)
    process.exit(2)
  }
  process.exit(0)
}

console.error('用法: config | config get <键> | config set <键> <值> | config like [add|rm 词] | config dislike [...]')
process.exit(2)

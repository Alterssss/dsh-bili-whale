// collect-tags-round.mjs —— LOCAL：给一批 BV 采 B站 标签，写进两级标签库
// 用法：node tools/local/collect-tags-round.mjs BV1xxx BV1yyy ...
// 参数：--window 1 --src discover --keyword 新番  （都会记进 videos）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { recordVideo, maybePruneMonthly, stats, level1 } from './tagstore.mjs'
import { homePath } from '../lib/paths.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(here, '../..')
const LIB = 'file:///' + path.join(REPO, 'tools/lib/').replace(/\\/g, '/')
const { apiGet } = await import(LIB + 'bili-api.mjs')

const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const bvs = argv.filter((a, i) => /^BV/i.test(a) && !String(argv[i - 1]).startsWith('--'))
const meta = {
  src: argOf('--src') ?? 'round',
  window: Number(argOf('--window') ?? 0) || null,
  keyword: argOf('--keyword') ?? null,
}

function cookieHeader() {
  try {
    const c = JSON.parse(fs.readFileSync(homePath('.bili-ai', 'credentials.json'), 'utf8'))
    return ['SESSDATA=' + c.sessdata, 'bili_jct=' + c.bili_jct, c.buvid3 ? 'buvid3=' + c.buvid3 : ''].filter(Boolean).join('; ')
  } catch { return '' }
}
const H = { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/', cookie: cookieHeader() }

let ok = 0
let fail = 0
let emptyStreak = 0
for (const bv of bvs) {
  if (emptyStreak >= 2) { console.log('连续两次拿不到标签，停手'); break }
  let tags = []
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const j = await apiGet(`https://api.bilibili.com/x/tag/archive/tags?bvid=${bv}`, H, { noCache: true })
      tags = (j?.data ?? []).map((t) => String(t.tag_name ?? '').trim()).filter(Boolean)
    } catch { tags = [] }
    if (tags.length) break
    await new Promise((r) => setTimeout(r, 1200))
  }
  if (tags.length) {
    recordVideo(bv, tags, meta)
    ok += 1
    emptyStreak = 0
    console.log(`✓ ${bv}  ${tags.length} 个标签：${tags.slice(0, 6).join(' / ')}`)
  } else {
    fail += 1
    emptyStreak += 1
    console.log(`✗ ${bv}  没有标签或接口失败`)
  }
  await new Promise((r) => setTimeout(r, 700))
}

const pr = maybePruneMonthly(5, 30)
const s = stats()
const prLine = pr.action === 'init'
  ? `首次启用月度清理，起算日已记下，下一次 ${pr.nextAt}`
  : pr.action === 'pruned'
    ? `本月清理：剔除命中数 <5 的标签 ${pr.removed} 个，下一次 ${pr.nextAt}`
    : `本月不清理（下次 ${pr.nextAt}）`
console.log(`\n本轮采到 ${ok} 条 · 失败 ${fail} 条`)
console.log(prLine)
console.log(`库里共 ${s.videos} 条视频 / ${s.tags} 个标签（可留 ${s.keepable} 个）`)
console.log(`1 级标签（兴趣数×3）：${level1(Number(argOf('--kwcount') ?? 4)).map((t) => `${t.name}(${t.count})`).join(' · ')}`)

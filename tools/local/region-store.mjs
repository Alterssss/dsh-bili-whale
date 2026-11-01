// ── 这组模块是干什么的（为什么值得做）──────────────────────────────
// 目的：把「看过/搜到/相关推荐里出现」的视频的 tag 和分区统计起来，
//   用来反向挑兴趣词——即：从统计结果里选出真正有效、且 B 站搜索能搜出
//   合适视频的词，替换掉那些搜出来全是教程合集 / 标题党的宽泛词。
//
// 怎么做到「不带来太多延迟」：
//   · tag 只在「已经决定要深读」的视频上采，一条一次请求，不额外扫全站；
//   · 分区信息是随搜索结果一起返回的（不需要额外请求）；
//   · 相关推荐补采有播放量门槛和条数上限（bw_cfg_relatedMinPlay / relatedTakeMax），
//     只取最值得的几条；
//   · 全部统计都写本地文件，找片时不读它们，所以不影响一轮的耗时。
//   · 统计口径只统计「兴趣来源」的视频；热搜/排行榜不参与（它们的分布跟个人兴趣无关）。
//
// 一句话：先攒统计 → 再从统计里挑词 → 让搜索更准，代价是可控的少量请求。
// ────────────────────────────────────────────────────────────────
// region-store.mjs —— LOCAL：分区统计（跟 tag 统计一个思路）
//   统计结果供人工查看：攒够一段时间后，从里面挑出反复出现、且能搜到
//   合适视频的 tag / 分区，用来替换掉那些搜出来全是教程合集或标题党的宽泛词。
//   本仓库不负责调度（什么时候看由使用者自己决定）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshPath, homePath } from '../lib/paths.mjs'

const FILE = dshPath('whale-work', 'regions.jsonl')
// 仓库位置按本文件位置反推，不写死本机路径
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const LIB = 'file:///' + REPO + '/tools/lib/'

function cred() {
  try {
    const c = JSON.parse(fs.readFileSync(homePath('.bili-ai', 'credentials.json'), 'utf8'))
    return ['SESSDATA=' + c.sessdata, 'bili_jct=' + c.bili_jct].filter(Boolean).join('; ')
  } catch { return '' }
}

/** 给一批 BV 记分区（每条一次 view 请求） */
export async function recordRegions(bvs, known = {}) {
  const { apiGet } = await import(LIB + 'bili-api.mjs')
  // 首次写入时目录可能还不存在（新机器/新 DSH_HOME），先建好再 append
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }) } catch {}
  const ck = cred()
  const rows = []
  for (const bv of bvs) {
    try {
      const H = { 'user-agent': 'Mozilla/5.0', referer: `https://www.bilibili.com/video/${bv}/`, cookie: ck }
      const v = await apiGet(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, H, { noCache: true })
      const d = v?.data ?? {}
      if (!d.tid) continue
      const nameFromCaller = known[bv] || ''
      const row = {
        at: new Date().toISOString().slice(0, 10),
        bv,
        tid: d.tid,
        tname: nameFromCaller || d.tname || d.tnamev2 || `分区${d.tid}`,
        tnamev2: d.tnamev2 ?? '',
        view: Number(d.stat?.view ?? 0),
        parts: Number(d.videos ?? 1),
      }
      rows.push(row)
      fs.appendFileSync(FILE, JSON.stringify(row) + '\n')
      await new Promise((r) => setTimeout(r, 400))
    } catch {}
  }
  return rows
}

/** 统计：二级分区名 → 次数 */
export function regionCounts() {
  const cnt = new Map()
  try {
    for (const line of fs.readFileSync(FILE, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      let r
      try { r = JSON.parse(line) } catch { continue }
      const key = r.tname || r.tnamev2 || String(r.tid)
      if (!key) continue
      cnt.set(key, (cnt.get(key) ?? 0) + 1)
    }
  } catch {}
  return [...cnt.entries()].sort((a, b) => b[1] - a[1])
}

if (process.argv[1]?.endsWith('region-store.mjs')) {
  const bvs = process.argv.slice(2)
  if (bvs.length) {
    const rows = await recordRegions(bvs)
    console.log(`已记录 ${rows.length} 条分区`)
  }
  const list = regionCounts()
  console.log('\n分区统计（全量）：')
  for (const [name, n] of list.slice(0, 20)) console.log(`  ${String(n).padStart(3)}×  ${name}`)
  if (!list.length) console.log('  （还没有数据）')
}

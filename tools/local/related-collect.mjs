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
// related-collect.mjs —— 相关推荐补采（2026-10-31）
//   规则：只对「兴趣搜索」来源的视频做；从相关推荐里挑播放量 > bw_cfg_relatedMinPlay 的，
//        按播放从高到低取最多 bw_cfg_relatedTakeMax 条；把这些视频的 tag 和分区收进库。
//   热搜/排行榜来源不参与（那些不处理）。
import { cv } from './bw-config.mjs'
import { recordVideo } from './tagstore.mjs'
import { recordRegions } from './region-store.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshPath, homePath } from '../lib/paths.mjs'

// 仓库位置按本文件位置反推，不写死本机路径
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const LIB = 'file:///' + REPO + '/tools/lib/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function headers(bv) {
  let ck = ''
  try {
    const c = JSON.parse(fs.readFileSync(homePath('.bili-ai', 'credentials.json'), 'utf8'))
    ck = ['SESSDATA=' + c.sessdata, 'bili_jct=' + c.bili_jct].filter(Boolean).join('; ')
  } catch {}
  return { 'user-agent': 'Mozilla/5.0', referer: `https://www.bilibili.com/video/${bv}/`, cookie: ck }
}

/**
 * @param {Array} items discover 的条目（含 bv / window / region）
 * @returns {Promise<{added:number, rows:Array}>}
 */
export async function collectRelated(items) {
  const { apiGet } = await import(LIB + 'bili-api.mjs')
  const MIN_PLAY = cv('relatedMinPlay')
  const TAKE = cv('relatedTakeMax')
  const sources = items.filter((x) => x.window !== '热搜')
  const out = []
  let added = 0

  for (const src of sources) {
    let list = []
    try {
      const j = await apiGet(`https://api.bilibili.com/x/web-interface/archive/related?bvid=${src.bv}`, headers(src.bv), { noCache: true })
      list = Array.isArray(j?.data) ? j.data : []
    } catch { continue }
    const picked = list
      .filter((x) => Number(x.stat?.view ?? 0) > MIN_PLAY)
      .sort((a, b) => Number(b.stat?.view ?? 0) - Number(a.stat?.view ?? 0))
      .slice(0, TAKE)

    for (const r of picked) {
      const bv = r.bvid
      if (!bv) continue
      const name = r.tname || r.tnamev2 || ''
      try {
        const t = await apiGet(`https://api.bilibili.com/x/tag/archive/tags?bvid=${bv}`, headers(bv), { noCache: true })
        const tags = (t?.data ?? []).map((x) => x.tag_name).filter(Boolean)
        if (!tags.length) continue
        recordVideo(bv, tags, {
          source: 'related',
          from: src.bv,
          play: Number(r.stat?.view ?? 0),
          region: name,
          title: String(r.title ?? ''),
        })
        added += 1
        out.push({ bv, from: src.bv, play: Number(r.stat?.view ?? 0), region: name, tags })
      } catch {}
      await sleep(600)
    }
    // 分区也记（只有拿到名字的才有意义）
    const withName = picked.filter((r) => r.tname || r.tnamev2)
    if (withName.length) {
      try {
        await recordRegions(withName.map((r) => r.bvid), Object.fromEntries(withName.map((r) => [r.bvid, r.tname || r.tnamev2])))
      } catch {}
    }
    await sleep(600)
  }
  return { added, rows: out }
}

if (process.argv[1]?.endsWith('related-collect.mjs')) {
  // 单独跑时要读「最近一份 discover 日志」；读不到就友好提示并正常退出（不当作错误）
  let items = []
  try {
    const dl = dshPath('whale-work', 'discover-logs')
    const f = fs.readdirSync(dl).filter((x) => x.endsWith('.json')).map((x) => path.join(dl, x))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
    if (!f) throw new Error('discover-logs 里没有 .json 文件')
    items = JSON.parse(fs.readFileSync(f, 'utf8')).items ?? []
  } catch (e) {
    console.log('没有找到 discover 日志，先跑一次 discover（node tools/local/discover.mjs --n 5），再来补采。')
    console.log('（读不到的原因：' + String(e.message).slice(0, 80) + '）')
    process.exit(0)
  }
  const res = await collectRelated(items)
  console.log(`相关推荐补采：新增 ${res.added} 条`)
  for (const r of res.rows) console.log(`  ${r.bv} ${String(r.play)} 播放 ${r.region || '-'} ${r.tags.slice(0, 3).join('/')}  ← 来自 ${r.from}`)
}

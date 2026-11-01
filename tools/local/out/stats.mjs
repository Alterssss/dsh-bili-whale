// out/stats.mjs —— LOCAL：相关推荐补采 + 分区记录（round:done 订阅者，order 30 / 50）
import path from 'node:path'
import { hooks } from '../hooks.mjs'

// 2026-10-31：相关推荐补采（只对兴趣来源的视频做，热搜不参与）
hooks.on('round:done', async ({ items, here }) => {
  try {
    const rc = await import('file:///' + path.join(here, 'related-collect.mjs').replace(/\\/g, '/'))
    const res = await rc.collectRelated(items)
    console.log('\n[相关推荐补采] 新增 ' + res.added + ' 条')
    for (const r of res.rows.slice(0, 10)) console.log(`  ${r.bv} ${(r.play / 10000).toFixed(1)}万 ${r.region || '-'} ${r.tags.slice(0, 3).join('/')}  ← 来自 ${r.from}`)
  } catch (e) { console.log('（相关推荐补采失败：' + String(e.message).slice(0, 60) + '）') }
}, 30)

// 2026-10-31：顺手记分区（用 discover 已拿到的 typename，不多发请求）
hooks.on('round:done', async ({ items, here }) => {
  try {
    const rs = await import('file:///' + path.join(here, 'region-store.mjs').replace(/\\/g, '/'))
    // 2026-10-31：热搜/排行榜来源不处理分区
    const interestOnly = items.filter((x) => x.window !== '热搜')
    const known = Object.fromEntries(interestOnly.map((x) => [x.bv, x.region || '']))
    const rows = await rs.recordRegions(interestOnly.map((x) => x.bv), known)
    console.log('\n[分区] 记录 ' + rows.length + ' 条：' + [...new Set(rows.map((r) => r.tname))].join(' · '))
  } catch (e) { console.log('（分区统计失败：' + String(e.message).slice(0, 60) + '）') }
}, 50)

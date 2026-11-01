// out/overview.mjs —— LOCAL：「看了哪些」（含分区/tag，5 条一组）round:done 订阅者，order 20
import fs from 'node:fs'
import { dshPath } from '../../lib/paths.mjs'
import { hooks } from '../hooks.mjs'
import { cv } from '../bw-config.mjs'

hooks.on('round:done', ({ items, N }) => {
  console.log('')
  // 2026-10-31：对话输出的总览里，每条都要带分区和 tag（最多 3 个）
  try {
    const db = JSON.parse(fs.readFileSync(dshPath('whale-work', 'tag-stats.json'), 'utf8'))
    // 2026-10-31：每条带 标题 / 播放 / 日期 / 分区 / 最多 3 个 tag；
    //   太长就按 5 条一组拆分（发私信时也是 5+5 两条总览）
    // 2026-10-31：分组条数改由 bw_cfg_overviewPerMessage 控制。
    //   0（默认）= 不分条，一次打印完整列表（与上游"直接列出候选"一致）；
    //   >0 = 每 N 条一组，标题带「第几组/共几组」。
    const perCfg = Number(cv('overviewPerMessage') ?? 0)
    const list = items.slice(0, N)
    const PER = perCfg > 0 ? perCfg : Math.max(list.length, 1)
    for (let gi = 0; gi < list.length; gi += PER) {
      const group = list.slice(gi, gi + PER)
      const groupTag = perCfg > 0 ? ` ${gi / PER + 1}/${Math.ceil(list.length / PER)}` : ''
      console.log(`\n[看了哪些${groupTag}（含分区/tag）]`)
      for (const it of group) {
        const rec = db.videos?.[it.bv]
        const tags = (rec?.tags ?? []).slice(0, 3).join('/') || '-'
        const region = it.region || '-'
        const play = Number(it.totalPlay ?? it.play ?? 0)
        const playText = play >= 10000 ? (play / 10000).toFixed(1) + '万' : String(play)
        const date = String(it.pubdate ?? '').slice(0, 10)
        console.log(`  ${it.bv} ${String(it.title ?? '').slice(0, 18).padEnd(18)} ${playText} ${date} ${String(region).padEnd(10)} ${tags}`)
      }
    }
  } catch (e) { console.log('（总览读不到 tag：' + String(e.message).slice(0, 50) + '）') }
}, 20)

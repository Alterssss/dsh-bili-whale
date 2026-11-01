// feedlog.mjs —— LOCAL：每次 feed 都落一份来源日志，事后能追"这条哪来的"
// 为什么要有（2026-10-29）：feed 的选择过程没记录，只能靠重跑+猜。
// 这个模块把每个候选写成一行 JSONL，字段：
//   bv / 标题 / 播放 / 弹幕 / 时长 / 来源类别 / 偏好词 / 命中词 / 分数 / 是否入选 / 是否补齐
// 来源类别：偏好搜索（命中偏好词）/ 热搜·热门 / 热搜·排行 / 关注 / 补齐
import fs from 'node:fs'
import path from 'node:path'
import { dshPath } from '../lib/paths.mjs'

const LOGDIR = dshPath('whale-work', 'feed-logs')

const HOT = new Set(['热门', '排行', '关注'])

function classify(x, isFilled) {
  if (isFilled) return '补齐'
  const kw = String(x?.kw ?? '')
  if (kw === '热门') return '热搜·热门'
  if (kw === '排行') return '热搜·排行'
  if (kw === '关注') return '关注'
  return '偏好搜索'
}

export function writeFeedLog(finalPicked, allCandidates, preFillCount) {
  try {
    fs.mkdirSync(LOGDIR, { recursive: true })
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')
    const file = path.join(LOGDIR, `feed-${stamp}.jsonl`)
    const pickedSet = new Set((finalPicked ?? []).map((x) => x.bv))
    const filledSet = new Set((finalPicked ?? []).slice(preFillCount ?? 0).map((x) => x.bv))
    const rows = (allCandidates ?? []).map((x) => {
      const isFilled = filledSet.has(x.bv)
      const src = classify(x, isFilled)
      return {
        bv: x.bv,
        title: x.t,
        play: x.play,
        dm: x.dm,
        dur: x.d,
        up: x.up,
        src,
        kw: HOT.has(String(x.kw)) ? '' : String(x.kw ?? ''),
        hits: (x._hits ?? []).join('+'),
        score: Number(x._score ?? 0).toFixed(1),
        picked: pickedSet.has(x.bv),
        filled: isFilled,
      }
    })
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

    const count = (k) => rows.filter((r) => r.picked && r.src === k).length
    const summary = `[来源] 入选 ${pickedSet.size} 条：偏好搜索 ${count('偏好搜索')} · 热搜·热门 ${count('热搜·热门')} · 热搜·排行 ${count('热搜·排行')} · 关注 ${count('关注')} · 补齐 ${count('补齐')}`
    console.log(summary)
    console.log(`[日志] ${file}`)
    return file
  } catch (e) {
    console.log(`[日志] 写失败：${String(e.message).slice(0, 80)}`)
    return null
  }
}

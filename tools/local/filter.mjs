// filter.mjs —— LOCAL：统一的筛选方法（新搜索、老搜索、热搜 都走这一套）
// 2026-10-29：筛选逻辑只写一处，改逻辑就改这里，所有入口自动跟着变。
//
// 检查顺序：看过没 → 质量下限 → 时间上限
// 返回 { passed, dropped: { seen, quality, age } }
import { CONFIG, daysAgo } from './search-config.mjs'

export function makeSeenSet(diaryText = '', extraSets = []) {
  const seen = new Set()
  for (const m of String(diaryText).matchAll(/\bBV[0-9A-Za-z]{10}\b/g)) seen.add(m[0])
  for (const s of extraSets) for (const v of s ?? []) seen.add(v)
  return seen
}

/** 单个条目能不能过 */
export function passFilter(item, opts = {}) {
  const { seen = new Set(), maxAgeDays = CONFIG.filterWindows.at(-1), minPlay = CONFIG.minPlay, minDm = CONFIG.minDm } = opts
  if (!item?.bv) return { ok: false, why: 'quality' }
  if (seen.has(item.bv)) return { ok: false, why: 'seen' }
  const play = Number(item.play ?? 0)
  const dm = Number(item.dm ?? 0)
  if (play < minPlay || dm < minDm) return { ok: false, why: 'quality' }
  if (maxAgeDays && daysAgo(item.pubdate) > maxAgeDays) return { ok: false, why: 'age' }
  return { ok: true, why: '' }
}

/** 整批筛 */
export function filterList(list, opts = {}) {
  const dropped = { seen: 0, quality: 0, age: 0 }
  const passed = []
  const takenBvs = new Set()
  for (const item of list ?? []) {
    if (takenBvs.has(item?.bv)) continue
    const r = passFilter(item, opts)
    if (!r.ok) { dropped[r.why] = (dropped[r.why] ?? 0) + 1; continue }
    takenBvs.add(item.bv)
    passed.push(item)
  }
  return { passed, dropped }
}

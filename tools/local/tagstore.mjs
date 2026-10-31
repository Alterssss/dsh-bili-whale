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
// tagstore.mjs —— LOCAL：标签库（两级）
// 2026-10-29：
//   1 级标签 = 按命中数排最高的一批，数量 = 兴趣词数 × 3（默认，可用 --level1 覆盖）
//   2 级标签 = 全量，但定期剔除命中数 < 5 的
//   取标签时优先 1 级，不够再取 2 级
//
// 数据文件：dshPath('whale-work', 'tag-stats.json')（默认在 ~/.dsh 下，可用 DSH_HOME 改）
//   videos   每个视频的标签 + 来源信息
//   tags     每个标签的 count / weight / high / lastSeen
//   cooccur  标签共现（用来拼组合词）
import fs from 'node:fs'
import path from 'node:path'
import { dshPath } from '../lib/paths.mjs'

const FILE = dshPath('whale-work', 'tag-stats.json')

export const MIN_KEEP = 5        // 2 级标签的保留门槛
const load = () => {
  let db
  try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { db = {} }
  // 兼容旧文件（早期只有 videos / tags 两张表）
  db.videos = db.videos ?? {}
  db.tags = db.tags ?? {}
  db.cooccur = db.cooccur ?? {}
  return db
}
const save = (db) => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2))
}

/** 记一条视频的标签。meta: { play, dm, src, window, score } */
export function recordVideo(bv, tags, meta = {}) {
  if (!bv || !Array.isArray(tags) || !tags.length) return false
  const db = load()
  const clean = [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))]
  const prev = db.videos[bv]?.tags ?? []
  db.videos[bv] = { ...db.videos[bv], ...meta, tags: clean, at: new Date().toISOString() }

  // 标签计数：只对新出现的标签加一（重采同一视频不重复计）
  const fresh = clean.filter((t) => !prev.includes(t))
  const score = Number(meta.score ?? 0)
  for (const t of fresh) {
    const e = (db.tags[t] = db.tags[t] ?? { count: 0, weight: 0, high: 0 })
    e.count += 1
    e.weight += 1 + (Number.isFinite(score) && score > 0 ? score / 10 : 0) + (Number(meta.play ?? 0) > 100000 ? 0.5 : 0)
    if (score >= 13) e.high += 1
    e.lastSeen = new Date().toISOString()
  }
  // 共现
  for (let i = 0; i < clean.length; i += 1) {
    for (let j = i + 1; j < clean.length; j += 1) {
      const k = [clean[i], clean[j]].sort().join('|')
      db.cooccur[k] = (db.cooccur[k] ?? 0) + 1
    }
  }
  save(db)
  return fresh.length > 0
}

/** 每月清一次：剔除命中数低于门槛的标签
 *  2026-10-29：不是每次采集都剔，改成一个月一次。
 *  第一次今天是"起算日"，不剔 —— 到下个月同一天才第一次清理。
 *  返回值：{ action: 'init' | 'pruned' | 'skipped', removed?, nextAt? } */
export function maybePruneMonthly(min = MIN_KEEP, days = 30) {
  const db = load()
  const now = Date.now()
  const last = Number(db.meta?.lastPrune ?? 0)
  if (!last) {
    db.meta = { ...(db.meta ?? {}), lastPrune: now }
    save(db)
    return { action: 'init', nextAt: new Date(now + days * 86400000).toISOString().slice(0, 10) }
  }
  const elapsed = (now - last) / 86400000
  if (elapsed < days) {
    return { action: 'skipped', nextAt: new Date(last + days * 86400000).toISOString().slice(0, 10) }
  }
  let removed = 0
  for (const [t, e] of Object.entries(db.tags)) {
    if ((e?.count ?? 0) < min) { delete db.tags[t]; removed += 1 }
  }
  db.meta = { ...(db.meta ?? {}), lastPrune: now }
  save(db)
  return { action: 'pruned', removed, nextAt: new Date(now + days * 86400000).toISOString().slice(0, 10) }
}

/** 立刻剔一次（手动用，比如你想马上清理） */
export function pruneNow(min = MIN_KEEP) {
  const db = load()
  let removed = 0
  for (const [t, e] of Object.entries(db.tags)) {
    if ((e?.count ?? 0) < min) { delete db.tags[t]; removed += 1 }
  }
  db.meta = { ...(db.meta ?? {}), lastPrune: Date.now() }
  save(db)
  return removed
}

/** 从 videos 表重建 tags 计数（标签被误剔或换算法时用） */
export function rebuild() {
  const db = load()
  const tags = {}
  const cooccur = {}
  for (const v of Object.values(db.videos)) {
    const list = [...new Set(v.tags ?? [])]
    for (const t of list) {
      const e = (tags[t] = tags[t] ?? { count: 0, weight: 0, high: 0 })
      e.count += 1
      e.weight += 1 + (Number(v.play ?? 0) > 100000 ? 0.5 : 0)
    }
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const k = [list[i], list[j]].sort().join('|')
        cooccur[k] = (cooccur[k] ?? 0) + 1
      }
    }
  }
  db.tags = tags
  db.cooccur = cooccur
  save(db)
  return Object.keys(tags).length
}

const sortTags = (db) => Object.entries(db.tags)
  .map(([name, e]) => ({ name, count: e.count ?? 0, weight: e.weight ?? 0, high: e.high ?? 0 }))
  .sort((a, b) => (b.count - a.count) || (b.weight - a.weight))

/** 1 级标签：命中数最高的 keywordCount × 3 个 */
export function level1(keywordCount = 4, db = load()) {
  return sortTags(db).slice(0, Math.max(3, keywordCount * 3))
}

/** 2 级标签：全量（已剔除 < MIN_KEEP 的） */
export function level2(db = load()) {
  return sortTags(db)
}

/** 取来用的标签：先 1 级，不够再拿 2 级补 */
export function tagsForSearch(need, keywordCount = 4) {
  const db = load()
  const one = level1(keywordCount, db).map((t) => t.name)
  if (one.length >= need) return { level: 1, tags: one.slice(0, need) }
  const two = level2(db).map((t) => t.name).filter((t) => !one.includes(t))
  return { level: 2, tags: one.concat(two).slice(0, need) }
}

export function stats() {
  const db = load()
  const all = sortTags(db)
  return {
    videos: Object.keys(db.videos).length,
    tags: all.length,
    level1: level1(4, db).map((t) => `${t.name}(${t.count})`),
    keepable: all.filter((t) => t.count >= MIN_KEEP).length,
    top: all.slice(0, 12),
  }
}

/** 本轮标签统计：给一批 BV，返回这批视频里各标签出现次数，从多到少 */
export function readRoundTags(bvs, db = load()) {
  const cnt = {}
  for (const bv of bvs ?? []) {
    const tags = db.videos?.[bv]?.tags ?? []
    for (const t of new Set(tags)) cnt[t] = (cnt[t] ?? 0) + 1
  }
  return Object.entries(cnt).map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

/**
 * 「有人在她 @主人的评论下说话 → 私信主人，问他回不回」
 * （2026-10-30 主人要求）
 *
 * 识别逻辑：
 *   她在视频评论区发的分享评论 = `--share` 发出的评论，`root == 0`（顶层）。
 *   B 站把「回复根评论」记在 `x/msgfeed/reply` 的 `root_id` 里：
 *     有人直接回她的分享 → 那条新回复的 root_id == 她的分享 rpid ✓
 *   所以只要「新回复的 root_id」命中了「她发过的分享 rpid 集合」，就是"在我说的话下面说话" ✓
 *
 * 分享 rpid 从哪来（两条路，任一命中即可）：
 *   ① quota.json 的 log 里的 share 记录（comment.mjs 记账时带 rpid ✓）
 *   ② DSH_HOME/whale-shares.json（本插件自己维护的缓存 ✓ 兜底 ①）
 *
 * 为什么只问主人、不直接回：
 *   那些人是在**公开评论区**说话，回错就不是小事 ✗
 *   而且分享评论下容易招 AI 号/杠精（ai-share 那道闸就是为这个加的 ✓）
 */

/** 从 quota 账本里捞出「她发过的分享评论 rpid」集合 */
export function shareRpidsFromQuota(readJson, quotaFile) {
  const out = new Map()   // rpid -> { bvid, at, text }
  try {
    const q = readJson(quotaFile) ?? {}
    for (const e of q.log ?? []) {
      if (!e?.share || !e.rpid) continue
      // target 形如 "BV:xxxx" 或 "oid:123"
      const target = String(e.target ?? '')
      const bvid = target.startsWith('BV:') ? target.slice(3) : ''
      out.set(String(e.rpid), { bvid, at: e.at ?? '', text: String(e.note ?? '') })
    }
  } catch {}
  return out
}

/** 补一份本插件维护的分享缓存（quota 里没有 rpid 时的兜底） */
export function shareRpidsFromCache(readJson, cacheFile) {
  const out = new Map()
  try {
    const c = readJson(cacheFile) ?? {}
    for (const [rpid, v] of Object.entries(c.shares ?? {})) out.set(String(rpid), v)
  } catch {}
  return out
}

/**
 * 哪些新回复是「挂在我的分享评论下面」的
 * @param fresh pullFeed('reply') 拿到的新条目
 * @param mine  Map<rpid, {bvid, at, text}>
 * @returns 命中的条目（已补上对应的分享信息）
 */
export function repliesUnderMyShares(fresh, mine) {
  if (!mine.size) return []
  const hits = []
  for (const x of fresh) {
    if (x.kind !== 'reply') continue
    const root = String(x.root ?? '')
    if (!root || root === '0') continue          // 顶层评论 → 不是"回复我"
    if (String(x.mid) === '') continue
    const share = mine.get(root)
    if (share) hits.push({ ...x, shareRoot: root, share })
  }
  return hits
}

/**
 * 给主人发的那条询问私信（由插件直接发，不占她的话轮 ✓）
 * 措辞按「主人一句话就能回」来写：回 1=回 / 2=不回
 *
 * ⚠️ 坐标（oid/root/parent）**不在**这条私信里给主人看（他不需要 ✓），
 *    而是存进待审文件 whale-share-reply-pending.json，
 *    主人回「回」之后她去读 → 知道去哪条下面回复 ✓
 */
export function askOwnerText(hits, maxItems = 3) {
  const lines = []
  const n = hits.length
  lines.push(`【有人在你评论下说话】共 ${n} 条`)
  lines.push('')
  let i = 0
  for (const h of hits.slice(0, maxItems)) {
    i += 1
    const url = h.share?.bvid ? `https://www.bilibili.com/video/${h.share.bvid}/#reply${h.shareRoot}` : ''
    lines.push(`${i}. ${h.who}（mid ${h.mid}）回复了你的分享评论`)
    if (url) lines.push(`   视频：${url}`)
    const said = String(h.source || h.title || '').replace(/\s+/g, ' ').slice(0, 120)
    if (said) lines.push(`   他说：${said}`)
    lines.push('')
  }
  if (n > maxItems) lines.push(`（还有 ${n - maxItems} 条，先在评论区/comment-digest 看全）`, '')
  lines.push('要她回吗？直接回我：')
  lines.push('  · 回「回」或「1」→ 她去回复（可以顺便说要怎么回）')
  lines.push('  · 回「不回」或「2」→ 这次不回 ✓')
  return lines.join('\n')
}

/** 待审清单：主人回「回」之后她去读这里拿坐标 ✓ */
export function pendingRecord(hits, now = Date.now()) {
  return {
    at: new Date(now).toISOString(),
    items: hits.map((h) => ({
      who: h.who,
      mid: String(h.mid),
      said: String(h.source || h.title || '').slice(0, 300),
      oid: String(h.oid),
      root: String(h.root),
      parent: String(h.parent),
      business: Number(h.business ?? 1),
      shareRoot: String(h.shareRoot),
      bvid: h.share?.bvid ?? '',
      url: h.share?.bvid ? `https://www.bilibili.com/video/${h.share.bvid}/#reply${h.shareRoot}` : '',
    })),
  }
}

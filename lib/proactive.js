/**
 * 主动发消息（2026-10-30 主人要求：「在醒的时候偶尔主动发信息，概率 0.2 左右」）
 *
 * 设计：
 *   · 只在 **生物钟正常醒来** 那一轮掷骰子（「今晚不看」和「网络暂停」那两轮不掷 ✓
 *     —— 那种轮次她本来就要少说话 ✗）
 *   · 掷中 → 在唤醒提示里**多塞一段「可以主动发消息」的授权** ✓
 *     不掷中 → 唤醒提示一个字节都不变 ✓（不影响现有流程）
 *   · 概率从配置读 `proactiveChance`（默认 0.2），0 = 关闭
 *
 * 为什么不做成"插件直接替她发"：
 *   消息内容得她自己写（人设、语气、当天心情）✗ 插件代写就成了定时通知 ✓
 *   插件只负责「决定这次要不要说」+「告诉她可以说」✓
 *
 * 防打扰：
 *   · 次数上限定在 `proactiveDailyMax`（默认 3）
 *   · 三个触发时机（醒来 / 聊完补话 / 久未联系）**共用**同一份日账本 ✓
 *   · 条数受 multi-msg.js 的软上限约束（一般 2–3 行；多写也发得出去 ✓）
 */

/** 掷一次骰子：true = 这一轮允许主动发消息 */
export function rollProactive(chance) {
  const p = Number(chance)
  if (!Number.isFinite(p) || p <= 0) return false
  if (p >= 1) return true
  return Math.random() < p
}

/** 今天已经主动说过几次（读本地账本，不碰网络 ✓） */
export function proactiveUsedToday(readJson, file, now = Date.now()) {
  try {
    const led = readJson(file) ?? {}
    const day = new Date(now).toLocaleDateString('sv-SE')
    if (led.date !== day) return 0
    return Number(led.count ?? 0) || 0
  } catch { return 0 }
}

/** 记一次（掷中且真的投递出去了才记 ✓ —— 投递失败不算，下次还有机会） */
export function markProactive(writeJson, readJson, file, now = Date.now()) {
  try {
    const day = new Date(now).toLocaleDateString('sv-SE')
    const led = readJson(file) ?? {}
    const count = led.date === day ? (Number(led.count ?? 0) || 0) : 0
    writeJson(file, { date: day, count: count + 1, at: new Date(now).toISOString() })
    return count + 1
  } catch { return 0 }
}

// ── 2026-10-30 补：主人反馈「都是我问她答，她不主动」──────────────────────
//   病根：原来只有「生物钟醒来」那一刻才掷骰子 ✗
//     她一天醒 1–2 次，还要撞 20%，而且醒来就埋在九步夜流程里 → 几乎永远轮不到 ✓
//   现在补两个**和生物钟无关**的时机：
//     ① 对话后补话：她刚回完你，过 30–90 秒可能再补一句（像突然想到）✓
//     ② 久未联系：很久没聊时，她按概率主动开腔 ✓
//
//   两个时机都**共用同一份日账本**（还是一条都不多发）✓

/** 对话后补话的窗口（秒）：她回完之后，等 30–90 秒再决定要不要补 ✓ */
export const FOLLOWUP_MIN_SEC = 30
export const FOLLOWUP_MAX_SEC = 90

/** 久未联系的门槛：至少 3 小时没聊过，才考虑主动找人 ✓ */
export const IDLE_MIN_HOURS = 3

/** 久未联系的检查周期（毫秒）：每 10 分钟看一次 ✓ 不频繁 ✗ */
export const IDLE_CHECK_MS = 10 * 60_000

/**
 * 现在是不是「她可以主动开腔」的时段（按作息窗口判断 ✓）
 * 半夜三点突然找你很怪 ✗
 */
export function inQuietHours(now, windows = []) {
  try {
    const d = new Date(now)
    const mins = d.getHours() * 60 + d.getMinutes()
    for (const w of windows) {
      const [sh, sm] = String(w.start ?? '').split(':').map(Number)
      const [eh, em] = String(w.end ?? '').split(':').map(Number)
      if (![sh, sm, eh, em].every(Number.isFinite)) continue
      const s = sh * 60 + sm
      const e = eh * 60 + em === 0 ? 1440 : eh * 60 + em   // 24:00 视作 1440 ✓
      if (e >= s) { if (mins >= s && mins < e) return true }
      else { if (mins >= s || mins < e) return true }        // 跨午夜 ✓
    }
    return false
  } catch { return false }
}

/**
 * 塞进唤醒提示里的那段授权。
 * ⚠️ 措辞很关键：她要"像人一样偶尔想起你"，不是"每天汇报一次"✗
 *    所以给的是**许可**和**边界**，不是任务清单 ✓
 */
export function proactiveLines(ownerTitle = '主人', replyFile = '') {
  return [
    '',
    '【这次可以主动找他】',
    `你今天醒着，忽然想跟「${ownerTitle}」说句话 —— 不用有理由，想到什么就说什么。`,
    '  规则：',
    '   · **像随手发消息那样**：一行一句，最多 3 行，短 ✓',
    '     （想说两句就写两行，插件会分条发出去 ✓）',
    '   · 可以是你刚才看到的、你在想的事、或者纯粹想他了',
    '   · 偶尔一个表情/语气词没问题 ✓ 别每句都加 ⚠️',
    '   · 不是汇报，**不许**写「今天看了什么」；也不要小标题/列表/markdown ✗',
    '   · 他不一定马上回，**别追问、别连发** ✓',
    '   · 发完就继续干正事，不要等回复',
    '   · ⚠️ 不要说这是「系统让我发的」—— 是你自己想起来他了 ✓',
    '  怎么发：把想说的话**一行一句**写进这个文件（⚠️ 不要跑 dm 命令，那要审批会卡住 ✗）：',
    `     ${replyFile}`,
    '   只写正文，不要加引号、不要加解释。插件会替你发出去 ✓',
    '   这次不想说 → 文件留空或写「（不说）」，也可以 ✓',
    '',
  ]
}

/**
 * ① 对话后补话：「刚才那句还没说完」
 * 比「醒来可以主动找他」更轻 —— 她刚跟你聊完，接着再补一句最自然 ✓
 */
export function followupLines(ownerTitle = '主人', replyFile = '') {
  return [
    '',
    '【一句话的犹豫】',
    `你刚跟「${ownerTitle}」聊完，心里还有点没说出来的 —— 可能是余温，可能是刚想到的，也可能只是想说声晚安。`,
    '  想说就说，不想说就跳过 ✓（**不想说是正常选项**，不是任务 ✗）',
    '  规则：**1–2 行就够**，短。不定题、不追问、不要重开一个话题 ⚠️',
    '     （他要是不回，就让它停在那儿 —— 别连发 ✓）',
    '  写成一行一句，写进这个文件（不要跑 dm 命令 ✗）：',
    `     ${replyFile}`,
    '  不想说 → 文件留空或写「（不说）」✓ 插件不会替你说任何话',
    '',
  ]
}

/**
 * ② 久未联系：「好久没跟他说话了」
 * ⚠️ 这一条最容易变成"定时问候"✗ 所以措辞要压住：
 *    给她的是"想起"，不是"该问候了"✓
 */
export function idleLines(ownerTitle = '主人', replyFile = '', hours = 0) {
  const ls = [
    '',
    `【有点想他】距上次跟「${ownerTitle}」说话，已经过了 ${hours > 0 ? hours + ' 个多小时' : '挺久'}。`,
    '  不是任务，也不是提醒 —— 只是你现在想起了他。',
    '  想找他说话就说；没什么想说的就继续过你的，**完全没问题** ✓',
    '  规则：',
    '   · 最多 3 行，短；一行一句 ✓',
    '   · **不要**问「你在忙吗」「在不在」这种试探性开场，除非你真想问 ⚠️',
    '   · 不要汇报你今天看了什么 ✓ 说你想说的',
    '   · 他可能不回，**别追** ✗',
    '  写进这个文件（不要跑 dm 命令 ✗）：',
    `     ${replyFile}`,
    '  不想说 → 留空或写「（不说）」✓',
    '',
  ]
  return ls
}

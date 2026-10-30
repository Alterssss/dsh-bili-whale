/**
 * 多段私信（2026-10-30 主人要求）——
 * 「别只回一次且一次回很多，像正常人一样，可以自由回多条消息，偶尔加小表情」
 *
 * 机制：
 *   · 她把回复写成**多行**文件，**一行 = 一条消息** ✓
 *   · 插件按行依次发出，**每条之间停顿 1–3 秒**（像人在打字 ✓）
 *   · 空行忽略；`---` 分隔符也当分段（她可能用 markdown ✓）
 *   · 单条超长 → 不动它，交给 dm.mjs 的 300 字闸门拦下并报错 ✓
 *     不在这里偷偷截断 ✗（截断会发出半句话，比不发更糟 ✓）
 *
 * 兼容：
 *   只有一行 → 行为和以前完全一样 ✓（一条消息）
 *   写「（不回）」/「(不回)」/「不回」→ 不回 ✓
 *
 * ⚠️ 为什么不合并成一条再发：
 *   主人要的就是「多条短消息」的节奏感 ✗ 合并回去等于没改 ✓
 */

const SKIP_TOKENS = new Set(['（不回）', '(不回)', '不回'])

/** 把文件内容解析成「要发的若干条消息」 */
export function parseOutgoing(raw) {
  const text = String(raw ?? '')
  if (!text.trim()) return []
  if (SKIP_TOKENS.has(text.trim())) return []
  const parts = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '---' && !/^[-–—]{3,}$/.test(s))
  // 去掉包裹引号（她有时会把整句用引号括起来 ✗）
  const cleaned = parts.map((s) => s.replace(/^[「“"'](.*)[」”"']$/s, '$1').trim()).filter(Boolean)
  return cleaned
}

/** 多条之间的停顿（毫秒）：模拟打字，别像机器人连发 ✓ */
export function gapMs(i, seed = Math.random) {
  const base = 1000 + Math.floor(seed() * 2000)   // 1–3 秒
  // 第一条不等 ✓ 后面每条都等 ✓
  return i === 0 ? 0 : base
}

/**
 * 一次发几条 —— 上限 6（2026-10-30 主人定：最多六行）
 *
 * 历史：
 *   · 最早硬截 3 条 → 她写 6 行会被吞掉 3 行 ✗
 *   · 中间改成软上限 8 条
 *   · 现在按主人要求定在 **6**：超过 6 行只发前 6 行 ✓
 *     截断时保留**靠前的**（她按重要性排过序 ✓）
 *
 * ⚠️ 为什么还要留上限：
 *   模型偶尔会把一大段说明拆成十几行 ✗ 全发就成刷屏了 ✓
 */
export const SOFT_TARGET = 6     // 提示里告诉她"最多 6 行" ✓
export const HARD_CAP = 6        // 超过就截断（保留前 6 条 ✓）

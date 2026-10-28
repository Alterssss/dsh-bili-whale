// 统一配置层 —— 一个文件承载所有"属于使用者"的东西。
//
// 为什么要有它（2026-10-14 外部评审指出的最大架构缺口）：
//   在此之前，"个人化的东西"散在四处、形态还不一样 ——
//     ① `~/.bili-ai/quota.json`（额度/白名单，独立文件）
//     ② `~/.dsh/whale-night.config.json`（作息，独立文件）
//     ③ `whale-diary.md` 的叙事段落（偏好被 feed.mjs 解析 Markdown 提取 ✗ 脆弱）
//     ④ 代码里硬编码（历史昵称 SELF_NAMES ✗）
//   使用者的体验是"我得读源码才知道要改哪" ✗ —— 这不是模板，是作者的自用件。
//   现在：**填一个 `bili-whale.config.json` 就完成自定义** ✓，其余全是中性默认值。
//
// 查找顺序：$BILI_WHALE_CONFIG → ~/.dsh/bili-whale.config.json → 内置默认值（中性）
import fs from 'node:fs'
import path from 'node:path'
// ⚠️ 2026-10-21：configPath 必须 **import 进来** 才可用 ✗
//   `export { configPath } from './paths.mjs'` 只是再导出，不会创建本地绑定 →
//   下面 config() 里的 fs.readFileSync(configPath) 会拿到 undefined → 抛错 → 被 catch 吞掉
//   → 静默退回默认值（self / owner / quota / preferences 全部失效）✗ 实测踩到
import { dshPath, configPath } from './paths.mjs'


const HOME = process.env.USERPROFILE || process.env.HOME || '.'
export { configPath } from './paths.mjs'

/** 中性默认值：不含任何作者的个人信息，换个人也能跑。 */
export const DEFAULTS = {
  sessionRotateDays: 0,
  personaOncePerSession: false,
  risk: { minGapMs: 1500, readHourly: 600, readDaily: 3000, writeHourly: 12, writeDaily: 30, writeGapSec: 120, dmGapSec: 60 },
  persona: {
    name: '<角色名>',
    ownerTitle: '你',      // 助手怎么称呼使用者
    selfClaim: '我',       // 助手怎么自称
    diaryTitle: '今日摘要', // diary show 的标题（想用自己的口吻就改这里）
  },
  preferences: {
    like: ['AI 工具与插件', '鬼畜与怀旧向剪辑', '猫咪', 'Live2D/模型'],
    dislike: ['带货', '擦边', '标题党', '纯搬运'],
  },
  notify: { type: 'none', url: '', template: 'text', cmd: '' },   // none | desktop | webhook | command（见 commands/notify.mjs）
  aliases: [],                  // 历史昵称（兜底用；当前昵称仍从 nav 动态读）
  // 使用者本人（分享型评论要 @ 的人）：mid 用于白名单/查询，name 用于正文里的 @昵称
  // （acc/info 查询会风控，所以 name 缓存一份；改过就用 thread 的 `@到:` 验一下）
  owner: { mid: '', name: '' },
  quota: { shareDaily: 3 },
  // 「标尺」（2026-10-18 加）：分享前必须打分，不到 share.minScore 就是"今天没有值得发的"（合法结果）
  share: { aiCommentGuard: false, aiThreshold: 30, enabled: true, via: 'comment', minScore: 13, silentAfterDays: 3 },  // 分享型（@主人）开关与评分阈值
  // 倾听（2026-10-18 补默认值，与设置页对齐）：评论区 + 直播间
  // 2026-10-24 改默认：\u8bc4\u8bba\u76d1\u542c\u9ed8\u8ba4\u5173\u3001\u79c1\u4fe1\u76d1\u542c\u9ed8\u8ba4\u5f00 \u4f46\u95f4\u9694 60 \u79d2
  //   原因：新装的号多半是刚创的小号 \u2014\u2014 \u957f\u65f6\u95f4\u76d1\u542c\u662f\u98ce\u63a7\u7684\u5934\u53f7\u98ce\u9669 \u2717
  //   \u60f3\u5f00\u5c31\u53bb\u8bbe\u7f6e\u9875\u6253\u5f00 \u2713 \u9ed8\u8ba4\u4e0d\u66ff\u4ed6\u4eec\u6253\u5f00 \u2717
  listen: { dmTransport: 'poll', comment: false, commentIntervalSec: 60, scope: 'both', oncePerPerson: true, allDay: false, dm: true, dmIntervalSec: 60, live: false, liveRoom: '', liveScope: 'owner' },
  // 作息：windows[] = 每天允许醒来的时段（每个窗口 = 一次机会）；maxWakesPerDay 缺省 = 窗口数（硬上限 3）
  night: { windows: [{ start: '20:00', end: '24:00', wakes: 1 }], skipChance: 0.3, minGapMin: 10, maxVideos: 5 },
}

const merge = (base, over) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? merge(base[k] ?? {}, v) : v
  }
  return out
}

let cache = null
/** 读取合并后的配置（带缓存）。 */
export function config() {
  if (cache) return cache
  let user = {}
  try { user = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch { /* 没配置就用默认 */ }
  cache = merge(DEFAULTS, user)
  cache.__hasUserFile = Object.keys(user).length > 0
  return cache
}

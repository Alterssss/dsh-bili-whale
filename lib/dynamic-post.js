/**
 * 醒来时按概率发一条 B 站动态（2026-10-30 主人要求：概率 0.3）
 *
 * 设计：和「主动发消息」同一套模式 ——
 *   · 只在 **生物钟正常醒来** 那一轮掷骰子（「今晚不看」「网络暂停」不掷 ✗）
 *   · 掷中 → 在唤醒提示里多塞一段「可以发条动态」的授权 ✓
 *   · 掷不中 → 唤醒提示一个字节都不变 ✓
 *   · 概率从配置读 `dynamicChance`（默认 0.3），0 = 关闭
 *
 * 为什么要走"写文件 + 插件代发"：
 *   她的会话权限是 ask，自己跑 `dynamic post --go` 会弹审批卡住 ✗
 *   写文件属于 workspace-write，免审批 ✓ 插件进程再代发（仍在请求保护之下 ✓）
 *
 * 防刷屏：一天最多 1 条（`dynamicDailyMax`，默认 1）。
 *   她一天醒 1–2 次，0.3 概率 ≈ 每两三天一条，正常不会触发上限 ✓
 *   上限是防止主人调高概率后动态刷屏 ✗
 */

/** 今天已经发过几条动态（读本地账本 ✓ 不碰网络） */
export function dynamicUsedToday(readJson, file, now = Date.now()) {
  try {
    const led = readJson(file) ?? {}
    const day = new Date(now).toLocaleDateString('sv-SE')
    if (led.date !== day) return 0
    return Number(led.count ?? 0) || 0
  } catch { return 0 }
}

/** 记一次（真的发出去了才记 ✓） */
export function markDynamic(writeJson, readJson, file, now = Date.now()) {
  try {
    const day = new Date(now).toLocaleDateString('sv-SE')
    const led = readJson(file) ?? {}
    const count = led.date === day ? (Number(led.count ?? 0) || 0) : 0
    writeJson(file, { date: day, count: count + 1, at: new Date(now).toISOString() })
    return count + 1
  } catch { return 0 }
}

/**
 * 塞进唤醒提示里的那段授权。
 * ⚠️ 措辞要点：
 *   · 动态是**公开**的，她的关注者都看得见 → 不能写成"只给主人看的话" ✗
 *   · 也不能变成每日汇报 ✗ 要像她自己随手发的一条 ✓
 *   · 动态没有 @ 功能，所以**不要**写 @主人（会变成一个死链）✗
 */
export function dynamicLines(replyFile = '') {
  return [
    '',
    '【想发条动态】',
    '今天心里有点什么，可以顺手发到 B 站动态里 —— 不用是大事，一句吐槽、一个念头、一点心情都行。',
    '  规则：',
    '   · **公开的**：你的关注者会看见。所以别写只有主人懂的私事、别透露你们的对话细节 ✗',
    '   · 短，**1–3 行**就够；像随手发的，不是正文稿 ✓',
    '   · 不要写成「今天看了什么」的汇报 ✗ 也不要小标题/列表/markdown ✗',
    '   · 偶尔一个表情/语气词可以 ✓ 别每句都加 ⚠️',
    '   · 动态里**不要 @主人**（动态没有这个功能，会变成死链 ✗）；想跟他说话就用私信 ✓',
    '   · 不想发就跳过 —— 今天没有想说的完全可以 ✓',
    '  怎么写：把动态正文**一行一句**写进这个文件（⚠️ 不要自己跑 dynamic 命令，那要审批会卡住 ✗）：',
    `     ${replyFile}`,
    '   只写正文，不要加引号、不要加解释。插件会替你发出去 ✓',
    '   这次不想发 → 文件留空或写「（不发）」✓',
    '',
  ]
}

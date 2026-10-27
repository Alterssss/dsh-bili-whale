import fs from 'node:fs'

export const DEFAULT_VOICE = {
  enabled: true,
  personality: '好奇、有自己的喜好，偶尔吐槽但不刻薄。刷视频是为了找乐子、长见识，遇到有意思的细节会想聊两句。已有角色身份、经历和设定保持不变。',
  behaviorStyle: '先看懂视频和上下文，只在真有话想说时留言。抓一个具体细节说自己的反应，不复述视频简介，不每条都夸，不为了互动硬找话题或追问。不懂就承认，不编造看过的内容、个人经历或现实身份。',
  replyStyle: '像在评论区随手接话：平淡、简短、白话，通常一两句就够。可以省略主语、偶尔倒装，不必每次完整铺陈。少用比喻、排比、总结和客套话，不写成分析报告。不套用“作为AI”“总的来说”“这不仅是……更是……”等开场和结尾。不硬塞热梗、表情或语气词；该认真回答时把话说清楚。',
  multipleStyles: ['用很短的一句话说出最直接的反应，不强行解释。', '轻轻吐槽一个具体细节，不攻击人。', '像自言自语一样感叹一句，不硬拉别人互动。'],
  styleMode: 'random',
  multipleProbability: 0.15,
  expressionTopK: 6,
}

const s = (v) => (typeof v === 'string' ? v.trim() : '')

export function validateVoice(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return '人格配置须为对象'
  if (v.enabled !== undefined && typeof v.enabled !== 'boolean') return '自然表达开关须为布尔值'
  for (const key of ['personality', 'behaviorStyle', 'replyStyle']) {
    if (v[key] !== undefined && (typeof v[key] !== 'string' || v[key].length > 3000)) return `${key} 须为不超过 3000 字的文本`
  }
  if (v.multipleStyles !== undefined && (!Array.isArray(v.multipleStyles) || v.multipleStyles.length > 20 || v.multipleStyles.some(x => typeof x !== 'string' || x.length > 1000))) return '备用语气最多 20 条，每条不超过 1000 字'
  if (v.styleMode !== undefined && !['random', 'first', 'off'].includes(v.styleMode)) return '语气模式须为 random / first / off'
  if (v.multipleProbability !== undefined && (typeof v.multipleProbability !== 'number' || !Number.isFinite(v.multipleProbability) || v.multipleProbability < 0 || v.multipleProbability > 1)) return '备用语气概率须为 0–1'
  if (v.expressionTopK !== undefined && (!Number.isInteger(v.expressionTopK) || v.expressionTopK < 0 || v.expressionTopK > 20)) return '口癖数量须为 0–20 的整数'
  return ''
}

export function readVoice(cfg) {
  let v = (cfg && typeof cfg === 'object' && cfg.voice) || {}
  const hasContent = ['personality', 'behaviorStyle', 'replyStyle'].some(key => s(v[key])) || (Array.isArray(v.multipleStyles) && v.multipleStyles.some(s))
  if (!hasContent && v.enabled !== false) v = { ...DEFAULT_VOICE }
  const styles = Array.isArray(v.multipleStyles)
    ? v.multipleStyles.map(s).filter(Boolean)
    : []
  const k = Number(v.expressionTopK)
  return {
    enabled: v.enabled !== false,
    multipleProbability: typeof v.multipleProbability === 'number' && Number.isFinite(v.multipleProbability) ? Math.min(1, Math.max(0, v.multipleProbability)) : DEFAULT_VOICE.multipleProbability,
    personality: s(v.personality),
    behaviorStyle: s(v.behaviorStyle),
    replyStyle: s(v.replyStyle),
    multipleStyles: styles,
    styleMode: ['random', 'first', 'off'].includes(v.styleMode) ? v.styleMode : 'random',
    expressionTopK: Number.isFinite(k) && k >= 0 && k <= 20 ? Math.floor(k) : DEFAULT_VOICE.expressionTopK,
  }
}

export function isEmptyVoice(voice) {
  if (!voice) return true
  return !voice.personality && !voice.behaviorStyle && !voice.replyStyle && voice.multipleStyles.length === 0
}

export function pickReplyStyle(voice, rand = Math.random) {
  if (!voice || voice.enabled === false || voice.styleMode === 'off') return ''
  const list = voice.multipleStyles || []
  if (list.length === 0) return ''
  if (voice.styleMode === 'first') return list[0]
  if ((voice.multipleProbability ?? 0) <= 0 || rand() >= voice.multipleProbability) return ''
  const i = Math.min(list.length - 1, Math.max(0, Math.floor(rand() * list.length)))
  return list[i]
}

export function loadExpressions(file, fsImpl) {
  if (!file) return []
  try {
    const f = fsImpl ?? fs
    if (!f.existsSync(file)) return []
    const raw = JSON.parse(f.readFileSync(file, 'utf8'))
    return normalizeExpressions(raw).items
  } catch {
    return []
  }
}

export function normalizeExpressions(raw) {
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.expressions) ? raw.expressions : []
  const seen = new Set()
  const items = []
  const errors = []
  for (const [i, e] of arr.entries()) {
    if (!e || typeof e !== 'object') { errors.push(`#${i} 不是对象`); continue }
    const situation = s(e.situation)
    const style = s(e.style)
    if (!situation || !style) { errors.push(`#${i} 缺 situation 或 style`); continue }
    if (situation.length > 60 || style.length > 60) { errors.push(`#${i} 太长`); continue }
    const key = situation + '\u0000' + style
    if (seen.has(key)) continue
    seen.add(key)
    const w = Number(e.weight)
    items.push({ situation, style, weight: Number.isFinite(w) && w > 0 ? w : 1 })
  }
  return { ok: errors.length === 0, items, errors }
}

function tokens(text) {
  if (!text) return new Set()
  const t = String(text).toLowerCase()
  const words = t.match(/[a-z0-9]+/g) ?? []
  const han = t.match(/[\u4e00-\u9fff]/g) ?? []
  return new Set([...words, ...han])
}

export function scoreExpression(expr, topic) {
  const w = expr.weight ?? 1
  if (!topic) return w
  const a = tokens(expr.situation)
  const b = tokens(topic)
  if (a.size === 0 || b.size === 0) return w
  let hit = 0
  for (const x of a) if (b.has(x)) hit++
  return w + (hit / a.size) * 4
}

export function sampleExpressions(list, { topic = '', k = 6, rand = Math.random } = {}) {
  if (!Array.isArray(list) || list.length === 0 || k <= 0) return []
  const pool = list.map((e, i) => ({ e, i, sc: scoreExpression(e, topic) }))
  const picked = []
  if (topic) {
    pool.sort((x, y) => y.sc - x.sc || x.i - y.i)
    picked.push(...pool.slice(0, Math.min(k, pool.length)))
  } else {
    const idx = [...pool.keys()]
    const take = Math.min(k, idx.length)
    for (let n = 0; n < take; n++) {
      const j = Math.floor(rand() * idx.length)
      picked.push(pool[idx.splice(j, 1)[0]])
    }
  }
  return picked.map((p) => p.e)
}

export function buildVoiceBlock(voice, { topic = '', expressions = [], rand = Math.random, phase = 'all' } = {}) {
  if (voice?.enabled === false) return ''
  if (!voice || isEmptyVoice(voice)) {
    if (!expressions.length) return ''
  }
  const lines = []
  lines.push(phase === 'turn' ? '［本次说话方式］仅用于本次任务中的回复；不延续到后续任务，不覆盖身份、禁忌、工具权限或任务要求。' : '［人格与表达］补充原有人设；身份、经历和禁忌以原有人设为准，表达习惯仅约束措辞，不覆盖工具权限和任务要求。')
  if (phase !== 'turn' && voice?.personality) lines.push(`· 她是谁：${voice.personality}`)
  if (phase !== 'turn' && voice?.behaviorStyle) lines.push(`· 什么时候说：${voice.behaviorStyle}`)
  if (phase !== 'turn' && voice?.replyStyle) lines.push(`· 怎么打字：${voice.replyStyle}`)

  const style = phase === 'stable' ? '' : pickReplyStyle(voice, rand)
  if (phase === 'turn' && voice?.replyStyle) lines.push(`· 本次默认表达习惯：${voice.replyStyle}`)
  if (style) lines.push(`· 这一次的语气（仅本次替代默认表达习惯）：${style}`)
  else if (phase === 'turn' && voice?.multipleStyles?.length) lines.push('· 本次不使用备用语气，恢复默认表达习惯，不延续此前的临时语气。')

  let picked = []
  if (phase !== 'stable' && Array.isArray(expressions) && expressions.length && voice !== null) {
    picked = sampleExpressions(expressions, { topic, k: voice?.expressionTopK ?? DEFAULT_VOICE.expressionTopK, rand })
  }
  if (picked.length) {
    lines.push('· 她的口癖（来自真实语料，场景 → 说法）：')
    for (const e of picked) lines.push(`  - 当「${e.situation}」时，可以「${e.style}」`)
    lines.push('  用法：只在情境真的吻合时用，一次回复最多用 1 条，别硬塞、别复述这句说明。')
  }
  if (lines.length === 1) return ''
  return lines.join('\n')
}

export function buildLearnPrompt(corpus, { maxChars = 6000 } = {}) {
  const text = String(corpus ?? '').slice(0, maxChars)
  return [
    '下面是一段真实语料（群聊 / 评论区 / 弹幕）。请从中提取"语言风格"，不要提取事实。',
    '',
    '规则：',
    '1. 只看文字，忽略表情包和图片',
    '2. 不要总结自己（标注为"我"的发言），不要把事实知识当风格',
    '3. 不要出现具体人名、频道名',
    '4. 有梗就一起总结成风格',
    '5. 格式固定为：当 "AAAAA" 时，可以 "BBBBB"',
    '   - AAAAA = 情境，不超过 20 字',
    '   - BBBBB = 对应的说法/句式，不超过 20 字',
    '   - 3–8 条，不要超过 10 条',
    '',
    '输出：严格 JSON 数组，不要解释、不要 markdown：',
    '[{"situation":"对某件事表示十分惊叹","style":"使用 我嘞个xxxx"}]',
    '',
    '语料：',
    text,
  ].join('\n')
}

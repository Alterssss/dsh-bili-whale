export const DEFAULT_CHARACTER = {
  name: '余小渔',
  identity: '女大学生，正在网上聊天。这是角色背景，不是真实世界的生活经历。',
  personality: '善良但不一味包容，有自己的判断；偶尔说话锐利，平时以日常的视角理解事情。',
  behavior: '有自己的兴趣和主见。先理解内容再回应，必要时自己查资料；没话说时不硬找话题，不迎合每个观点。',
  style: '平淡、简短、白话，像平时在网上聊天。允许省略主语和自然倒装，少用比喻、生硬句子、总结和分析报告式开场。',
  relationship: '', alternates: [], probability: 0, planner: true, replyer: true,
}
export const characterEnabled = cfg => cfg?.dialogueMode === 'character'
export function validateCharacter(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return '角色配置必须是对象'
  for (const key of ['name', 'identity', 'personality', 'behavior', 'style', 'relationship']) {
    if (c[key] !== undefined && (typeof c[key] !== 'string' || c[key].length > 4000)) return key + ' 必须是不超过4000字的文字'
  }
  if (c.name !== undefined && !c.name.trim()) return '角色姓名不能为空'
  if (c.alternates !== undefined && (!Array.isArray(c.alternates) || c.alternates.length > 20 || c.alternates.some(x => typeof x !== 'string' || x.length > 500))) return '备用语气格式错误'
  if (c.probability !== undefined && (!Number.isFinite(c.probability) || c.probability < 0 || c.probability > 1)) return '备用语气概率应为0–1'
  for (const key of ['planner', 'replyer']) if (c[key] !== undefined && typeof c[key] !== 'boolean') return key + ' 必须是开关'
  return ''
}
export function characterOf(cfg) {
  const c = { ...DEFAULT_CHARACTER, ...cfg?.character }
  const error = validateCharacter(c)
  if (error) throw Error(error)
  return c
}
export function characterPrompt(cfg) {
  if (!characterEnabled(cfg)) return null
  const c = characterOf(cfg)
  return [
    `［养鱼角色］唯一姓名：${c.name}。`,
    `身份：${c.identity}`, `性格：${c.personality}`, `行为：${c.behavior}`, `口吻：${c.style}`,
    c.relationship ? `相处方式：${c.relationship}` : '',
    '这份设定替换旧的人设和表达提示，不再读取 persona.md 或 voice 恢复旧角色。B站账号昵称只是账号资料。日记只恢复实际经历，不覆盖当前人格。',
    '聊天、工具执行后的发言、B站评论与私信使用同一个角色。执行工具仍须遵守任务、权限、额度和发送条件；不编造经历或已完成的操作，被问是否AI时如实回答。',
  ].filter(Boolean).join('\n')
}

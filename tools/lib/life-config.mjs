import {affectConfig,AFFECT_DEFAULTS} from './affect-config.mjs'
import {dynamicConfig,DYNAMIC_DEFAULTS} from './dynamic-memory-config.mjs'
export const LIFE_DEFAULTS = {
  affect:AFFECT_DEFAULTS,
  dynamicMemory:DYNAMIC_DEFAULTS,
  enabled: true, paused: false, draftMode: 'cat-draft', requireDraft: false,
  threadReplies: 4, threadDaily: 8, cooldownMinutes: 60, duplicateHours: 24,
  memoryChars: 5000, recentEvents: 20, retentionDays: 30, maxEvents: 1200,
  autonomy: false, autonomyDaily: 1, autonomyMinutes: 5, autonomyReads: 4, autonomyDelayMinutes: 10,
  learnFromLikes: false,
  learningEnabled:true, formationWakeIntervalSec:21600, learningIntervalSec:300, learningLeaseSec:600, learningDailyJobs:24, learningMaxMemories:1000,
  hardMode: 'warn', hardScenes: ['public-comment'], hardMaxChars: 60, hardWarnAt: 40,
  hardEmojiWarn: false, hardAtWarn: false, hardDisabledRules: [], commentVerifySeconds: 30,
  corpusEnabled:true, corpusChars:1000, corpusExamples:3,
}
export function lifeConfig(input = {}) {
  const c = { ...LIFE_DEFAULTS, ...input, affect:affectConfig(input.affect), dynamicMemory:{...dynamicConfig(input.dynamicMemory),enabled:true,shadow:false} }
  for (const key of ['enabled','paused','requireDraft','autonomy','learnFromLikes','hardEmojiWarn','hardAtWarn','corpusEnabled','learningEnabled']) {
    if (typeof c[key] !== 'boolean') throw Error('life.' + key + ' 必须是布尔值')
  }
  for (const [key, min, max] of [
    ['formationWakeIntervalSec',300,86400],['learningIntervalSec',30,86400],['learningLeaseSec',60,3600],['learningDailyJobs',0,100],['learningMaxMemories',200,10000],
    ['threadReplies',1,30],['threadDaily',1,100],['cooldownMinutes',1,10080],
    ['duplicateHours',1,720],['memoryChars',500,20000],['recentEvents',1,100],
    ['retentionDays',7,365],['maxEvents',100,10000],['autonomyDaily',0,5],
    ['autonomyMinutes',1,30],['autonomyReads',1,30],['autonomyDelayMinutes',1,1440],
    ['hardMaxChars',20,1000],['hardWarnAt',0,1000],['commentVerifySeconds',1,30],
    ['corpusChars',300,4000],['corpusExamples',1,5],
  ]) {
    if (!Number.isInteger(c[key]) || c[key]<min || c[key]>max) throw Error('life.'+key+' 超出范围 '+min+'–'+max)
  }
  if (!['direct','cat-draft'].includes(c.draftMode)) throw Error('草稿方式必须为 direct 或 cat-draft')
  if(!['off','warn','enforce'].includes(c.hardMode))throw Error('硬框架方式必须为 off / warn / enforce')
  if(!Array.isArray(c.hardScenes)||c.hardScenes.some(s=>!['private-recommendation','public-comment','reply','private-reply'].includes(s)))throw Error('硬框架场景无效')
  if(!Array.isArray(c.hardDisabledRules)||c.hardDisabledRules.length>100||c.hardDisabledRules.some(s=>typeof s!=='string'||s.length>100))throw Error('停用规则列表无效')
  if(c.hardWarnAt>c.hardMaxChars)throw Error('硬框架提醒长度不能大于拒绝长度')
  return c
}

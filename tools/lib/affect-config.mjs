export const AFFECT_DEFAULTS=Object.freeze({enabled:true,moodHalfLifeHours:6,shareDecayPerHour:2,shareAccrualPerHour:6,trigger:70,rearm:40,initiativeGapMinutes:180,initiativeDailyMax:2,ownerIdleMinutes:30,analysisDailyMax:24,coverageDailyMax:6})
export function affectConfig(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('life.affect 必须是对象')
  const c={...AFFECT_DEFAULTS,...input}
  if(typeof c.enabled!=='boolean')throw Error('affect.enabled 必须是布尔值')
  for(const [k,min,max] of [['moodHalfLifeHours',1,48],['shareDecayPerHour',0,10],['shareAccrualPerHour',0,10],['trigger',40,100],['rearm',0,60],['initiativeGapMinutes',60,1440],['initiativeDailyMax',0,5],['ownerIdleMinutes',15,1440],['analysisDailyMax',0,100],['coverageDailyMax',0,24]])if(!Number.isFinite(c[k])||c[k]<min||c[k]>max)throw Error('affect.'+k+' 超出范围')
  if(c.rearm>=c.trigger)throw Error('affect.rearm 必须小于 trigger')
  return c
}

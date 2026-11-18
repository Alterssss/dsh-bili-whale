export const CHAT_DEFAULTS=Object.freeze({multi:true,maxParts:6,followup:false,idle:false,chance:0.2,idleHours:3,dailyMax:3,shareReply:false,dynamic:false,dynamicChance:0.3,dynamicDailyMax:1})
export function chatConfig(input={}) {
  const out={...CHAT_DEFAULTS}
  for(const key of ['multi','followup','idle','shareReply','dynamic'])if(typeof input?.[key]==='boolean')out[key]=input[key]
  for(const [key,min,max] of [['maxParts',1,6],['chance',0,1],['idleHours',3,168],['dailyMax',0,3],['dynamicChance',0,1],['dynamicDailyMax',0,1]]){
    const n=Number(input?.[key]);if(input?.[key]!=null&&Number.isFinite(n))out[key]=Math.max(min,Math.min(max,n))
  }
  for(const key of ['maxParts','dailyMax','dynamicDailyMax'])out[key]=Math.floor(out[key])
  return out
}

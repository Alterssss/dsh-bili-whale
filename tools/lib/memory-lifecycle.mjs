import {relationView,relationTopics} from './memory-relations.mjs'
import {terms} from './memory-index.mjs'
import {inScope} from './memory-scope.mjs'
import {DYNAMIC_DEFAULTS,TEMPORAL_KINDS} from './dynamic-memory-config.mjs'
const DAY=86400000
export const mandatoryMemory=m=>['preference','expression_policy'].includes(m.type)
export function temporalKind(m){return m.lifecycle?.temporalKind??m.temporalKind??({pattern:'recent_pattern',preference:'stable_preference',expression_policy:'stable_preference',commitment:'commitment',episodic:'episodic',memory:'episodic'}[m.type]??'understanding')}
export function lifecycleDefaults(m){
 const temporal=temporalKind(m),at=['current_state','recent_pattern'].includes(temporal)?m.observationWindow?.to??m.at??0:m.acceptedAt??m.at??0
 return {schema:1,temporalKind:temporal,validFrom:at,validUntil:m.expiresAt??(temporal==='current_state'?at+DAY:null),
 reviewDueAt:temporal==='recent_pattern'?at+14*DAY:temporal==='understanding'&&m.epistemic==='inferred'?m.reviewAfter??at+30*DAY:null,
 recallControl:m.recallEnabled===false?'legacy_blocked':'enabled',retention:{class:mandatoryMemory(m)||temporal==='commitment'?'important':'normal',pinnedBy:null,reason:null}}
}
export function validateTemporal(input){
 if(input.temporalKind!==undefined&&!TEMPORAL_KINDS.includes(input.temporalKind))throw Error('未知时间类型')
 // Explicit time windows come from trusted management, not invented model timestamps.
 if(input.validUntil!==undefined||input.validFrom!==undefined)throw Error('模型不能自行指定现实有效时间')
 return input.temporalKind
}
export function lifecycleView(m,at,access={},cfg=DYNAMIC_DEFAULTS){
 const l={...lifecycleDefaults(m),...m.lifecycle},kind=l.temporalKind
 let validity='current'
 if(!m.active||['revoked','superseded','disputed'].includes(m.status))validity=m.status??'revoked'
 else if(m.stale||l.validity==='disputed')validity=m.stale?'needs_review':'disputed'
 else if(l.validUntil!==null&&l.validUntil<=at)validity='historical'
 else if(l.reviewDueAt!==null&&l.reviewDueAt<=at&&!mandatoryMemory(m)&&kind!=='commitment')validity='needs_review'
 const half=cfg.halfLives[kind]*1000,age=Math.max(0,at-(access.evaluatedAt??m.acceptedAt??m.at??at))
 const useMass=Math.max(0,access.useMass??0)*2**(-age/half)
 const relation=relationView(m,at,half)
 const last=relation.lastRelatedAt??m.acceptedAt??m.at??at
 const recency=2**(-Math.max(0,at-last)/half)
 const attention=Math.min(1,0.75*recency+0.25*Math.min(1,Math.log1p(relation.mass)/Math.log(9)))
 const forgettingDays={current_state:1,recent_pattern:14,episodic:30,stable_preference:90,understanding:90}
 const protectedMemory=['important','protected'].includes(l.retention?.class)||mandatoryMemory(m)||kind==='commitment'
 const forgotten=!protectedMemory&&relation.mass<1&&at-last>(forgettingDays[kind]??90)*DAY
 const tier=forgotten?'dormant':attention>=0.6?'hot':attention>=0.25?'warm':attention>=0.05?'cold':'dormant'
 return {...l,validity,tier,attention,relation,retentionStage:protectedMemory?'protected':forgotten?'dormant':relation.count>=3&&relation.independentDays>=2?'long-term':'ordinary',useMass,evaluatedAt:at,effectiveUseCount:access.effectiveUseCount??0,lastFetchedAt:access.lastFetchedAt??null,lastTaskUseAt:access.lastTaskUseAt??null}
}
export function recallEligibility(m,scene,at,{historical=false,access={},cfg=DYNAMIC_DEFAULTS}={}){
 const v=lifecycleView(m,at,access,cfg)
 if(!m.active||['revoked','superseded','disputed'].includes(v.validity))return {allowed:false,reason:v.validity,view:v}
 if(m.recallEnabled===false||v.recallControl!=='enabled')return {allowed:false,reason:v.recallControl==='enabled'?'legacy_blocked':v.recallControl,view:v}
 if(!inScope(m,scene))return {allowed:false,reason:'scope',view:v}
 if(!historical&&v.validity!=='current')return {allowed:false,reason:v.validity,view:v}
 return {allowed:true,reason:historical&&v.validity!=='current'?'historical-only':'eligible',view:v}
}
export function rankMemories(memories,{query='',scene,at,access={},cfg=DYNAMIC_DEFAULTS,historical=false}={}){
 const tokens=[...terms(query).slice(0,200),...relationTopics(query)]
 const rows=[]
 for(const m of memories){
  const check=recallEligibility(m,scene,at,{historical,access:access[m.id],cfg});if(!check.allowed)continue
  const words=new Set([...terms(m.text+' '+JSON.stringify(m.behaviorLinks??[])),...relationTopics(m.text)])
  const hits=tokens.filter(t=>words.has(t)||(t.length===1&&String(m.text).includes(t))).length,relevance=tokens.length?hits/tokens.length:0
  const required=mandatoryMemory(m),v=check.view
  v.longTermThreshold=3
  // Hotness alone never overrides a nonmatching explicit query.
  if(!required&&tokens.length&&!hits)continue
  if(!required&&!tokens.length&&!historical&&!['hot','warm'].includes(v.tier))continue
  const importance=v.retention?.class==='protected'?0.1:v.retention?.class==='important'?0.05:0
  rows.push({memory:m,view:v,required,score:4*relevance+cfg.maxUseBoost*v.attention+importance,relevance,reason:required?'mandatory':hits?'query-match':'recent-context'})
 }
 return rows.sort((a,b)=>Number(b.required)-Number(a.required)||b.score-a.score||String(a.memory.id).localeCompare(String(b.memory.id)))
}
export function migrateLifecycle(s,{apply=false}={}){
 const changes=s.memories.filter(m=>!m.lifecycle).map(m=>({id:m.id,lifecycle:lifecycleDefaults(m)}))
 if(apply)for(const row of changes)s.memories.find(m=>m.id===row.id).lifecycle=row.lifecycle
 return {schema:1,dryRun:!apply,count:changes.length,legacyBlocked:changes.filter(x=>x.lifecycle.recallControl==='legacy_blocked').length,changes}
}

import {normalizeRelationProposals,commitRelationProposals} from './memory-relations.mjs'
import {dynamicActive} from './dynamic-memory-config.mjs'
import {lifecycleView,lifecycleDefaults,validateTemporal,migrateLifecycle} from './memory-lifecycle.mjs'
import crypto from 'node:crypto'
import {formationDiagnostic} from './formation-diagnostic.mjs'
import {contextScore} from './context-relevance.mjs'
import {digest,visible,applicable,SCENES,validatePolicy} from './memory-context.mjs'

export const selfAction=e=>e?.kind==='sent'&&e.origin==='tool'&&['apiAccepted','visibilityConfirmed'].includes(e.phase)&&!!String(e.receipt??'').trim()
const selfKey=e=>'sent:'+e.channel+':'+e.target+':'+e.receipt
const DAY=86400000
const uid=()=>crypto.randomUUID()
const unique=a=>[...new Set(a)]
const text=(v,max=4000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('记忆文本为空或超限');return v.trim()}
const snapshotIndexes=new WeakMap()
export function cognitionIndexes(s){
  let index=snapshotIndexes.get(s)
  if(!index||index.events!==s.events||index.count!==s.events.length){
    const byId=new Map(),byOrigin=new Map(),byKey=new Map()
    for(const e of s.events){byId.set(e.id,e);if(e.key)byKey.set(e.key,e);for(const origin of e.originEvidenceIds??[e.id]){if(!byOrigin.has(origin))byOrigin.set(origin,new Set());byOrigin.get(origin).add(e.id)}}
    index={events:s.events,count:s.events.length,byId,byOrigin,byKey};snapshotIndexes.set(s,index)
  }
  return index
}
export function cognitiveState(s){
  return s.cognition??={schema:1,seq:0,cursor:0,jobs:[],working:{revision:0,exchanges:[],outbound:[],situations:[],questions:[],overrides:[]},episodes:[],traces:[],deletedIds:[],indexRevision:-1,bindings:[],lastRunAt:0}
}
export function observeEvent(s,e,{trusted=false}={}){
  const c=cognitiveState(s)
  if(!e.seq)e.seq=++c.seq
  e.schemaVersion=2;e.originEvidenceIds??=[e.id]
  if(trusted)e.verifiedRole=e.origin==='owner'?'owner':e.origin==='tool'?'tool':'other'
  const w=c.working
  if(e.kind==='received'){
    w.exchanges.push({id:e.id,at:e.at,text:e.text,channel:e.channel??'bili-dm',replyTo:e.replyTo??null,episodeId:e.episodeId??null,visibility:e.data?.visibility??'private'})
    w.exchanges=w.exchanges.slice(-30);w.revision++
  }
  if(['sent','outbound'].includes(e.kind)){
    w.outbound.push({id:e.id,at:e.at,text:e.text,channel:e.channel,target:e.target,taskId:e.taskId??null,episodeId:e.episodeId??null,receipt:e.receipt??null,phase:e.phase??'uncertain',visibility:e.channel==='comment'?'public':'private'})
    w.outbound=w.outbound.slice(-20);w.revision++
  }
}
export function changeRevision(s,{policy=false,permission=false}={}){
  s.settings.memoryRevision=(s.settings.memoryRevision??0)+1
  if(policy)s.settings.policyRevision=(s.settings.policyRevision??0)+1
  if(permission)s.settings.permissionVersion=(s.settings.permissionVersion??0)+1
  if(policy||permission)for(const d of s.drafts)if(['editing','pending'].includes(d.status)){d.status='discarded';d.reason='memory-policy-changed'}
}
export const learningKinds=new Set(['received','observed','video-read','sent','activity-result'])
function evidenceView(e){return {id:e.id,at:e.at,seq:e.seq,kind:e.kind,text:String(e.text??'').slice(0,2000),truncated:String(e.text??'').length>2000,origin:e.origin,verifiedRole:e.verifiedRole,channel:e.channel,replyTo:e.replyTo,visibility:visible(e,'public')?'public':'private',phase:e.phase,receipt:e.receipt,target:e.target,originEvidenceIds:e.originEvidenceIds}}
function allOrigins(events,ids,seen=new Set()){
  const out=[]
  for(const id of ids){if(seen.has(id))continue;seen.add(id);const e=events.get(id);if(!e)throw Error('证据链缺失');const parents=e.originEvidenceIds??[id];if(parents.length===1&&parents[0]===id)out.push(id);else out.push(...allOrigins(events,parents,seen))}
  return unique(out)
}
function checkLease(s,id,token,stage,now){
  const c=cognitiveState(s),j=c.jobs.find(j=>j.id===id)
  if(!j||j.stage!==stage||j.tokenHash!==digest(String(token))||j.expiresAt<=now)throw Error('归纳作业无效、过期或阶段已变化')
  if(s.settings.paused)throw Error('归纳已暂停')
  if(j.permissionVersion!==(s.settings.permissionVersion??0))throw Error('归纳权限版本已变化')
  for(const row of j.inputs){const e=cognitionIndexes(s).byId.get(row.id);if(!e||digest(e)!==row.hash||c.deletedIds.includes(row.id))throw Error('归纳来源已变化或删除')}
  return j
}
function cognitiveUse(input){
  const use={}
  for(const [field,max] of [['appliesTo',500],['doThis',800],['falsifiedBy',500]]){
    try{use[field]=text(input[field],max)}catch{throw Error('认知候选需要有效的 '+field+'（非空且不超限）')}
  }
  return use
}
function normalizeCandidate(s,j,input,now){
  const types=['fact','episodic','pattern','understanding','preference','expression_policy','commitment']
  if(!types.includes(input.type))throw Error('不支持自动形成的记忆类型')
  const subject=input.subject??'world'
  if(!['self','owner','world'].includes(subject))throw Error('认知 subject 无效')
  if(subject==='self'&&(!['pattern','understanding','episodic'].includes(input.type)||input.epistemic==='owner_explicit'))throw Error('自我认知只能是暂定行为理解')
  const key=text(input.key,100),statement=text(input.text),allowed=new Set(j.inputs.map(x=>x.id))
  if(!Array.isArray(input.sourceIds)||!input.sourceIds.length||input.sourceIds.length>20||input.sourceIds.some(id=>!allowed.has(id)))throw Error('候选必须引用本批次 1–20 条来源')
  const ids=unique(input.sourceIds),refs=ids.map(id=>cognitionIndexes(s).byId.get(id)),refById=new Map(refs.map(e=>[e.id,e]))
  if(!Array.isArray(input.quotes)||ids.some(id=>!input.quotes.some(q=>q.eventId===id&&typeof q.text==='string'&&q.text.trim()&&evidenceView(refById.get(id)).text.includes(q.text))))throw Error('每条证据需可核对的原文引用')
  let scenes=input.scope?.scenes
  if(!Array.isArray(scenes)||!scenes.length||scenes.some(x=>!SCENES.slice(0,5).includes(x)))throw Error('需明确适用场景')
  let visibility=input.visibility==='public'?'public':'private'
  const selfFromPrivate=subject==='self'&&['pattern','understanding'].includes(input.type)&&refs.some(e=>!visible(e,'public'))
  if(visibility==='public'&&selfFromPrivate){visibility='private';scenes=['private-reply','private-recommendation']}
  if(visibility==='public'&&refs.some(e=>!visible(e,'public')))throw Error('私密证据不能自动公开')
  if(visibility==='private'&&scenes.some(x=>!x.startsWith('private-')))throw Error('私密学习仅适用于私人场景')
  const origins=allOrigins(cognitionIndexes(s).byId,ids)
  const temporal=validateTemporal(input)
  if(temporal==='stable_preference'&&!['preference','expression_policy'].includes(input.type)||temporal==='commitment'&&input.type!=='commitment')throw Error('时间类型不能提升候选权限')
  const c={subject,temporalKind:temporal,key,type:input.type,text:statement,sourceIds:ids,originEvidenceIds:origins,quotes:input.quotes.map(q=>({eventId:q.eventId,text:text(q.text,2000)})),scope:{scenes:unique(scenes)},visibility,
    selfFromPrivate,scopeAdjusted:selfFromPrivate&&input.visibility==='public',epistemic:'inferred',counterEvidenceIds:[],alternatives:[],behaviorLinks:[],observationWindow:{from:Math.min(...refs.map(e=>e.at)),to:Math.max(...refs.map(e=>e.at))},reviewAfter:now+30*DAY}
  if(input.baseId){const old=s.memories.find(m=>m.id===input.baseId&&m.active);if(!old||j.memoryVersions[old.id]!==input.baseVersion||(old.version??1)!==input.baseVersion)throw Error('候选替换版本已变化');c.baseId=old.id;c.baseVersion=input.baseVersion}
  if(input.counterEvidenceIds!==undefined){if(!Array.isArray(input.counterEvidenceIds)||input.counterEvidenceIds.some(id=>!allowed.has(id)))throw Error('反例不在授权批次');c.counterEvidenceIds=unique(input.counterEvidenceIds)}
  if(input.alternatives!==undefined){if(!Array.isArray(input.alternatives)||input.alternatives.length>4)throw Error('替代解释超限');c.alternatives=input.alternatives.map(x=>text(x,600))}
  if(['pattern','understanding'].includes(c.type)&&!c.alternatives.length)throw Error('推断需要考虑替代解释')
  if(input.behaviorLinks!==undefined){if(!Array.isArray(input.behaviorLinks)||input.behaviorLinks.length>4)throw Error('行为影响超限');c.behaviorLinks=input.behaviorLinks.map(x=>({when:text(x.when,500),adjustment:text(x.adjustment,800),limits:text(x.limits,500)}))}
  if(['pattern','understanding'].includes(c.type)){
    Object.assign(c,cognitiveUse(input))
    const link={when:c.appliesTo,adjustment:c.doThis,limits:c.falsifiedBy}
    // Keep the actionable contract available to existing behavior-link consumers.
    if(!c.behaviorLinks.some(x=>x.when===link.when&&x.adjustment===link.adjustment&&x.limits===link.limits)){
      c.behaviorLinks.unshift(link)
    }
  }
  if(c.type==='fact'&&!refs.some(e=>e.verifiedRole==='owner'||['video-read','observed'].includes(e.kind)&&!['model','formation'].includes(e.origin)))throw Error('事实需要已读材料、观察或明确消息来源')
  if(c.type==='expression_policy')c.policy=validatePolicy(input,ids)
  if(c.type==='preference'){
    if(!['exclude','prefer','note'].includes(input.effect)||!['keyword','author','bvid','mention-owner'].includes(input.scope?.field))throw Error('程序偏好字段无效')
    c.effect=input.effect;c.scope={...c.scope,scene:input.scope.scene,field:input.scope.field,value:text(input.scope.value,200)}
    if(!['watch','recommend','public','private','all'].includes(c.scope.scene))throw Error('程序偏好场景无效')
  }
  c.ownerEvidence=refs.some(e=>e.verifiedRole==='owner')
  c.requestedAuthority=input.epistemic==='owner_explicit'?'owner_explicit':'inferred'
  // The classifier cannot elevate model/legacy text to a verified owner directive.
  if(c.requestedAuthority==='owner_explicit'&&!c.ownerEvidence)throw Error('缺少可信主人来源')
  return c
}

function memoryForFormation(m){
 return {id:m.id,version:m.version??1,subject:m.subject??'world',type:m.type,text:m.text,scope:m.scope,visibility:m.visibility,epistemic:m.epistemic,sourceIds:m.sourceIds,
   appliesTo:m.appliesTo,doThis:m.doThis,falsifiedBy:m.falsifiedBy,alternatives:m.alternatives,behaviorLinks:m.behaviorLinks,temporalKind:m.temporalKind,observationWindow:m.observationWindow}
}
function relationReviewInput(s,j){
 const ids=new Set([...(j.relations??[]).map(r=>r.memoryId),...(j.candidates??[]).map(c=>c.baseId).filter(Boolean)])
 return {events:j.inputs.map(r=>evidenceView(cognitionIndexes(s).byId.get(r.id))),candidates:j.candidates,relations:j.relations??[],memories:s.memories.filter(m=>ids.has(m.id)).map(memoryForFormation),summary:j.summary}
}
function candidateEvidence(s,candidate,d){
 const old=candidate.baseId?s.memories.find(m=>m.id===candidate.baseId):null
 if(candidate.baseId&&(!old||!old.active||(old.version??1)!==candidate.baseVersion))throw Error('归纳替换目标版本冲突')
 const explicit=candidate.subject!=='self'&&candidate.requestedAuthority==='owner_explicit'&&candidate.ownerEvidence&&d.explicitDirective===true&&d.longTerm===true
 const roots=candidate.originEvidenceIds.map(id=>cognitionIndexes(s).byId.get(id))
 const observations=roots.filter(e=>e&&(selfAction(e)||e.kind==='received'&&e.verifiedRole==='owner'||e.kind==='video-read'||e.kind==='observed'&&e.origin!=='model'))
 const independentKeys=unique(observations.map(e=>selfAction(e)?selfKey(e):e.kind==='video-read'?'video:'+e.target:e.id))
 const independentDays=unique(observations.map(e=>new Date(e.at+8*3600000).toISOString().slice(0,10)))
 return {old,explicit,independentKeys,independentDays}
}
function formationHistory(c,j,stage,diagnostic,at,status){
 c.history??=[];c.history.push({jobId:j.id,stage,through:j.through,at,status,...diagnostic});c.history=c.history.slice(-100)
 j.lastDiagnostic={stage,at,...diagnostic}
}
function queueRetry(s,j,stage,diagnostic,at,cfg){
 const c=cognitiveState(s);j.failures??={};j.failures[stage]=(j.failures[stage]??0)+1
 if(stage==='extract'&&diagnostic.code==='FORMATION_FINISH_INVALID'&&['max-tokens','length'].includes(diagnostic.details?.kind)){
  const fresh=j.inputs.filter(r=>{const e=cognitionIndexes(s).byId.get(r.id);return e&&e.seq>c.cursor&&!(c.consumed??[]).includes(e.seq)})
  if(fresh.length){
   const limit=Math.max(1,Math.floor(fresh.length/2))
   c.extractBatchLimit=Math.min(c.extractBatchLimit??12,limit)
   // Dropped inputs stay unconsumed and are eligible for later jobs.
   j.inputs=fresh.slice(0,limit);j.through=Math.max(...j.inputs.map(r=>cognitionIndexes(s).byId.get(r.id).seq))
  }
 }
 const retry=j.failures[stage]<3&&j.permissionVersion===(s.settings.permissionVersion??0)&&!s.settings.paused&&!cfg.paused&&cfg.learningEnabled&&cfg.enabled
 j.tokenHash=null;j.reason=diagnostic.reason
 j.stage=retry?'retry_pending':'failed';j.retryStage=stage;j.retryAt=at+60000*2**(j.failures[stage]-1);j.expiresAt=at+Math.max(cfg.learningLeaseSec*1000,10*60000)
 formationHistory(c,j,stage,diagnostic,at,retry?'retry_pending':'failed')
}
function expireFormation(s,at,cfg){
 const c=cognitiveState(s)
 for(const j of c.jobs)if(j.stage==='expired'&&!j.lastDiagnostic)formationHistory(c,j,'legacy',{code:'FORMATION_LEGACY_EXPIRED',reason:'历史作业已过期；旧版未记录具体失败阶段与原因'},at,'expired')
 for(const j of c.jobs)if(['extract','review','review_pending','retry_pending'].includes(j.stage)&&j.expiresAt<=at){
  const stage=j.stage
  const diagnostic={code:'FORMATION_LEASE_EXPIRED',reason:stage==='review_pending'?'等待独立审核超过租约':stage==='retry_pending'?'重试等待超过租约':stage==='review'?'独立审核租约到期，未确认提交':'提取租约到期，未确认提交'}
  if(['extract','review'].includes(stage))queueRetry(s,j,stage,diagnostic,at,cfg)
  else{j.stage='expired';j.tokenHash=null;j.reason=diagnostic.reason;formationHistory(c,j,stage,diagnostic,at,'expired')}
 }
}
export function attachCognition(api,{event,account,owner,cfg}){
  const now=api.now,tx=api.tx
  const enabled=()=>{if(!cfg.enabled||!cfg.learningEnabled||cfg.paused)throw Error('归纳已关闭')}
  Object.assign(api,{
    invalidateFormation(reason='configuration-changed'){return tx(s=>{for(const j of cognitiveState(s).jobs)if(['extract','review','review_pending','retry_pending'].includes(j.stage)){j.stage='cancelled';j.tokenHash=null;j.reason=reason}changeRevision(s,{permission:true,policy:true});return {cancelled:true}})},
    bindChannel({channel,senderId,enabled=true}){return tx(s=>{
      if(!['qq','wechat'].includes(channel)||!String(senderId??'').trim())throw Error('外部身份绑定无效')
      const c=cognitiveState(s);c.bindings=c.bindings.filter(b=>b.channel!==channel)
      c.bindings.push({channel,senderId:String(senderId),enabled:enabled===true,at:now()})
      changeRevision(s,{permission:true,policy:true});return c.bindings
    })},
    ingestOwnerMessage(input){return tx(s=>{
      const channel=input.channel??'bili-dm'
      if(!input.messageId||(channel==='bili-dm'&&String(input.actor)!==String(owner)))throw Error('主人身份或消息 ID 无效')
      if(channel!=='bili-dm'&&!cognitiveState(s).bindings.some(b=>b.channel===channel&&b.senderId===String(input.actor)&&b.enabled))throw Error('外部通道未绑定')
      const key='incoming:'+channel+':'+input.messageId,old=cognitionIndexes(s).byKey.get(key)??api.search(key,{archives:true,limit:100}).find(e=>e.key===key);if(old)return old
      const c=cognitiveState(s),prior=c.working.outbound.filter(x=>now()-x.at<DAY&&['apiAccepted','visibilityConfirmed'].includes(x.phase))
      const match=input.replyTo?prior.find(x=>x.id===input.replyTo||x.receipt===input.replyTo):prior.length===1?prior[0]:null
      const episodeId=match?.episodeId??'episode:'+uid()
      const shared=input.contentKind==='share'
      // 纯图片私信没有正文：给一个占位，否则整条消息会因为"记忆文本为空"被丢掉。
      const body=[String(input.text??'').trim(),input.imageUrl?'[图片]':''].filter(Boolean).join('\n')||''
      if(!body)throw Error('记忆文本为空或超限')
      const e=event(s,'received',{key,text:text(body,12000),target:'dm:'+owner,actor:String(owner),origin:shared?'external':'owner',channel,externalMessageId:String(input.messageId),replyTo:match?.id??null,episodeId,data:{visibility:'private',affectExplicitReply:!!input.replyTo,replyAmbiguous:!match&&prior.length>1,...(input.imageUrl?{imageUrl:String(input.imageUrl),imageWidth:Number(input.imageWidth)||0,imageHeight:Number(input.imageHeight)||0}:{})}})
      if(!shared)e.verifiedRole='owner'
      const row=c.working.exchanges.find(x=>x.id===e.id);if(row){row.episodeId=episodeId;row.replyTo=e.replyTo}
      return e
    })},
    planFormation({force=false,minimumIntervalSec=0}={}){return tx(s=>{
      if(!Number.isInteger(minimumIntervalSec)||minimumIntervalSec<0||minimumIntervalSec>86400)throw Error('归纳间隔无效')
      const c=cognitiveState(s)
      if(!cfg.enabled||!cfg.learningEnabled||s.settings.paused||cfg.paused)return null
      expireFormation(s,now(),cfg)
      const active=c.jobs.find(j=>['extract','review','review_pending','retry_pending'].includes(j.stage)&&j.expiresAt>now());if(active)return null
      if(!force&&now()-c.lastRunAt<Math.max(cfg.learningIntervalSec,minimumIntervalSec)*1000)return null
      const today=new Date(now()).toISOString().slice(0,10)
      if(c.jobs.filter(j=>j.day===today).length>=cfg.learningDailyJobs)return null
      const deleted=new Set(c.deletedIds)
      // 已消费但还没被 cursor 跨过的 seq（跳读留下的），不再重复选中 ✓
      const consumedSet=new Set(c.consumed??[])
      const eligible=s.events.filter(e=>e.seq>c.cursor&&learningKinds.has(e.kind)&&!deleted.has(e.id)&&!consumedSet.has(e.seq))
      if(!eligible.length)return null
      // Alternate oldest and newest unprocessed evidence; new arrivals cannot starve backlog.
      const ordered=[...eligible].sort((a,b)=>a.seq-b.seq),freshOrder=[]
      for(let lo=0,hi=ordered.length-1;lo<=hi;){freshOrder.push(ordered[lo++]);if(lo<=hi)freshOrder.push(ordered[hi--])}
      const lastLimited=c.jobs.findLast(j=>j.lastDiagnostic?.stage==='extract'&&j.lastDiagnostic?.code==='FORMATION_FINISH_INVALID'&&['max-tokens','length'].includes(j.lastDiagnostic?.details?.kind))
      const limit=c.extractBatchLimit??(lastLimited?Math.max(1,Math.min(12,Math.floor(lastLimited.inputs.length/2))):12)
      const selected=[];let bytes=0
      const add=e=>{const n=Buffer.byteLength(JSON.stringify(evidenceView(e)));if(bytes+n>24576)return false;selected.push(e);bytes+=n;return true}
      for (const e of freshOrder) {
        if (selected.length >= limit) break
        add(e) // An item that does not fit must not prevent trying later, smaller items.
      }
      if(!selected.length)throw Error('单事件超过归纳预算')
      // A little prior evidence helps reinforcement without taking fresh evidence's budget.
      for (const e of s.events.filter(e=>learningKinds.has(e.kind)&&e.seq<=c.cursor&&now()-e.at<14*DAY).slice(-4)) add(e)
      const query=selected.filter(e=>e.seq>c.cursor).map(e=>e.text??'').join(' ')
      const score=m=>contextScore(query,[m.text,m.appliesTo,m.falsifiedBy].filter(Boolean).join(' '))
      const memories=s.memories.filter(m=>m.active).sort((a,b)=>score(b)-score(a)||(b.at??0)-(a.at??0)).slice(0,30).map(memoryForFormation)
      while(Buffer.byteLength(JSON.stringify({events:selected.map(evidenceView),memories}))>32768&&memories.length)memories.pop()
      const token=crypto.randomBytes(24).toString('hex'),j={id:uid(),day:today,stage:'extract',at:now(),expiresAt:now()+cfg.learningLeaseSec*1000,tokenHash:digest(token),permissionVersion:s.settings.permissionVersion??0,inputs:selected.map(e=>({id:e.id,hash:digest(e)})),memoryVersions:Object.fromEntries(memories.map(m=>[m.id,m.version])),through:Math.max(...selected.map(e=>e.seq)),attempts:0}
      j.freshLimit=limit
      c.jobs.push(j);c.lastRunAt=now();c.jobs=c.jobs.filter(j=>now()-j.at<7*DAY).slice(-200)
      return {jobId:j.id,token,stage:j.stage,expiresAt:j.expiresAt,input:{events:selected.map(evidenceView),memories},budgetBytes:32768}
    })},
    submitFormation(jobId,token,output,{isolateInvalid=false}={}){return tx(s=>{
      enabled();const j=checkLease(s,jobId,token,'extract',now())
      if(!Array.isArray(output.candidates)||output.candidates.length>8)throw Error('归纳最多 8 个候选，允许 0 个')
      const candidates=[],rejected=[]
      for(const x of output.candidates){try{candidates.push(normalizeCandidate(s,j,x,now()))}catch(e){if(!isolateInvalid)throw e;rejected.push({key:typeof x?.key==='string'?x.key.slice(0,100):null,stage:'extract',...formationDiagnostic(e)})}}
      const rejectedRelations=[]
      const relations=normalizeRelationProposals(s,j,output.relations??[],{isolateInvalid,rejected:rejectedRelations})
      if(unique(candidates.map(c=>c.key)).length!==candidates.length)throw Error('候选 key 重复')
      if(Buffer.byteLength(JSON.stringify({events:j.inputs.map(r=>evidenceView(cognitionIndexes(s).byId.get(r.id))),candidates,relations,summary:output.summary??''}))>32768)throw Error('复核输入超过 32KiB，请缩减候选及原文引用')
      j.inputCandidates=output.candidates.length;j.candidates=candidates;j.rejectedAtExtract=rejected;j.rejectedRelations=rejectedRelations;j.relations=relations;j.summary=typeof output.summary==='string'?output.summary.slice(0,2000):''
      if(Buffer.byteLength(JSON.stringify(relationReviewInput(s,j)))>32768)throw Error('复核输入超过32KiB，请缩减候选及关联')
      j.stage='review_pending';j.tokenHash=null;j.expiresAt=now()+cfg.learningLeaseSec*1000
      return {jobId:j.id,status:'review_pending',candidates:candidates.length}
    })},
    failFormationAttempt(jobId,token,stage,diagnostic){return tx(s=>{
      const j=cognitiveState(s).jobs.find(j=>j.id===jobId)
      if(!j||j.stage!==stage||j.tokenHash!==digest(String(token)))return {status:'stale'}
      queueRetry(s,j,stage,formationDiagnostic(diagnostic),now(),cfg)
      return {status:j.stage,retryAt:j.retryAt}
    })},
    claimFormationRetry(){return tx(s=>{
      enabled();if(s.settings.paused)return null
      const j=cognitiveState(s).jobs.find(j=>j.stage==='retry_pending'&&j.retryAt<=now()&&j.expiresAt>now());if(!j)return null
      if(j.permissionVersion!==(s.settings.permissionVersion??0)){j.stage='stale';j.tokenHash=null;return null}
      for(const row of j.inputs){const e=cognitionIndexes(s).byId.get(row.id);if(!e||digest(e)!==row.hash||cognitiveState(s).deletedIds.includes(row.id)){j.stage='stale';return null}}
      const token=crypto.randomBytes(24).toString('hex');j.stage=j.retryStage;j.tokenHash=digest(token);j.expiresAt=now()+cfg.learningLeaseSec*1000
      const input=j.stage==='review'?relationReviewInput(s,j):{events:j.inputs.map(r=>evidenceView(cognitionIndexes(s).byId.get(r.id))),memories:s.memories.filter(m=>m.active&&j.memoryVersions[m.id]===(m.version??1)).map(memoryForFormation)}
      return {jobId:j.id,token,stage:j.stage,expiresAt:j.expiresAt,input,previousDiagnostic:j.lastDiagnostic}
    })},
    claimReview(){return tx(s=>{
      enabled();if(s.settings.paused)return null
      const c=cognitiveState(s),j=c.jobs.find(j=>j.stage==='review_pending'&&j.expiresAt>now());if(!j)return null
      if(j.permissionVersion!==(s.settings.permissionVersion??0)){j.stage='stale';return null}
      const token=crypto.randomBytes(24).toString('hex');j.stage='review';j.tokenHash=digest(token);j.expiresAt=now()+cfg.learningLeaseSec*1000
      return {jobId:j.id,token,stage:'review',expiresAt:j.expiresAt,input:relationReviewInput(s,j)}
    })},
    commitFormation(jobId,token,result,{isolateInvalid=false}={}){return tx(s=>{
      enabled();const j=checkLease(s,jobId,token,'review',now()),c=cognitiveState(s)
      if(!Array.isArray(result.decisions)||result.decisions.length!==j.candidates.length)throw Error('审核需逐项覆盖全部候选')
      if(unique(result.decisions.map(x=>x.key)).length!==j.candidates.length)throw Error('审核 key 重复')
      const relationResult=commitRelationProposals(s,j,result.relationDecisions??[],cfg.dynamicMemory)
      if(relationResult.contradicted)changeRevision(s,{policy:true,permission:true})
      const created=[],rejected=[...(j.rejectedAtExtract??[])],decisions=new Map(result.decisions.map(d=>[d.key,d]))
      const byMemoryId=new Map(s.memories.map(m=>[m.id,m])),byEvidence=new Map(),byOrigins=new Map()
      const originKey=m=>digest({subject:m.subject??'world',type:m.type,origins:m.originEvidenceIds?.slice().sort(),scope:m.scope})
      const indexMemory=m=>{
        if(m.evidenceKey){const key=digest({subject:m.subject??'world',type:m.type,text:m.text,origins:(m.originEvidenceIds??m.sourceIds??[]).slice().sort(),scope:m.scope});if(!byEvidence.has(key))byEvidence.set(key,[]);byEvidence.get(key).push(m)}
        const key=originKey(m);if(!byOrigins.has(key))byOrigins.set(key,[]);byOrigins.get(key).push(m)
        byMemoryId.set(m.id,m)
      }
      for(const m of s.memories)indexMemory(m)
      let activeCount=s.memories.filter(m=>m.active).length
      for(const candidate of j.candidates){
        const d=decisions.get(candidate.key)
        if(!d||!['accept','clarify','reject'].includes(d.action))throw Error('审核动作无效')
        const reason=text(d.reason,1200)
        if(d.action==='reject'){rejected.push({key:candidate.key,reason});continue}
        if(d.action==='clarify'){
          if(c.working.questions.length>=20)throw Error('待澄清问题过多')
          c.working.questions.push({id:uid(),text:reason,sourceIds:candidate.sourceIds,at:now(),expiresAt:now()+7*DAY});continue
        }
        let evidence
        try{evidence=candidateEvidence(s,candidate,d)}catch(e){if(!isolateInvalid)throw e;rejected.push({key:candidate.key,reason:e.message});continue}
        const {old,explicit,independentKeys,independentDays}=evidence
        if(['preference','expression_policy','commitment'].includes(candidate.type)&&!explicit){c.working.questions.push({id:uid(),text:reason,sourceIds:candidate.sourceIds,at:now(),expiresAt:now()+7*DAY});continue}
        const originIds=unique([...(old?.originEvidenceIds??old?.sourceIds??[]),...candidate.originEvidenceIds])
        if(originIds.length>2000)throw Error('单条理解来源达到上限，需分期整理，不能静默丢弃来源')
        const evidenceKeys=unique([...(old?.independentEvidenceKeys??[]),...independentKeys])
        const evidenceDates=unique([...(old?.independentDates??[]),...independentDays])
        const evidenceKey=digest({subject:candidate.subject??'world',type:candidate.type,text:candidate.text,origins:originIds.slice().sort(),scope:candidate.scope})
        if(byEvidence.get(evidenceKey)?.some(m=>m.active)||(!old&&['pattern','understanding'].includes(candidate.type)&&byOrigins.get(originKey({...candidate,originEvidenceIds:originIds}))?.some(m=>m.active)))continue
        if(activeCount>=cfg.learningMaxMemories&&!old)throw Error('有效记忆达到维护上限，请合并或归档；未静默丢弃')
        if(old&&!candidate.originEvidenceIds.some(id=>!(old.originEvidenceIds??old.sourceIds).includes(id)))throw Error('替换理解需要新证据，不能靠反复总结强化')
        const keepId = old?.id ?? uid()
        const m={...candidate,id:keepId,version:(old?.version??0)+1,at:now(),acceptedAt:now(),active:true,recallEnabled:true,status:explicit?'active':'provisional',authority:explicit?'owner_explicit':'inferred',epistemic:explicit?'owner_explicit':'inferred',reviewState:'auto_validated',reviewReason:reason,origin:'formation',evidenceKey,originEvidenceIds:originIds,independentEvidence:Math.max(old?.independentEvidence??0,evidenceKeys.length),independentEvidenceKeys:evidenceKeys,independentDays:Math.max(old?.independentDays??0,evidenceDates.length),independentDates:evidenceDates,sourceIds:unique([...(old?.sourceIds??[]),...candidate.sourceIds]).slice(-40),confidenceBand:explicit?'high':'low',counterEvidenceIds:unique([...(old?.counterEvidenceIds??[]),...candidate.counterEvidenceIds])}
        if(dynamicActive(cfg.dynamicMemory))m.lifecycle=lifecycleDefaults(m)
        delete m.ownerEvidence;delete m.requestedAuthority
        // 沿用旧 id 时【就地替换】那一条，不能再 push 一条同 id 的记录（否则 find 会拿错）✓
        if(old){old.active=false;old.status='superseded';const at=s.memories.findIndex(x=>x===old);if(at>=0)s.memories[at]=m;else s.memories.push(m)}
        else s.memories.push(m)
        indexMemory(m);if(!old)activeCount++;created.push(m.id)
        changeRevision(s,{policy:explicit||!!old,permission:!!old});event(s,'memory-formed',{target:m.id,sourceIds:m.sourceIds,origin:'tool',data:{memory:structuredClone(m),jobId}})
      }
      const episode={id:'formation:'+j.id,at:now(),sourceIds:j.inputs.map(x=>x.id),text:j.summary,visibility:'private',memoryIds:created}
      c.episodes.push(episode);c.episodes=c.episodes.slice(-100)
      // 2026-10-30（主人要求「修好游标跳过问题」）：
      //   旧做法 cursor=Math.max(cursor, through)，而 through 是本批最大 seq ✗
      //   → 批次从最新往回取时，中间的 seq 被整段跳过，永远不会再被归纳 ✓
      //   → 改成【显式记录已消费的 seq】，cursor 只在"从旧到新连续消费"时前进 ✓
      //   没进过任何批次的经历，seq 仍 > cursor 且不在 consumed 里 → 下一轮还会被选中 ✓
      //   这样「多批次处理后，无经历被意外遗漏」是可验证的（见 acceptance 用例）✓
      const consumed=new Set(c.consumed??[])
      const freshCount=j.inputs.filter(x=>{
        const e=cognitionIndexes(s).byId.get(x.id)
        return e&&learningKinds.has(e.kind)&&e.seq>c.cursor&&!consumed.has(e.seq)
      }).length
      // A completed reduced batch earns a gradual increase; token failures still halve it.
      // Legacy jobs use the persisted limit, so existing stores recover without a reset.
      const batchLimit=c.extractBatchLimit??j.freshLimit
      if(Number.isInteger(batchLimit)&&batchLimit>=1&&batchLimit<12&&freshCount>=batchLimit){
        c.extractBatchLimit=batchLimit+1
      }
      for(const x of j.inputs){const e=s.events.find(ev=>ev.id===x.id);if(e&&learningKinds.has(e.kind))consumed.add(e.seq)}
      c.consumed=[...consumed].filter(sq=>sq>c.cursor).sort((a,b)=>a-b).slice(-4000)
      // cursor 只跨过"连续已消费"的区间；遇到第一个没消费的就停住 ✓
      {
        const learningSeqs=s.events.filter(e=>learningKinds.has(e.kind)).map(e=>e.seq).sort((a,b)=>a-b)
        let cur=c.cursor
        for(const sq of learningSeqs){if(sq<=cur)continue;if(consumed.has(sq))cur=sq;else break}
        c.cursor=Math.max(c.cursor,cur)
      }
      c.consumed=(c.consumed??[]).filter(sq=>sq>c.cursor)
      j.stage='committed';j.tokenHash=null;j.committedAt=now();j.created=created;j.rejected=rejected;delete j.reason;delete j.lastDiagnostic
      j.relationResult={...relationResult,rejected:j.rejectedRelations??[]};j.result={inputCandidates:j.inputCandidates??j.candidates.length,accepted:created.length,rejected:rejected.length,empty:j.candidates.length===0&&!rejected.length};delete j.relations;delete j.candidates;delete j.summary;c.working.revision++
      return {jobId,created,rejected,rejectedRelations:j.rejectedRelations??[],cursor:c.cursor,result:j.result}
    })},
    failFormation(jobId,reason){return tx(s=>{const j=cognitiveState(s).jobs.find(j=>j.id===jobId);if(j&&j.stage!=='committed'){j.stage='failed';j.tokenHash=null;j.reason=String(reason).slice(0,300)}return {status:j?.stage??'missing'}})},
    learningStatus(){const s=api.read(),c=cognitiveState(s);return {history:c.history??[],enabled:cfg.enabled&&cfg.learningEnabled,archivedUnprocessed:c.archivedUnprocessed??0,extractBatchLimit:c.extractBatchLimit??null,cursor:c.cursor,unprocessed:s.events.filter(e=>e.seq>c.cursor&&learningKinds.has(e.kind)&&!(c.consumed??[]).includes(e.seq)&&!c.deletedIds.includes(e.id)).length,jobs:c.jobs.map(({tokenHash,candidates,inputs,...j})=>({...j,inputCount:inputs.length})),working:c.working,episodes:c.episodes,memoryRevision:s.settings.memoryRevision??0}},
    async captureContext(taskId,query,scene,sessionId,{excludeEventIds=[],sessionRole,migrateFailedLegacy=false}={}){
      if(!Array.isArray(excludeEventIds)||excludeEventIds.length>100||excludeEventIds.some(x=>typeof x!=='string'))throw Error('上下文排除来源无效')
      if(sessionRole==='browse-main'&&scene!=='public-recommendation')throw Error('浏览上下文必须为公开范围')
      return tx(s=>{const c=cognitiveState(s),snapshot=api.compileSnapshot(s,query,scene,{excludeEventIds}),trace={taskId,at:now(),scene,sessionId,sessionRole,allowedExpressionScenes:sessionRole==='browse-main'?['public-comment','private-recommendation']:undefined,contextId:snapshot.contextId,memoryRevision:s.settings.memoryRevision??0,policyRevision:snapshot.policyRevision,permissionVersion:snapshot.permissionVersion,refs:snapshot.segments.flatMap(x=>x.refs),budget:snapshot.budget,omitted:snapshot.omitted,stage:'prepared'}
        const previous=c.traces.findLast(t=>t.taskId===taskId)
        const migrated=previous&&previous.scene!==scene&&migrateFailedLegacy&&sessionRole==='browse-main'&&scene==='public-recommendation'&&previous.scene==='private-recommendation'
        if(previous&&previous.scene!==scene&&!migrated)throw Error('任务场景不能变更')
        if(migrated){trace.migratedFromScene=previous.scene;for(const draft of s.drafts)if(draft.taskId===taskId&&['editing','pending'].includes(draft.status)){draft.status='discarded';draft.reason='failed-legacy-route-migrated'}}
        if(previous){if(!migrated){trace.memoryUsage=previous.memoryUsage;trace.fetchedRefs=previous.fetchedRefs}c.traces=c.traces.filter(t=>t.taskId!==taskId)}
        trace.dynamicMemory=snapshot.dynamicMemory
        c.traces.push(trace);c.traces=c.traces.slice(-200);return snapshot})
    },
    recordDecision(input){return tx(s=>{
      const c=cognitiveState(s),t=c.traces.findLast(t=>t.taskId===input.taskId);if(!t)throw Error('任务没有已准备上下文')
      if(!['reply','recommend','postpone','ask','abstain','analyze'].includes(input.action))throw Error('决定类型无效')
      const refs=input.memoryIds??[];if(!Array.isArray(refs)||refs.some(id=>!t.refs.some(r=>r.id===id)))throw Error('决定引用不在实际上下文中')
      t.decision={action:input.action,reason:text(input.reason,1000),memoryIds:refs};t.output=typeof input.output==='string'?input.output.slice(0,8000):null;if(!t.outcomes?.length)t.stage='model-reported';return t
    })},
    decisionTraces(){return cognitiveState(api.read()).traces},
    maintainCognition(){return tx(s=>{
      const c=cognitiveState(s),w=c.working
      for(const key of ['situations','questions','overrides'])w[key]=w[key].filter(x=>x.expiresAt>now())
      w.exchanges=w.exchanges.filter(x=>now()-x.at<3*DAY).slice(-30);w.outbound=w.outbound.filter(x=>now()-x.at<3*DAY).slice(-20)
      let changed=false,forgotten=0
      expireFormation(s,now(),cfg)
      if(dynamicActive(cfg.dynamicMemory)){
        migrateLifecycle(s,{apply:true})
        // Defer collection while an in-flight proposal still needs the old version.
        const held=new Set()
        for(const j of c.jobs)if(['extract','review','review_pending','retry_pending'].includes(j.stage)&&j.expiresAt>now())for(const id of Object.keys(j.memoryVersions??{}))held.add(id)
        for(const p of s.proposals.filter(p=>p.status==='pending')){if(p.baseId)held.add(p.baseId);for(const b of p.baseVersions??[])held.add(b.id??b.memoryId)}
        const removed=new Set(s.memories.filter(m=>cfg.dynamicMemory.autoDelete&&!held.has(m.id)&&lifecycleView(m,now(),s.dynamicMemory?.access?.[m.id],cfg.dynamicMemory).retentionStage==='dormant').map(m=>m.id))
        if(removed.size){
          s.memories=s.memories.filter(m=>!removed.has(m.id));forgotten=removed.size;changed=true
          c.episodes=c.episodes.filter(e=>!(e.memoryIds??[]).some(id=>removed.has(id)))
          if(s.dynamicMemory){for(const id of removed)delete s.dynamicMemory.access[id];s.dynamicMemory.receipts=s.dynamicMemory.receipts.filter(r=>!removed.has(r.memoryId));s.dynamicMemory.accessRevision++}
          s.settings.forgottenMemories=(s.settings.forgottenMemories??0)+forgotten
        }
        for(const m of s.memories.filter(m=>m.active)){const v=lifecycleView(m,now(),s.dynamicMemory?.access?.[m.id],cfg.dynamicMemory);if((m.lifecycle.lastEvaluatedValidity??'current')!==v.validity){m.lifecycle.lastEvaluatedValidity=v.validity;changed=true}}
      }else for(const m of s.memories)if(m.origin==='formation'&&m.active&&m.epistemic==='inferred'&&m.reviewAfter<=now()&&!m.stale){m.stale=true;m.recallEnabled=false;changed=true}
      if(changed)changeRevision(s,{permission:true,policy:true})
      return {working:w.exchanges.length,episodes:c.episodes.length,stale:s.memories.filter(m=>m.stale).length,forgotten}
    })},
  })
}

export function workingSegments(s,scene,at,{query='',excludeEventIds=[]}={}){
  const w=s.cognition?.working;if(!w)return []
  const excluded=new Set(excludeEventIds),rows=[]
  const entries=[...w.outbound.map(x=>({x,kind:'recentOutbound'})),...w.exchanges.map(x=>({x,kind:'currentExchange'}))]
    .filter(({x})=>at-x.at<DAY&&x.at<=at&&visible(x,scene)&&!excluded.has(x.id))
    .sort((a,b)=>a.x.at-b.x.at).slice(-7)
  for(const {x,kind} of entries){
    if(rows.some(r=>r.refs.some(ref=>ref.id===x.id)))continue
    rows.push({kind:'working',text:JSON.stringify({[kind]:{id:x.id,at:x.at,text:String(x.text??'').slice(0,800),phase:x.phase}}),refs:[{id:x.id}]})
  }
  if(scene.startsWith('private')&&query.trim())for(const q of w.questions.filter(q=>q.expiresAt>at&&contextScore(query,q.text)>0).slice(-2))rows.push({kind:'working',text:JSON.stringify({clarification:q.text}),refs:q.sourceIds.map(id=>({id}))})
  return rows
}

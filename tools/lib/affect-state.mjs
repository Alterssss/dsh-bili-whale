import crypto from 'node:crypto'
import {chatOpportunity,followupTurn} from './chat-opportunity.mjs'
import {chatConfig} from './chat-config.mjs'
import {initialAffect,advance,dayKey,HOUR,DAY,hash,fail,note,activeTopic,selectable,parseEffects,applyEffects,settleTopics,affectContext,publicTopic,publicTopics} from './affect-engine.mjs'
import {inWindow} from './night-plan.mjs'
const uid=()=>crypto.randomUUID()
const enabled=(s,c)=>c.enabled&&c.affect.enabled&&!c.paused&&!s.settings.paused
const version=s=>s.settings.permissionVersion??0
const ownerEvent=e=>e.kind==='received'&&e.verifiedRole==='owner'&&['bili-dm','qq','wechat'].includes(e.channel)
function videoMaterial(e){
  const text=String(e.text??'')
  if(e.data?.subtitle===true){
    const offset=e.data.subtitleOffset
    const start=Number.isInteger(offset)&&offset>=0 ? offset : (text.match(/^\[P\d+\]\r?\n(?=\[\d+:)/m)?.index??0)
    const body=text.slice(start).trim()
    return body ? {kind:'subtitles',body} : null
  }
  const title=e.data?.title
  if(e.data?.subtitle!==false||typeof title!=='string'||!title||!text.startsWith(title+'\n'))return null
  const body=text.slice(title.length+1).trim()
  return (body.match(/[\p{L}\p{N}]/gu)??[]).length>=40 ? {kind:'author-description',body} : null
}
const sourceBatchBytes=10000
function subtitleView(source,body){
  const chars=Array.from(body)
  function sample(limit){
    if(chars.length<=limit)return {...source,text:body,truncated:false}
    const tail=Math.floor(limit/2)
    return {...source,text:chars.slice(0,limit-tail).join(''),tailText:chars.slice(-tail).join(''),truncated:true}
  }
  const result=sample(1800)
  if(Buffer.byteLength(JSON.stringify([result]))<=sourceBatchBytes)return result
  // JSON needs at most six UTF-8 bytes per escaped code point.
  const overhead=Buffer.byteLength(JSON.stringify([{...source,text:'',tailText:'',truncated:false}]))
  return sample(Math.floor((sourceBatchBytes-overhead)/6))
}
function sourceView(e){
  const material=e.kind==='video-read'&&e.origin==='video'?videoMaterial(e):null
  if(!(material||ownerEvent(e)||['video-read','observed','activity-result'].includes(e.kind)&&e.origin==='tool'))return null
  const body=material?.body??String(e.text??'')
  if(!body.trim())return null
  const source={id:e.id,seq:e.seq,at:e.at,kind:e.kind,text:body.slice(0,350),truncated:body.length>350,materialOnly:e.kind==='video-read',publicMaterial:!!material,...(material?{materialKind:material.kind}:{}),channel:e.channel??'',verifiedRole:e.verifiedRole??'',target:e.target??'',replyTo:e.replyTo??null,explicitReply:e.data?.affectExplicitReply===true}
  return material?.kind==='subtitles'?subtitleView(source,body):source
}
function compactRetrySource(source){
  if(source.materialKind!=='subtitles')return source
  const head=Array.from(source.text),tail=source.tailText?Array.from(source.tailText):head
  if(head.length+(source.tailText?tail.length:0)<=900)return source
  return {...source,text:head.slice(0,450).join(''),tailText:tail.slice(-450).join(''),truncated:true}
}
const signature=c=>hash(c)
export function ensureAffect(s,now){s.affect??=initialAffect(now,s.cognition?.seq??0);return s.affect}
export function syncAffect(s,now,c){
  const a=ensureAffect(s,now),paused=!enabled(s,c)
  if(a.paused!==paused){advance(a,now,c.affect,{paused:a.paused});a.paused=paused;if(!paused)a.resumeAfter=now+30*60000;a.policyVersion++;if(a.pendingInitiative&&!a.pendingInitiative.operationId)a.pendingInitiative.status='cancelled'}
  // Control/arrival facts cannot be delayed by semantic queue backpressure.
  for(const e of s.events.filter(e=>e.seq>a.cursor&&ownerEvent(e))){
    a.lastOwnerAt=Math.max(a.lastOwnerAt,e.at)
    if(a.pendingInitiative&&!a.pendingInitiative.operationId)a.pendingInitiative.status='cancelled'
    if(!a.initiativeBlocked&&/^(?:请)?(?:别|不要|停止)(?:再)?主动(?:给我)?(?:发消息|发信息|联系我|发)[。！!\s]*$/.test(e.text.trim())){a.initiativeBlocked=true;a.policyVersion++;note(a,now,'owner-stop-initiative',{sourceEventIds:[e.id]})}
  }
  for(const e of s.events.filter(e=>e.seq>a.cursor).sort((x,y)=>x.seq-y.seq)){
    if(!paused&&['send-rejected','session-delivery-failed','wake-delivery-failed'].includes(e.kind)&&['tool','scheduler'].includes(e.origin)){
      const key=hash([e.kind,e.target]);a.failureCooldowns??=[]
      if(!a.failureCooldowns.some(x=>x.key===key&&now-x.at<1800000)){
        advance(a,now,c.affect);const d=Math.min(3,30-a.daily.negativeMood);a.mood.value=Math.max(-100,a.mood.value-d);a.daily.negativeMood+=d
        a.failureCooldowns=[...a.failureCooldowns.filter(x=>now-x.at<1800000),{key,at:now}].slice(-64);note(a,now,'mood:tool-failure',{delta:-d,sourceEventIds:[e.id]})
      }
    }
    const source=paused?null:sourceView(e)
    if(!source){a.cursor=e.seq;continue}
    const key=hash([e.kind,ownerEvent(e)?e.id:e.target,e.text])
    if(a.sourceHashes.includes(key)){a.cursor=e.seq;continue}
    const thread=ownerEvent(e)?e.channel+':'+e.target:'background'
    const last=a.jobs.at(-1)
    const merge=last?.status==='queued'&&!last.attempt&&last.thread===thread&&last.sources.length<8&&Buffer.byteLength(JSON.stringify([...last.sources,source]))<=sourceBatchBytes&&e.at-last.lastAt<=30000&&e.at-last.createdAt<60000
    if(!merge&&a.jobs.length>=20){a.backlog=true;break}
    const job=merge?last:{id:uid(),thread,status:'queued',createdAt:e.at,lastAt:e.at,sources:[],attempt:0,notBefore:e.at+30000}
    job.sources.push(source);job.lastAt=e.at;job.notBefore=Math.min(job.createdAt+60000,e.at+30000)
    if(!merge)a.jobs.push(job)
    a.sourceHashes.push(key);a.sourceHashes=a.sourceHashes.slice(-2000);a.cursor=e.seq;a.backlog=false
  }
}
function candidateTopics(a,job,at){
  const privateBatch=job.sources.some(ownerEvent)
  if(!privateBatch)return publicTopics(a,at).slice(0,3).map(t=>({id:t.id,revision:t.revision,summary:t.summary,status:t.status,explicitReply:false}))
  return a.topics.filter(t=>t.status!=='expired'&&(at-(t.lastDiscussedAt??t.updatedAt)<15*60000||job.sources.some(e=>e.explicitReply&&[t.lastSentEventId,t.lastReceipt,t.lastOperationId].includes(e.replyTo))))
    .sort((x,y)=>(y.lastDiscussedAt??y.updatedAt)-(x.lastDiscussedAt??x.updatedAt)).slice(0,3)
    .map(t=>({id:t.id,revision:t.revision,summary:t.summary,status:t.status,explicitReply:job.sources.some(e=>e.explicitReply&&[t.lastSentEventId,t.lastReceipt,t.lastOperationId].includes(e.replyTo))}))
}
function liveJob(s,id,lease,c,at){const a=s.affect,j=a.jobs.find(j=>j.id===id);if(!enabled(s,c)||!j||j.status!=='running'||j.lease!==lease||j.expiresAt<=at||j.permission!==version(s)||j.configHash!==signature(c))fail('AFFECT_JOB_STALE');return j}
function planCheck(s,c,full,at,p,{dispatch=false,opportunity=p?p.opportunity:chatOpportunity(s,full,at)}={}){
  const a=s.affect,chat=chatConfig(full.chat)
  if(!enabled(s,c)||!c.autonomy||a.initiativeBlocked)return 'disabled'
  if(full.share?.enabled===false||(!opportunity&&String(full.share?.via??'dm')!=='dm'))return 'private-route-unavailable'
  if(!full.self?.mid||!full.owner?.mid)return 'identity'
  if(!opportunity&&!inWindow(full.night??{},at))return 'outside-window'
  if(a.share.lastInitiativeAt>a.lastOwnerAt&&at-a.share.lastInitiativeAt<DAY)return 'awaiting-owner'
  const hour=new Date(at+8*HOUR).getUTCHours();if(hour>=23||hour<9)return 'quiet'
  if(at<a.resumeAfter||opportunity?.kind!=='followup'&&a.lastOwnerAt&&at-a.lastOwnerAt<c.affect.ownerIdleMinutes*60000)return 'owner-active'
  if(p?.opportunity&&(p.chatSignature!==hash(chat)||p.opportunity.ownerAt!==a.lastOwnerAt))return 'chat-policy-changed'
  if(p){
    if(!['generating','ready'].includes(p.status)||p.expiresAt<=at||p.permission!==version(s)||p.policyVersion!==a.policyVersion||p.configHash!==signature(c)||p.ownerAt!==a.lastOwnerAt)return 'plan-stale'
    if(p.turn){
      const current=followupTurn(s,full)
      if(!current||current.owner.id!==p.turn.ownerId||current.reply.id!==p.turn.replyId)return 'conversation-changed'
    }else{
      const t=a.topics.find(t=>t.id===p.topicId&&t.revision===p.revision);if(!t||!selectable(t,at))return 'topic-stale'
    }
  }else{
    if(a.lastAttemptAt&&at-a.lastAttemptAt<c.affect.initiativeGapMinutes*60000)return 'cooldown'
    if(a.daily.attempts>=Math.min(c.affect.initiativeDailyMax,opportunity?chat.dailyMax:c.affect.initiativeDailyMax))return 'daily-max'
    if(a.pendingInitiative&&['generating','ready','dispatching','uncertain'].includes(a.pendingInitiative.status))return 'pending'
    if(!opportunity&&(!a.share.armed||a.share.value<c.affect.trigger))return 'below-threshold'
    if(opportunity?.kind!=='followup'&&!a.topics.some(t=>selectable(t,at)))return 'no-topic'
  }
  if(Object.values(s.pending).some(x=>x.channel==='dm'&&String(x.target)===String(full.owner.mid)&&(!dispatch||x.affectPlanId!==p?.id)))return 'pending-send'
  return null
}
export function affectSendCheck(s,request,c,full,at){
  if(!request.affectPlanId)return null
  const p=s.affect?.pendingInitiative
  if(!p||p.id!==request.affectPlanId||request.channel!=='dm'||String(request.target)!==String(full.owner?.mid)||request.scene!=='private-reply'||!request.auto) return 'affect-plan-mismatch'
  const reason=planCheck(s,c,full,at,p,{dispatch:true});if(reason)return reason
  if(p.textHash!==hash(request.text)||p.draftId!==request.draftId||!p.covered)return 'affect-body-unverified'
  return null
}
export function bindAffectSend(s,p,at){
  if(p.dmAttachmentOf||p.dmImageOnly)return
  const a=s.affect;if(!a||a.paused)return
  if(p.affectPlanId){const plan=a.pendingInitiative;plan.operationId=p.operationId;return}
  if(p.channel==='comment'&&p.scene==='public-comment'&&p.share){
    const bv=String(p.video??p.target??'');p.affectTopicRefs=publicTopics(a,at).filter(t=>t.sources.some(e=>e.target===bv)).slice(0,3).map(t=>({topicId:t.id,revision:t.revision}));p.affectPublicShare=true;return
  }
  if(p.channel!=='dm'||p.scene!=='private-reply')return
  p.affectTopicRefs=a.topics.filter(t=>selectable(t,at)).sort((x,y)=>y.priority-x.priority).slice(0,3).map(t=>({topicId:t.id,revision:t.revision}))
}
export function affectDispatched(s,p){if(p.affectPlanId&&s.affect?.pendingInitiative?.id===p.affectPlanId)s.affect.pendingInitiative.status='dispatching'}
export function affectSettled(s,p,event,at,c){
  const a=s.affect;if(!a)return
  advance(a,at,c.affect,{paused:a.paused})
  if(p.affectPlanId){const plan=a.pendingInitiative;if(plan?.id!==p.affectPlanId)return
    if(plan.turn){
      plan.status=event?'sent':'failed'
      if(event)a.share.lastInitiativeAt=Math.max(a.share.lastInitiativeAt,event.at)
      return
    }
    if(event){settleTopics(a,[{topicId:plan.topicId,revision:plan.revision}],p.operationId,at,{initiative:true});plan.status='sent'}else plan.status='failed'
    const t=a.topics.find(t=>t.id===plan.topicId);if(t&&event){t.lastReceipt=event.receipt;t.lastSentEventId=event.id}
    return
  }
  if(!event)return
  const refs=(p.affectTopicRefs??[]).filter(r=>a.topics.some(t=>t.id===r.topicId&&t.revision===r.revision&&!t.creditReleased))
  if(!refs.length)return
  for(const r of refs){const t=a.topics.find(t=>t.id===r.topicId);t.status='needs-reconcile';t.lastOperationId=p.operationId;t.lastReceipt=event.receipt;t.lastSentEventId=event.id;t.lastDiscussedAt=at;t.reconcile={refs:[r],text:event.text,hash:event.hash,eventId:event.id,operationId:p.operationId,at,attempt:0,initiative:!!p.affectPublicShare,visibility:p.affectPublicShare?'public':'private'}}
}
export function attachAffect(api,cfg){
  const {tx,read,now}=api,c=cfg.affect
  const projected=()=>{const s=read();ensureAffect(s,now());advance(s.affect,now(),c,{paused:!enabled(s,cfg)});return s}
  Object.assign(api,{
    affectContext(scene){return affectContext(read().affect,scene,now(),c)},
    affectStatus(){const a=projected().affect;return {enabled:c.enabled,mood:Math.round(a.mood.value*10)/10,share:Math.round(a.share.value*10)/10,armed:a.share.armed,trigger:c.trigger,openTopics:a.topics.filter(t=>selectable(t,now())).length,publicTopics:publicTopics(a,now()).length,coveragePending:a.topics.filter(t=>t.status==='needs-reconcile').length,topics:a.topics.filter(activeTopic).length,queued:a.jobs.length,backlog:!!a.backlog,archivedUnprocessed:a.archivedUnprocessed??0,initiativeBlocked:a.initiativeBlocked,paused:a.paused,daily:{...a.daily,topicShareAdded:a.daily.shareAdded-a.daily.timeShareAdded},lastReason:a.recentChanges.at(-1)?.code??null,plan:a.pendingInitiative?{id:a.pendingInitiative.id,status:a.pendingInitiative.status}:null}},
    affectExplain(){const s=projected(),a=s.affect;const recentVideos=s.events.filter(e=>e.kind==='video-read'&&e.origin==='video').slice(-12).map(e=>({id:e.id,at:e.at,seq:e.seq,subtitle:e.data?.subtitle===true,textCharacters:e.text?.length??0,materialKind:videoMaterial(e)?.kind??null}));return {status:api.affectStatus(),recentVideos,cursor:a.cursor,lastAnalysisAt:a.lastAnalysisAt,changes:a.recentChanges.slice(-20),topics:a.topics.filter(activeTopic).map(t=>({id:t.id,summary:t.summary,reasonToShare:t.reasonToShare,status:t.status}))}},
    claimAffectJob(){return tx(s=>{
      const a=s.affect;if(!enabled(s,cfg))return null;advance(a,now(),c)
      if(a.jobs.some(j=>j.status==='running'&&j.expiresAt>now()))return null
      for(const j of a.jobs)if(j.status==='running'&&j.expiresAt<=now()){j.status=j.attempt<2?'queued':'failed';j.notBefore=now()+120000;note(a,now(),'analysis-lease-expired')}
      a.jobs=a.jobs.filter(j=>j.status!=='failed')
      if(a.daily.analysis>=c.analysisDailyMax||a.lastAnalysisAt&&now()-a.lastAnalysisAt<120000)return null
      const job=a.jobs.filter(j=>j.status==='queued'&&j.notBefore<=now()).sort((x,y)=>(x.thread==='background')-(y.thread==='background')||x.createdAt-y.createdAt)[0];if(!job)return null
      job.topics=candidateTopics(a,job,now());job.status='running';job.lease=uid();job.expiresAt=now()+45000;job.attempt++;job.permission=version(s);job.configHash=signature(cfg);job.inputDigest=hash([job.sources,job.topics]);a.daily.analysis++;a.lastAnalysisAt=now()
      return structuredClone(job)
    })},
    commitAffectJob(id,lease,raw){return tx(s=>{
      const a=s.affect,j=liveJob(s,id,lease,cfg,now())
      if(j.topics.some(ref=>!a.topics.some(t=>t.id===ref.id&&t.revision===ref.revision)))fail('AFFECT_TOPIC_STALE')
      if(j.inputDigest!==hash([j.sources,j.topics]))fail('AFFECT_INPUT_CHANGED')
      const result=parseEffects(raw,j)
      advance(a,now(),c)
      const before={mood:a.mood.value,share:a.share.value}
      const proposedByType={mood:result.moodEffects.length,topic:result.topicEffects.length,context:result.contextHints.length}
      const proposed=proposedByType.mood+proposedByType.topic+proposedByType.context
      applyEffects(a,result,j,now(),c)
      const skipped=a.recentChanges.filter(x=>x.jobId===id&&x.decision==='skipped').length
      const applied=proposed-skipped
      note(a,now(),'analysis-committed',{jobId:id,sourceEventIds:j.sources.map(e=>e.id),sourceSamples:j.sources.map(e=>({id:e.id,characters:Array.from(e.text+(e.tailText??'')).length,truncated:e.truncated,hasTail:!!e.tailText})),resultDigest:hash(raw),proposed,proposedByType,skipped,applied,outcome:proposed===0?'empty':applied?'applied':'no-change',moodDelta:a.mood.value-before.mood,shareDelta:a.share.value-before.share});a.jobs=a.jobs.filter(x=>x.id!==id);return {status:'committed'}
    })},
    failAffectJob(id,lease,code='AFFECT_ANALYSIS_FAILED',details){return tx(s=>{const a=s.affect,j=a.jobs.find(j=>j.id===id&&j.lease===lease);if(!j||j.status!=='running')return
      j.status='queued';j.notBefore=now()+120000
      if(j.attempt>=2)a.jobs=a.jobs.filter(x=>x!==j)
      else if(code==='AFFECT_FINISH_INVALID'&&['max-tokens','length'].includes(details?.kind)){
        j.sources=j.sources.map(compactRetrySource)
      }
      note(a,now(),/^[A-Z_]+$/.test(code)?code:'AFFECT_ANALYSIS_FAILED',{jobId:id,...(details?{details}:{})})})},
    claimAffectCoverage({batch=false}={}){return tx(s=>{
      const a=s.affect;if(!enabled(s,cfg))return null;advance(a,now(),c)
      for(const t of a.topics.filter(t=>t.status==='needs-reconcile'&&t.reconcile?.attempt>=2&&(!t.reconcile.expiresAt||t.reconcile.expiresAt<=now()))){
        if(!t.creditReleased){a.share.value=Math.max(0,a.share.value-t.credit-t.accrualAdded);t.creditReleased=true}
        t.status='suppressed';t.suppressionReason='coverage-unresolved';t.revision++;delete t.reconcile;note(a,now(),'coverage-unresolved',{topicId:t.id,operationId:t.lastOperationId})
      }
      if(a.daily.coverage>=c.coverageDailyMax)return null
      const t=a.topics.find(t=>t.status==='needs-reconcile'&&t.reconcile&&t.reconcile.attempt<2&&(!t.reconcile.expiresAt||t.reconcile.expiresAt<=now())&&t.expiresAt>now());if(!t)return null
      const group=batch?a.topics.filter(x=>x.status==='needs-reconcile'&&x.reconcile?.operationId===t.reconcile.operationId&&x.reconcile.text===t.reconcile.text&&x.reconcile.attempt<2&&(!x.reconcile.expiresAt||x.reconcile.expiresAt<=now())&&x.expiresAt>now()).slice(0,3):[t]
      const lease=uid();for(const x of group){const r=x.reconcile;r.attempt++;r.lease=lease;r.expiresAt=now()+45000;r.permission=version(s);r.configHash=signature(cfg)}
      a.daily.coverage++;return {...structuredClone(t.reconcile),topic:{id:t.id,revision:t.revision,summary:t.summary},...(group.length>1?{batchTopics:group.map(x=>({id:x.id,revision:x.revision,summary:x.summary}))}:{})}
    })},
    failAffectCoverage(job,code='AFFECT_COVERAGE_FAILED'){return tx(s=>{for(const ref of job.batchTopics??[job.topic]){const t=s.affect.topics.find(t=>t.id===ref.id&&t.revision===ref.revision),r=t?.reconcile;if(!r||r.lease!==job.lease)continue;r.expiresAt=now()+120000;r.lastError=/^[A-Z_]+$/.test(code)?code:'AFFECT_COVERAGE_FAILED';note(s.affect,now(),'coverage-retry',{topicId:t.id,attempt:r.attempt,code:r.lastError})}})},
    commitAffectCoverage(job,raw){return tx(s=>{
      const a=s.affect,topics=job.batchTopics??[job.topic],live=[]
      for(const ref of topics){const t=a.topics.find(t=>t.id===ref.id&&t.revision===ref.revision),r=t?.reconcile
       if(!enabled(s,cfg)||!r||r.lease!==job.lease||r.expiresAt<=now()||r.permission!==version(s)||r.configHash!==signature(cfg)||r.text!==job.text)fail('AFFECT_COVERAGE_STALE')
       live.push({t,r})
      }
      let checks
      if(job.batchTopics){
       if(typeof raw!=='string'||Buffer.byteLength(raw)>8192)fail('AFFECT_COVERAGE_SIZE')
       let result;try{result=JSON.parse(raw)}catch{fail('AFFECT_COVERAGE_JSON')}
       if(!result||Object.keys(result).some(k=>k!=='checks')||!Array.isArray(result.checks)||result.checks.length!==topics.length||new Set(result.checks.map(x=>x.topicId)).size!==topics.length||result.checks.some(x=>!topics.some(t=>t.id===x.topicId)||Object.keys(x).some(k=>!['topicId','covered','quote'].includes(k))))fail('AFFECT_COVERAGE_SHAPE')
       checks=topics.map(t=>{const x=result.checks.find(x=>x.topicId===t.id);return parseCoverage(JSON.stringify({covered:x.covered,quote:x.quote}),job.text)})
      }else checks=[parseCoverage(raw,job.text)]
      live.forEach(({t,r},i)=>{if(checks[i]){settleTopics(a,r.refs,r.operationId,now(),{initiative:!!r.initiative,initiativeAt:r.at});delete t.reconcile}else{t.status='open';t.deferUntil=now()+3*HOUR;delete t.reconcile}note(a,now(),checks[i]?'coverage-confirmed':'coverage-not-expressed',{operationId:job.operationId,topicId:t.id})})
      return {covered:checks.every(Boolean),checks:topics.map((t,i)=>({topicId:t.id,covered:checks[i]}))}
    })},
    affectPreview(full,env={}){const s=projected(),a=s.affect;if(full.share?.via==='comment'){const reason=!enabled(s,cfg)||full.share?.enabled===false||a.initiativeBlocked?'disabled':!publicTopics(a,now()).length?'no-public-topic':!inWindow(full.night??{},now())?'outside-window':env.busy?'busy':env.networkPaused?'network':null;const at=now(),opportunity=chatOpportunity(s,full,at)
      const chatReason=opportunity?(planCheck(s,cfg,full,at,null,{opportunity})??(env.busy?'busy':env.networkPaused?'network':null)):'no-chat-opportunity'
      return {eligible:!reason,reason,mode:'scheduled-browse-comment',privateChat:{eligible:!chatReason,reason:chatReason,kind:opportunity?.kind??null},status:api.affectStatus()}}const reason=planCheck(s,cfg,full,now(),null);return {eligible:!reason&&!env.busy&&!env.networkPaused,reason:reason??(env.busy?'busy':env.networkPaused?'network':null),status:api.affectStatus()}},
    claimAffectInitiative(full,env={}){return tx(s=>{
      const a=s.affect;advance(a,now(),c,{paused:!enabled(s,cfg)})
      if(a.pendingInitiative&&!a.pendingInitiative.operationId&&a.pendingInitiative.expiresAt<=now())a.pendingInitiative.status='expired'
      if(env.busy||env.networkPaused)return null
      const at=now(),opportunity=chatOpportunity(s,full,at)
      const reason=planCheck(s,cfg,full,at,null,{opportunity});if(reason)return null
      const topics=a.topics.filter(t=>selectable(t,now()))
      const weight=t=>t.priority*(a.mood.value>=5&&['shared-interest','touching-experience','new-understanding'].includes(t.category)||a.mood.value<=-5&&t.category==='touching-experience'?1.15:1)
      const turn=opportunity?.kind==='followup'?followupTurn(s,full):null
      const t=turn?null:topics.sort((x,y)=>weight(y)-weight(x))[0]
      if(!turn&&!t)return null
      const subject=turn?{turn:{ownerId:turn.owner.id,replyId:turn.reply.id},sourceEventIds:[turn.owner.id,turn.reply.id]}:{topicId:t.id,revision:t.revision,sourceEventIds:t.sourceEventIds}
      const p={id:uid(),...subject,status:'generating',createdAt:now(),expiresAt:turn?Math.min(at+180000,turn.reply.at+5*60000+1):at+180000,permission:version(s),policyVersion:a.policyVersion,ownerAt:a.lastOwnerAt,configHash:signature(cfg),requestId:'affect:'+uid()}
      if(opportunity){p.opportunity=opportunity;p.chatSignature=hash(chatConfig(full.chat))}
      const snapshot=api.compileSnapshot(s,turn?'最近一轮主人私信':[t.summary,t.reasonToShare].filter(Boolean).join(' '),'private-reply')
      if(snapshot.blocked)return null
      if(opportunity)a.chatAttempts=[...(a.chatAttempts??[]),opportunity.key].slice(-100)
      p.memoryRefs=turn?[]:snapshot.segments.filter(x=>['recall','policy'].includes(x.kind)).flatMap(x=>x.refs)
      a.pendingInitiative=p;a.daily.attempts++;a.lastAttemptAt=now()
      if(turn)return {...structuredClone(p),conversation:{owner:turn.owner.text.slice(-1500),reply:turn.reply.text.slice(-1500)},context:''}
      t.attempts++;return {...structuredClone(p),topic:structuredClone(t),context:snapshot.text}
    })},
    readyAffectPlan(id,draftId,text,coverage,full){return tx(s=>{
      const a=s.affect,p=a.pendingInitiative;if(!p||p.id!==id)fail('AFFECT_PLAN_STALE')
      const reason=planCheck(s,cfg,full,now(),p);if(reason)fail('AFFECT_PLAN_STALE')
      if(!parseCoverage(coverage,text))fail('AFFECT_NOT_EXPRESSED')
      const d=s.drafts.find(d=>d.id===draftId&&d.status==='pending'&&d.text===text&&d.target===String(full.owner.mid)&&d.scene==='private-reply');if(!d)fail('AFFECT_DRAFT_STALE')
      p.status='ready';p.draftId=draftId;p.textHash=hash(text);p.covered=true;return {id,draftId}
    })},
    finishAffectPlan(id,outcome){return tx(s=>{const a=s.affect,p=a.pendingInitiative;if(!p||p.id!==id||['sent','failed'].includes(p.status))return
      if(p.operationId){p.status='uncertain';return} // a prepared/dispatching write must never be automatically retried
      p.status=outcome==='skip'?'skipped':'failed';const t=a.topics.find(t=>t.id===p.topicId)
      const d=s.drafts.find(d=>d.id===p.draftId);if(d&&['editing','pending'].includes(d.status))d.status='discarded'
      if(outcome==='skip'&&t){t.status='deferred';t.deferUntil=now()+DAY}
      note(a,now(),'initiative-'+p.status)
    })},
    validateAffectPlanRequest(id,draftId,text,full){const request={affectPlanId:id,draftId,text,channel:'dm',target:String(full.owner?.mid),scene:'private-reply',auto:true};const reason=affectSendCheck(read(),request,cfg,full,now());if(reason)fail('AFFECT_'+reason.toUpperCase().replaceAll('-','_'));return request},
  })
}
export function parseCoverage(raw,text){
  if(typeof raw!=='string'||Buffer.byteLength(raw)>2048)fail('AFFECT_COVERAGE_SIZE')
  let r;try{r=JSON.parse(raw)}catch{fail('AFFECT_COVERAGE_JSON')}
  if(!r||Object.keys(r).some(k=>!['covered','quote'].includes(k))||typeof r.covered!=='boolean'||typeof r.quote!=='string')fail('AFFECT_COVERAGE_SHAPE')
  if(r.covered&&(r.quote.length<4||!text.includes(r.quote)))fail('AFFECT_COVERAGE_QUOTE')
  return r.covered
}

import {attachDiary,validateDiary} from './diary-state.mjs'
import {captureSessionBoundary,sessionBoundaryChanged} from './session-boundary.mjs'
import {attachAffect,ensureAffect,syncAffect,affectSendCheck,bindAffectSend,affectDispatched,affectSettled} from './affect-state.mjs'
import {validateAffect,affectContext} from './affect-engine.mjs'
import {observeRelations,validateRelations} from './memory-relations.mjs'
import {checkOperation} from './operation-context.mjs'
import {attachDynamicMemory,applyDecisionUsage,validateDynamicState} from './dynamic-memory.mjs'
import {dynamicActive} from './dynamic-memory-config.mjs'
import {recallEligibility,rankMemories} from './memory-lifecycle.mjs'
import {attachCognition,observeEvent,cognitiveState,changeRevision,cognitionIndexes} from './cognition.mjs'
import {LEGACY_NAMES,legacyRecall,legacySource} from './legacy-memory.mjs'
import {atomicWriteJson as atomic,createLifePersistence} from './life-persistence.mjs'
import {archiveDigest,archiveLifeState} from './life-archive.mjs'
export {archiveDigest} from './life-archive.mjs'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { acquireProcessLock } from './process-lock.mjs'
import { DSH_HOME } from './paths.mjs'
import { LIFE_DEFAULTS, lifeConfig } from './life-config.mjs'
import {checkHard,hardMessage} from './expression-hard.mjs'
import {compileContext, visible, applicable, validatePolicy, digest, assertScene} from './memory-context.mjs'
import {rebuildIndex, indexCandidates, terms} from './memory-index.mjs'
import {draftForm} from './expression-delivery.mjs'
import {chatConfig} from './chat-config.mjs'
import {inWindow} from './night-plan.mjs'

const DAY=86400000
export const fingerprint = text => crypto.createHash('sha256').update(String(text).normalize('NFKC').replace(/\s+/g,' ').trim()).digest('hex')
const id = () => crypto.randomUUID()
const str=(v,n=4000)=>String(v??'').slice(0,n)
const date=at=>new Date(at).toLocaleDateString('sv-SE')
export function createLifeStore({dshHome=DSH_HOME,account='',owner='',ownerName='',config=LIFE_DEFAULTS,fullConfig=null,now=Date.now}={}) {
  const cfg=lifeConfig(config)
  const dir=path.join(dshHome,'whale-life',fingerprint(account+'|'+owner).slice(0,24)),file=path.join(dir,'state.json')
  const checkpointFile=path.join(dir,'checkpoint.json')
  const validate=s=>{if(s.version!==1||!Number.isInteger(s.revision)||!['events','memories','proposals','drafts','agenda','leases','archives'].every(k=>Array.isArray(s[k]))||!s.threads||!s.pending||!s.settings)throw Error('schema');validateDynamicState(s);validateRelations(s);validateAffect(s.affect);validateDiary(s.settings.diary);return s}
  const {checkpoint,read}=createLifePersistence({account,owner,file,checkpointFile,validate,digest})
  const event=(s,kind,data={})=>{
    const e={id:id(),at:now(),kind,...data};s.events.push(e);observeEvent(s,e);if(cfg.enabled&&!cfg.paused)observeRelations(s,e,cfg.dynamicMemory);return e
  }
  function archive(s,force=false) {
    archiveLifeState(s,{dir,now,cfg},force)
  }
  async function tx(fn,afterCommit=null,{projectionOptional=false}={}) {
    if(!String(account).trim()||!String(owner).trim())throw Error('长期状态写入需要明确账号和主人')
    checkOperation()
    fs.mkdirSync(dir,{recursive:true})
    let release
    for(let i=0;i<80;i++){
      checkOperation()
      try{release=await acquireProcessLock(file);break}catch(e){if(i===79)throw e;await new Promise(r=>setTimeout(r,50))}
    }
    try{
      checkOperation()
      const s=read(),before=JSON.stringify(s),boundaryBefore=captureSessionBoundary(s),c=cognitiveState(s)
      if(s.settings.dynamicPolicyVersion!==1){
        if(s.events.length||s.memories.length||c.jobs.length){
          for(const j of c.jobs)if(['extract','review','review_pending','retry_pending'].includes(j.stage)){j.stage='cancelled';j.tokenHash=null;j.reason='dynamic-policy-upgrade'}
          changeRevision(s,{permission:true,policy:true})
        }
        s.settings.dynamicPolicyVersion=1
      }
      for(const e of s.events)if(!e.seq)e.seq=++c.seq
      ensureAffect(s,now())
      const value=await fn(s)
      if(sessionBoundaryChanged(boundaryBefore,s))s.settings.sessionBoundaryVersion=(s.settings.sessionBoundaryVersion??0)+1
      syncAffect(s,now(),cfg)
      validateAffect(s.affect)
      validateDiary(s.settings.diary)
      checkOperation();archive(s);checkOperation()
      if(JSON.stringify(s)===before&&fs.existsSync(checkpointFile)){
        // No new commit, but repair a missing/behind compatibility projection.
        let projectionRevision
        try{projectionRevision=JSON.parse(fs.readFileSync(file,'utf8')).revision}catch(e){if(e.code!=='ENOENT')throw e}
        if(projectionRevision!==s.revision){try{atomic(file,s)}catch(e){if(!projectionOptional)throw e}}
        return afterCommit?afterCommit(value):value
      }
      s.revision++;s.settings.checkpointSchema=1
      atomic(checkpointFile,{schema:1,account,owner,digest:digest(s),state:s})
      try{atomic(file,s)}catch(e){if(!projectionOptional)throw e}
      return afterCommit?afterCommit(value):value
    }
    finally{await release()}
  }
  function sources(s,ids) {
    if(!Array.isArray(ids)||!ids.length||ids.length>20)throw Error('需要 1–20 条真实来源事件')
    const events=ids.map(x=>cognitionIndexes(s).byId.get(x)??api.search(x,{archives:true,limit:100}).find(e=>e.id===x))
    if(events.some(e=>!e))throw Error('来源事件不存在或已归档，请先检索并重新提案')
    return events
  }
  function invalidatePolicies(s){
    s.settings.policyRevision=(s.settings.policyRevision??0)+1
    s.settings.permissionVersion=(s.settings.permissionVersion??0)+1
    for(const d of s.drafts)if(['editing','pending'].includes(d.status)){d.status='discarded';d.reason='memory-policy-changed'}
  }
  function thread(s,key) {
    return s.threads[key]??={key,status:'open',count:0,day:date(now()),daily:0,lastAt:0,reason:null,until:0,reopenFor:null,handled:[]}
  }
  function activityLease(s){
    if(!cfg.enabled||!cfg.autonomy||cfg.paused||s.settings.paused)return null
    if(s.leases.some(l=>l.expiresAt>now()&&l.status==='active')||s.leases.filter(l=>date(l.at)===date(now())).length>=cfg.autonomyDaily)return null
    const l={id:id(),at:now(),expiresAt:now()+cfg.autonomyMinutes*60000,remaining:cfg.autonomyReads,status:'active'}
    s.leases.push(l);event(s,'activity-started',{target:l.id,origin:'tool'});return l
  }
  function inspect(s,request) {
    if(!['comment','dm','dynamic'].includes(request.channel)||!String(request.target??'').trim()||!String(request.text??'').trim()||(request.channel==='comment'&&!/^\d+:\d+:(?:\d+|top)$/.test(request.thread??'')))throw Error('发送坐标或正文无效')
    if(request.channel==='dynamic'&&(request.scene!=='public-comment'||request.target!==String(account)||request.thread||request.parent||request.share))throw Error('动态目标或场景不一致')
    let attachmentAuthorization
    if(request.dmImageHash&&!/^[a-f0-9]{64}$/.test(request.dmImageHash))throw Error('图片摘要无效')
    if(request.dmAttachmentOf){
      const parent=s.events.find(e=>e.kind==='sent'&&e.operationId===request.dmAttachmentOf)
      attachmentAuthorization=parent?.data?.dmAttachment
      if(request.channel!=='dm'||parent?.channel!=='dm'||parent.target!==request.target||
        now()-parent.at>DAY||!attachmentAuthorization||attachmentAuthorization.hash!==request.dmImageHash||
        attachmentAuthorization.policyRevision!==(s.settings.policyRevision??0)||
        request.auto!==attachmentAuthorization.auto||request.scene!==attachmentAuthorization.scene||
        (request.taskId??null)!==(parent.taskId??null)||request.share||request.draftId||request.affectPlanId||
        request.text!=='[图片 sha256:'+request.dmImageHash+']')return {allow:false,reason:'附图与已确认文字消息不匹配'}
    }
    const hard=checkHard(request.text,request.scene,cfg)
    if(!hard.ok)return {allow:false,reason:hardMessage(hard),hard}
    const currentFull=typeof fullConfig==='function'?fullConfig():fullConfig;
    if(request.auto&&currentFull&&(String(currentFull.self?.mid)!==String(account)||String(currentFull.owner?.mid)!==String(owner)||lifeConfig(currentFull.life).paused||s.settings.paused))return {allow:false,reason:'账号、主人或暂停设置已变化'}
    if(request.auto&&currentFull&&lifeConfig(currentFull.life).requireDraft&&!request.draftId&&!attachmentAuthorization?.draftId)return {allow:false,reason:'自主发言需要 expression 草稿凭据；先 expression prepare <JSON文件> → finalize <ID>，再 comment/dm --draft <ID> --dry → --go'}
    if(request.socialJobId){
      const job=(s.settings.socialJobs??[]).find(j=>j.id===request.socialJobId),full=currentFull??{},chat=chatConfig(full.chat)
      if(!request.auto||!job||job.status!=='sending'||job.draftId!==request.draftId||now()-job.at>300000||!inWindow(full.night??{},now())||!lifeConfig(full.life).enabled||s.settings.paused||lifeConfig(full.life).paused||job.ownerAt!==(s.affect?.lastOwnerAt??0)||
        (job.kind==='dynamic'?(!chat.dynamic||request.channel!=='dynamic'||chat.dynamicDailyMax<1):(!chat.shareReply||request.channel!=='dm'||s.affect?.initiativeBlocked)))return {allow:false,reason:'社交任务已取消、过期或设置变化'}
    }
    if(request.auto&&request.share&&currentFull&&(currentFull.share?.enabled===false||(request.affectShareRoute!==undefined&&String(currentFull.share?.via??'dm')!==request.affectShareRoute)||s.affect?.initiativeBlocked))return {allow:false,reason:'分享出口、开关或主动联系许可已变化'}
    const affectReason=affectSendCheck(s,request,currentFull?lifeConfig(currentFull.life):cfg,currentFull??{},now());if(affectReason)return {allow:false,reason:affectReason}
    if(!cfg.enabled)return {allow:true}
    if(request.auto&&(cfg.paused||s.settings.paused)) return {allow:false,reason:'主动活动已暂停'}
    const taskId=request.taskId??s.drafts.find(d=>d.id===request.draftId)?.taskId
    const trace=taskId?s.cognition?.traces.findLast(t=>t.taskId===taskId):null
    if(dynamicActive(cfg.dynamicMemory)&&trace&&trace.refs.some(r=>{const m=s.memories.find(m=>m.id===r.id);return m&&(!recallEligibility(m,trace.scene,now(),{cfg:cfg.dynamicMemory,historical:trace.fetchedRefs?.some(f=>f.id===m.id&&f.historical)}).allowed||(m.version??1)!==r.version)}))return {allow:false,reason:'任务引用的记忆已失效，请重新判断'}
    if(trace?.decision?.action==='abstain'||(trace?.decision?.action==='postpone'&&(request.share||request.scene?.includes('recommendation'))))return {allow:false,reason:'本任务已决定不行动或推迟推荐；不能继续原发送'}
    const isPublic=['comment','dynamic'].includes(request.channel)
    let bv=String(request.video??request.target??'').match(/BV[0-9A-Za-z]{10}/)?.[0]
    const video=s.events.findLast(e=>e.kind==='video-read'&&(bv?e.target===bv:String(e.data?.aid)===request.thread?.split(':')[1]))
    bv??=video?.target
    const meta=video?.data
    const scopes=isPublic?['public','all']:['private','all']
    if(request.share)scopes.push('recommend')
    for(const m of s.memories.filter(m=>m.type==='preference'&&m.active&&m.effect==='exclude'&&(!m.expiresAt||m.expiresAt>now())&&scopes.includes(m.scope.scene))){
      const {field,value}=m.scope
      if(field==='mention-owner'&&isPublic&&request.ownerName&&request.text.includes('@'+request.ownerName))return {allow:false,reason:'已确认偏好禁止公开提及主人'}
      if(field==='bvid'&&bv===value)return {allow:false,reason:'目标视频在已确认排除范围内'}
      if(isPublic&&request.thread?.startsWith('1:')&&!bv&&['bvid','keyword','author'].includes(field))return {allow:false,reason:'视频身份未知，请先 debrief 核对偏好范围'}
      if(['keyword','author'].includes(field)&&bv){
        if(!meta)return {allow:false,reason:'请先 debrief 读取视频资料以核对已确认偏好'}
        if(field==='author'?String(meta.author)===value:String(meta.title).toLowerCase().includes(value.toLowerCase()))return {allow:false,reason:'目标在已确认排除范围内'}
      }
    }
    const hash=fingerprint(request.text+(attachmentAuthorization?'\n'+request.dmAttachmentOf:'')),t=request.channel==='comment'?thread(s,request.thread):null
    if(Object.values(s.pending).some(p=>p.channel===request.channel&&p.target===request.target))return {allow:false,reason:'目标有未确认发送；先核查回执，不能直接重发'}
    if(s.events.some(e=>e.kind==='sent'&&e.channel===request.channel&&e.target===request.target&&e.hash===hash&&now()-e.at<cfg.duplicateHours*3600000))return {allow:false,reason:'近期已成功发送相同内容'}
    if(t){
      const daily=t.day===date(now())?t.daily:0
      if(request.parent&&t.handled.includes(String(request.parent)))return {allow:false,reason:'该条消息已经回复'}
      if(daily>=cfg.threadDaily)return {allow:false,reason:'线程今日预算已用完'}
      if(t.reopenFor&&t.reopenFor!==String(request.parent??''))return {allow:false,reason:'恢复只适用于获准的新问题'}
      if(t.status!=='open'){
        if(t.until>now())return {allow:false,reason:'线程冷却中'}
        if(!t.reopenFor||t.reopenFor!==String(request.parent??''))return {allow:false,reason:'线程已结束；有新问题需申请恢复，原预算保留'}
      }
      if(t.count>=cfg.threadReplies&&!t.reopenFor)return {allow:false,reason:'连续回复预算已用完'}
    }
    if(request.draftId){
      const draft=s.drafts.find(d=>d.id===request.draftId)
      if(draft&&draft.policyRevision!==(s.settings.policyRevision??0))return {allow:false,reason:'草稿使用旧策略，请重新生成'}
      if(!draft||draft.status!=='pending'||now()-draft.at>DAY)return {allow:false,reason:'草稿不存在、未定稿、过期或已发送；请检查 finalize 输出的 ID'}
      if(draft.delivery?.channel&&draft.delivery.channel!==request.channel)return {allow:false,reason:'草稿通道不一致'}
      const expected=draftForm(draft,{share:!!request.share&&!request.affectPlanId,ownerName:request.ownerName??ownerName})
      if(expected!==request.text)return {allow:false,reason:'草稿正文与最终发送正文不一致；使用 --draft <ID>，移除重复正文参数；修改请先 revise 一次'}
      for(const [key,actual] of [['target',request.target],['scene',request.scene],['thread',request.thread??''],['parent',String(request.parent??'')]])if(draft[key]!==actual)return {allow:false,reason:'草稿 '+key+' 不一致；已固化为 '+String(draft[key])+'，请只用 --draft 读取坐标，或重新创建正确目标的草稿'}
    }else if(cfg.requireDraft&&request.auto&&!attachmentAuthorization?.draftId)return {allow:false,reason:'自主发言需要 expression 草稿凭据；先 expression prepare <JSON文件> → finalize <ID>，再 comment/dm --draft <ID> --dry → --go'}
    return {allow:true,hash}
  }
  const api={dir,file,read,tx,now,policy:cfg,identity:{owner:{mid:String(owner),name:String(ownerName)}},
    sources(ids){return sources(read(),ids)},
    checkpointStatus(){const s=checkpoint();return {schema:1,revision:s.revision,digest:digest(s),archives:s.archives.length}},
    replayCheck(){const s=checkpoint();for(const a of s.archives){if(archiveDigest(fs.readFileSync(path.join(dir,'archive',path.basename(a.name)),'utf8'))!==a.digest)throw Error('归档校验失败')}return {ok:true,revision:s.revision,memories:s.memories.length,pending:Object.keys(s.pending).length,networkEffects:0}},
    async record(kind,data={},dedupKey=''){
      const current=typeof fullConfig==='function'?fullConfig():fullConfig;if(kind==='diary'&&(!cfg.enabled||cfg.paused||current?.life?.enabled===false||current?.life?.paused||current?.diary?.enabled===false||read().settings.paused))return {status:'disabled'}
      if(!['received','observed','reflection','diary','video-read','activity-result'].includes(kind))throw Error('该事件只能由发送或控制工具写入')
      const result=await tx(s=>{
        if(kind==='diary'&&data.data?.visibility==='public'&&(data.data?.sourceIds??[]).some(id=>{const e=s.events.find(e=>e.id===id);return !e||!visible(e,'public')}))throw Error('公开日记不能引用私人来源')
        if(dedupKey){const old=api.search(dedupKey,{archives:true,limit:100}).find(e=>e.key===dedupKey);if(old)return old}
        return event(s,kind,{text:str(data.text,12000),target:str(data.target,256),origin:str(data.origin||'model',40),actor:str(data.actor,64),key:str(dedupKey,256),data:data.data??null})
      })
      if(kind==='diary'){try{await api.renderDiary()}catch(e){return {...result,diaryRender:{status:'failed',code:'DIARY_RENDER_FAILED'}}}}
      return result
    },
    recordScheduler(kind,data){
      if(!['wake-delivery-forced-release','night-triggered','night-trigger-rejected'].includes(kind))throw Error('无效调度事件')
      const key=kind+':'+str(data.runId??data.id,128)
      return tx(s=>{
        const old=api.search(key,{archives:true,limit:100}).find(e=>e.key===key);if(old)return old
        return event(s,kind,{key,origin:'scheduler',target:str(data.requestId??data.id,256),text:str(data.error??data.reason??kind,300),data})
      })
    },
    recordDelivery(record){
      if(!['accepted','failed','unconfirmed'].includes(record.status)||!record.requestId||!record.attempt)throw Error('无效投递回执')
      const key=str(record.requestId+':'+record.attempt+':'+record.status,256)
      return tx(s=>{
        const old=api.search(key,{archives:true,limit:100}).find(e=>e.key===key);if(old)return old
        const kind=(record.channel==='wake'?'wake':'session')+'-delivery-'+record.status
        return event(s,kind,{key,origin:'scheduler',target:str(record.requestId,256),text:str(record.error??'宿主已接受投递；不代表 agent 已执行',300),data:{sessionId:record.sessionId,status:record.status,channel:record.channel}})
      })
    },
    check(request){return inspect(read(),request)},
    recordVisibility(receipt,result){return tx(s=>{
      const sent=s.events.findLast(e=>e.kind==='sent'&&e.channel==='comment'&&e.receipt===String(receipt))
      if(!sent)throw Error('该回执没有对应的评论发送事件')
      const data={status:result.status,checkedAt:result.checkedAt,publicObserved:!!result.publicObserved,loginObserved:!!result.loginObserved,evidence:result.evidence??[],readError:result.readError??null}
      sent.visibility=data
      if(data.publicObserved)sent.phase='visibilityConfirmed'
      return event(s,'visibility-checked',{target:sent.target,receipt:String(receipt),text:String(result.message??''),data,origin:'tool'})
    })},
    reserve(request){return tx(s=>{
      const verdict=inspect(s,request);if(!verdict.allow)throw Error(verdict.reason)
      const token=id();s.pending[token]={...request,text:str(request.text,16000),hash:verdict.hash??fingerprint(request.text),at:now(),status:'uncertain',phase:'prepared',operationId:token,policyRevision:s.settings.policyRevision??0}
      const full=typeof fullConfig==='function'?fullConfig():fullConfig;if(request.auto&&request.share&&full)s.pending[token].affectShareRoute=String(full.share?.via??'dm')
      bindAffectSend(s,s.pending[token],now())
      return token
    })},
    async dispatch(token,invoke){
      const result=await tx(s=>{const p=s.pending[token];if(!p||p.phase!=='prepared')throw Error('操作已派发或状态未知，禁止重复发送');if(p.policyRevision!==(s.settings.policyRevision??0))throw Error('策略已变化，请核查并重新生成');const view=structuredClone(s);delete view.pending[token];const verdict=inspect(view,p);if(!verdict.allow)throw Error(verdict.reason);p.phase='dispatching';affectDispatched(s,p);return token},()=>{const response=Promise.resolve(invoke());response.catch(()=>{});return {response}})
      return result.response
    },
    settle(token,{status,receipt='',verified=false}={}){return tx(s=>{
      const p=s.pending[token];if(!p)return {alreadySettled:true}
      if(!['sent','rejected','not-sent'].includes(status))throw Error('无效回执状态')
      if(status==='sent'&&!String(receipt))throw Error('成功必须有平台回执')
      if(status==='not-sent'&&!verified)throw Error('人工核查后才能解除不确定发送')
      if(status==='sent'){
        const sentEvent=event(s,'sent',{operationId:token,phase:'apiAccepted',taskId:p.taskId??s.drafts.find(d=>d.id===p.draftId)?.taskId,channel:p.channel,target:p.target,thread:p.thread,parent:p.parent,hash:p.hash,text:p.text,receipt:String(receipt),origin:'tool'})
        if(p.share)sentEvent.data={share:true}
        if(p.affectPlanId)sentEvent.data={...sentEvent.data,initiative:true}
        if(p.socialJobId)sentEvent.data={...sentEvent.data,initiative:true,socialJobId:p.socialJobId}
        if(p.channel==='dynamic')sentEvent.data={...sentEvent.data,visibility:'public'}
        if(p.dmImageHash){
          sentEvent.data={...sentEvent.data,contentKind:p.dmAttachmentOf||p.dmImageOnly?'image':'text',imageHash:p.dmImageHash}
          if(p.dmAttachmentOf)sentEvent.data.attachmentOf=p.dmAttachmentOf
          else if(!p.dmImageOnly)sentEvent.data.dmAttachment={hash:p.dmImageHash,auto:p.auto,scene:p.scene,draftId:p.draftId,policyRevision:p.policyRevision}
        }
        affectSettled(s,p,sentEvent,now(),cfg)
        if(p.channel==='comment'){
          const t=thread(s,p.thread);if(t.day!==date(now())){t.day=date(now());t.daily=0}
          t.count++;t.daily++;t.lastAt=now();t.reopenFor=null
          if(p.parent)t.handled=[...new Set([...t.handled,String(p.parent)])]
          if(t.count>=cfg.threadReplies){t.status='closed';t.closedAt=now();t.reason='budget';t.until=now()+cfg.cooldownMinutes*60000}
          if(p.thread.endsWith(':top')){const key=p.thread.slice(0,-3)+String(receipt);s.threads[key]={...t,key,handled:[...t.handled]}}
        }
        const taskId=p.taskId??s.drafts.find(d=>d.id===p.draftId)?.taskId
        const trace=s.cognition?.traces.findLast(t=>t.taskId===taskId);if(trace&&!p.dmAttachmentOf&&!p.dmImageOnly){trace.outcomes??=[];trace.outcomes.push({operationId:token,receipt:String(receipt),phase:'apiAccepted',at:now()});trace.stage='apiAccepted';if(!cfg.paused)applyDecisionUsage(s,trace,now(),cfg.dynamicMemory)}
        if(p.draftId){const d=s.drafts.find(d=>d.id===p.draftId);if(d)d.status='sent'}
      }else {event(s,'send-rejected',{target:p.target,status,origin:'tool'});affectSettled(s,p,null,now(),cfg)}
      delete s.pending[token];return {status}
    })},
    closeThread(key,reason='completed'){return tx(s=>{const t=thread(s,key);t.status='closed';t.closedAt=now();t.reason=str(reason,100);t.until=now()+cfg.cooldownMinutes*60000;t.reopenFor=null;event(s,'thread-closed',{target:key,text:t.reason,origin:'tool'});return t})},
    reviewWake(key){return tx(s=>{const t=s.threads[key];if(!cfg.enabled||!t||t.status==='open')return true;if(t.until>now()||now()-(t.lastReviewAt??0)<cfg.cooldownMinutes*60000)return false;t.lastReviewAt=now();return true})},
    reopenThread(key,eventId,{approved=false}={}){return tx(s=>{
      const t=thread(s,key),e=sources(s,[eventId]).find(e=>e.kind==='received'&&e.target===key)
      if(!e)throw Error('需要该线程的新收件事件')
      if(e.at<=Math.max(t.lastAt,t.closedAt??0)||t.handled.includes(String(e.data?.parent??'')))throw Error('旧消息不能重新开启线程')
      if(t.until>now())throw Error('仍在冷却期')
      if(!approved)throw Error('恢复提案需在设置页确认新问题')
      t.reopenFor=String(e.data?.parent??'');if(!t.reopenFor)throw Error('事件缺少回复坐标')
      t.status='open';t.count=0;for(const p of s.proposals)if(p.type==='reopen'&&p.status==='pending'&&p.sourceIds.includes(eventId)){p.status='accepted';p.reviewedAt=now()};event(s,'thread-reopened',{target:key,sourceIds:[eventId],origin:'owner'});return t
    })},
    propose(input){return tx(s=>{
      const refs=sources(s,input.sourceIds)
      const type=String(input.type??'memory');if(!['memory','preference','expression_policy','persona','reopen'].includes(type))throw Error('无效提案类型')
      const p={id:id(),at:now(),type,text:str(input.text),sourceIds:refs.map(e=>e.id),status:'pending',scope:input.scope??{},visibility:input.visibility==='public'?'public':'private',effect:input.effect??'note',expiresAt:input.expiresAt??null,baseId:input.baseId??null,origin:'model'}
      p.sourceIds=[...new Set(p.sourceIds)]
      if(type==='expression_policy'){p.policy=validatePolicy(input,p.sourceIds);if(p.visibility!=='public'&&p.scope.scenes.some(scene=>['public-comment','reply','public-recommendation'].includes(scene)))throw Error('公开表达策略需要独立公开来源与公开可见性；私密禁止公开 @ 请用 mention-owner 程序偏好')}
      if(p.baseId){const base=s.memories.find(m=>m.id===p.baseId&&m.active);if(!base)throw Error('待替换记忆已经变化');p.baseVersion=input.baseVersion??base.version??1;if(p.baseVersion!==(base.version??1))throw Error('记忆版本冲突')}
      if(p.visibility==='public'&&refs.some(e=>!visible(e,'public')))throw Error('私密来源不能直接形成公开记忆；需独立公开来源')
      if(!p.text.trim())throw Error('提案为空')
      if(!p.scope||typeof p.scope!=='object'||Array.isArray(p.scope))throw Error('提案范围无效')
      if(type==='persona'&&p.text.length>2000)throw Error('人格增量最多 2000 字符')
      if(p.expiresAt!==null&&(!Number.isFinite(p.expiresAt)||p.expiresAt<=now()))throw Error('失效时间必须在未来')
      if(type==='preference'){
        if(!['exclude','prefer','note'].includes(p.effect))throw Error('偏好效果无效')
        if(!['watch','recommend','public','private','all'].includes(p.scope.scene))throw Error('需要明确适用场景')
        if(!['keyword','author','bvid','mention-owner'].includes(p.scope.field)||!String(p.scope.value??'').trim())throw Error('需要明确偏好对象')
        p.scope.value=str(p.scope.value,200)
      }
      if(s.proposals.filter(x=>x.status==='pending').length>=200)throw Error('待审提案过多，请先处理')
      s.proposals.push(p);return p
    })},
    review(proposalId,action,{expectedRevision}={}){return tx(s=>{
      if(expectedRevision!==undefined&&s.revision!==expectedRevision)throw Error('状态版本冲突')
      const p=s.proposals.find(x=>x.id===proposalId);if(!p||p.status!=='pending')throw Error('提案不存在或已处理')
      if(!['accept','reject'].includes(action))throw Error('无效审核操作')
      p.status=action==='accept'?'accepted':'rejected';p.reviewedAt=now()
      if(action==='accept'){
        if(p.type==='reopen')throw Error('线程恢复请使用专门的恢复操作')
        if(s.memories.filter(m=>m.active).length>=200&&!p.baseId&&!p.baseVersions?.length)throw Error('有效记忆已达 200 条，请先合并或撤销')
        if(p.expiresAt&&p.expiresAt<=now())throw Error('提案已经过期')
        for(const base of p.baseVersions??[]){const old=s.memories.find(m=>m.id===base.id&&m.active);if(!old||(old.version??1)!==base.version)throw Error('整理来源已经变化');old.active=false;old.status='superseded'}
        if(p.baseId){const old=s.memories.find(m=>m.id===p.baseId&&m.active);if(!old||(old.version??1)!==p.baseVersion)throw Error('待替换记忆已经变化');old.active=false;old.status='superseded'}
        const m={...p,id:id(),version:(p.baseVersion??0)+1,active:true,status:'active',recallEnabled:true,authority:'owner_approved',origin:'owner-approved',acceptedAt:now()};s.memories.push(m)
        changeRevision(s,{policy:['preference','expression_policy'].includes(m.type),permission:!!p.baseId});event(s,'memory-accepted',{target:m.id,sourceIds:p.sourceIds,origin:'owner',data:{memory:structuredClone(m),supersedes:p.baseId}})
      }return p
    })},
    revoke(memoryId){return tx(s=>{const m=s.memories.find(x=>x.id===memoryId);if(!m)throw Error('记忆不存在');m.active=false;m.status='revoked';invalidatePolicies(s);event(s,'memory-revoked',{target:memoryId,origin:'owner'});return m})},
    preferences(candidate,scene='watch',snapshot=null){
      const active=(snapshot??read()).memories.filter(m=>m.type==='preference'&&m.active&&(!m.expiresAt||m.expiresAt>now())&&[scene,'all'].includes(m.scope.scene))
      const hit=active.filter(m=>{const value=String(m.scope.value).toLowerCase();const field=m.scope.field;return field==='keyword'?String(candidate.title??'').toLowerCase().includes(value):String(candidate[field]??'').toLowerCase()===value})
      return {excluded:hit.some(m=>m.effect==='exclude'),boost:Math.min(4,hit.filter(m=>m.effect==='prefer').length*2),ids:hit.map(m=>m.id)}
    },
    compileSnapshot(s,query='',scene='private',options={}){const snapshot=compileContext(s,{query,scene,limit:cfg.memoryChars,recent:cfg.recentEvents,at:now(),dynamicMemory:cfg.dynamicMemory,...options});const affect=affectContext(s.affect,scene,now(),cfg.affect);if(affect&&!snapshot.blocked)snapshot.text+='\n'+affect;return snapshot},
    contextSnapshot(query='',scene='private',options={}){return api.compileSnapshot(read(),query,scene,options)},
    context(query='',scene='private'){
      const result=api.contextSnapshot(query,scene)
      if(result.blocked)throw Error('强制记忆规则超出预算，停止投递；请调整 life.memoryChars 或审核适用范围')
      return result.text
    },
    // Only trusted adapters may construct this facade. It is not a sandbox for shell access.
    reader(scene){
      assertScene(scene)
      return Object.freeze({
        taskCatalog(options={}){return api.memoryTaskCatalog({...options,scene})},
        catalog(options={}){return api.memoryCatalog({...options,scene})},
        history(options={}){return api.memoryHistory({...options,scene})},
        readMemory(options){return api.memoryFetch({...options,scene})},
        explain(id){return api.memoryExplain(id,scene)},
        get(memoryId){const state=read();if((state.cognition?.deletedIds??[]).includes(memoryId))return null;return state.memories.find(m=>m.id===memoryId&&(dynamicActive(cfg.dynamicMemory)?recallEligibility(m,scene,now(),{cfg:cfg.dynamicMemory}).allowed:applicable(m,scene,now())))??null},
        sources(ids){if(!Array.isArray(ids)||ids.length>20)throw Error('来源 ID 列表无效');return ids.flatMap(id=>api.search(id,{archives:true,scene,limit:100}).filter(e=>e.id===id))},
        search(query,options={}){return api.search(query,{...options,scene})},
        context(query='',options={}){return api.contextSnapshot(query,scene,{limit:options.limit??cfg.memoryChars})},
        recall(query){const s=read();if(dynamicActive(cfg.dynamicMemory))return {items:rankMemories(s.memories.filter(m=>!(s.cognition?.deletedIds??[]).includes(m.id)),{query,scene,at:now(),cfg:cfg.dynamicMemory,access:s.dynamicMemory?.access??{}}).slice(0,20).map(r=>r.memory),status:'ok',diagnostics:[]}
          let ids,diagnostics=[];try{ids=new Set(indexCandidates(dir,query))}catch(e){diagnostics.push({code:'INDEX_UNAVAILABLE',detail:e.message})}
          const q=terms(query);const rows=s.memories.filter(m=>applicable(m,scene,now())&&(ids?.has(m.id)||q.some(t=>terms(m.text+' '+JSON.stringify(m.policy??{})).includes(t))))
          return {items:rows.slice(0,20),diagnostics,status:diagnostics.length?'degraded':'ok'}},
      })
    },
    bindLegacy(name,visibility='private'){return tx(s=>{if(!LEGACY_NAMES.includes(name)||!['private','public'].includes(visibility)||(name.includes('-private')&&visibility==='public'))throw Error('旧来源绑定无效');(s.settings.legacyBindings??={})[name]={visibility,account,owner};return s.settings.legacyBindings})},
    legacyRecall(scene,query={}){return legacyRecall(dshHome,read().settings.legacyBindings??{},scene,query)},
    legacySource(scene,ref){return legacySource(dshHome,read().settings.legacyBindings??{},scene,ref)},
    rebuildIndex(){return rebuildIndex(dir,read())},
    suppress(memoryId,value=true){return tx(s=>{const m=s.memories.find(m=>m.id===memoryId);if(!m)throw Error('记忆不存在');m.recallEnabled=!value;if(m.lifecycle)m.lifecycle.recallControl=value?'owner_suppressed':'enabled';invalidatePolicies(s);return m})},
    consolidate(input){return tx(s=>{
      if(!input||input.expectedRevision!==s.revision)throw Error('整理版本冲突')
      if(!Array.isArray(input.groups)||input.groups.length>20)throw Error('整理批次最多 20 组')
      const allowed=new Map(s.memories.filter(m=>m.active).slice(-80).map(m=>[m.id,m]))
      const output=[]
      for(const g of input.groups){
        if(!Array.isArray(g.ids)||g.ids.length<2||g.ids.length>20||new Set(g.ids).size!==g.ids.length)throw Error('合并需要 2–20 个不同 ID')
        const rows=g.ids.map(id=>allowed.get(id));if(rows.some(x=>!x))throw Error('整理引用了窗口外或失效 ID')
        if(rows.some(x=>x.type!=='memory'||x.visibility!==rows[0].visibility||JSON.stringify(x.scope)!==JSON.stringify(rows[0].scope)||x.expiresAt!==rows[0].expiresAt))throw Error('整理只能合并权限范围一致的普通记忆；策略需单独审核')
        if(typeof g.text!=='string'||!g.text.trim()||g.text.length>4000)throw Error('合并正文无效')
        const p={id:id(),at:now(),type:'memory',text:g.text,sourceIds:[...new Set(rows.flatMap(m=>m.sourceIds))],derivedFrom:g.ids,baseVersions:rows.map(m=>({id:m.id,version:m.version??1})),scope:rows[0].scope,visibility:rows[0].visibility,expiresAt:rows[0].expiresAt,status:'pending',origin:'model'}
        if(p.sourceIds.length>20)throw Error('合并后的独立来源超过 20 条；请缩小批次')
        output.push(p)
      }
      if(s.proposals.filter(p=>p.status==='pending').length+output.length>200)throw Error('待审提案过多')
      s.proposals.push(...output);return {proposals:output}
    })},
    search(query,{archives=false,limit=20,scene='local-management'}={}){
      limit=Math.max(1,Math.min(100,Number(limit)||20))
      const s=read(),q=String(query).toLowerCase(),matches=e=>visible(e,scene)&&JSON.stringify(e).toLowerCase().includes(q)
      const result=s.events.filter(matches).slice(-Math.min(100,limit))
      if(archives&&result.length<limit)for(const a of s.archives.slice().reverse()){
        const raw=fs.readFileSync(path.join(dir,'archive',path.basename(a.name)),'utf8');if(archiveDigest(raw)!==a.digest)throw Error('历史归档校验失败')
        result.push(...JSON.parse(raw).events.filter(matches).slice(0,limit-result.length));if(result.length>=limit)break
      }
      return result
    },
    archive(){return tx(s=>{archive(s,true);return {archives:s.archives.length,events:s.events.length,pending:Object.keys(s.pending).length}})},
    pause(value){return tx(s=>{if(s.settings.paused!==!!value)changeRevision(s,{permission:true,policy:true});s.settings.paused=!!value;if(!value&&s.affect){s.affect.initiativeBlocked=false;s.affect.resumeAfter=now()+1800000;s.affect.policyVersion++}return {paused:!!value}})},
    agendaAdd(text){return tx(s=>{if(s.agenda.filter(a=>a.status==='open').length>=100)throw Error('议程已满');const item={id:id(),text:str(text,1000),at:now(),status:'open'};if(!item.text.trim())throw Error('议程为空');s.agenda.push(item);return item})},
    agendaDone(agendaId,result){return tx(s=>{const a=s.agenda.find(x=>x.id===agendaId);if(!a)throw Error('议程不存在');a.status='done';a.result=str(result,2000);event(s,'activity-result',{target:a.id,text:a.result,origin:'model'});return a})},
    beginActivity(){return tx(s=>{
      return activityLease(s)
    })},
    scheduleActivity(trigger,dueAt){return tx(s=>{
      if(!cfg.enabled||!cfg.autonomy)return null
      if(!String(trigger)||!Number.isFinite(dueAt)||dueAt<now())throw Error('附加活动的触发来源或时间无效')
      const queue=s.settings.activityQueue??=[]
      const old=queue.find(a=>a.trigger===String(trigger));if(old)return old
      const item={id:id(),trigger:String(trigger),at:now(),dueAt,status:'queued'}
      queue.push(item);s.settings.activityQueue=queue.filter(a=>now()-a.at<7*DAY).slice(-100)
      return item
    })},
    beginScheduledActivity(){return tx(s=>{
      const item=(s.settings.activityQueue??[]).find(a=>a.status==='queued'&&a.dueAt<=now()&&now()-a.at<DAY)
      if(!item)return null
      const lease=activityLease(s);if(!lease)return null
      item.status='dispatching';item.leaseId=lease.id
      return {item,lease}
    })},
    finishScheduledActivity(activityId,delivered){return tx(s=>{
      const item=(s.settings.activityQueue??[]).find(a=>a.id===activityId)
      if(!item||item.status!=='dispatching')throw Error('附加活动投递状态已经变化')
      item.status=delivered==='unconfirmed'?'delivery-unconfirmed':delivered?'delivered':'delivery-failed';item.finishedAt=now()
      if(!delivered){const lease=s.leases.find(l=>l.id===item.leaseId);if(lease){lease.status='done';lease.expiresAt=now()}}
      return item
    })},
    consumeActivity(leaseId){return tx(s=>{const l=s.leases.find(x=>x.id===leaseId);if(!l||l.expiresAt<=now()||l.remaining<=0||l.status!=='active'||cfg.paused||s.settings.paused)throw Error('自主活动已结束或预算耗尽');l.remaining--;return l})},
    endActivity(leaseId){return tx(s=>{const l=s.leases.find(x=>x.id===leaseId);if(!l)throw Error('活动不存在');l.status='done';l.expiresAt=now();return l})},
    export(){const s=read();return {exportedAt:now(),...s,archiveContents:s.archives.map(a=>{const raw=fs.readFileSync(path.join(dir,'archive',path.basename(a.name)),'utf8');if(archiveDigest(raw)!==a.digest)throw Error('历史归档校验失败');return {name:a.name,...JSON.parse(raw)}})}},
    status(){const s=read();return {schema:1,revision:s.revision,policyRevision:s.settings.policyRevision??0,recovery:fs.existsSync(checkpointFile)?'checkpoint':'legacy-state',learning:api.learningStatus(),affect:api.affectStatus(),diary:api.diaryStatus(),dynamicMemory:api.dynamicStatus(),memoryRevision:s.settings.memoryRevision??0,capabilities:{formation:'session-file-two-stage',privateContinuity:'shared-main',externalIngress:'adapter-required',behaviorEvaluation:'not-live-validated',context:'ok',readFacade:'ok',hostToolIsolation:'unavailable',erase:'unavailable'},enabled:cfg.enabled,paused:cfg.paused||!!s.settings.paused,events:s.events.length,archives:s.archives.length,chat:{batches:(s.settings.dmBatches??[]).map(b=>({id:b.id,status:b.status,parts:b.parts.map(p=>p.status)})),jobs:(s.settings.socialJobs??[]).map(j=>({id:j.id,kind:j.kind,status:j.status})),replyInbox:s.settings.shareReplyInbox??[]},pending:Object.entries(s.pending).map(([id,p])=>({id,channel:p.channel,target:p.target,at:p.at,status:p.status,phase:p.phase??'legacy-uncertain',operationId:p.operationId??id})),threads:Object.values(s.threads),memories:s.memories,proposals:s.proposals,agenda:s.agenda,leases:s.leases,activities:s.settings.activityQueue??[],lastArchiveAt:s.settings.lastArchiveAt??null}}
  }
  attachAffect(api,cfg)
  attachDiary(api,cfg,{event,fullConfig})
  attachDynamicMemory(api,cfg)
  attachCognition(api,{event,account,owner,cfg})
  return api
}

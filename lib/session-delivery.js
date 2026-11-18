import { HOME } from '../tools/lib/paths.mjs'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {setTimeout as setDeadline, clearTimeout as clearDeadline} from 'node:timers'
import {readDeliveries, updateDelivery} from './delivery-state.js'
import {loadBehavior,behaviorSections,BEHAVIOR_ROOT} from '../tools/lib/behavior.mjs'
import {expressionPrompt} from '../tools/lib/expression.mjs'
import {lifeConfig} from '../tools/lib/life-config.mjs'

export const isUnconfirmedDelivery = e => e?.code === 'DELIVERY_UNCONFIRMED'
const checkAbort = signal => {if(signal?.aborted)throw signal.reason??new Error('投递已取消')}
function unconfirmed(requestId, message = '宿主投递结果未确认；本次不重复入队，请检查 DSH 会话') {
  return Object.assign(new Error(message), {code: 'DELIVERY_UNCONFIRMED', requestId})
}

export function createSessionDelivery({controller,workspaceController,dshHome,cwd,sessionId,config,persona,isBusy=()=>false,now=Date.now,log=()=>{},onSession=()=>{},memoryContext=null,timeoutMs=60_000,onOutcome=()=>{},sessionFile='whale-session.json',contextGeneration=null,scopeKey=null,sessionRole=null,behaviorRoot=BEHAVIOR_ROOT}) {
  const file=path.join(dshHome,sessionFile)
  let state={id:sessionId,startedAt:now()},ready=false,tail=Promise.resolve(),lastDelivered=0
  let booted=false
  const recoveryScopes=new Map()
  try {
    const saved=JSON.parse(fs.readFileSync(file,'utf8'))
    if(typeof saved.id!=='string'||!saved.id||!Number.isFinite(saved.startedAt)||saved.startedAt<0)throw Error('invalid state')
    delete saved.behaviorDelivered;delete saved.behaviorReloadKey;state=saved;ready=true
  } catch(e) { if(e.code!=='ENOENT')throw Error('会话状态损坏，请检查 whale-session.json，避免误建会话') }
  onSession(state.id)
  readDeliveries(dshHome) // A corrupt journal must not silently remove duplicate protection.
  lastDelivered=Number.isFinite(state.deliveredAt)?state.deliveredAt:0
  function save(next) {
    fs.mkdirSync(dshHome,{recursive:true})
    const tmp=file+'.'+crypto.randomUUID()+'.tmp'
    try {fs.writeFileSync(tmp,JSON.stringify(next));fs.renameSync(tmp,file)} finally {fs.rmSync(tmp,{force:true})}
  }
  function outcome(requestId, update) {
    const record = updateDelivery(dshHome, requestId, {...update,scopeKey, updatedAt: now()})
    try { Promise.resolve(onOutcome(record)).catch(e => log('记录投递事件失败：'+e.message)) }
    catch(e) { log('记录投递事件失败：'+e.message) }
    return record
  }
  function bounded(promise, signal, dispatched, requestId, deadline) {
    return new Promise((resolve,reject) => {
      let done = false, timer
      const finish = (fn,value) => {if(done)return;done=true;clearDeadline(timer);signal?.removeEventListener('abort',abort);fn(value)}
      const abort = () => finish(reject, dispatched ? unconfirmed(requestId) : (signal?.reason ?? Error('投递等待超时（尚未提交提示）')))
      timer = setDeadline(() => finish(reject, dispatched ? unconfirmed(requestId) : Object.assign(Error('建立会话超时，尚未提交提示'), {code:'DELIVERY_TIMEOUT'})), Math.max(1, deadline-now()))
      signal?.addEventListener('abort',abort,{once:true})
      if(signal?.aborted)abort()
      Promise.resolve(promise).then(value=>finish(resolve,value),error=>finish(reject,error))
    })
  }
  return {
    send(request,signal,{retainUntilAck=false,memoryScene,taskKind,memoryQuery,sourceEventIds,compatibleScopeKeys=[]}={}) {
      const requestId=request.requestId??crypto.randomUUID()
      const deliver=async()=>{
        checkAbort(signal)
        const existing=readDeliveries(dshHome).find(r=>r.requestId===requestId)
        if(scopeKey&&existing?.scopeKey&&existing.scopeKey!==scopeKey){
          if(!compatibleScopeKeys.includes(existing.scopeKey))throw Error('任务回执属于另一账号或场景，需核查任务 ID')
          recoveryScopes.set(requestId,existing.scopeKey)
        }
        if(existing?.status==='accepted')return // Retry an ack, never an already accepted prompt.
        if(existing&&['dispatching','unconfirmed'].includes(existing.status))throw unconfirmed(requestId)
        const startedAt=now(),deadline=startedAt+Math.max(1,Number(timeoutMs)||60_000)
        const cfg=config(),days=Number(cfg.sessionRotateDays??0),once=cfg.personaOncePerSession!==false
        const generation=contextGeneration?.()
        const invalidated=contextGeneration&&state.contextGeneration!==generation
        const persist=!!memoryScene||!!contextGeneration||retainUntilAck||!!state.pendingRequest||once||(Number.isFinite(days)&&days>0)
        const rotating=invalidated||(!state.pendingRequest&&Number.isFinite(days)&&days>0&&now()-state.startedAt>=days*86400000&&now()-lastDelivered>=8*60000&&!isBusy())
        let next=rotating?{id:crypto.randomUUID(),startedAt:now(),rotatedFrom:state.id,contextGeneration:generation}:state
        if(retainUntilAck){
          if(!request.requestId)throw Error('可靠交付需要 requestId')
          next={...next,pendingRequest:request.requestId}
        }
        let created = null
        if(!ready||rotating) {
          try {
            let workspaceId
            try {
              if (typeof workspaceController?.create === 'function') {
                // Leave time for cwd fallback if the optional workspace service hangs.
                const workspaceDeadline = now() + Math.min(5000, Math.max(1, (deadline-now()) / 2))
                const resolved = await bounded(Promise.resolve().then(() => workspaceController.create({path:cwd})),signal,false,requestId,workspaceDeadline)
                workspaceId = resolved?.workspace?.workspaceId
              }
            } catch (error) {
              checkAbort(signal)
              if (now() >= deadline) throw error
              log('工作区登记失败，本次按会话目录创建')
            }
            const createRequest = typeof workspaceId === 'string' && workspaceId ? {sessionId:next.id,workspaceId} : {sessionId:next.id,cwd}
            created = await bounded(Promise.resolve().then(()=>controller.create(createRequest)),signal,false,requestId,deadline)
          }
          catch(e) {
            if(!signal?.aborted)outcome(requestId,{attempt:crypto.randomUUID(),channel:'other',sessionId:next.id,status:'failed',phase:'create',startedAt,error:String(e.message).slice(0,300)})
            throw e
          }
        }
        const requestedSessionId=next.id
        if(typeof created?.sessionId==='string'&&created.sessionId){next={...next,id:created.sessionId}}
        const bootFirst = !booted
        if(persist)save(next)
        if(rotating)log(`会话轮换：${state.id} → ${next.id}；原因=${invalidated?'permission-generation':'configured-age'}；角色=${sessionRole??'legacy'}；旧会话保留`)
        state=next;ready=true;onSession(state.id)
        checkAbort(signal)
        const block=persona(),fingerprint=crypto.createHash('sha256').update(block).digest('hex')
        const include=!once||bootFirst||state.personaHash!==fingerprint
        const reminder=`人设依据：${path.join(HOME,'.bili-ai/persona.md')}；上下文缺失时重读。`
        const memory=memoryContext?await memoryContext({...request,memoryScene,sessionRole,taskKind,memoryQuery,sourceEventIds,migrateFailedLegacy:existing?.status==='failed'&&recoveryScopes.has(requestId)&&sessionRole==='browse-main',sessionId:state.id}):null
        if(memory?.blocked)throw Error('强制记忆规则超出预算')
        const diary=memoryContext ? '［有界上下文］需要更多资料时按场景检索。\n'+(typeof memory==='string'?memory:memory.text) : !memoryScene?'旧版记忆入口：'+path.join(dshHome,'whale-diary.md')+'、'+path.join(dshHome,'whale-diary-private.md')+'；核实可见范围后按需检索，不全文重读。':''
        const traceHint=memory&&typeof memory==='object'?'taskId='+requestId+'；记忆场景='+memoryScene+'。需要记录决定时 life decision <JSON文件>；草稿带taskId，仅引用本任务供应或授权读取的ID。详细字段：behavior read memory。':''
        const recallHint=memory?.dynamicMemory?.mode==='active'?'动态记忆已启用；按当前场景用 memory-catalog/history/fetch，需要时 behavior read memory。':''
        const chapters=memoryScene?loadBehavior(behaviorSections(memoryScene,sessionRole,taskKind).filter(id=>id!=='public-comment'),{root:behaviorRoot}):[]
        const behavior=chapters.map(c=>{
          const label='［规范 '+c.id+'］'
          return label+'\n'+c.text
        }).join('\n')
        const contract=memoryScene?'当前身份与人设继续适用；场景='+memoryScene+'，角色='+(sessionRole??'legacy')+'。私密材料不公开；未知发送先核查，程序权限与完整例外优先。规范索引：'+path.join(behaviorRoot,'BEHAVIOR.md'):''
        const policy=lifeConfig(cfg.life)
        const expressionScenes=sessionRole==='browse-main'?['public-comment','private-recommendation']:['private-reply','private-recommendation','public-comment','reply'].includes(memoryScene)?[memoryScene]:[]
        const expression=expressionScenes.map(scene=>'［表达场景 '+scene+'］\n'+expressionPrompt(scene,policy.draftMode,policy)).join('\n')
        const prefix=[include?block:reminder,contract,behavior,expression,traceHint,recallHint,diary].filter(Boolean).join('\n')
        const content=[...(request.content??[])]
        if(content[0]?.type==='text')content[0]={...content[0],text:prefix+'\n'+content[0].text}
        else content.unshift({type:'text',text:prefix})
        checkAbort(signal)
        const attempt=crypto.randomUUID()
        const channel=requestId.startsWith('bili-whale-wake:')?'wake':requestId.includes('-dm-')?'dm':requestId.includes('-listen-')?'comment':requestId.includes('-activity-')?'activity':'other'
        outcome(requestId,{attempt,channel,sessionRole,taskKind,memoryScene,sessionId:state.id,requestedSessionId,createdSessionId:created?.sessionId??null,promptCharacters:content.filter(c=>c.type==='text').reduce((n,c)=>n+c.text.length,0),behaviorSections:chapters.map(c=>c.id),expressionScenes,status:'dispatching',startedAt,retained:retainUntilAck,error:null})
        const raw=Promise.resolve().then(()=>{
          checkAbort(signal)
          if(contextGeneration&&contextGeneration()!==generation)throw Error('记忆权限已变化，停止旧上下文投递')
          return controller.prompt({...request,requestId,sessionId:state.id,content},signal)
        })
        const tracked=raw.then(()=>{
          try { outcome(requestId,{status:'accepted',error:null}) }
          catch(e) {log('宿主已接受投递，但保存回执失败：'+e.message)}
        },e=>{
          try {outcome(requestId,{status:signal?.aborted?'unconfirmed':'failed',error:String(e?.message??e).slice(0,300)})}
          catch(writeError){log('保存投递错误失败：'+writeError.message)}
          throw e
        })
        try {await bounded(tracked,signal,true,requestId,deadline)}
        catch(e) {
          if(isUnconfirmedDelivery(e)||signal?.aborted){
            const current=readDeliveries(dshHome).find(r=>r.requestId===requestId)
            if(current?.status!=='accepted')outcome(requestId,{status:'unconfirmed',error:String(e.message).slice(0,300)})
            throw unconfirmed(requestId)
          }
          throw e
        }
        booted=true   // 投递成功了才算
        lastDelivered=now()
        state={...state,personaHash:fingerprint,deliveredAt:lastDelivered,sessionRole}
        if(persist)try {save(state)} catch(e){log('会话已投递，但保存人设标记失败：'+e.message)}
      }
      const job=tail.then(async()=>{
        try{return await deliver()}catch(e){
          if(e.code!=='session/not-found')throw e
          checkAbort(signal);ready=false;booted=false
          state={id:crypto.randomUUID(),startedAt:now(),contextGeneration:contextGeneration?.()}
          return deliver()
        }
      })
      tail=job.catch(()=>{})
      return job
    },
    confirm(requestId) {
      const job=tail.then(()=>{
        const entry=readDeliveries(dshHome).find(r=>r.requestId===requestId)
        if(entry?.scopeKey&&scopeKey&&entry.scopeKey!==scopeKey&&recoveryScopes.get(requestId)!==entry.scopeKey)return
        if(entry)updateDelivery(dshHome,requestId,{retained:false})
        const oldScope=recoveryScopes.get(requestId)
        if(oldScope&&/^[a-f0-9]{24}$/.test(oldScope)){
          const oldFile=path.join(dshHome,'whale-session-'+oldScope+'.json')
          try{
            const old=JSON.parse(fs.readFileSync(oldFile,'utf8'))
            if(old.pendingRequest===requestId){delete old.pendingRequest;const tmp=oldFile+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(old));fs.renameSync(tmp,oldFile)}finally{fs.rmSync(tmp,{force:true})}}
          }catch(e){if(e.code!=='ENOENT')throw e}
          recoveryScopes.delete(requestId)
        }
        if(state.pendingRequest!==requestId)return
        const next={...state};delete next.pendingRequest
        save(next);state=next
      })
      tail=job.catch(()=>{});return job
    },
  }
}

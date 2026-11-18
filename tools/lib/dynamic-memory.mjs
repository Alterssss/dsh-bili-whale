import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {terms} from './memory-index.mjs'
import {assertScene,visible,inScope} from './memory-scope.mjs'
import {dynamicActive} from './dynamic-memory-config.mjs'
import {lifecycleView,recallEligibility,rankMemories,migrateLifecycle,mandatoryMemory} from './memory-lifecycle.mjs'
const DAY=86400000
const hash=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex')
const bytes=x=>Buffer.byteLength(JSON.stringify(x))
const historicalKinds=new Set(['received','video-read','observed','sent'])
export function validateDynamicState(s){
 if(s.dynamicMemory){
  const d=s.dynamicMemory
  if(d.schema!==1||!d.access||typeof d.access!=='object'||Array.isArray(d.access)||!Array.isArray(d.receipts)||!Number.isInteger(d.accessRevision)||d.accessRevision<0)throw Error('动态记忆 schema 无效')
  for(const a of Object.values(d.access))if(!a||!Number.isInteger(a.version)||a.version<1||!Number.isFinite(a.useMass)||a.useMass<0||a.useMass>32||!Number.isSafeInteger(a.effectiveUseCount)||a.effectiveUseCount<0)throw Error('动态访问状态无效')
 }
 for(const m of s.memories)if(m.lifecycle&&(m.lifecycle.schema!==1||!['enabled','owner_suppressed','legacy_blocked'].includes(m.lifecycle.recallControl)))throw Error('记忆生命周期 schema 无效')
}
export const dynamicState=s=>s.dynamicMemory??={schema:1,accessRevision:0,access:{},receipts:[]}
const cursorEncode=x=>Buffer.from(JSON.stringify(x)).toString('base64url')
function cursorDecode(value,fingerprint){try{const c=JSON.parse(Buffer.from(value,'base64url'));if(c.fingerprint!==fingerprint)throw Error();return c}catch{throw Error('检索游标失效，请重新检索')}}
function requireTask(s,taskId,scene,at){
 const t=s.cognition?.traces.findLast(t=>t.taskId===taskId)
 if(!t||t.scene!==scene||at-t.at>DAY||at<t.at||t.permissionVersion!==(s.settings.permissionVersion??0))throw Error('任务上下文不存在、过期或权限已变化')
 return t
}
// This function is invoked only by successful retrieval or the existing trusted
// transport receipt path. A model-reported decision alone cannot call it.
export function creditMemoryUse(s,t,m,{phase,at,cfg}){
 if(!dynamicActive(cfg)||s.settings.paused)return
 const check=recallEligibility(m,t.scene,at,{historical:phase==='fetched'||t.fetchedRefs?.some(r=>r.id===m.id&&r.historical),cfg});if(!check.allowed)return
 const dyn=dynamicState(s),a=dyn.access[m.id]??={version:m.version??1,useMass:0,effectiveUseCount:0}
 if(a.version!==(m.version??1)){dyn.access[m.id]={version:m.version??1,useMass:0,effectiveUseCount:0};return creditMemoryUse(s,t,m,{phase,at,cfg})}
 if(phase==='fetched')a.lastFetchedAt=at
 const key=m.id+':'+(m.version??1),usage=t.memoryUsage??={bytes:0,credits:{}}
 const old=usage.credits[key],wanted=phase==='applied'?1:0.25
 if(!old)usage.credits[key]={weight:0,phase,at}
 const receipt=usage.credits[key]
 // Upgrade one task's weak retrieval credit to applied credit, never count twice.
 const canCredit=(receipt.weight>0||a.lastTaskUseAt===undefined||at-a.lastTaskUseAt>=cfg.useWindowSec*1000)&&wanted>receipt.weight
 if(canCredit){
  const view=lifecycleView(m,at,a,cfg)
  a.useMass=Math.min(32,view.useMass+wanted-receipt.weight);a.evaluatedAt=at
  if(receipt.weight===0)a.effectiveUseCount++
  a.lastTaskUseAt=at;receipt.weight=wanted
 }
 if(phase==='applied')receipt.phase='applied'
 const liveIds=new Set(s.memories.filter(m=>m.active).map(m=>m.id));for(const id of Object.keys(dyn.access))if(!liveIds.has(id))delete dyn.access[id]
 dyn.accessRevision++
 dyn.receipts.push({taskId:t.taskId,memoryId:m.id,version:m.version??1,phase,at,credited:canCredit})
 dyn.receipts=dyn.receipts.filter(r=>at-r.at<2*DAY).slice(-500)
}
export function applyDecisionUsage(s,t,at,cfg){
 if(!dynamicActive(cfg)||!t?.outcomes?.some(o=>o.phase==='apiAccepted')||!t.decision||t.permissionVersion!==(s.settings.permissionVersion??0))return
 for(const id of t.decision.memoryIds??[]){const ref=t.refs.find(r=>r.id===id),m=s.memories.find(m=>m.id===id);if(m&&ref?.version===(m.version??1))creditMemoryUse(s,t,m,{phase:'applied',at,cfg})}
}
function boundedFragment(record,meta,offset,budget,expectedHash){
 const raw=Buffer.from(JSON.stringify(record)),contentHash=hash(raw.toString('utf8'))
 if(!Number.isInteger(offset)||offset<0||offset>=raw.length||(raw[offset]&0xc0)===0x80)throw Error('全文分页位置无效')
 if(offset>0&&expectedHash!==contentHash)throw Error('分页内容已变化，请从第一页重新读取')
 let end=Math.min(raw.length,offset+Math.max(1,budget-650))
 const result=()=>({...meta,format:'json-fragment',contentHash,offsetBytes:offset,nextOffsetBytes:end<raw.length?end:null,complete:end===raw.length,fragment:raw.subarray(offset,end).toString('utf8')})
 while(end>offset){while(end<raw.length&&(raw[end]&0xc0)===0x80)end--;const out=result();if(bytes(out)<=budget)return out;end-=Math.max(1,Math.ceil((bytes(out)-budget)/2))}
 throw Error('单次读取预算不足，无法返回完整字符')
}
function archiveRows(api,s,entry){
 const name=entry.name
 if(name!==path.basename(name)||!name.endsWith('.json'))throw Error('归档名称无效')
 const file=path.join(api.dir,'archive',name),size=fs.statSync(file).size
 if(size>8*1024*1024)throw Error('归档超过单次读取上限')
 const raw=fs.readFileSync(file,'utf8');if(hash(raw)!==entry.digest)throw Error('归档校验失败')
 const data=JSON.parse(raw);if(!Array.isArray(data.events))throw Error('归档格式无效')
 return {rows:data.events,size}
}
const eventAllowed=(s,e,scene)=>historicalKinds.has(e.kind)&&visible(e,scene)&&!(s.cognition?.deletedIds??[]).includes(e.id)
function findEvent(api,s,id,scene,archive){
 let e
 if(archive){const entry=s.archives.find(a=>a.name===archive);if(!entry)throw Error('归档不在权威清单中');e=archiveRows(api,s,entry).rows.find(e=>e.id===id)}
 else e=s.events.find(e=>e.id===id)
 return e&&eventAllowed(s,e,scene)?e:null
}
export function attachDynamicMemory(api,cfg){
 const c=cfg.dynamicMemory,now=api.now
 Object.assign(api,{
  dynamicStatus(){const s=api.read(),d=s.dynamicMemory??{access:{},accessRevision:0};const tiers={hot:0,warm:0,cold:0,dormant:0};for(const m of s.memories.filter(m=>m.active))tiers[lifecycleView(m,now(),d.access[m.id],c).tier]++;return {schema:1,enabled:c.enabled,shadow:c.shadow,active:dynamicActive(c),config:c,accessRevision:d.accessRevision,tiers,legacyBlocked:s.memories.filter(m=>m.recallEnabled===false&&!m.lifecycle).length,migrationRequired:s.memories.filter(m=>!m.lifecycle).length,automaticDeletion:dynamicActive(c)&&c.autoDelete,attentionBasis:'independent-related-events',usageMetrics:'diagnostic-only'}},
  dynamicMigrate({apply=false}={}){if(!apply)return migrateLifecycle(api.read());return api.tx(s=>{const result=migrateLifecycle(s,{apply:true});dynamicState(s);if(result.count){s.settings.permissionVersion=(s.settings.permissionVersion??0)+1;s.settings.policyRevision=(s.settings.policyRevision??0)+1;for(const d of s.drafts)if(['editing','pending'].includes(d.status))d.status='discarded'}return result})},
  memoryCatalog({query='',scene='private-reply',historical=false,limit=c.catalogLimit,cursor=null}={}){
   assertScene(scene);if(typeof query!=='string'||query.length>2000)throw Error('检索文本超限')
   if(!Number.isInteger(limit)||limit<1||limit>c.catalogLimit)throw Error('目录数量超限')
   const s=api.read(),ranked=rankMemories(s.memories.filter(m=>!(s.cognition?.deletedIds??[]).includes(m.id)),{query,scene,at:now(),historical,access:s.dynamicMemory?.access??{},cfg:c})
   const fingerprint=hash({query,scene,historical,rows:ranked.map(r=>[r.memory.id,r.memory.version??1,r.view.validity]),permission:s.settings.permissionVersion??0})
   const offset=cursor?cursorDecode(cursor,fingerprint).offset:0;if(!Number.isInteger(offset)||offset<0||offset>ranked.length)throw Error('目录分页位置无效')
   const page=ranked.slice(offset,offset+limit)
   return {items:page.map(({memory:m,view:v,reason,relevance})=>({id:m.id,version:m.version??1,title:Array.from(m.text).slice(0,60).join(''),summary:Array.from(m.text).slice(0,160).join(''),type:m.type,subject:m.subject??'world',validity:v.validity,observationWindow:m.observationWindow,tier:v.tier,retentionStage:v.retentionStage,relation:v.relation,reason,relevance})),cursor:offset+limit<ranked.length?cursorEncode({fingerprint,offset:offset+limit}):null}
  },
  memoryExplain(id,scene='local-management'){
   assertScene(scene);const s=api.read(),m=s.memories.find(m=>m.id===id)
   if(!m||(s.cognition?.deletedIds??[]).includes(m.id)||!inScope(m,scene))return null
   const check=recallEligibility(m,scene,now(),{cfg:c,access:s.dynamicMemory?.access?.[id]})
   if(scene!=='local-management'&&!check.allowed)return null
   return {id,version:m.version??1,...check,evidence:{independent:m.independentEvidence??null,sourceIds:m.sourceIds,counterEvidenceIds:m.counterEvidenceIds??[],confidence:m.confidenceBand??null},semanticVersion:m.version??1,accessRevision:s.dynamicMemory?.accessRevision??0}
  },
  memoryHistory({query='',scene='private-reply',cursor=null,limit=c.catalogLimit}={}){
   assertScene(scene);if(typeof query!=='string'||query.length>2000||!Number.isInteger(limit)||limit<1||limit>c.catalogLimit)throw Error('历史检索参数无效')
   const s=api.read(),entries=[null,...s.archives.slice().reverse()],tokens=terms(query),fingerprint=hash({query,scene,events:s.events,archives:s.archives,permission:s.settings.permissionVersion??0,deleted:s.cognition?.deletedIds})
   let position=cursor?cursorDecode(cursor,fingerprint):{entry:0,row:0}
   if(!Number.isInteger(position.entry)||!Number.isInteger(position.row)||position.entry<0||position.entry>=entries.length||position.row<0)throw Error('历史分页位置无效')
   const items=[],diagnostics=[];let readBytes=0,scanned=0
   for(;position.entry<entries.length;position.entry++,position.row=0){
    const a=entries[position.entry];if(a&&(scanned>=8||readBytes>=8*1024*1024))break
    let rows
    if(a){scanned++;try{const loaded=archiveRows(api,s,a);if(readBytes+loaded.size>8*1024*1024&&scanned>1)break;rows=loaded.rows;readBytes+=loaded.size}catch(e){diagnostics.push({code:'ARCHIVE_UNAVAILABLE',message:e.message});continue}}
    else rows=s.events
    for(;position.row<rows.length;position.row++){
     const e=rows[position.row];if(!eventAllowed(s,e,scene))continue
     const words=new Set(terms(e.text));if(tokens.length&&!tokens.some(t=>words.has(t)||(t.length===1&&String(e.text).includes(t))))continue
     items.push({id:e.id,version:1,kind:e.kind,at:e.at,title:Array.from(String(e.text??'')).slice(0,100).join(''),archive:a?.name??null,validity:'historical'})
     if(items.length>=limit){position.row++;return {items,diagnostics,cursor:cursorEncode({...position,fingerprint})}}
    }
   }
   return {items,diagnostics,cursor:position.entry<entries.length?cursorEncode({...position,fingerprint}):null}
  },
  async memoryTaskCatalog({taskId,scene,history=false,...options}){
   assertScene(scene);if(!dynamicActive(c)||cfg.paused)throw Error('动态召回尚未启用或处于对照/暂停模式')
   return api.tx(s=>{
    if(s.settings.paused)throw Error('当前已暂停')
    const t=requireTask(s,taskId,scene,now());t.memoryUsage??={bytes:0,credits:{}}
    const remaining=Math.min(c.fetchBytes,c.taskFetchBytes-t.memoryUsage.bytes)
    if(remaining<512)throw Error('本任务记忆读取预算已耗尽')
    let limit=options.limit??c.catalogLimit,out
    // Redo the pure page with a smaller limit so continuation never skips rows.
    do{
     out=history?api.memoryHistory({...options,scene,limit}):api.memoryCatalog({...options,scene,limit})
     if(bytes(out)<=remaining)break
     if(limit<=1)throw Error('目录响应超过剩余预算')
     limit=Math.max(1,Math.floor(limit/2))
    }while(true)
    t.memoryUsage.bytes+=bytes(out)
    return out
   })
  },
  async memoryFetch({id,expectedVersion,taskId,scene,offsetBytes=0,contentHash,historical=false,kind='memory',archive=null}){
   assertScene(scene);if(!dynamicActive(c)||cfg.paused)throw Error('动态召回尚未启用或处于对照/暂停模式')
   return api.tx(s=>{
    if(s.settings.paused)throw Error('当前已暂停')
    const t=requireTask(s,taskId,scene,now());t.memoryUsage??={bytes:0,credits:{}}
    let m,record
    if(kind==='memory'){
     m=s.memories.find(m=>m.id===id)
     if(!m||(s.cognition?.deletedIds??[]).includes(m.id)||!recallEligibility(m,scene,now(),{historical,cfg:c}).allowed)throw Error('记忆不可取回')
     if(expectedVersion!==(m.version??1))throw Error('记忆内容版本已变化')
     record={id:m.id,version:m.version??1,text:m.text,type:m.type,subject:m.subject??'world',scope:m.scope,epistemic:m.epistemic,observationWindow:m.observationWindow,policy:m.policy,alternatives:m.alternatives,behaviorLinks:m.behaviorLinks,sourceIds:m.sourceIds,counterEvidenceIds:m.counterEvidenceIds}
    }else if(kind==='event'){
     if(!historical||expectedVersion!==1)throw Error('历史原文需明确 historical 和 version=1')
     const e=findEvent(api,s,id,scene,archive);if(!e)throw Error('历史来源不存在或不可见')
     record={id:e.id,version:1,kind:e.kind,at:e.at,text:e.text,origin:e.origin,verifiedRole:e.verifiedRole??'unverified',validity:'historical',sourceIds:[e.id]}
    }else throw Error('未知读取对象')
    const remaining=c.taskFetchBytes-t.memoryUsage.bytes
    if(remaining<512)throw Error('本任务记忆读取预算已耗尽')
    const out=boundedFragment(record,{id,version:expectedVersion,kind,validity:m?lifecycleView(m,now(),{},c).validity:'historical'},offsetBytes,Math.min(c.fetchBytes,remaining),contentHash)
    t.memoryUsage.bytes+=bytes(out)
    if(!t.refs.some(r=>r.id===id&&r.version===expectedVersion)){if((t.fetchedRefs??[]).length>=32)throw Error('任务取回条目过多');t.refs.push({id,version:expectedVersion});(t.fetchedRefs??=[]).push({id,version:expectedVersion,historical})}
    if(m)creditMemoryUse(s,t,m,{phase:'fetched',at:now(),cfg:c})
    return out
   },null,{projectionOptional:true})
  },
  memoryRetention(id,{protect=false,reason=''}={}){return api.tx(s=>{
   const m=s.memories.find(m=>m.id===id);if(!m||!m.active)throw Error('记忆不存在或已撤销')
   if(typeof reason!=='string'||reason.length>500||protect&&!reason.trim())throw Error('保护记忆需说明依据，最多 500 字')
   migrateLifecycle(s,{apply:true});m.lifecycle.retention={class:protect?'protected':mandatoryMemory(m)?'important':'normal',pinnedBy:protect?'owner':null,reason:protect?reason:null}
   return {id,retention:m.lifecycle.retention,recallControl:m.lifecycle.recallControl}
  })},
 })
}

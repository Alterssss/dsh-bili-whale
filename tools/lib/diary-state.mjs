import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {checkOperation} from './operation-context.mjs'
import {acquireProcessLock} from './process-lock.mjs'
import {dayKey,DAY} from './affect-engine.mjs'
const uid=()=>crypto.randomUUID()
const error=code=>{throw Object.assign(Error(code),{code})}
const publicSource=e=>e.kind==='video-read'&&e.origin==='video'&&e.data?.subtitle===true||e.kind==='sent'&&['comment','dynamic'].includes(e.channel)&&e.origin==='tool'&&!!e.receipt
const privateSource=e=>e.kind==='received'&&e.verifiedRole==='owner'||e.kind==='sent'&&e.channel==='dm'&&e.origin==='tool'&&!!e.receipt
const init=s=>s.settings.diary??={version:1,cursors:{public:0,private:0},jobs:{},daily:{day:'',public:0,private:0}}
export function attachDiary(api,cfg,{event,fullConfig}){
 const full=()=>typeof fullConfig==='function'?fullConfig():fullConfig??{}
 const enabled=s=>{const f=full();return cfg.enabled&&!cfg.paused&&!s.settings.paused&&f.life?.enabled!==false&&!f.life?.paused&&f.diary?.enabled!==false}
 const paths={public:path.join(api.dir,'whale-diary.md'),private:path.join(api.dir,'whale-diary-private.md')}
 const entries=scope=>{if(!['public','private'].includes(scope))throw Error('需要明确日记范围');const s=api.export();return [...s.events,...s.archiveContents.flatMap(a=>a.events)].filter(e=>e.kind==='diary'&&(e.data?.visibility==='public'?'public':'private')===scope).sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id))}
 Object.assign(api,{
  diaryEntries:entries,
  diaryStatus(){const s=api.read(),d=s.settings.diary;return {enabled:enabled(s),paths,lastPush:d?.lastPush??null,cursors:d?.cursors??{},daily:d?.daily??null,jobs:Object.values(d?.jobs??{}).map(j=>({id:j.id,scope:j.scope,status:j.status,attempt:j.attempt,lastError:j.lastError??null,finishKind:j.finishKind??null,quotaRefunded:j.quotaRefunded??false}))}},
  async renderDiary(){
   if(!enabled(api.read()))return {status:'disabled',paths}
   // 空闲 tick 不该每次把整段历史重新导出一遍：
   // 两个派生文件都在、且日记事件没有新增时，直接返回轻量结果。
   const st=api.read(),d=init(st)
   const bothExist=fs.existsSync(paths.public)&&fs.existsSync(paths.private)
   // 轻量路径：没有新提交（renderDirty 为假）且上次渲染成功、两个文件都在 → 直接跳过，不导出历史。
   // 旧状态没有 renderDirty 字段 → 当作脏，渲染一次后置假。
   if(bothExist&&d.lastRender?.ok&&d.renderDirty!==true)return {status:'skipped',paths,reason:'no-change'}
   const s=api.export()
   const all=[...s.events,...s.archiveContents.flatMap(a=>a.events)].filter(e=>e.kind==='diary')
   const latest=all.reduce((n,e)=>Math.max(n,Number(e.at)||0),0)
   const count=all.length
   fs.mkdirSync(api.dir,{recursive:true});let release
   for(let i=0;i<80;i++){try{release=await acquireProcessLock(path.join(api.dir,'diary-render'));break}catch(e){if(i===79)throw e;await new Promise(r=>setTimeout(r,25))}}
   try{
    // 公开与私人两本共用同一份导出快照（一次重建只 export 一次）。
    const scopeRows=scope=>all.filter(e=>(e.data?.visibility==='public'?'public':'private')===scope).sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id))
    for(const scope of ['public','private']){
    const rows=scopeRows(scope),text='# '+(scope==='public'?'浏览日记':'私人日记')+'\n\n这是已提交日记事件的派生视图；范围：'+scope+'。\n\n'+rows.map(e=>'## '+new Date(e.at+8*3600000).toISOString().slice(0,16).replace('T',' ')+'（北京时间）\n\n'+e.text+'\n\n<!-- diary-event:'+e.id+' -->\n').join('\n')
    let old;try{old=fs.readFileSync(paths[scope],'utf8')}catch(e){if(e.code!=='ENOENT')throw e}
    if(old===text)continue
    checkOperation();if(!enabled(api.read()))return {status:'disabled',paths}
    const tmp=paths[scope]+'.'+uid()+'.tmp';try{fs.writeFileSync(tmp,text,{mode:0o600});fs.renameSync(tmp,paths[scope])}finally{fs.rmSync(tmp,{force:true})}
   }api.tx(s2=>{const d2=init(s2);d2.lastRender={ok:true,count,latest,at:api.now()};d2.renderDirty=false})
   return {status:'rendered',paths}}finally{await release()}
  },
  prepareDiaryPush(eventId){return api.tx(s=>{
   const d=init(s),j=d.jobs.public,f=full()
   if(!enabled(s)||f.diary?.push===false||!f.notify?.type||f.notify.type==='none'||j?.eventId!==eventId||j.status!=='committed'||d.lastPush?.eventId===eventId)return false
   d.lastPush={eventId,status:'ready',at:api.now()}
   return true
  })},
  claimDiaryPush(eventId){return api.tx(s=>{
   const d=init(s),p=d.lastPush,f=full()
   if(!enabled(s)||f.diary?.push===false||!f.notify?.type||f.notify.type==='none'||p?.eventId!==eventId||p.status!=='ready')return null
   const e=s.events.find(e=>e.id===eventId&&e.origin==='diary-worker'&&e.kind==='diary'&&e.data?.visibility==='public')
   if(!e)return null
   p.status='attempted';p.at=api.now()
   return e.text
  })},
  finishDiaryPush(eventId,status){return api.tx(s=>{
   const p=s.settings.diary?.lastPush
   if(p?.eventId===eventId&&['ready','attempted'].includes(p.status)){
    p.status=status;p.at=api.now()
    if(status==='failed')p.code='DIARY_PUSH_FAILED'
   }
  })},
  claimDiaryJob(){return api.tx(s=>{
   if(!enabled(s))return null
   const d=init(s),at=api.now(),day=dayKey(at);if(d.daily.day!==day)d.daily={day,public:0,private:0}
   for(const scope of ['public','private']){
    let j=d.jobs[scope]
    if(j?.status==='running'&&j.expiresAt>at)continue
    if(j&&['running','retry'].includes(j.status)){
     if(j.notBefore>at)continue
     if(j.attempt>=2){j.status='abandoned';d.cursors[scope]=Math.max(d.cursors[scope],j.throughSeq);continue}
    }else{
     if(j&&at-j.createdAt<30*60000||d.daily[scope]>=4)continue
     const sources=s.events.filter(e=>e.seq>d.cursors[scope]&&e.at>=at-DAY&&e.at<=at-120000&&(scope==='public'?publicSource(e):privateSource(e))).sort((a,b)=>a.seq-b.seq).slice(0,16)
     if(!sources.length)continue
     j={id:uid(),scope,status:'queued',createdAt:at,attempt:0,throughSeq:sources.at(-1).seq,sources:sources.map(e=>({id:e.id,kind:e.kind,at:e.at,text:String(e.text).slice(0,1200),channel:e.channel??'',target:e.target??'',materialOnly:e.kind==='video-read'}))};d.jobs[scope]=j
    }
    // Pre-.24 jobs did not retain the finish reason. Reuse the paid slot once
    // for a blocked same-day retry without reclassifying the original error.
    const legacySlot=d.daily[scope]>=4&&j.status==='retry'&&j.attempt===1&&j.chargeDay===undefined&&
      j.lastError==='AFFECT_FINISH_INVALID'&&dayKey(j.expiresAt-120000)===day
    if(d.daily[scope]>=4&&!legacySlot)continue
    j.status='running';j.attempt++;j.lease=uid();j.expiresAt=at+120000;j.permission=s.settings.permissionVersion??0
    j.chargeDay=day;j.charged=!legacySlot
    if(j.charged)d.daily[scope]++
    return structuredClone(j)
   }return null
  })},
  commitDiaryJob(job,raw){return api.tx(s=>{
   const d=init(s),j=d.jobs[job.scope]
   if(!enabled(s)||!j||j.id!==job.id||j.lease!==job.lease||j.status!=='running'||j.expiresAt<=api.now()||j.permission!==(s.settings.permissionVersion??0))error('DIARY_JOB_STALE')
   if(typeof raw!=='string'||Buffer.byteLength(raw)>8192)error('DIARY_OUTPUT_SIZE')
   const r=JSON.parse(raw)
   if(!r||Object.keys(r).some(k=>!['action','text','quotes'].includes(k))||!['write','skip'].includes(r.action))error('DIARY_OUTPUT_INVALID')
   if(r.action==='write'){
    if(typeof r.text!=='string'||!r.text.trim()||r.text.length>1200||!Array.isArray(r.quotes)||!r.quotes.length||r.quotes.length>16)error('DIARY_OUTPUT_INVALID')
    for(const q of r.quotes)if(!q||Object.keys(q).some(k=>!['eventId','text'].includes(k))||typeof q.text!=='string'||q.text.length<2||!j.sources.some(e=>e.id===q.eventId&&e.text.includes(q.text)))error('DIARY_SOURCE_QUOTE')
    const sourceIds=[...new Set(r.quotes.map(q=>q.eventId))]
    const e=event(s,'diary',{key:'diary:'+j.id,text:r.text.trim(),origin:'diary-worker',data:{visibility:j.scope,sourceIds,quotes:r.quotes,jobId:j.id}});j.eventId=e.id;d.renderDirty=true
   }
   j.status=r.action==='write'?'committed':'skipped';j.completedAt=api.now();d.cursors[j.scope]=Math.max(d.cursors[j.scope],j.throughSeq);return {status:j.status,eventId:j.eventId??null}
  })},
  failDiaryJob(job,code='DIARY_FAILED',finishKind){return api.tx(s=>{
   const d=s.settings.diary,j=d?.jobs[job.scope]
   if(!j||j.id!==job.id||j.lease!==job.lease||j.status!=='running')return
   j.status='retry';j.notBefore=api.now()+120000;j.lastError=/^[A-Z_]+$/.test(code)?code:'DIARY_FAILED'
   j.finishKind=code==='AFFECT_FINISH_INVALID'&&typeof finishKind==='string'?finishKind.slice(0,64):null
   j.chargeDay??=dayKey(j.expiresAt-120000);j.charged??=true
   j.quotaRefunded=false
   if(['max-tokens','length'].includes(j.finishKind)&&j.charged&&d.daily.day===j.chargeDay){
    d.daily[j.scope]=Math.max(0,d.daily[j.scope]-1);j.charged=false;j.quotaRefunded=true
   }
  })},
 })
}

export function validateDiary(d){
 if(d===undefined)return
 if(!d||d.version!==1||!d.cursors||!d.jobs||!d.daily||['public','private'].some(k=>!Number.isInteger(d.cursors[k])||d.cursors[k]<0||!Number.isFinite(d.daily[k])||d.daily[k]<0))error('DIARY_STATE_INVALID')
 for(const [scope,j] of Object.entries(d.jobs))if(!['public','private'].includes(scope)||j.scope!==scope||!j.id||!['queued','running','retry','abandoned','committed','skipped'].includes(j.status)||!Number.isInteger(j.attempt)||j.attempt<0||j.attempt>2||!Array.isArray(j.sources)||j.sources.length>16||!Number.isInteger(j.throughSeq))error('DIARY_STATE_INVALID')
}

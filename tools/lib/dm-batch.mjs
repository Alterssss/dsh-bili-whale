import crypto from 'node:crypto'
import path from 'node:path'
import {acquireProcessLock} from './process-lock.mjs'
import {prepareExpression,finalizeExpression} from './expression.mjs'
import {chatConfig} from './chat-config.mjs'
const SKIP=new Set(['不回','不说','不发','（不回）','（不说）','（不发）','(不回)','(不说)','(不发)'])
export function parseMessages(input,maxParts=6){
  const value=typeof input==='string'?input.trim():input
  if(!value||typeof value==='string'&&SKIP.has(value))return []
  const rows=Array.isArray(value)?value:String(value).split(/\r?\n/).filter(x=>x.trim()&&!/^[-–—]{3,}$/.test(x.trim()))
  if(rows.some(x=>typeof x!=='string'))throw Error('多段正文必须是字符串数组')
  const messages=rows.map(x=>x.trim()).filter(x=>x&&!SKIP.has(x))
  if(messages.length>maxParts)throw Error('超过 '+maxParts+' 条，未截断或发送；请整理后重试')
  if(messages.some(x=>x.length>300))throw Error('单条超过 300 字；未截断或发送')
  if(new Set(messages).size!==messages.length)throw Error('同组有重复正文，请合并后重试')
  return messages
}
export async function createBatch(store,input,{config={},taskId=null,key=''}={}){
  const release=await acquireProcessLock(path.join(store.dir,'dm-batch-create'))
  try{return await prepareBatch(store,input,{config,taskId,key})}finally{await release()}
}
async function prepareBatch(store,input,{config={},taskId=null,key=''}={}){
  const c=chatConfig(config.chat),messages=parseMessages(input,c.multi?c.maxParts:1)
  if(!messages.length)return null
  const signature=crypto.createHash('sha256').update(JSON.stringify([messages,taskId])).digest('hex')
  // Content identity prevents recreating a partially sent batch from the same file.
  const existing=(store.read().settings.dmBatches??[]).find(b=>(key?b.key===key:b.signature===signature)&&store.now()-b.at<86400000)
  if(existing){if(existing.signature!==signature)throw Error('同一任务的正文已变化，请先核查原发送组');return existing}
  const drafts=[]
  try{
    for(const text of messages){const d=await prepareExpression(store,{scene:'private-reply',target:String(config.owner?.mid??''),text,share:false,taskId});drafts.push(d.id);await finalizeExpression(store,d.id)}
    return await store.tx(s=>{
      const batches=s.settings.dmBatches??=[]
      if(batches.filter(b=>b.status!=='sent'&&b.status!=='cancelled').length>=30)throw Error('待发送组过多，请先处理')
      const b={id:crypto.randomUUID(),key,signature,at:store.now(),owner:String(config.owner?.mid),policy:s.settings.policyRevision??0,status:'ready',parts:messages.map((text,i)=>({text,draftId:drafts[i],status:'ready'}))}
      batches.push(b);s.settings.dmBatches=batches.filter(x=>x.status!=='sent'||store.now()-x.at<7*86400000);return b
    })
  }catch(e){await store.tx(s=>{for(const d of s.drafts)if(drafts.includes(d.id)&&['editing','pending'].includes(d.status))d.status='discarded'});throw e}
}
export async function sendBatch(store,id,{run,config,signal}={}){
  const release=await acquireProcessLock(path.join(store.dir,'dm-batch-send'))
  const update=fn=>store.tx(s=>{const b=(s.settings.dmBatches??[]).find(x=>x.id===id);if(!b)throw Error('发送组不存在');return fn(b,s)})
  try{
    let b=(store.read().settings.dmBatches??[]).find(x=>x.id===id)
    if(!b)throw Error('发送组不存在')
    if(b.status==='sent')return b
    if(b.status==='cancelled')throw Error('发送组已取消')
    for(let i=0;i<b.parts.length;i++){
      signal?.throwIfAborted()
      const full=typeof config==='function'?config():config
      const s=store.read(),part=b.parts[i],draft=s.drafts.find(d=>d.id===part.draftId)
      if(b.owner!==String(full.owner?.mid)||b.policy!==(s.settings.policyRevision??0)||store.now()-b.at>86400000)throw Error('发送组目标/策略变化或已过期，请核查剩余正文')
      if(part.status==='sent')continue
      if(draft?.status==='sent'){await update(x=>{x.parts[i].status='sent'});continue}
      if(Object.values(s.pending).some(p=>p.draftId===part.draftId)){
        await update(x=>{x.status='unconfirmed';x.parts[i].status='unconfirmed'});throw Error('第 '+(i+1)+' 条回执未知，先核查；剩余正文已保留')
      }
      if(draft?.status!=='pending')throw Error('第 '+(i+1)+' 条草稿已失效')
      const args=['dm','--draft',part.draftId,'--auto']
      const dry=await run([...args,'--dry'],signal)
      signal?.throwIfAborted()
      if(!dry.ok)throw Error('第 '+(i+1)+' 条预检失败：'+String(dry.err??'').slice(-300))
      await update(x=>{x.status='sending';x.parts[i].status='sending'})
      const result=await run([...args,'--go'],signal)
      // A child exit code is not a receipt. The existing DM ledger is authoritative.
      const after=store.read(),confirmed=after.drafts.find(d=>d.id===part.draftId)?.status==='sent'
      const uncertain=Object.values(after.pending).some(p=>p.draftId===part.draftId)
      await update(x=>{x.parts[i].status=confirmed?'sent':uncertain?'unconfirmed':'ready';x.status=confirmed?'sending':uncertain?'unconfirmed':'partial'})
      if(!confirmed)throw Error('第 '+(i+1)+' 条未确认，剩余正文已保留：'+String(result.err??'').slice(-300))
      b=(store.read().settings.dmBatches??[]).find(x=>x.id===id)
    }
    return await update(x=>{x.status='sent';return x})
  }finally{await release()}
}
export async function cancelBatch(store,id){
  const release=await acquireProcessLock(path.join(store.dir,'dm-batch-send'))
  try{return await store.tx(s=>{
    const b=(s.settings.dmBatches??[]).find(x=>x.id===id);if(!b)throw Error('发送组不存在')
    if(b.parts.some(part=>Object.values(s.pending).some(p=>p.draftId===part.draftId)))throw Error('存在未确认发送，先核查回执')
    for(const part of b.parts){const d=s.drafts.find(d=>d.id===part.draftId);if(d?.status==='sent')part.status='sent';else if(d&&['pending','editing'].includes(d.status))d.status='discarded'}
    b.status='cancelled';return b
  })}finally{await release()}
}

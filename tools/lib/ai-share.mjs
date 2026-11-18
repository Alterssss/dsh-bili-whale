import { resolveHome } from './home.mjs'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const TTL = 6 * 3600000
const hash = s => crypto.createHash('sha256').update(s).digest('hex')
const home = () => resolveHome()
function file(bvid, suffix) {
  if (!/^BV[a-zA-Z0-9]{10}$/.test(bvid)) throw Error('需要有效 BV 号')
  let session = 'anonymous'
  try { session = JSON.parse(fs.readFileSync(path.join(home(),'.bili-ai/credentials.json'),'utf8')).sessdata || session } catch {}
  const dir = path.join(home(),'.bili-ai/ai-share',hash(session).slice(0,20))
  fs.mkdirSync(dir,{recursive:true})
  return path.join(dir,bvid+'.'+suffix+'.json')
}
export function readAI(bvid, suffix) {
  try { const x=JSON.parse(fs.readFileSync(file(bvid,suffix),'utf8')); return x.at <= Date.now() && Date.now()-x.at<TTL ? x : null } catch { return null }
}
export function writeAI(bvid,suffix,value) {
  const dest=file(bvid,suffix), tmp=dest+'.'+crypto.randomUUID()+'.tmp'
  fs.writeFileSync(tmp,JSON.stringify(value));fs.renameSync(tmp,dest)
}
export function cacheComments(bvid,oid,sort,items) {
  writeAI(bvid,'comments-'+sort,{at:Date.now(),oid:String(oid),items})
}
export function makeSample(bvid,oid,items,limit=20,sampledAt=Date.now()) {
  const seen=new Set(), rows=[]
  for(const r of items) {
    const id=String(r.rpid??''),text=String(r.text??'').trim().slice(0,400)
    if(!id||!text||seen.has(id))continue
    seen.add(id);rows.push({id,text});if(rows.length>=limit)break
  }
  const at=Math.min(Date.now(),sampledAt), sampleId=hash(JSON.stringify({bvid,oid:String(oid),rows}))
  const sample={at,bvid,oid:String(oid),sampleId,rows,limit}
  writeAI(bvid,'sample',sample);return sample
}
export function recordAssessment(bvid,result) {
  const sample=readAI(bvid,'sample')
  if(!sample || result.sampleId!==sample.sampleId)throw Error('样本已过期或 sampleId 不匹配')
  if(!Array.isArray(result.labels)||result.labels.length!==sample.rows.length)throw Error('必须逐条标记全部样本')
  const ids=new Set(sample.rows.map(r=>r.id)), seen=new Set()
  for(const row of result.labels) {
    if(!ids.has(row.id)||seen.has(row.id)||!['suspected','other','uncertain'].includes(row.label))throw Error('评论 ID 或分类无效')
    if(row.label==='suspected' && (typeof row.reason!=='string'||row.reason.trim().length<8))throw Error('疑似 AI 判断需要具体理由')
    seen.add(row.id)
  }
  const assessment={...sample,labels:result.labels.map(({id,label,reason})=>({id,label,reason:String(reason??'').slice(0,300)}))}
  writeAI(bvid,'assessment',assessment);return assessment
}
// 2026-10-24 主人定：暂缓阈值写死 30%，不再做成设置项
// 理由：这是判断她要不要在这个评论区说话的产品原则，不该让用户微调
export const AI_SUSPECT_THRESHOLD = 30
export function decision(bvid,oid,threshold=AI_SUSPECT_THRESHOLD) {
  const sample=readAI(bvid,'sample'), a=readAI(bvid,'assessment')
  threshold=Number(threshold);if(!Number.isFinite(threshold)||threshold<1||threshold>100)threshold=AI_SUSPECT_THRESHOLD
  if(!sample||sample.oid!==String(oid))return {status:'pending',allow:false,reason:'尚无有效样本，请先运行 ai-share sample'}
  if(sample.rows.length<20)return {status:'insufficient',allow:true,n:sample.rows.length,reason:'样本不足 20 条，无法判断；按策略允许分享'}
  if(!a||a.sampleId!==sample.sampleId)return {status:'pending',allow:false,reason:'样本尚未由 DSH 模型评估'}
  const n=a.labels.length, suspected=a.labels.filter(x=>x.label==='suspected').length, unknown=a.labels.filter(x=>x.label==='uncertain').length
  const ratio=suspected/n*100
  if(sample.limit<40 && Math.abs(ratio-threshold)<=10)return {status:'expand',allow:false,n,ratio,reason:'接近阈值，请 sample --more 补充样本后重新判断'}
  if(ratio>=threshold)return {status:'blocked',allow:false,n,ratio,reason:'样本中疑似 AI 发言占比达到阈值（不代表整个评论区）'}
  if((suspected+unknown)/n*100>=threshold)return {status:'uncertain',allow:false,n,ratio,reason:'无法确定的评论可能影响结论，暂缓分享'}
  return {status:'allowed',allow:true,n,ratio,reason:'样本疑似比例低于阈值'}
}
export async function notifyOnce(bvid,result,send) {
  if(readAI(bvid,'notice'))return false
  // Exclusive marker prevents parallel CLI invocations from duplicating alerts.
  const lock=file(bvid,'notice')+'.lock'
  let fd
  try {fd=fs.openSync(lock,'wx')} catch(e) {if(e.code==='EEXIST')return false;throw e}
  try {
    if(readAI(bvid,'notice'))return false
    await send(`暂缓 @ 分享\nhttps://www.bilibili.com/video/${bvid}/\n${result.reason}\n样本：${result.n??0} 条；疑似占比：${result.ratio==null?'无法判断':result.ratio.toFixed(1)+'%'}。仅为模型估计，不是身份鉴定。`)
    writeAI(bvid,'notice',{at:Date.now()});return true
  } finally {fs.closeSync(fd);fs.unlinkSync(lock)}
}

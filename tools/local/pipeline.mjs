import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {config} from '../lib/config.mjs'
import {lifeStore} from '../lib/life-runtime.mjs'
import {credentialsPath} from '../lib/paths.mjs'
import {apiGet} from '../lib/bili-api.mjs'
import {atomicWriteJson} from '../lib/life-persistence.mjs'
import {acquireProcessLock} from '../lib/process-lock.mjs'
import {preferenceMatches} from '../lib/feed-preferences.mjs'
import {pipelineConfig,eligibleVideo} from './pipeline-config.mjs'
import {runNode,mapLimit,parseResult} from './process.mjs'
export const commandFile=name=>fileURLToPath(new URL('../commands/'+name+'.mjs',import.meta.url))
export async function discover(args=[],options={}){const result=parseResult(await runNode(commandFile('feed'),[...args,'--json'],options));if(result.schema!=='whale.discovery/1'||!Array.isArray(result.items))throw Error('找片输出格式无效');return result}
export async function batchDebrief(bvs,{noFrames=false,concurrency,timeoutMs,run=runNode,samplePages=1}={}){
 const p=pipelineConfig(),ids=[...new Set(bvs)]
 if(!ids.length||ids.length>20||ids.some(x=>!/^BV[0-9A-Za-z]{10}$/.test(x)))throw Error('需要 1–20 个有效 BV')
 const limit=Number(concurrency??p.concurrency);if(!Number.isInteger(limit)||limit<1||limit>3)throw Error('并发数必须为 1–3')
 if(!Number.isInteger(Number(samplePages))||Number(samplePages)<1||Number(samplePages)>20)throw Error('字幕采样必须为 1–20')
 const results=await mapLimit(ids,limit,async bv=>{
  const started=Date.now()
  try{
   const report=parseResult(await run(commandFile('debrief'),[bv,'--json','--sample-pages',String(samplePages),...(noFrames?['--no-frames']:[])],{timeoutMs:timeoutMs??p.timeoutMs}))
   if(report.schema!=='bw.debrief.report/1'||report.bvid!==bv||typeof report.evidenceId!=='string'||!report.evidenceId)throw Error('缺少结构化报告或来源事件回执')
   return {bv,ok:true,elapsedMs:Date.now()-started,report}
  }catch(error){return {bv,ok:false,elapsedMs:Date.now()-started,error:error.message}}
 })
 return {schema:'whale.batch/1',ok:results.filter(x=>x.ok).map(x=>x.bv),failed:results.filter(x=>!x.ok).map(x=>x.bv),results}
}
function headers(){const c=JSON.parse(fs.readFileSync(credentialsPath,'utf8'));return {'user-agent':'Mozilla/5.0',referer:'https://www.bilibili.com/',cookie:`SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct}; buvid3=${c.buvid3??''}`}}
async function get(url){const j=await apiGet(url,headers());if(j.code!==0)throw Error(j.message??('API code='+j.code));return j.data}
export async function collectTags(bvs,{kind='read'}={}){
 const life=lifeStore(),p=pipelineConfig(),rows=[];const state=life.read()
 for(const bv of [...new Set(bvs)].slice(0,20)){
  if(!/^BV[0-9A-Za-z]{10}$/.test(bv))throw Error('无效 BV')
  const evidence=state.events.findLast(e=>e.kind==='video-read'&&e.target===bv)
  if(kind==='read'&&!evidence)throw Error('没有已读取来源事件：'+bv)
  const tags=await get('https://api.bilibili.com/x/tag/archive/tags?bvid='+bv)
  rows.push({bv,kind,region:String(evidence?.data?.tname??''),evidenceId:evidence?.id??null,tags:[...new Set((Array.isArray(tags)?tags:[]).map(t=>String(t.tag_name??'').trim()).filter(Boolean))].slice(0,30),at:new Date().toISOString()})
 }
 const file=path.join(life.dir,'video-tags.json');fs.mkdirSync(life.dir,{recursive:true});const release=await acquireProcessLock(file)
 try{
  let data={schema:1,items:[]};try{data=JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
  if(data.schema!==1||!Array.isArray(data.items))throw Error('标签统计损坏')
  const items=new Map(data.items.map(x=>[x.bv,x]));for(const row of rows){const prior=items.get(row.bv);items.set(row.bv,{...row,...(prior?.kind==='read'?{kind:'read',evidenceId:prior.evidenceId}:{})})}
  data.items=[...items.values()].slice(-2000);atomicWriteJson(file,data)
  const counts=new Map();for(const row of data.items.filter(x=>x.kind==='read'))for(const tag of row.tags)counts.set(tag,(counts.get(tag)??0)+1)
  const regions=new Map();for(const row of data.items.filter(x=>x.kind==='read'&&x.region))regions.set(row.region,(regions.get(row.region)??0)+1)
  return {rows,regions:[...regions].sort((a,b)=>b[1]-a[1]),top:[...counts].sort((a,b)=>b[1]-a[1]).slice(0,30).map(([tag,count])=>({tag,count})),note:'统计参考，不自动改变已确认兴趣或排除偏好'}
 }finally{await release()}
}
export async function relatedCollect(bvs){
 const p=pipelineConfig(),cfg=config(),life=lifeStore(),snapshot=life.read(),seen=new Set(snapshot.events.filter(e=>e.kind==='video-read').map(e=>e.target)),items=[],have=new Set(bvs)
 for(const bv of [...new Set(bvs)].slice(0,p.relatedSources)){
  if(!/^BV[0-9A-Za-z]{10}$/.test(bv))throw Error('无效 BV');if(!p.relatedTakeMax)break
  const rows=await get('https://api.bilibili.com/x/web-interface/archive/related?bvid='+bv);let count=0
  for(const v of (Array.isArray(rows)?rows:[]).slice(0,20)){
   const x={bv:v.bvid,t:String(v.title??''),mid:String(v.owner?.mid??''),up:v.owner?.name??'',d:Number(v.duration??0),play:Number(v.stat?.view??0),dm:Number(v.stat?.danmaku??0),pubdate:Number(v.pubdate),parts:Number(v.videos??1),source:bv,region:String(v.tname??'')}
   if(have.has(x.bv)||seen.has(x.bv)||x.mid===String(cfg.self?.mid??'')||!eligibleVideo(x,p)||x.play<p.relatedMinPlay||(cfg.preferences?.dislike??[]).some(word=>preferenceMatches(x.t,word))||life.preferences({title:x.t,author:x.mid,bvid:x.bv},'watch',snapshot).excluded)continue
   have.add(x.bv);items.push(x);if(++count>=p.relatedTakeMax)break
  }
 }
 return items
}

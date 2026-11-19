import {hooks} from './hooks.mjs'
import fs from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {dshPath} from '../lib/paths.mjs'
import {config} from '../lib/config.mjs'
import {atomicWriteJson} from '../lib/life-persistence.mjs'
import {pipelineConfig} from './pipeline-config.mjs'
import {discover,batchDebrief,collectTags,relatedCollect} from './pipeline.mjs'
// 展示层（out/*.mjs）是本机可选的：out/ 被 .gitignore 忽略，全新 clone 里并不存在。
// 有就挂上，没有就跳过；采集、存档与 --json 输出都不依赖它。
const OUT_VIEWS=['overview','report','stats','final']
for(const view of OUT_VIEWS){
  const file=new URL(`./out/${view}.mjs`,import.meta.url)
  if(fs.existsSync(file))await import(file.href)
}
export async function runRound(argv=process.argv.slice(2)){
 const start=Date.now(),p=pipelineConfig(),arg=name=>{const i=argv.indexOf(name);return i<0?undefined:argv[i+1]},n=Number(arg('--n')??6)
 if(!Number.isInteger(n)||n<1||n>20)throw Error('--n 必须为 1–20')
 const args=['--n',String(n),'--per',String(Math.max(2,Math.ceil(n/Math.max(1,config().preferences?.like?.length??1))))]
 for(let i=0;i<argv.length;i++)if(argv[i]==='--kw'){if(!argv[i+1]||argv[i+1].startsWith('--'))throw Error('--kw 缺少关键词');args.push('--kw',argv[++i])}
 const explicitCount=args.filter(x=>x==='--kw').length;if(explicitCount)args[3]=String(Math.max(2,Math.ceil(n/explicitCount)))
 const selection=await discover(args),result={schema:'whale.round/1',at:new Date().toISOString(),dry:argv.includes('--dry'),selection,warnings:[],timings:{discoveryMs:Date.now()-start}}
 if(!result.dry&&selection.items.length){
  const take=p.deepReadMax==='all'?selection.items.length:p.deepReadMax
  const deepStart=Date.now()
  result.batch=await batchDebrief(selection.items.slice(0,take).map(x=>x.bv),{noFrames:argv.includes('--no-frames'),samplePages:Number(arg('--sample-pages')??1)})
  result.timings.debriefMs=Date.now()-deepStart
  if(result.batch.ok.length){
   const tagsStart=Date.now()
   try{result.tags=await collectTags(result.batch.ok)}catch(e){result.warnings.push('标签统计未完成：'+e.message)}
   result.timings.tagsMs=Date.now()-tagsStart
   const relatedStart=Date.now()
   if(!argv.includes('--no-related'))try{result.related=await relatedCollect(result.batch.ok);if(result.related.length)result.relatedTags=await collectTags(result.related.map(x=>x.bv),{kind:'related'})}catch(e){result.warnings.push('相关推荐未完成：'+e.message)}
   result.timings.relatedMs=Date.now()-relatedStart
  }
 }
 result.elapsedMs=Date.now()-start
 // A round journal contains acquisition results, never fabricated diary thoughts or send receipts.
 if(!result.dry){const file=dshPath('whale-work','rounds',Date.now()+'-'+process.pid+'.json');atomicWriteJson(file,result);result.file=file}
 return result
}
// 没有任何 out/*.mjs 订阅时也要说清这一轮发生了什么，否则看起来像没跑。
function roundFallback(r){
 const picked=r.selection?.items??[],read=r.batch?.ok??[]
 const lines=[`本轮 ${picked.length} 条 · 深读 ${read.length} 条 · 用时 ${(r.elapsedMs/1000).toFixed(1)}s`]
 for(const it of picked)lines.push(`  ${it.bv}  ${it.t}`)
 if(r.batch?.failed?.length)lines.push(`  深读失败: ${r.batch.failed.map(x=>x.bv??x).join(', ')}`)
 if(r.file)lines.push(`存档 ${r.file}`)
 lines.push('提示：out/*.mjs 是本机可选展示层（不进仓库），放进 tools/local/out/ 才会打印详细报告')
 return lines.join('\n')
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{
  const r=await runRound()
  if(process.argv.includes('--json'))console.log(JSON.stringify(r))
  else if(hooks.count('round:done'))await hooks.emit('round:done',{result:r,print:console.log})
  else console.log(roundFallback(r))
  if(r.batch?.failed.length)process.exitCode=1
 }catch(e){console.error(e.message);process.exitCode=1}
}

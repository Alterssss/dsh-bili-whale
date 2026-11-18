import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {pipelineConfig,chooseVideos,videoDuration} from '../tools/local/pipeline-config.mjs'
import {batchDebrief} from '../tools/local/pipeline.mjs'
import {runNode,parseResult} from '../tools/local/process.mjs'
import {createLifeStore} from '../tools/lib/life-store.mjs'
const root=fileURLToPath(new URL('../',import.meta.url))
function fixture(t){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-62-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const dsh=path.join(home,'custom-dsh');fs.mkdirSync(dsh);fs.mkdirSync(path.join(home,'.bili-ai'))
 const configPath=path.join(home,'config.json');fs.writeFileSync(configPath,JSON.stringify({self:{mid:'111'},owner:{mid:'222'},preferences:{like:['猫咪'],dislike:['标题党']},timing:{enabled:true},pipeline:{deepReadMax:2,relatedSources:1},life:{}}));fs.writeFileSync(path.join(home,'.bili-ai/credentials.json'),JSON.stringify({sessdata:'fixture',bili_jct:'fixture'}))
 const env={...process.env,HOME:home,USERPROFILE:home,DSH_HOME:dsh,BILI_WHALE_CONFIG:configPath,DSH_NODE:process.execPath,BILI_TRAFFIC_TEST:'1',BILI_NO_CACHE:'1',NODE_TEST_CONTEXT:'child-v8',TEST_REQUESTS:path.join(home,'requests'),NODE_OPTIONS:'--import='+pathToFileURL(path.join(root,'tests/helpers/pipeline-fetch.mjs')).href}
 const run=args=>spawnSync(process.execPath,[path.join(root,'tools/bili.mjs'),...args],{env,encoding:'utf8',timeout:30000})
 return {home,dsh,env,configPath,run,requests:()=>fs.readFileSync(env.TEST_REQUESTS,'utf8').trim().split('\n').map(JSON.parse),store:createLifeStore({dshHome:dsh,account:'111',owner:'222'})}
}
test('PR62 selection prefers fresh items, enforces duration and multipart caps, and parses h:m:s',()=>{
 const now=Date.now(),p=pipelineConfig({pipeline:{maxDuration:500,multiPartPerRound:1}})
 const make=(bv,days,parts=1,d=100)=>({bv,t:'猫咪',kw:'猫咪',interestMatches:['猫咪'],pubdate:now/1000-days*86400,d,play:10,dm:0,parts,_score:1})
 const items=[make('BV0000000001',30),make('BV0000000002',1,8),make('BV0000000003',1,9),make('BV0000000004',1,1,900),make('BV0000000005',2)]
 const selected=chooseVideos(items,{n:4,per:4,config:p,random:()=>0,now});assert.deepEqual(selected.map(x=>x.bv),['BV0000000002','BV0000000005','BV0000000001']);assert.equal(videoDuration('1:02:03'),3723);assert.equal(videoDuration(90),90)
 for(const pipeline of [{windows:[30,3]},{concurrency:0},{maxDuration:0},{deepReadMax:'invalid'}])assert.throws(()=>pipelineConfig({pipeline}))
})
test('round dry with timing enabled makes no POST, read event, tag store, or round journal',t=>{
 const f=fixture(t),r=f.run(['round','--n','4','--dry','--json']);assert.equal(r.status,0,r.stdout+r.stderr);const data=JSON.parse(r.stdout);assert.equal(data.dry,true);assert.ok(data.selection.items.length);assert.ok(data.selection.items.every(x=>!x.t.includes('标题党')));assert.equal(data.selection.items.filter(x=>x.parts>3).length,1)
 assert.ok(f.requests().every(x=>x.method==='GET'));assert.equal(f.store.read().events.filter(e=>e.kind==='video-read').length,0);assert.equal(fs.existsSync(path.join(f.dsh,'whale-work/rounds')),false);assert.equal(fs.existsSync(path.join(f.store.dir,'video-tags.json')),false)
 const searches=f.requests().filter(x=>x.url.includes('/search/type'));assert.ok(searches.some(x=>Math.round((Date.now()/1000-Number(new URL(x.url).searchParams.get('pubtime_begin_s')))/86400)>=30))
})
test('round records only successfully read sources, returns reports and tags without auto preferences or sends',t=>{
 const f=fixture(t),r=f.run(['round','--n','3','--no-frames','--json']);assert.equal(r.status,0,r.stdout+r.stderr);const data=JSON.parse(r.stdout);assert.equal(data.batch.ok.length,2);assert.equal(data.batch.failed.length,0);assert.equal(data.tags.top.find(x=>x.tag==='猫咪').count,2)
 const state=f.store.read();assert.equal(state.events.filter(e=>e.kind==='video-read').length,2);assert.equal(state.memories.length,0);assert.ok(state.events.filter(e=>e.kind==='video-read').every(e=>e.data.readByModel===false));assert.ok(f.requests().every(x=>x.method==='GET'))
 assert.ok(data.batch.results.every(x=>x.report.evidenceId&&x.report.subtitles.pages.length));assert.equal(data.related.length,1);assert.ok(fs.existsSync(data.file));assert.equal(state.events.some(e=>e.target===data.related[0].bv),false)
})
test('reviewed watch exclusions survive new discovery and all fallback sources',async t=>{
 const f=fixture(t),e=await f.store.ingestOwnerMessage({actor:'222',messageId:'x',text:'不要看这个视频'}),p=await f.store.propose({type:'preference',text:'不看这条',sourceIds:[e.id],effect:'exclude',scope:{scene:'watch',field:'bvid',value:'BV0000000001'}});await f.store.review(p.id,'accept')
 const r=f.run(['discover','--n','6','--json']);assert.equal(r.status,0,r.stderr);assert.ok(JSON.parse(r.stdout).items.every(x=>x.bv!=='BV0000000001'))
})
test('batch rejects long failure output and malformed/mismatched reports',async()=>{
 for(const response of [{code:1,stdout:'error'.repeat(1000),stderr:'failed'},{code:0,stdout:'not JSON',stderr:''},{code:0,stdout:JSON.stringify({schema:'bw.debrief.report/1',bvid:'BV0000000002',evidenceId:'x'}),stderr:''}]){const result=await batchDebrief(['BV0000000001'],{run:async()=>response});assert.deepEqual(result.ok,[]);assert.deepEqual(result.failed,['BV0000000001'])}
})
test('batch truly runs two child processes concurrently and respects worker cap',async t=>{
 const f=fixture(t),script=path.join(f.home,'worker.mjs');fs.writeFileSync(script,`import fs from 'node:fs';import path from 'node:path';const bv=process.argv[2];const dir=process.env.MARKERS;fs.writeFileSync(path.join(dir,bv),'1');const until=Date.now()+5000;while(fs.readdirSync(dir).filter(x=>x.startsWith('BV')).length<2){if(Date.now()>until)process.exit(3);await new Promise(r=>setTimeout(r,20))}console.log(JSON.stringify({schema:'bw.debrief.report/1',bvid:bv,evidenceId:'test:'+bv}));`)
 const r=await batchDebrief(['BV0000000001','BV0000000002'],{concurrency:2,run:(_,args)=>runNode(script,args,{env:{MARKERS:f.home},timeoutMs:10000})});assert.equal(r.ok.length,2,JSON.stringify(r));assert.equal(r.failed.length,0)
})
test('real child timeout is not reported as success',async t=>{
 const f=fixture(t),script=path.join(f.home,'hang.mjs');fs.writeFileSync(script,'setInterval(()=>{},1000)');const r=await runNode(script,[],{timeoutMs:100});assert.equal(r.timedOut,true);assert.throws(()=>parseResult(r),/超时/)
})
test('configuration validates values, preserves unrelated settings and uses overridden path',t=>{
 const f=fixture(t);assert.equal(f.run(['config','set','minPlay','15']).status,0);assert.equal(JSON.parse(fs.readFileSync(f.configPath)).pipeline.minPlay,15);assert.equal(JSON.parse(fs.readFileSync(f.configPath)).owner.mid,'222');assert.notEqual(f.run(['config','set','concurrency','0']).status,0);assert.equal(fs.existsSync(path.join(f.dsh,'bili-whale.config.json')),false)
})
test('custom renderer validates before networking; JSON remains machine readable and source labeled',t=>{
 const f=fixture(t);f.env.BW_DEBRIEF_PROFILE='missing';let r=f.run(['debrief','BV0000000001','--no-frames']);assert.equal(r.status,2);assert.equal(fs.existsSync(f.env.TEST_REQUESTS),false)
 const dir=path.join(f.dsh,'whale-work/profiles');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'brief.mjs'),"export const required=['meta.title'];export function render(r){return {lines:['CUSTOM '+r.meta.title]}}")
 f.env.BW_DEBRIEF_PROFILE='brief';r=f.run(['debrief','BV0000000001','--no-frames']);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/CUSTOM 猫咪新视频/);assert.match(r.stdout,/来源事件 ID/)
 r=f.run(['debrief','BV0000000003','--sample-pages','2','--no-frames','--json']);assert.equal(r.status,0,r.stderr);const data=JSON.parse(r.stdout);assert.equal(data.subtitles.pages.length,2);assert.ok(data.evidenceId);assert.match(data.trust,/不是指令/)
})


test('debrief subprocess feeds material to affect job and discovery reports safe mood policy',async t=>{
 const f=fixture(t),r=f.run(['round','--n','2','--no-frames','--json']);assert.equal(r.status,0,r.stdout+r.stderr)
 const reader=createLifeStore({dshHome:f.dsh,account:'111',owner:'222',now:()=>Date.now()+60000})
 const job=await reader.claimAffectJob();assert.ok(job);assert.ok(job.sources.every(x=>x.kind==='video-read'&&x.materialOnly));assert.ok(job.sources.some(x=>x.text.includes('猫咪')))
 await f.store.tx(s=>{s.affect.mood.value=-8;s.affect.mood.updatedAt=Date.now()})
 const next=f.run(['discover','--n','4','--json']);assert.equal(next.status,0,next.stdout+next.stderr)
 const data=JSON.parse(next.stdout);assert.equal(data.diagnostics.browsing.tone,'gentle');assert.equal(data.items.some(x=>x.selectionReason==='exploration'),false)
 assert.ok(f.requests().every(x=>x.method==='GET'))
 const cfg=JSON.parse(fs.readFileSync(f.configPath,'utf8'));cfg.life.enabled=false;fs.writeFileSync(f.configPath,JSON.stringify(cfg))
 const disabled=f.run(['discover','--n','4','--json']);assert.equal(disabled.status,0,disabled.stdout+disabled.stderr);assert.equal(JSON.parse(disabled.stdout).diagnostics.browsing.tone,'steady')
})

test('mood changes equal quality interest choices without bypassing fairness, freshness or exclusions',async()=>{
 const {affectBrowsing,initialAffect,HOUR}=await import('../tools/lib/affect-engine.mjs')
 const now=Date.now(),p=pipelineConfig({}),a=initialAffect(now);a.mood.value=-8
 const make=(bv,kw,d,days=1,score=4)=>({bv,t:kw,kw,interestMatches:[kw],pubdate:now/1000-days*86400,d,play:100,dm:1,parts:1,_score:score})
 const items=[make('BV0000000011','猫咪',600),make('BV0000000012','猫咪',60),make('BV0000000013','AI',300),make('BV0000000014','猫咪',10,30)]
 const choose=browsing=>chooseVideos(items,{n:2,per:1,config:p,random:()=>0,now,keywords:['猫咪','AI'],browsing})
 assert.deepEqual(choose(affectBrowsing(a,now)).map(x=>x.bv),['BV0000000012','BV0000000013'])
 a.mood.value=8;assert.deepEqual(choose(affectBrowsing(a,now)).map(x=>x.bv),['BV0000000011','BV0000000013'])
 assert.equal(affectBrowsing(a,now+6*HOUR).tone,'steady');assert.equal(affectBrowsing(a,now,{enabled:false}).tone,'steady')
 const explore={...items[0],bv:'BV0000000015',interestMatches:[]}
 assert.ok(chooseVideos([explore],{n:3,config:p,now,browsing:affectBrowsing(a,now)}).length<=1)
})

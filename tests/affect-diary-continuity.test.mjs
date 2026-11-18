import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createLifeStore} from '../tools/lib/life-store.mjs'
import {affectInterestOrder,DAY} from '../tools/lib/affect-engine.mjs'
import {createDiaryWorker} from '../lib/diary-worker.js'
import {affectPrompt,createAffectWorker} from '../lib/affect-worker.js'
const repo=fileURLToPath(new URL('../',import.meta.url))
function fixture(t){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-continuity-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
 let now=Date.parse('2026-11-18T12:00:00+08:00'),i=0
 const full={self:{mid:'1'},owner:{mid:'2',name:'主人'},share:{via:'comment',enabled:true},night:{windows:[{start:'00:00',end:'24:00',wakes:2}]},diary:{enabled:true},life:{autonomy:true,hardMode:'off'}}
 const open=()=>createLifeStore({dshHome:home,account:'1',owner:'2',config:full.life,fullConfig:()=>full,now:()=>now}),store=open()
 return {home,full,store,open,now:()=>now,add:n=>now+=n,receive:text=>store.ingestOwnerMessage({channel:'bili-dm',actor:'2',messageId:String(++i),text}),video:()=>store.record('video-read',{origin:'video',target:'BV0000000001',text:'猫咪通过纸箱，字幕说明胡须感知宽度。',data:{subtitle:true,readByModel:false,aid:'101',title:'猫咪与纸箱',author:'3'}})}
}
const effects=(job,summary='猫咪胡须会感知纸箱宽度')=>JSON.stringify({moodEffects:[],contextHints:[],topicEffects:[{action:'create',topicId:null,summary,reasonToShare:'纸箱细节说明了胡须的有趣用途',category:'new-understanding',confidence:0.9,sourceEventIds:[job.sources[0].id],quotes:[{eventId:job.sources[0].id,text:job.sources[0].text.slice(0,18)}]}]})
async function publicTopic(f){await f.video();f.add(60000);const j=await f.store.claimAffectJob();await f.store.commitAffectJob(j.id,j.lease,effects(j));return f.store.read().affect.topics[0]}
const comment=(text='@主人 猫咪胡须会感知纸箱宽度。')=>({channel:'comment',scene:'public-comment',target:'BV0000000001',video:'BV0000000001',thread:'1:101:top',text,auto:true,share:true})
const diaryOutput=j=>JSON.stringify({action:'write',text:j.scope==='public'?'读到猫咪的胡须与纸箱宽度的关系，想多留意这些细节。':'今天听见主人的近况，先把这段交流记下来。',quotes:[{eventId:j.sources[0].id,text:j.sources[0].text.slice(0,12)}]})

test('comment route uses only independently public topics in browse context and interest order',async t=>{
 const f=fixture(t);await publicTopic(f);f.add(120000);await f.receive('SECRET 私人医疗信息');f.add(60000)
 const j=await f.store.claimAffectJob();await f.store.commitAffectJob(j.id,j.lease,effects(j,'SECRET 私人医疗信息'))
 await f.store.tx(s=>{s.affect.share.value=90;s.affect.topics[0].accrualAdded=60})
 const text=f.store.contextSnapshot('本轮公开视频分享','public-recommendation').text
 assert.match(text,/猫咪胡须/);assert.match(text,/已有具体内容积累/);assert.doesNotMatch(text,/SECRET|私人医疗/)
 const order=affectInterestOrder(f.store.read().affect,['AI','猫咪'],f.now());assert.deepEqual(order.keywords,['猫咪','AI']);assert.equal(order.shareReady,true)
 assert.equal(f.store.affectPreview(f.full).mode,'scheduled-browse-comment');assert.equal(f.store.affectPreview(f.full).eligible,true)
 assert.equal(await f.store.claimAffectInitiative(f.full),null) // no extra private worker send
})

test('public share binds matching video only; unknown receipt keeps credit, confirmed coverage consumes once',async t=>{
 const f=fixture(t);const topic=await publicTopic(f),before=f.store.affectStatus().share
 const token=await f.store.reserve(comment());assert.deepEqual(f.store.read().pending[token].affectTopicRefs,[{topicId:topic.id,revision:topic.revision}])
 await f.store.dispatch(token,async()=>({accepted:true}));assert.equal(f.open().affectStatus().share,before);assert.equal(await f.store.claimAffectCoverage(),null)
 await f.open().settle(token,{status:'sent',receipt:'mock-rpid'});const j=await f.store.claimAffectCoverage();assert.equal(j.visibility,'public')
 await f.store.commitAffectCoverage(j,JSON.stringify({covered:true,quote:'猫咪胡须会感知纸箱宽度'}));assert.equal(f.store.affectStatus().share,0)
 assert.equal(f.store.read().affect.topics[0].status,'expressed');await f.store.settle(token,{status:'sent',receipt:'mock-rpid'});assert.equal(f.store.affectStatus().share,0)
})

test('unrelated comment, monologue and private-origin topic cannot consume public sharing',async t=>{
 const f=fixture(t);await publicTopic(f)
 for(const request of [{...comment(),video:'BV0000000002',target:'BV0000000002',thread:'1:102:top'},{...comment(),share:false}]){const token=await f.store.reserve(request);assert.equal(f.store.read().pending[token].affectTopicRefs?.length??0,0);await f.store.settle(token,{status:'rejected'})}
 assert.equal(f.store.read().affect.topics[0].status,'open')
 await f.store.tx(s=>{s.affect.topics[0].publicMaterial=false})
 assert.doesNotMatch(f.store.affectContext('public-comment'),/猫咪胡须/)
})

test('coverage failure retries with backoff then exits unresolved without marking expressed or resending',async t=>{
 const f=fixture(t);await publicTopic(f);const token=await f.store.reserve(comment());await f.store.settle(token,{status:'sent',receipt:'r'})
 let job=await f.store.claimAffectCoverage();await f.store.failAffectCoverage(job,'AFFECT_TIMEOUT');assert.equal(await f.store.claimAffectCoverage(),null)
 f.add(120001);job=await f.open().claimAffectCoverage();assert.equal(job.attempt,2);await f.store.failAffectCoverage(job,'AFFECT_TIMEOUT')
 f.add(120001);assert.equal(await f.store.claimAffectCoverage(),null)
 const topic=f.store.read().affect.topics[0];assert.equal(topic.status,'suppressed');assert.equal(topic.suppressionReason,'coverage-unresolved');assert.equal(topic.lastReceipt,'r')
 assert.equal(f.store.affectStatus().coveragePending,0);assert.equal(f.store.affectStatus().share,0)
})

test('daily coverage budget defers work across day rather than discarding it',async t=>{
 const f=fixture(t);await publicTopic(f);const token=await f.store.reserve(comment());await f.store.settle(token,{status:'sent',receipt:'r'})
 await f.store.tx(s=>s.affect.daily.coverage=6);assert.equal(await f.store.claimAffectCoverage(),null)
 f.add(DAY);const job=await f.store.claimAffectCoverage();assert.ok(job);assert.equal(job.attempt,1)
})

test('worker records semantic coverage failures for bounded recovery',async t=>{
 const f=fixture(t);await publicTopic(f);const token=await f.store.reserve(comment());await f.store.settle(token,{status:'sent',receipt:'r'})
 const worker=createAffectWorker({store:()=>f.store,config:()=>f.full,complete:async()=>{throw Object.assign(Error('fixture'),{code:'MODEL_FAILED'})}})
 assert.equal((await worker.tick()).status,'failed');assert.equal(f.store.read().affect.topics[0].reconcile.lastError,'MODEL_FAILED')
})

test('diary jobs separate public materials from owner dialogue, commits and renders both scopes',async t=>{
 const f=fixture(t);await f.video();await f.receive('SECRET 这是主人的私人近况');f.add(180000)
 let j=await f.store.claimDiaryJob();assert.equal(j.scope,'public');assert.doesNotMatch(JSON.stringify(j),/SECRET/);await f.store.commitDiaryJob(j,diaryOutput(j))
 j=await f.store.claimDiaryJob();assert.equal(j.scope,'private');assert.match(JSON.stringify(j),/SECRET/);await f.store.commitDiaryJob(j,diaryOutput(j))
 await f.store.renderDiary();const paths=f.store.diaryStatus().paths
 assert.match(fs.readFileSync(paths.public,'utf8'),/猫咪/);assert.doesNotMatch(fs.readFileSync(paths.public,'utf8'),/SECRET|主人/);assert.match(fs.readFileSync(paths.private,'utf8'),/主人/)
 assert.equal(f.open().diaryEntries('public').length,1);assert.equal(f.open().diaryEntries('private').length,1)
})

test('diary output validates quotes, skip is empty, duplicate commit cannot add a second entry',async t=>{
 const f=fixture(t);await f.video();f.add(180000);const j=await f.store.claimDiaryJob()
 await assert.rejects(f.store.commitDiaryJob(j,JSON.stringify({action:'write',text:'虚构经历',quotes:[{eventId:j.sources[0].id,text:'不存在的原文'}]})),/DIARY_SOURCE_QUOTE/)
 await f.store.commitDiaryJob(j,diaryOutput(j));await assert.rejects(f.store.commitDiaryJob(j,diaryOutput(j)),/DIARY_JOB_STALE/);assert.equal(f.store.diaryEntries('public').length,1)
 f.add(31*60000);await f.receive('你好');f.add(180000);const p=await f.store.claimDiaryJob();await f.store.commitDiaryJob(p,'{"action":"skip"}');assert.equal(f.store.diaryEntries('private').length,0)
})

test('diary failures survive restart, expire leases and stop retrying after two attempts',async t=>{
 const f=fixture(t);await f.video();f.add(180000);let j=await f.store.claimDiaryJob();assert.equal(await f.open().claimDiaryJob(),null)
 f.add(120001);j=await f.open().claimDiaryJob();assert.equal(j.attempt,2)
 await f.store.failDiaryJob(j,'DIARY_TIMEOUT');f.add(120001);assert.equal(await f.store.claimDiaryJob(),null)
 assert.equal(f.store.diaryStatus().jobs[0].status,'abandoned');assert.equal(f.store.diaryEntries('public').length,0)
})

test('diary truncation refunds one attempt and the reopened worker can commit the fourth slot',async t=>{
 const f=fixture(t);await f.video();f.add(180000)
 await f.store.tx(s=>{s.settings.diary??={version:1,cursors:{public:0,private:0},jobs:{},daily:{}};s.settings.diary.daily={day:'2026-11-18',public:3,private:4}})
 let calls=0
 const worker=()=>createDiaryWorker({store:()=>f.open(),config:()=>f.full,complete:async({maxTokens})=>{
  assert.equal(maxTokens,4800)
  if(++calls===1)throw Object.assign(Error('limit'),{code:'AFFECT_FINISH_INVALID',details:{kind:'max-tokens'}})
  return diaryOutput(f.store.read().settings.diary.jobs.public)
 }})
 assert.equal((await worker().tick()).status,'failed')
 const status=f.open().diaryStatus()
 assert.equal(status.daily.public,3);assert.equal(status.daily.private,4);assert.equal(status.jobs[0].finishKind,'max-tokens');assert.equal(status.jobs[0].quotaRefunded,true)
 assert.equal((await worker().tick()).status,'idle');f.add(120001)
 assert.equal((await worker().tick()).status,'committed');assert.equal(f.open().diaryStatus().daily.public,4)
 assert.equal(f.store.diaryEntries('public').length,1)
})
test('legacy full-quota finish error retries once without fabricating a refund',async t=>{
 const f=fixture(t);await f.video();f.add(180000)
 const first=await f.store.claimDiaryJob()
 await f.store.tx(s=>{const d=s.settings.diary,j=d.jobs.public;delete j.chargeDay;delete j.charged
  j.status='retry';j.notBefore=f.now();j.lastError='AFFECT_FINISH_INVALID';d.daily.public=4})
 const retry=await f.open().claimDiaryJob();assert.equal(retry.id,first.id);assert.equal(retry.attempt,2)
 await f.store.failDiaryJob(retry,'AFFECT_FINISH_INVALID','length');await f.store.failDiaryJob(retry,'AFFECT_FINISH_INVALID','length')
 assert.equal(f.store.diaryStatus().daily.public,4)
 f.add(120001);assert.equal(await f.store.claimDiaryJob(),null);assert.equal(f.store.diaryStatus().jobs[0].status,'abandoned')
})
test('unrelated finish reasons keep their charge and a late failure cannot refund the next day',async t=>{
 for(const nextDay of [false,true]){
  const f=fixture(t);await f.video();f.add(180000);const j=await f.store.claimDiaryJob()
  if(nextDay)await f.store.tx(s=>{s.settings.diary.daily={day:'2026-11-19',public:2,private:1}})
  await f.store.failDiaryJob(j,'AFFECT_FINISH_INVALID',nextDay?'length':'content-filter')
  assert.equal(f.store.diaryStatus().daily.public,nextDay?2:1);assert.equal(f.store.diaryStatus().jobs[0].quotaRefunded,false)
 }
})
test('diary renderer recovers missing file without duplicate events and keeps legacy files untouched',async t=>{
 const f=fixture(t),legacy=path.join(f.home,'whale-diary.md');fs.writeFileSync(legacy,'历史手写日记')
 await f.store.record('diary',{text:'新私人日记',data:{visibility:'private'}})
 const p=f.store.diaryStatus().paths.private;assert.match(fs.readFileSync(p,'utf8'),/新私人日记/);fs.unlinkSync(p)
 await f.open().renderDiary();assert.match(fs.readFileSync(p,'utf8'),/新私人日记/);assert.equal(f.store.diaryEntries('private').length,1);assert.equal(fs.readFileSync(legacy,'utf8'),'历史手写日记')
})

test('diary entries remain reconstructible after retention and cold archive',async t=>{
 const f=fixture(t);await f.store.record('diary',{text:'应当保留的浏览日记',data:{visibility:'public'}});f.add(40*DAY);await f.store.archive()
 assert.equal(f.store.read().events.filter(e=>e.kind==='diary').length,0);assert.equal(f.store.diaryEntries('public').length,1)
 await f.store.renderDiary();assert.match(fs.readFileSync(f.store.diaryStatus().paths.public,'utf8'),/应当保留/)
})

test('public manual diary cannot cite private sources; unknown visibility defaults to private',async t=>{
 const f=fixture(t),e=await f.receive('SECRET 私人材料')
 await assert.rejects(f.store.record('diary',{text:'不应进入公开日记',data:{visibility:'public',sourceIds:[e.id]}}),/公开日记不能引用私人来源/)
 await f.store.record('diary',{text:'默认私人'});assert.equal(f.store.diaryEntries('public').length,0);assert.equal(f.store.diaryEntries('private').length,1)
})

test('diary public generation excludes private persona and worker does not send platform messages',async t=>{
 const f=fixture(t);await f.video();f.add(180000);let calls=0
 const worker=createDiaryWorker({store:()=>f.store,config:()=>f.full,persona:()=> 'SECRET 私人角色记录',complete:async({prompt})=>{calls++;assert.doesNotMatch(prompt,/SECRET/);const j=f.store.read().settings.diary.jobs.public;return diaryOutput(j)}})
 assert.equal((await worker.tick()).status,'committed');assert.equal(calls,1);assert.equal(f.store.read().events.filter(e=>e.kind==='sent').length,0);assert.equal((await worker.tick()).status,'idle')
})

test('diary disable during model call rejects late commit',async t=>{
 const f=fixture(t);await f.video();f.add(180000)
 const w=createDiaryWorker({store:()=>f.store,config:()=>f.full,complete:async()=>{const j=f.store.read().settings.diary.jobs.public;f.full.diary.enabled=false;return diaryOutput(j)}})
 assert.equal((await w.tick()).status,'failed');assert.equal(f.store.diaryEntries('public').length,0)
 assert.equal((await w.tick()).status,'disabled');assert.equal((await f.store.renderDiary()).status,'disabled')
})

test('diary timeout returns ownership and rejects later completion',async t=>{
 const f=fixture(t);await f.video();f.add(180000);let resolve
 const w=createDiaryWorker({store:()=>f.store,config:()=>f.full,timeoutMs:20,complete:()=>new Promise(r=>resolve=r)})
 assert.equal((await w.tick()).code,'DIARY_TIMEOUT');const job=f.store.read().settings.diary.jobs.public;resolve(diaryOutput(job));await new Promise(r=>setTimeout(r,25));assert.equal(f.store.diaryEntries('public').length,0)
})

test('diary show CLI uses committed scoped events rather than stale legacy files',async t=>{
 const f=fixture(t),cfg=path.join(f.home,'config.json');fs.writeFileSync(cfg,JSON.stringify(f.full))
 // CLI uses wall-clock time, so use the runtime's actual time for this fixture.
 const store=createLifeStore({dshHome:f.home,account:'1',owner:'2',fullConfig:f.full})
 await store.record('diary',{text:'新公开日记',data:{visibility:'public'}});await store.record('diary',{text:'SECRET 私人日记'})
 fs.writeFileSync(path.join(f.home,'whale-diary.md'),'旧文件不能冒充今日记录')
 const run=args=>spawnSync(process.execPath,[path.join(repo,'tools/bili.mjs'),'diary','show',...args],{env:{...process.env,DSH_HOME:f.home,BILI_WHALE_CONFIG:cfg,HOME:f.home,USERPROFILE:f.home},encoding:'utf8',timeout:10000})
 let r=run([]);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/新公开日记/);assert.doesNotMatch(r.stdout,/SECRET|旧文件不能/)
 r=run(['--private','--days','1']);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/SECRET/);assert.doesNotMatch(r.stdout,/新公开日记/)
})


test('same receipt coverage batches three topics into one quota unit and commits each result atomically',async t=>{
 const f=fixture(t);await publicTopic(f)
 await f.store.tx(s=>{const first=s.affect.topics[0];for(let i=1;i<3;i++)s.affect.topics.push({...structuredClone(first),id:'topic-'+i,summary:'猫咪细节 '+i})})
 const token=await f.store.reserve(comment());await f.store.settle(token,{status:'sent',receipt:'batch-r'})
 const j=await f.store.claimAffectCoverage({batch:true});assert.equal(j.batchTopics.length,3);assert.equal(f.store.affectStatus().daily.coverage,1)
 await assert.rejects(f.store.commitAffectCoverage(j,JSON.stringify({checks:[{topicId:j.topic.id,covered:true,quote:'猫咪胡须会感知纸箱宽度'}]})),/AFFECT_COVERAGE_SHAPE/)
 assert.equal(f.store.read().affect.topics.filter(t=>t.status==='needs-reconcile').length,3)
 const checks=j.batchTopics.map((t,i)=>({topicId:t.id,covered:i!==1,quote:i===1?'':'猫咪胡须会感知纸箱宽度'}))
 await f.store.commitAffectCoverage(j,JSON.stringify({checks}));const topics=f.store.read().affect.topics
 assert.equal(topics.filter(t=>t.status==='expressed').length,2);assert.equal(topics[1].status,'open');assert.ok(topics[1].deferUntil>f.now())
})

test('changing route or stopping initiative after reserve prevents actual comment dispatch',async t=>{
 const f=fixture(t);await publicTopic(f);const token=await f.store.reserve(comment());f.full.share.via='dm';let writes=0
 await assert.rejects(f.store.dispatch(token,async()=>writes++),/分享出口/);assert.equal(writes,0)
 f.full.share.via='comment';await f.receive('别主动发消息');await assert.rejects(f.store.dispatch(token,async()=>writes++),/主动联系/);assert.equal(writes,0)
})

test('diary switch disables both manual entry and background claim',async t=>{
 const f=fixture(t);f.full.diary.enabled=false;const r=await f.store.record('diary',{text:'不应保存'});assert.equal(r.status,'disabled');assert.equal(f.store.diaryEntries('private').length,0);assert.equal(await f.store.claimDiaryJob(),null)
})

test('diary push failure leaves the entry committed and never replays on restart',async t=>{
 const f=fixture(t);f.full.notify={type:'dm'};await f.video();f.add(180000)
 let calls=0
 const worker=createDiaryWorker({store:()=>f.open(),config:()=>f.full,complete:async()=>diaryOutput(f.store.read().settings.diary.jobs.public),push:async id=>{
  calls++;assert.ok(await f.store.claimDiaryPush(id));return {ok:false,code:1}
 }})
 const result=await worker.tick();assert.equal(result.status,'committed');assert.equal(result.push,'failed')
 assert.equal(f.open().diaryStatus().lastPush.code,'DIARY_PUSH_FAILED')
 assert.equal(await f.open().claimDiaryPush(result.eventId),null)
 await worker.tick();assert.equal(calls,1);assert.equal(f.store.diaryEntries('public').length,1)
})
test('disabled push, no channel, private writes and skips produce no notification',async t=>{
 for(const mode of ['off','none','private','skip']){
  const f=fixture(t);f.full.diary.push=mode!=='off';f.full.notify={type:mode==='none'?'none':'dm'}
  if(mode==='private')await f.receive('只限私人的材料');else await f.video()
  f.add(180000);let calls=0
  const worker=createDiaryWorker({store:()=>f.store,config:()=>f.full,push:async()=>{calls++;return {ok:true}},complete:async()=>mode==='skip'?'{"action":"skip"}':diaryOutput(f.store.read().settings.diary.jobs[mode==='private'?'private':'public'])})
  assert.equal((await worker.tick()).status,mode==='skip'?'skipped':'committed')
  assert.equal(calls,0);assert.equal(f.store.diaryStatus().lastPush,null)
 }
})
test('actual scheduler affect tick invokes diary worker with isolated model and no platform fetch',t=>{
 const f=fixture(t),cfg=path.join(f.home,'config.json');fs.mkdirSync(path.join(f.home,'.bili-ai'));fs.writeFileSync(cfg,JSON.stringify({...f.full,notify:{type:'file',path:path.join(f.home,'push.jsonl')},listen:{dm:false,comment:false},life:{...f.full.life,learningEnabled:false}}))
 const r=spawnSync(process.execPath,[path.join(repo,'tests/helpers/diary-scheduler.mjs')],{env:{...process.env,HOME:f.home,USERPROFILE:f.home,DSH_HOME:f.home,BILI_WHALE_CONFIG:cfg,DSH_NODE:process.execPath},encoding:'utf8',timeout:10000})
 assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/PASS scheduler diary/)
})


test('actual comment dry/go consumes original quota and binds platform receipt to public topic coverage',async t=>{
 const f=fixture(t);await publicTopic(f);f.full.notify={type:'none'};f.full.quota={shareDaily:1};f.full.share.aiCommentGuard=false
 const cfg=path.join(f.home,'config.json'),req=path.join(f.home,'requests');fs.writeFileSync(cfg,JSON.stringify(f.full));fs.mkdirSync(path.join(f.home,'.bili-ai'));fs.writeFileSync(path.join(f.home,'.bili-ai/credentials.json'),JSON.stringify({sessdata:'fixture',bili_jct:'fixture',buvid3:'fixture'}))
 const env={...process.env,HOME:f.home,USERPROFILE:f.home,DSH_HOME:f.home,BILI_WHALE_CONFIG:cfg,DSH_NODE:process.execPath,BILI_TRAFFIC_TEST:'1',NODE_TEST_CONTEXT:'child-v8',TEST_AFFECT_NOW:String(f.now()),TEST_REQUESTS:req,NODE_OPTIONS:'--import='+pathToFileURL(path.join(repo,'tests/helpers/affect-comment-fetch.mjs')).href}
 const args=['comment','--oid','101','--bvid','BV0000000001','--message','猫咪胡须会感知纸箱宽度。','--share','--auto','--reason','这段字幕说明了胡须感知宽度的有趣用途','--score','16','--rank','1']
 const run=mode=>spawnSync(process.execPath,[path.join(repo,'tools/bili.mjs'),...args,mode],{env,encoding:'utf8',timeout:15000})
 let r=run('--dry');assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(f.store.affectStatus().coveragePending,0)
 assert.ok(fs.readFileSync(req,'utf8').trim().split('\n').map(JSON.parse).every(x=>x.method!=='POST'))
 r=run('--go');assert.equal(r.status,0,r.stdout+r.stderr)
 assert.equal(fs.readFileSync(req,'utf8').trim().split('\n').map(JSON.parse).filter(x=>x.method==='POST').length,1)
 assert.equal(f.store.affectStatus().coveragePending,1);const job=await f.store.claimAffectCoverage();assert.equal(job.operationId,f.store.read().affect.topics[0].lastOperationId)
 await f.store.commitAffectCoverage(job,'{"covered":true,"quote":"猫咪胡须会感知纸箱宽度"}');assert.equal(f.store.affectStatus().share,0)
 const quota=JSON.parse(fs.readFileSync(path.join(f.home,'.bili-ai/quota.json')));assert.equal(quota.log.filter(x=>x.share).length,1)
 r=run('--go');assert.notEqual(r.status,0);assert.equal(fs.readFileSync(req,'utf8').trim().split('\n').map(JSON.parse).filter(x=>x.method==='POST').length,1)
})

test('diary projection failure retains committed event and retries projection without new narrative',async t=>{
 const f=fixture(t),paths=f.store.diaryStatus().paths;fs.mkdirSync(paths.private,{recursive:true})
 const r=await f.store.record('diary',{text:'已提交但派生失败'});assert.equal(r.diaryRender.status,'failed');assert.equal(f.store.diaryEntries('private').length,1)
 fs.rmdirSync(paths.private);await f.open().renderDiary();assert.match(fs.readFileSync(paths.private,'utf8'),/已提交但派生失败/);assert.equal(f.store.diaryEntries('private').length,1)
})

test('coverage worker batches same-receipt topics in one model call',async t=>{
 const f=fixture(t);await publicTopic(f);await f.store.tx(s=>s.affect.topics.push({...structuredClone(s.affect.topics[0]),id:'second-topic'}))
 const token=await f.store.reserve(comment());await f.store.settle(token,{status:'sent',receipt:'worker-batch'});let calls=0
 const worker=createAffectWorker({store:()=>f.store,config:()=>f.full,complete:async({prompt})=>{calls++;assert.match(prompt,/每个指定话题/);const topics=f.store.read().affect.topics;return JSON.stringify({checks:topics.map(t=>({topicId:t.id,covered:true,quote:'猫咪胡须会感知纸箱宽度'}))})}})
 assert.equal((await worker.tick()).status,'idle');assert.equal(calls,1);assert.equal(f.store.affectStatus().daily.coverage,1);assert.equal(f.store.read().affect.topics.filter(t=>t.status==='expressed').length,2)
})


test('invalid diary schema cannot replace the last good checkpoint',async t=>{
 const f=fixture(t);await f.video();f.add(180000);await f.store.claimDiaryJob();const before=f.store.checkpointStatus()
 await assert.rejects(f.store.tx(s=>{s.settings.diary.version=99}),/DIARY_STATE_INVALID/);assert.deepEqual(f.store.checkpointStatus(),before)
})


test('delayed public coverage uses actual receipt time so a later owner response remains later',async t=>{
 const f=fixture(t);await publicTopic(f);const token=await f.store.reserve(comment());await f.store.settle(token,{status:'sent',receipt:'delayed-r'});const sentAt=f.now()
 f.add(3*3600000);await f.receive('我看到啦，这个细节很有趣');const j=await f.store.claimAffectCoverage();await f.store.commitAffectCoverage(j,'{"covered":true,"quote":"猫咪胡须会感知纸箱宽度"}')
 const a=f.store.read().affect;assert.equal(a.share.lastInitiativeAt,sentAt);assert.ok(a.lastOwnerAt>a.share.lastInitiativeAt)
})

test('author description enters public affect with a verifiable quote while title and frames alone do not',async t=>{
 const f=fixture(t),title='视频标题',description='作者在简介中介绍了猫咪胡须感知纸箱通道宽度的细节，同时提到拍摄时记录了猫咪遇到狭窄通道时的反应。'
 for(const body of ['',description])await f.store.record('video-read',{origin:'video',target:'BV0000000001',text:[title,body].filter(Boolean).join('\n'),data:{title,subtitle:false,framesPrepared:true,readByModel:false}})
 f.add(60000);const j=await f.store.claimAffectJob()
 assert.equal(j.sources.length,1);assert.equal(j.sources[0].text,description);assert.equal(j.sources[0].materialKind,'author-description');assert.equal(j.sources[0].materialOnly,true)
 await f.store.commitAffectJob(j.id,j.lease,effects(j))
 assert.equal(f.store.affectStatus().publicTopics,1);assert.ok(f.store.affectStatus().share>0)
 assert.deepEqual(f.store.affectExplain().recentVideos.map(x=>x.materialKind),[null,'author-description'])
})
test('long description does not displace subtitles and neutral analysis remains observable',async t=>{
 const f=fixture(t),line='[P1]\n[00:01] 猫咪通过纸箱通道。'
 await f.store.record('video-read',{origin:'video',target:'BV0000000001',text:'标题\n'+'简介'.repeat(500)+'\n'+line,data:{subtitle:true,title:'标题'}})
 f.add(60000);const j=await f.store.claimAffectJob();assert.equal(j.sources[0].text,line);assert.equal(j.sources[0].materialKind,'subtitles')
 await f.store.commitAffectJob(j.id,j.lease,JSON.stringify({moodEffects:[],topicEffects:[],contextHints:[]}))
 assert.equal(f.store.affectExplain().changes.at(-1).outcome,'empty');assert.equal(f.store.affectStatus().share,0)
})

test('author description records rejected proposal and accepts the exact confidence boundary',async t=>{
 const f=fixture(t),title='猫咪视频'
 await f.store.record('video-read',{origin:'video',target:'BV0000000001',text:title+'\n'+'作者介绍猫咪通过纸箱时如何用胡须感知周围空间。'.repeat(4),data:{title,subtitle:false}})
 f.add(60000)
 const j=await f.store.claimAffectJob(),r=JSON.parse(effects(j))
 r.topicEffects[0].confidence=0.64
 await f.store.failAffectJob(j.id,j.lease,'TEMP_FAILURE')
 f.add(120001)
 const retry=await f.store.claimAffectJob()
 await f.store.commitAffectJob(retry.id,retry.lease,JSON.stringify(r))
 const changes=f.store.affectExplain().changes
 const drop=changes.find(x=>x.decision==='skipped')
 assert.equal(drop.reason,'low-confidence');assert.equal(drop.confidence,0.64);assert.equal(drop.threshold,0.65)
 assert.deepEqual(drop.materialKinds,['author-description']);assert.deepEqual(drop.sourceEventIds,[j.sources[0].id])
 const commit=changes.at(-1)
 assert.equal(commit.applied,0);assert.equal(commit.skipped,1);assert.equal(commit.outcome,'no-change')
 assert.deepEqual(commit.proposedByType,{mood:0,topic:1,context:0})
 f.add(120001)
 await f.store.record('video-read',{origin:'video',target:'BV0000000002',text:title+'\n'+'作者解释猫咪再次尝试穿过纸箱后如何辨别距离。'.repeat(4),data:{title,subtitle:false}})
 f.add(60000)
 const next=await f.store.claimAffectJob(),nextResult=JSON.parse(effects(next))
 nextResult.topicEffects[0].confidence=0.65
 nextResult.topicEffects.push(structuredClone(nextResult.topicEffects[0]))
 await f.store.commitAffectJob(next.id,next.lease,JSON.stringify(nextResult))
 const log=f.store.affectExplain().changes
 assert.equal(log.at(-2).reason,'duplicate-fingerprint')
 assert.equal(log.at(-1).applied,1);assert.equal(log.at(-1).skipped,1);assert.equal(f.store.affectStatus().publicTopics,1)
})

test('1556 subtitle characters reach analysis intact and long subtitles split into independent quotes',async t=>{
 const f=fixture(t),full='字'.repeat(1556),long='首'.repeat(1000)+'中'.repeat(500)+'尾'.repeat(1000)
 const video=(text,target)=>f.store.record('video-read',{origin:'video',target,text,data:{subtitle:true}})
 await video(full,'BV0000000001');await video(long,'BV0000000002')
 f.add(60000)
 const first=await f.store.claimAffectJob()
 assert.equal(first.sources.length,1);assert.equal(first.sources[0].text,full)
 assert.ok(affectPrompt(first).includes(full));assert.equal(first.sources[0].truncated,false)
 await f.store.commitAffectJob(first.id,first.lease,JSON.stringify({moodEffects:[],topicEffects:[],contextHints:[]}))
 f.add(120001)
 const second=await f.store.claimAffectJob(),source=second.sources[0]
 assert.equal(source.text,'首'.repeat(900));assert.equal(source.tailText,'尾'.repeat(900))
 assert.ok(affectPrompt(second).includes(source.tailText));assert.ok(Buffer.byteLength(affectPrompt(second))<=16384)
 const r=JSON.parse(effects(second))
 const quote=r.topicEffects[0].quotes[0];quote.text='首尾'
 await assert.rejects(f.store.commitAffectJob(second.id,second.lease,JSON.stringify(r)),/AFFECT_QUOTE/)
 quote.text='尾尾'
 await f.store.commitAffectJob(second.id,second.lease,JSON.stringify(r))
 assert.equal(f.store.read().affect.topics[0].sources[0].text,'尾尾')
 assert.equal(f.store.affectExplain().changes.at(-1).sourceSamples[0].characters,1800)
})
test('token-limited analysis retries once with shorter persisted evidence across restart',async t=>{
 const f=fixture(t)
 await f.store.record('video-read',{origin:'video',target:'BV1',text:'首'.repeat(500)+'中'.repeat(700)+'尾'.repeat(500),data:{subtitle:true}})
 f.add(60000)
 const complete=async({prompt,maxTokens})=>{
  assert.equal(maxTokens,4800)
  assert.ok(prompt.includes('中'.repeat(700)))
  throw Object.assign(Error('limit'),{code:'AFFECT_FINISH_INVALID',details:{kind:'max-tokens',outputBytes:0}})
 }
 const worker=createAffectWorker({store:()=>f.store,config:()=>f.full,complete})
 assert.equal((await worker.tick()).code,'AFFECT_FINISH_INVALID')
 const store=f.open()
 assert.equal(await store.claimAffectJob(),null)
 f.add(120001)
 const retry=createAffectWorker({store:()=>store,config:()=>f.full,complete:async({prompt,maxTokens})=>{
  assert.equal(maxTokens,4800);assert.ok(!prompt.includes('中'.repeat(100)))
  const job=store.read().affect.jobs[0],src=job.sources[0]
  assert.equal(src.text,'首'.repeat(450));assert.equal(src.tailText,'尾'.repeat(450))
  // A quote valid only in the original material must fail on this attempt.
  const r=JSON.parse(effects(job));r.topicEffects[0].quotes[0].text='中中';return JSON.stringify(r)
 }})
 assert.equal((await retry.tick()).code,'AFFECT_QUOTE')
 assert.equal(store.affectStatus().queued,0);assert.equal(store.affectStatus().daily.analysis,2);assert.equal(store.affectStatus().share,0)
})
test('expired last topic preserves a decaying balance without enabling public or private initiative',async t=>{
 const f=fixture(t);await publicTopic(f)
 await f.store.tx(s=>{s.affect.share.value=85;s.affect.topics[0].expiresAt=f.now()+1000})
 f.add(2000);assert.equal(await f.store.claimAffectCoverage(),null)
 const store=f.open();assert.ok(store.affectStatus().share>=84);assert.equal(store.affectStatus().publicTopics,0)
 assert.equal(store.affectPreview(f.full).reason,'no-public-topic');f.full.share.via='dm'
 assert.equal(await store.claimAffectInitiative(f.full),null);f.add(3600000)
 assert.ok(store.affectStatus().share<85);assert.ok(store.affectStatus().share>0)
})
test('escaped subtitle bytes fit the singleton budget and emoji excerpts retain full code points',async t=>{
 const f=fixture(t)
 for(const [i,text] of ['\u0001'.repeat(2100),'🐈'.repeat(2100)].entries()){
  await f.store.record('video-read',{origin:'video',target:'BV'+i,text,data:{subtitle:true}})
 }
 const jobs=f.store.read().affect.jobs;assert.equal(jobs.length,2)
 for(const j of jobs){
  assert.ok(Buffer.byteLength(JSON.stringify(j.sources))<=10000)
  assert.ok(Buffer.byteLength(affectPrompt({...j,topics:[]}))<=16384)
 }
 assert.equal(jobs[1].sources[0].tailText,'🐈'.repeat(900))
})

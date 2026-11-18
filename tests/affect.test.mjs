import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createLifeStore} from '../tools/lib/life-store.mjs'
import {initialAffect,advance,HOUR,DAY,dayKey,applyEffects,parseEffects,affectContext,hash} from '../tools/lib/affect-engine.mjs'
import {affectConfig} from '../tools/lib/affect-config.mjs'
import {createHostTextComplete} from '../lib/host-text-complete.js'
import {createAffectWorker,createAffectSend} from '../lib/affect-worker.js'
import {prepareExpression,finalizeExpression} from '../tools/lib/expression.mjs'

test('cancel during dry check prevents subsequent send; signal reaches child runner',async()=>{
 const controller=new AbortController(),calls=[]
 const send=createAffectSend(async(args,signal)=>{calls.push(args);assert.equal(signal,controller.signal);controller.abort();return {ok:true}})
 await assert.rejects(send({planId:'p',draftId:'d',signal:controller.signal}));assert.equal(calls.length,1);assert.ok(calls[0].includes('--dry'))
})

test('failed dry check cannot send; successful dry check sends the same bound plan',async()=>{
 const calls=[];const send=createAffectSend(async args=>{calls.push(args);return {ok:true}})
 await send({planId:'p',draftId:'d'});assert.deepEqual(calls,[['dm','--draft','d','--affect-plan','p','--dry'],['dm','--draft','d','--affect-plan','p','--go']])
 const failCalls=[];await createAffectSend(async args=>{failCalls.push(args);return {ok:false}})({planId:'p',draftId:'d'});assert.equal(failCalls.length,1)
})

function fixture(t,life={}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-affect-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
 let at=Date.parse('2026-10-29T12:00:00+08:00'),i=0
 const full={self:{mid:'1'},owner:{mid:'2',name:'主人'},share:{via:'dm'},night:{windows:[{start:'00:00',end:'24:00',wakes:2}]},life:{autonomy:true,...life}}
 const open=()=>createLifeStore({dshHome:home,account:'1',owner:'2',config:full.life,fullConfig:full,now:()=>at})
 const store=open()
 return {home,full,store,open,at:()=>at,add:n=>at+=n,set:x=>at=Date.parse(x),receive:text=>store.ingestOwnerMessage({channel:'bili-dm',actor:'2',messageId:String(++i),text})}
}
function effects(job,{mood='shared-interest',category='new-shared-topic',summary='以后想继续聊小猫',hint=null}={}){
 const e=job.sources[0],base={confidence:0.9,sourceEventIds:[e.id],quotes:[{eventId:e.id,text:e.text.slice(0,20)}]}
 return JSON.stringify({moodEffects:mood?[{...base,category:mood,relatedTopicId:null}]:[],topicEffects:summary?[{...base,action:'create',topicId:null,summary,reasonToShare:'上次一起谈过这个具体兴趣',category}]:[],contextHints:hint?[{...base,kind:hint}]:[]})
}
async function analyze(x,opts){await x.receive('我也很喜欢猫，我们以后接着聊小猫吧');x.add(60000);const j=await x.store.claimAffectJob();assert.ok(j);await x.store.commitAffectJob(j.id,j.lease,effects(j,opts));return j}
async function ready(x){await analyze(x);x.add(31*60000);await x.store.tx(s=>{s.affect.share.value=80;s.affect.share.updatedAt=x.at()});return x.store.claimAffectInitiative(x.full)}

test('only subtitle-backed discovery accepts confidence from 0.60, with real quote checks',async t=>{
 for(const [subtitle,category,confidence,expected] of [
  [true,'discovery',0.62,4.96],[true,'discovery',0.6,4.8],[true,'discovery',0.599,0],
  [false,'discovery',0.62,0],[true,'concern',0.62,0]
 ]){
  const x=fixture(t),title='猫咪视频'
  await x.store.record('video-read',{origin:'video',target:'BV1',text:title+'\n'+'猫咪胡须如何感知狭窄通道。'.repeat(8),data:{title,subtitle}})
  x.add(60000);const j=await x.store.claimAffectJob(),r=JSON.parse(effects(j,{mood:category,summary:null}))
  r.moodEffects[0].confidence=confidence
  await x.store.commitAffectJob(j.id,j.lease,JSON.stringify(r))
  assert.equal(x.open().read().affect.mood.value,expected)
  if(!expected)assert.equal(x.store.affectExplain().changes.at(-2).threshold,subtitle&&category==='discovery'?0.60:0.65)
 }
})
test('legacy combined credits split conservatively and hourly credits do not spend topic quota',async t=>{
 const x=fixture(t,{affect:{trigger:45}})
 await analyze(x);await x.store.tx(s=>{
  const a=s.affect;a.daily.shareAdded=70;delete a.daily.timeShareAdded
  a.recentChanges.push({code:'share:time',at:x.at(),shareDelta:16})
 })
 const store=x.open();const first=store.affectStatus()
 assert.equal(first.trigger,45);assert.equal(first.daily.topicShareAdded,54);assert.equal(first.daily.timeShareAdded,16)
 x.add(HOUR);await analyze(x,{summary:'另一个纸箱发现'})
 const after=store.affectStatus().daily
 assert.equal(after.timeShareAdded,22);assert.equal(after.topicShareAdded,60);assert.equal(after.shareAdded,82)
 x.add(120000);await analyze(x,{summary:'第三个观察'});assert.equal(store.affectStatus().daily.topicShareAdded,60)
 x.set('2026-10-30T00:00:00+08:00')
 const midnight=store.affectStatus()
 assert.equal(midnight.daily.topicShareAdded,0);assert.equal(midnight.daily.timeShareAdded,6);assert.ok(midnight.share>0)
 assert.equal(affectConfig({trigger:40,rearm:39}).trigger,40)
 assert.throws(()=>affectConfig({trigger:40,rearm:40}));assert.throws(()=>affectConfig({trigger:39,rearm:30}))
})
test('followup binds the latest confirmed reply and shares the daily attempt budget',async t=>{
 const x=fixture(t);x.full.share.via='comment';x.full.chat={followup:true,chance:1,dailyMax:1}
 await x.receive('我很喜欢小猫的故事');x.add(1000)
 const op=await x.store.reserve({channel:'dm',scene:'private-reply',target:'2',text:'这个小猫的故事真有趣',auto:false})
 await x.store.settle(op,{status:'sent',receipt:'reply-1'});x.add(60000)
 const job=await x.store.claimAffectJob();await x.store.commitAffectJob(job.id,job.lease,effects(job))
 assert.ok(x.store.affectStatus().share<70)
 const preview=x.store.affectPreview(x.full);assert.equal(preview.reason,'no-public-topic');assert.deepEqual(preview.privateChat,{eligible:true,reason:null,kind:'followup'})
 const plan=await x.store.claimAffectInitiative(x.full);assert.equal(plan.opportunity.kind,'followup')
 assert.equal(x.store.read().affect.daily.attempts,1)
 await x.store.finishAffectPlan(plan.id,'skip');assert.equal(await x.store.claimAffectInitiative(x.full),null)
})
async function conversationFixture(t){
 const x=fixture(t)
 x.full.share.via='comment';x.full.chat={followup:true,chance:1}
 x.full.night.windows=[{start:'04:06',end:'04:09',wakes:1}]
 await x.receive('纸箱应该留几个出口？');x.add(1000)
 const reply=await x.store.reserve({channel:'dm',scene:'private-reply',target:'2',text:'可以在纸箱侧面留一个出口。',auto:false})
 await x.store.settle(reply,{status:'sent',receipt:'r1'});x.add(60000)
 const j=await x.store.claimAffectJob()
 await x.store.commitAffectJob(j.id,j.lease,JSON.stringify({moodEffects:[],topicEffects:[],contextHints:[]}))
 return x
}
test('conversation followup outside browse hours sends once with no topic and preserves sharing balance',async t=>{
 const x=await conversationFixture(t),body='还可以在另一侧留第二个出口，方便猫咪转身离开。'
 await x.store.tx(s=>{s.affect.share.value=26})
 const before=x.store.affectStatus().share
 let writes=0
 const worker=createAffectWorker({store:()=>x.store,config:()=>x.full,complete:async({prompt})=>{
  if(prompt.includes('核对草稿是否直接承接')){assert.ok(prompt.includes('纸箱应该留几个出口'));return JSON.stringify({covered:true,quote:'第二个出口'})}
  if(prompt.includes('检查下列草稿'))return JSON.stringify({text:body})
  assert.ok(prompt.includes('纸箱应该留几个出口')&&prompt.includes('纸箱侧面留一个出口'))
  return JSON.stringify({action:'send',text:body})
 },send:async({planId,draftId})=>{
  const reopened=x.open(),req=reopened.validateAffectPlanRequest(planId,draftId,body,x.full)
  const token=await reopened.reserve(req);await reopened.dispatch(token,async()=>{writes++})
  await reopened.settle(token,{status:'sent',receipt:'followup-receipt'});return {ok:true}
 }})
 assert.equal((await worker.tick()).status,'sent');assert.equal(writes,1)
 assert.equal(x.store.affectStatus().share,before);assert.equal(x.store.affectStatus().topics,0)
 assert.equal(x.store.read().affect.share.lastInitiativeAt,x.at())
 await worker.tick();assert.equal(writes,1)
})
test('new owner message invalidates a reserved conversation followup before dispatch',async t=>{
 const x=await conversationFixture(t),p=await x.store.claimAffectInitiative(x.full)
 assert.ok(p.turn);assert.equal(p.topicId,undefined)
 const d=await prepareExpression(x.store,{scene:'private-reply',target:'2',text:'还可以再留一个出口。',share:false})
 await finalizeExpression(x.store,d.id);await x.store.readyAffectPlan(p.id,d.id,d.text,'{"covered":true,"quote":"再留一个出口"}',x.full)
 const token=await x.store.reserve(x.store.validateAffectPlanRequest(p.id,d.id,d.text,x.full))
 await x.receive('我还有一个新问题')
 let writes=0;await assert.rejects(x.store.dispatch(token,async()=>writes++));assert.equal(writes,0)
})
test('idle outside browse hours still checks quiet hours and selectable topics',async t=>{
 const x=await conversationFixture(t);x.full.chat={idle:true,idleHours:3,chance:1};x.add(4*HOUR)
 assert.equal(x.store.affectPreview(x.full).privateChat.reason,'no-topic')
 x.set('2026-10-29T23:01:00+08:00');assert.equal(x.store.affectPreview(x.full).privateChat.reason,'quiet')
})
test('PR58 idle opportunity cannot invent a topic; disabling switch invalidates a prepared plan',async t=>{
 const x=fixture(t);x.full.share.via='comment';x.full.chat={idle:true,chance:1}
 await x.receive('你好');x.add(4*HOUR);assert.equal(await x.store.claimAffectInitiative(x.full),null)
 await analyze(x);x.add(4*HOUR)
 const plan=await x.store.claimAffectInitiative(x.full);assert.equal(plan.opportunity.kind,'idle')
 const draft=await prepareExpression(x.store,{scene:'private-reply',target:'2',text:'小猫的故事还有一点想和你分享',share:false});await finalizeExpression(x.store,draft.id)
 x.full.chat.idle=false
 await assert.rejects(x.store.readyAffectPlan(plan.id,draft.id,draft.text,JSON.stringify({covered:true,quote:'小猫的故事'}),x.full),/STALE/)
})

test('explain attributes mood and sharing to quotes and distinguishes empty analysis',async t=>{
 const x=fixture(t);await analyze(x)
 const info=x.store.affectExplain(),m=info.changes.find(c=>c.code==='mood:shared-interest'),s=info.changes.find(c=>c.code==='share:new-shared-topic')
 assert.ok(Math.abs(m.moodDelta-7.2)<1e-8);assert.equal(s.shareDelta,10);assert.match(m.quotes[0].text,/喜欢猫/)
 assert.equal(info.topics[0].summary,'以后想继续聊小猫');assert.equal(info.changes.at(-1).outcome,'applied')
 x.add(180000);await x.receive('嗯');x.add(60000);const j=await x.store.claimAffectJob()
 await x.store.commitAffectJob(j.id,j.lease,'{"moodEffects":[],"topicEffects":[],"contextHints":[]}')
 const last=x.store.affectExplain().changes.at(-1);assert.equal(last.outcome,'empty');assert.equal(last.moodDelta,0);assert.equal(last.shareDelta,0)
})
test('an open topic keeps accumulating across days until threshold is reachable',async t=>{
 const x=fixture(t);await analyze(x)
 for(let i=0;i<16;i++){x.add(HOUR);await x.store.tx(s=>advance(s.affect,x.at()))}
 assert.ok(x.store.affectStatus().share>=70);assert.ok(x.store.read().affect.topics[0].accrualAdded>12)
 assert.ok(x.store.affectExplain().changes.some(c=>c.code==='share:time'&&c.shareDelta===6))
})

test('private dialogue persists mood/topic; duplicate incoming and repeated commit do not add again',async t=>{
 const x=fixture(t);const j=await analyze(x);assert.ok(x.store.affectStatus().mood>0);assert.equal(x.store.affectStatus().share,10)
 const before=x.store.read().affect;await assert.rejects(x.store.commitAffectJob(j.id,j.lease,effects(j)),/STALE/)
 await x.store.ingestOwnerMessage({channel:'bili-dm',actor:'2',messageId:'1',text:'我也很喜欢猫，我们以后接着聊小猫吧'})
 assert.deepEqual(x.open().read().affect,before);assert.equal(x.store.read().affect.topics[0].visibility,'private')
})
test('fake owner record cannot become trusted private input; no mood from silence',async t=>{
 const x=fixture(t);await x.store.record('received',{origin:'owner',text:'真的很喜欢'});x.add(HOUR)
 assert.equal(await x.store.claimAffectJob(),null);assert.equal(x.store.affectStatus().mood,0)
 await assert.rejects(x.store.ingestOwnerMessage({actor:'bad',messageId:'x',text:'喜欢猫'}))
})
test('new state does not replay old history on upgrade',async t=>{
 const x=fixture(t);await x.receive('喜欢小猫');await x.store.tx(s=>{delete s.affect}); // sync reinitializes to current cursor
 x.add(60000);assert.equal(await x.store.claimAffectJob(),null);assert.equal(x.store.affectStatus().share,0)
})
test('six-hour mood half life; no zero-value content-free accrual',()=>{
 const a=initialAffect(0);a.mood.value=80;advance(a,6*HOUR);assert.equal(a.mood.value,40);assert.equal(a.share.value,0)
 const copy=structuredClone(a);advance(a,5*HOUR);assert.equal(a.mood.value,copy.mood.value)
 assert.equal(dayKey(Date.parse('2026-10-29T16:00:00Z')),'2026-10-30')
})
test('time accumulation independent of tick frequency',async t=>{
 const x=fixture(t);await analyze(x);const a=x.store.read().affect,b=structuredClone(a),start=x.at()
 advance(a,start+5*HOUR);for(let i=1;i<=300;i++)advance(b,start+i*60000)
 assert.ok(Math.abs(a.share.value-b.share.value)<1e-8);assert.equal(a.topics[0].accrualAdded,b.topics[0].accrualAdded)
})
test('daily positive/negative limits and malformed effects are enforced',()=>{
 const e={id:'e',text:'我很喜欢这个小猫',verifiedRole:'owner'},j={id:'j',sources:[e],topics:[]};const a=initialAffect(0)
 for(let i=0;i<20;i++)applyEffects(a,parseEffects(effects(j,{summary:null}),j),{...j,id:String(i)},0)
 assert.equal(a.mood.value,40)
 const r=JSON.parse(effects(j));r.moodEffects[0].quotes[0].text='假的引用';assert.throws(()=>parseEffects(JSON.stringify(r),j),/QUOTE/)
 r.moodEffects[0].quotes[0].text=e.text;r.moodEffects[0].confidence='NaN';assert.throws(()=>parseEffects(JSON.stringify(r),j),/CONFIDENCE/)
 assert.throws(()=>affectConfig({trigger:50,rearm:50}));assert.equal(affectConfig({enabled:false}).enabled,false)
})
test('private topic never appears in public context',async t=>{
 const x=fixture(t);await analyze(x,{summary:'主人养过的私密小猫经历'});const a=x.store.read().affect
 assert.match(affectContext(a,'private-reply',x.at()),/私密小猫/);assert.doesNotMatch(affectContext(a,'public-comment',x.at()),/私密|sourceEvent|revision/)
})
test('topic edits during analysis, permissions and leases reject stale output',async t=>{
 const x=fixture(t);await analyze(x);x.add(120000);await x.receive('继续说说小猫');x.add(60000);const j=await x.store.claimAffectJob();assert.ok(j.topics.length)
 await x.store.tx(s=>s.affect.topics[0].revision++);await assert.rejects(x.store.commitAffectJob(j.id,j.lease,effects(j)),/TOPIC_STALE/)
 await x.store.pause(true);await assert.rejects(x.store.commitAffectJob(j.id,j.lease,effects(j)),/JOB_STALE/)
})
test('standalone stop command immediately blocks initiative; quote does not',async t=>{
 const x=fixture(t);await x.receive('书里写着“别主动发消息”');assert.equal(x.store.read().affect.initiativeBlocked,false)
 await x.receive('别主动发消息');assert.equal(x.store.read().affect.initiativeBlocked,true)
})
test('hysteresis, owner active and autonomy permission gate initiative',async t=>{
 const x=fixture(t);await analyze(x);await x.store.tx(s=>s.affect.share.value=80)
 assert.equal(await x.store.claimAffectInitiative(x.full),null);x.add(31*60000)
 await x.store.tx(s=>{s.affect.share.value=69;s.affect.share.updatedAt=x.at()});assert.equal(await x.store.claimAffectInitiative(x.full),null)
 await x.store.tx(s=>s.affect.share.value=70)
 const p=await x.store.claimAffectInitiative(x.full);assert.ok(p)
 assert.equal(await x.store.claimAffectInitiative(x.full),null)
})
test('private initiative cannot switch configured comment route',async t=>{
 const x=fixture(t);await analyze(x);x.add(HOUR);await x.store.tx(s=>s.affect.share.value=80);x.full.share.via='comment'
 assert.equal(await x.store.claimAffectInitiative(x.full),null)
})
test('sent platform receipt releases only once, unknown/restart keeps pending',async t=>{
 const x=fixture(t);const p=await ready(x);assert.ok(p)
 const d=await prepareExpression(x.store,{scene:'private-reply',target:'2',text:'上次聊到小猫，我又想起它们喜欢纸箱这件事。',share:false});await finalizeExpression(x.store,d.id)
 await x.store.readyAffectPlan(p.id,d.id,d.text,JSON.stringify({covered:true,quote:'上次聊到小猫'}),x.full)
 const req=x.store.validateAffectPlanRequest(p.id,d.id,d.text,x.full),token=await x.store.reserve(req)
 const share=x.store.affectStatus().share
 await x.store.dispatch(token,async()=>({accepted:true}));assert.equal(x.open().affectStatus().share,share)
 await x.store.finishAffectPlan(p.id,'failed');assert.equal(x.store.read().affect.pendingInitiative.status,'uncertain')
 assert.equal(await x.open().claimAffectInitiative(x.full),null)
 const topic=x.store.read().affect.topics[0],remaining=share-topic.credit-topic.accrualAdded
 await x.open().settle(token,{status:'sent',receipt:'platform-real-id'});assert.equal(x.store.affectStatus().share,remaining)
 await x.store.settle(token,{status:'sent',receipt:'platform-real-id'});assert.equal(x.store.affectStatus().share,remaining)
})
test('new incoming before dispatch cancels initiative',async t=>{
 const x=fixture(t),p=await ready(x);const d=await prepareExpression(x.store,{scene:'private-reply',target:'2',text:'想起我们上次聊过的小猫。',share:false});await finalizeExpression(x.store,d.id)
 await x.store.readyAffectPlan(p.id,d.id,d.text,JSON.stringify({covered:true,quote:'聊过的小猫'}),x.full)
 const token=await x.store.reserve(x.store.validateAffectPlanRequest(p.id,d.id,d.text,x.full));await x.receive('我现在有个问题')
 let called=false;await assert.rejects(x.store.dispatch(token,()=>{called=true}));assert.equal(called,false)
})
test('ordinary private reply is reconciled from actual sent body; no receipt no release',async t=>{
 const x=fixture(t);await analyze(x)
 const token=await x.store.reserve({channel:'dm',target:'2',scene:'private-reply',text:'关于小猫喜欢纸箱，我觉得这是很有趣的话题。',auto:false})
 assert.equal(await x.store.claimAffectCoverage(),null)
 await x.store.settle(token,{status:'sent',receipt:'r1'});assert.equal(x.store.read().affect.topics[0].status,'needs-reconcile')
 const job=await x.store.claimAffectCoverage();assert.ok(job)
 await x.store.commitAffectCoverage(job,JSON.stringify({covered:true,quote:'小猫喜欢纸箱'}));assert.equal(x.store.affectStatus().share,0)
 await assert.rejects(x.store.commitAffectCoverage(job,JSON.stringify({covered:true,quote:'小猫喜欢纸箱'})),/STALE/)
})
test('normal dialogue responds with autonomy off; affects still update',async t=>{
 const x=fixture(t,{autonomy:false});await analyze(x);assert.ok(x.store.affectStatus().mood>0);x.add(HOUR)
 await x.store.tx(s=>s.affect.share.value=80);assert.equal(await x.store.claimAffectInitiative(x.full),null)
 assert.equal(x.store.check({channel:'dm',scene:'private-reply',target:'2',text:'我在听',auto:false}).allow,true)
})
test('host adapter requires normal completion, excludes reasoning, caps and cancels hanging streams',async()=>{
 const ctx=stream=>({get:k=>k==='llm'?{stream}:k==='agentDefaultModel'?{currentSelection:()=>({provider:'p',model:'m'})}:null})
 const good=createHostTextComplete(ctx(async function*(){yield {type:'reasoning-delta',text:'secret'};yield {type:'text-delta',text:'{}'};yield {type:'finish',reason:{kind:'stop'}}}))
 assert.equal(await good({prompt:'hi'}),'{}')
 for(const chunks of [[{type:'text-delta',text:'{}'}],[{type:'text-delta',text:'{}'},{type:'finish',reason:{kind:'length'}}]]){
  const f=createHostTextComplete(ctx(async function*(){yield*chunks}));await assert.rejects(f({prompt:'hi'}))
 }
 const hung=createHostTextComplete(ctx(async function*(){await new Promise(()=>{})}),{timeoutMs:20});await assert.rejects(hung({prompt:'hi'}),/超时/)
})
test('worker runs real store pipeline with injected model and never sends below threshold',async t=>{
 const x=fixture(t);await x.receive('一起聊聊小猫吧');x.add(60000);let calls=0,sends=0
 const worker=createAffectWorker({store:()=>x.store,config:()=>x.full,complete:async()=>{calls++;return effects(x.store.read().affect.jobs[0])},send:async()=>{sends++;return {ok:true}},now:x.at})
 await worker.tick();assert.equal(calls,1);assert.equal(sends,0);assert.ok(x.store.affectStatus().mood>0)
})
test('worker timeout releases ownership and blocks late writes',async t=>{
 const x=fixture(t);await x.receive('一起聊聊小猫吧');x.add(60000);let resolve
 const worker=createAffectWorker({store:()=>x.store,config:()=>x.full,complete:()=>new Promise(r=>resolve=r),timeoutMs:20})
 const result=await worker.tick();assert.equal(result.code,'AFFECT_WORKER_TIMEOUT');assert.notEqual(worker.status().status,'running')
 resolve(effects(x.store.read().affect.jobs[0]));await new Promise(r=>setTimeout(r,20));assert.equal(x.store.affectStatus().mood,0)
})

test('complete initiative pipeline generates, edits, verifies and settles via guarded send',async t=>{
 const x=fixture(t);await analyze(x);x.add(HOUR);await x.store.tx(s=>{s.affect.share.value=80;s.affect.share.updatedAt=x.at()})
 let calls=0,network=0;const body='上次一起聊过小猫，我想起它们钻纸箱的样子。'
 const worker=createAffectWorker({store:()=>x.store,config:()=>x.full,complete:async({prompt})=>{
  calls++;if(prompt.includes('核对实际正文'))return JSON.stringify({covered:true,quote:'一起聊过小猫'})
  if(prompt.includes('检查下列草稿'))return JSON.stringify({text:body})
  return JSON.stringify({action:'send',text:body})
 },send:async({planId,draftId})=>{
  const request=x.store.validateAffectPlanRequest(planId,draftId,body,x.full),token=await x.store.reserve(request)
  await x.store.dispatch(token,async()=>{network++});await x.store.settle(token,{status:'sent',receipt:'fixture-platform-receipt'});return {ok:true}
 }})
 const topic=x.store.read().affect.topics[0],remaining=80-topic.credit-topic.accrualAdded
 assert.equal((await worker.tick()).status,'sent');assert.equal(network,1);assert.equal(calls,3);assert.equal(x.store.affectStatus().share,remaining)
 await worker.tick();assert.equal(network,1)
})
test('skip is a legitimate outcome and defers the selected topic',async t=>{
 const x=fixture(t);await analyze(x);x.add(HOUR);await x.store.tx(s=>{s.affect.share.value=80;s.affect.share.updatedAt=x.at()})
 let n=0;const w=createAffectWorker({store:()=>x.store,config:()=>x.full,complete:async()=>{n++;return '{"action":"skip"}'},send:()=>assert.fail('must not send')})
 assert.equal((await w.tick()).status,'skipped');assert.equal(x.store.affectStatus().share,80);await w.tick();assert.equal(n,1)
})
test('ordinary coverage of multiple topics cannot release more than twenty for one operation',async t=>{
 const x=fixture(t);await analyze(x,{summary:'小猫故事'});x.add(120000);await analyze(x,{summary:'小猫的新问题'});x.add(120000);await analyze(x,{summary:'小猫的新发现'})
 const before=x.store.affectStatus().share,token=await x.store.reserve({channel:'dm',target:'2',scene:'private-reply',text:'一起聊过小猫的故事、问题和发现。',auto:false})
 await x.store.settle(token,{status:'sent',receipt:'multi'})
 for(let i=0;i<3;i++){const j=await x.store.claimAffectCoverage();assert.ok(j);await x.store.commitAffectCoverage(j,'{"covered":true,"quote":"聊过小猫"}')}
 assert.equal(-x.store.read().affect.recentChanges.filter(e=>e.code==='expression-released'&&e.operationId===token).reduce((sum,e)=>sum+e.delta,0),20);assert.ok(Math.abs(x.store.affectStatus().share-(before-20))<0.11)
})
test('backpressure cannot delay owner stop control or last arrival timestamp',async t=>{
 const x=fixture(t)
 for(let i=0;i<22;i++){await x.receive('批次 '+i);x.add(61000)}
 assert.equal(x.store.read().affect.jobs.length,20)
 await x.receive('别主动发消息');assert.equal(x.store.read().affect.initiativeBlocked,true);assert.equal(x.store.read().affect.lastOwnerAt,x.at())
})
test('stale unsubmitted plan expires; prepared unknown write does not',async t=>{
 const x=fixture(t),p=await ready(x);x.add(4*HOUR);await x.store.tx(s=>{s.affect.share.value=80;s.affect.share.updatedAt=x.at()})
 const next=await x.store.claimAffectInitiative(x.full);assert.ok(next);assert.notEqual(p.id,next.id)
})
test('one failure chain reduces mood at most once per half hour',async t=>{
 const x=fixture(t)
 for(let i=0;i<3;i++){const token=await x.store.reserve({channel:'dm',target:'2',scene:'private-reply',text:'失败 '+i,auto:false});await x.store.settle(token,{status:'rejected'})}
 assert.equal(x.store.affectStatus().mood,-3);assert.equal(x.store.affectStatus().share,0)
})

test('rejected expression coverage discards unused draft without sending',async t=>{
 const x=fixture(t);await analyze(x);x.add(HOUR);await x.store.tx(s=>{s.affect.share.value=80;s.affect.share.updatedAt=x.at()})
 const body='我想继续聊聊小猫喜欢纸箱的事。'
 const worker=createAffectWorker({store:()=>x.store,config:()=>x.full,complete:async({prompt})=>prompt.includes('核对实际正文')?'{"covered":false,"quote":""}':JSON.stringify(prompt.includes('检查下列草稿')?{text:body}:{action:'send',text:body}),send:()=>assert.fail('must not send')})
 const result=await worker.tick();assert.equal(result.status,'skipped');assert.equal(result.reason,'topic-not-covered')
 const state=x.store.read();assert.equal(state.drafts.at(-1).status,'discarded')
 assert.equal(state.affect.pendingInitiative.status,'skipped');assert.equal(state.affect.topics[0].status,'deferred')
 assert.ok(state.affect.topics[0].deferUntil>x.at());assert.equal(state.affect.share.value,80)
 assert.equal((await worker.tick()).status,'idle')
})

test('initiative recalls relevant current memory and can skip without sending',async t=>{
 const x=fixture(t);await analyze(x);x.add(HOUR)
 await x.store.tx(s=>{
  s.affect.share.value=80;s.affect.share.updatedAt=x.at()
  s.memories.push({id:'cat-memory',version:3,at:x.at(),acceptedAt:x.at(),active:true,recallEnabled:true,status:'provisional',type:'understanding',subject:'owner',text:'主人最近照顾小猫很累，小猫话题只适合简短关心',scope:{scenes:['private-reply']},visibility:'private',sourceIds:[]})
  s.memories.push({id:'unrelated',version:1,at:x.at(),active:true,type:'episodic',text:'园艺盆栽记录',scope:{scenes:['private-reply']},visibility:'private',sourceIds:[]})
 })
 let generated=0
 const worker=createAffectWorker({store:()=>x.store,config:()=>x.full,complete:async({prompt})=>{
  generated++;assert.match(prompt,/主人最近照顾小猫很累/);assert.doesNotMatch(prompt,/园艺盆栽记录/)
  return '{"action":"skip"}'
 },send:()=>assert.fail('must not send')})
 assert.equal((await worker.tick()).status,'skipped');assert.equal(generated,1)
 assert.deepEqual(x.store.read().affect.pendingInitiative.memoryRefs,[{id:'cat-memory',version:3}])
})

for(const failedStage of ['analysis','generate','edit','coverage-check'])test(`worker preserves host error code and ${failedStage} stage`,async t=>{
 const x=fixture(t)
 if(failedStage==='analysis'){await x.receive('我也喜欢小猫');x.add(60000)}
 else{await analyze(x);x.add(HOUR);await x.store.tx(s=>{s.affect.share.value=80;s.affect.share.updatedAt=x.at()})}
 const body='我想继续聊聊小猫喜欢纸箱的事。',stages=[]
 const worker=createAffectWorker({store:()=>x.store,config:()=>x.full,complete:async({stage})=>{
  stages.push(stage)
  if(stage===failedStage)throw Object.assign(Error('model did not finish'),{code:'V10_FINISH_INVALID',details:{kind:'length'}})
  if(stage==='edit')return JSON.stringify({text:body})
  return JSON.stringify({action:'send',text:body})
 },send:()=>assert.fail('must not send')})
 const result=await worker.tick();assert.equal(result.status,'failed');assert.equal(result.stage,failedStage)
 assert.equal(result.code,'V10_FINISH_INVALID');assert.deepEqual(result.details,{kind:'length'})
 assert.equal(stages.at(-1),failedStage)
 if(failedStage!=='analysis')assert.equal(x.store.read().affect.pendingInitiative.status,'failed')
 if(['edit','coverage-check'].includes(failedStage))assert.equal(x.store.read().drafts.at(-1).status,'discarded')
})

test('malformed generation JSON remains failure, not a normal skip',async t=>{
 const x=fixture(t);await analyze(x);x.add(HOUR);await x.store.tx(s=>{s.affect.share.value=80;s.affect.share.updatedAt=x.at()})
 const worker=createAffectWorker({store:()=>x.store,config:()=>x.full,complete:async()=>'{broken',send:()=>assert.fail('must not send')})
 const result=await worker.tick();assert.equal(result.status,'failed');assert.equal(result.stage,'generate');assert.equal(result.code,'AFFECT_INVALID_JSON')
})

test('malformed coverage remains failure and cannot settle a topic as skipped or sent',async t=>{
 const x=fixture(t);await analyze(x);x.add(HOUR);await x.store.tx(s=>{s.affect.share.value=80;s.affect.share.updatedAt=x.at()})
 const body='我想继续聊聊小猫喜欢纸箱的事。'
 const worker=createAffectWorker({store:()=>x.store,config:()=>x.full,complete:async({stage})=>stage==='coverage-check'?'{"covered":"false","quote":""}':JSON.stringify(stage==='edit'?{text:body}:{action:'send',text:body}),send:()=>assert.fail('must not send')})
 const result=await worker.tick();assert.equal(result.status,'failed');assert.equal(result.stage,'coverage-check');assert.equal(result.code,'AFFECT_COVERAGE_SHAPE')
 assert.equal(x.store.read().affect.pendingInitiative.status,'failed');assert.equal(x.store.read().drafts.at(-1).status,'discarded')
})


test('actual debrief origin enters affect analysis only with textual material, never model reflections',async t=>{
 const x=fixture(t)
 await x.store.record('video-read',{origin:'video',target:'BV0000000001',text:'猫咪通过狭窄纸箱，字幕说明胡须感知宽度',data:{subtitle:true,readByModel:false}})
 await x.store.record('video-read',{origin:'video',target:'BV0000000002',text:'只有标题没有字幕',data:{subtitle:false}})
 await x.store.record('reflection',{origin:'model',text:'我看过所有画面，非常开心'})
 x.add(60000);const job=await x.store.claimAffectJob()
 assert.equal(job.sources.length,1);assert.equal(job.sources[0].target,'BV0000000001');assert.equal(job.sources[0].materialOnly,true)
 assert.equal(job.topics.length,0)
 await x.store.commitAffectJob(job.id,job.lease,effects(job,{mood:'discovery',summary:'纸箱与猫咪的胡须'}))
 assert.ok(x.open().affectStatus().mood>0);assert.equal(x.open().affectStatus().topics,1)
})

test('light evidenced affect reaches private context, public context excludes causes and reasons',async t=>{
 const x=fixture(t);await analyze(x,{summary:'私人猫咪故事'})
 const privateText=x.store.affectContext('private-reply');assert.match(privateText,/有些雀跃/);assert.match(privateText,/我也很喜欢猫/);assert.match(privateText,/上次一起谈过/)
 const publicText=x.store.affectContext('public-recommendation');assert.match(publicText,/有些雀跃/);assert.doesNotMatch(publicText,/我也很喜欢猫|私人猫咪|上次一起谈过|quotes/)
 x.add(12*HOUR);assert.match(x.store.affectContext('private-reply'),/当前角色状态：平静/);assert.doesNotMatch(x.store.affectContext('private-reply'),/我也很喜欢猫/)
})

test('confirmed initiative releases only its topic credit including accumulation',async t=>{
 const {settleTopics}=await import('../tools/lib/affect-engine.mjs')
 const x=fixture(t);await analyze(x)
 await x.store.tx(s=>{const a=s.affect,t=a.topics[0];t.credit=10;t.accrualAdded=6;a.topics.push({...structuredClone(t),id:'other',credit:54,accrualAdded:0});a.share.value=70;settleTopics(a,[{topicId:t.id,revision:t.revision}],'receipt-op',x.at(),{initiative:true})})
 assert.equal(x.store.affectStatus().share,54);assert.equal(x.store.read().affect.topics[1].status,'open')
})

test('no reply defers another initiative for a day; owner arrival and idle gate are respected',async t=>{
 const x=fixture(t);await analyze(x);x.add(HOUR)
 await x.store.tx(s=>{s.affect.share.lastInitiativeAt=x.at();s.affect.share.value=90;s.affect.share.armed=true})
 x.add(4*HOUR);assert.equal(x.store.affectPreview(x.full).reason,'awaiting-owner')
 await x.receive('我回来了，继续聊吧');assert.equal(x.store.affectPreview(x.full).reason,'owner-active')
 x.add(31*60000);assert.ok(await x.store.claimAffectInitiative(x.full))
})

test('new evidenced topic rearms residual sharing balance; passing time alone does not',async t=>{
 const x=fixture(t);await analyze(x);x.add(HOUR)
 await x.store.tx(s=>{const a=s.affect;a.share.value=80;a.share.updatedAt=x.at();a.share.armed=false;a.share.lastInitiativeAt=x.at()})
 x.add(HOUR);await x.store.tx(()=>{});assert.equal(x.store.affectStatus().armed,false)
 await analyze(x,{summary:'小猫胡须的新发现'});assert.equal(x.store.affectStatus().armed,true)
})


test('fresh evidence can rearm even when the sharing balance is capped',async t=>{
 const x=fixture(t);await analyze(x);x.add(HOUR)
 await x.store.tx(s=>{s.affect.share.value=100;s.affect.share.updatedAt=x.at();s.affect.share.armed=false;s.affect.share.lastInitiativeAt=x.at()-1})
 await x.receive('又发现猫咪胡须的具体细节');x.add(60000)
 const j=await x.store.claimAffectJob();await x.store.tx(s=>{s.affect.share.value=100;s.affect.share.updatedAt=x.at()})
 await x.store.commitAffectJob(j.id,j.lease,effects(j,{summary:'猫咪胡须的具体细节'}))
 assert.equal(x.store.affectStatus().share,100);assert.equal(x.store.affectStatus().armed,true)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {createLifeStore} from '../tools/lib/life-store.mjs'
import {lifeConfig} from '../tools/lib/life-config.mjs'
import {createFormationWorker,formationPrompt} from '../lib/formation-worker.js'
import {formationDiagnostic} from '../tools/lib/formation-diagnostic.mjs'

function setup(t){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-self-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
 let at=Date.parse('2026-10-25T23:11:00+08:00'),i=0
 const reopen=()=>createLifeStore({dshHome:home,account:'1',owner:'2',now:()=>at}),store=reopen()
 return {home,store,reopen,setTime:x=>at=Date.parse(x),send:async(receipt)=>{
  i++;const token=await store.reserve({channel:'comment',target:'BV1234567890',thread:'1:123:'+i,parent:String(i),text:'画面细节 '+i,auto:true,scene:'reply'})
  await store.settle(token,{status:'sent',receipt:receipt??String(i)})
  return store.read().events.find(e=>e.operationId===token)
 }}
}
const candidate=(events,extra={})=>({key:'self-detail',subject:'self',type:'pattern',text:'我两次写评论都先提画面细节',sourceIds:events.map(e=>e.id),quotes:events.map(e=>({eventId:e.id,text:e.text})),scope:{scenes:['public-comment']},visibility:'public',epistemic:'inferred',appliesTo:'写分享评论时',doThis:'可以先写准确的画面细节',falsifiedBy:'以后频繁采用其他写法时收窄判断',alternatives:['也可能只是两次视频的内容恰好适合'],...extra})
const decision=c=>({key:c.key,action:'accept',reason:'仅描述已有行为，不证明外部事实',grounded:true,scopeClear:true,overgeneralized:false,selfBehaviorOnly:true,claimsExternal:false})
async function form(store,c,d=decision(c)){
 const job=await store.planFormation({force:true});await store.submitFormation(job.jobId,job.token,{candidates:[c]})
 const review=await store.claimReview();return store.commitFormation(review.jobId,review.token,{decisions:[d]})
}
async function pair(t){const x=setup(t),a=await x.send();x.setTime('2026-10-26T00:15:00+08:00');return {...x,events:[a,await x.send()]}}

test('confirmed own sends across Shanghai midnight form a provisional self pattern',async t=>{
 const {store,events}=await pair(t);await form(store,candidate(events))
 const m=store.read().memories[0];assert.equal(m.subject,'self');assert.equal(m.independentDays,2);assert.equal(m.independentEvidence,2)
 assert.equal(m.confidenceBand,'low');assert.equal(m.epistemic,'inferred');assert.equal(m.authority,'inferred');assert.equal(m.status,'provisional')
})
test('same-day observations can form a provisional understanding with honest metadata',async t=>{
 const x=setup(t);await form(x.store,candidate([await x.send(),await x.send()],{type:'understanding'}))
 const m=x.store.read().memories[0];assert.equal(m.independentDays,1);assert.equal(m.independentEvidence,2);assert.equal(m.status,'provisional')
})
test('repeated receipts do not inflate independent evidence',async t=>{
 const x=setup(t),a=await x.send('same');x.setTime('2026-10-26T00:15:00+08:00');await form(x.store,candidate([a,await x.send('same')]))
 assert.equal(x.store.read().memories[0].independentEvidence,1)
})
test('self candidates require exact quotes and never request owner authority',async t=>{
 const {store,events}=await pair(t),j=await store.planFormation({force:true})
 for(const extra of [{quotes:[]},{subject:'other'},{epistemic:'owner_explicit'},{type:'fact'}])await assert.rejects(store.submitFormation(j.jobId,j.token,{candidates:[candidate(events,extra)]}))
})
test('private self sources never become public memories',async t=>{
 const {store,events}=await pair(t);await store.tx(s=>{for(const e of s.events.filter(e=>e.kind==='sent'))e.channel='dm'})
 await form(store,candidate(events));const m=store.read().memories[0];assert.equal(m.visibility,'private');assert.equal(m.selfFromPrivate,true);assert.deepEqual(m.scope.scenes,['private-reply','private-recommendation']);assert.doesNotMatch(store.contextSnapshot('画面','public-comment').text,/我两次写评论/)
})
test('fixed dynamic mode and file-only recovery defaults respect explicit hard/draft overrides',()=>{
 const c=lifeConfig({dynamicMemory:{enabled:false,shadow:true}})
 assert.equal(c.dynamicMemory.enabled,true);assert.equal(c.dynamicMemory.shadow,false);assert.equal(c.hardMode,'warn');assert.equal(c.draftMode,'cat-draft')
 assert.equal(lifeConfig({hardMode:'warn',draftMode:'direct'}).hardMode,'warn')
 assert.equal(lifeConfig({hardMode:'warn',draftMode:'direct'}).draftMode,'direct')
})
test('old state migration invalidates in-flight jobs once across restarts',async t=>{
 const x=setup(t);await x.store.ingestOwnerMessage({actor:'2',messageId:'1',text:'hello'})
 const j=await x.store.planFormation({force:true});await x.store.tx(s=>{delete s.settings.dynamicPolicyVersion})
 const before=x.store.read().settings.permissionVersion??0
 await x.reopen().maintainCognition();const s=x.store.read();assert.equal(s.settings.permissionVersion,before+1)
 assert.equal(s.cognition.jobs.find(v=>v.id===j.jobId).stage,'cancelled')
 await x.reopen().maintainCognition();assert.equal(x.store.read().settings.permissionVersion,before+1)
})
test('maintenance timeout releases worker and blocks late work',async()=>{
 let release,calls=0,hang=true;const held=new Promise(r=>release=r)
 const worker=createFormationWorker({timeoutMs:20,config:()=>({self:{mid:'1'},owner:{mid:'2'}}),store:()=>({read:()=>({settings:{}}),maintainCognition:()=>hang?held:Promise.resolve(),claimReview:async()=>{calls++;return null},planFormation:async()=>null}),complete:async()=>{throw Error('not expected')}})
 assert.equal((await worker.tick()).status,'timeout');hang=false
 assert.equal((await worker.tick()).status,'idle');release();await new Promise(r=>setTimeout(r,10));assert.equal(calls,1)
})
test('invalid direct output persists diagnosis without advancing cursor',async t=>{
 const x=setup(t);await x.store.ingestOwnerMessage({actor:'2',messageId:'x',text:'hello'})
 const worker=createFormationWorker({complete:async()=>'{"candidates":"invalid"}',store:()=>x.store,config:()=>({self:{mid:'1'},owner:{mid:'2'}})})
 const status=await worker.tick();assert.equal(status.status,'failed');assert.ok(status.reason);assert.equal(x.store.learningStatus().cursor,0)
 assert.ok(x.store.learningStatus().jobs[0].lastDiagnostic)
})
test('pause/resume CLI works without settings panel and obsolete commands are absent',t=>{
 const x=setup(t),cfg=path.join(x.home,'config.json');fs.writeFileSync(cfg,JSON.stringify({self:{mid:'1'},owner:{mid:'2'}}))
 const cli=fileURLToPath(new URL('../tools/bili.mjs',import.meta.url)),env={...process.env,DSH_HOME:x.home,BILI_WHALE_CONFIG:cfg,USERPROFILE:x.home,HOME:x.home}
 for(const [cmd,value] of [['pause',true],['resume',false]]){const r=spawnSync(process.execPath,[cli,'life',cmd],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).paused,value)}
 const root=fileURLToPath(new URL('../',import.meta.url));assert.equal(fs.existsSync(path.join(root,'tools/commands/danmaku-await.mjs')),false)
 assert.doesNotMatch(fs.readFileSync(path.join(root,'lib/scheduler.js'),'utf8'),/liveTick|timer3/)
 assert.match(formationPrompt({stage:'review',input:{}}),/暂定理解/)
})

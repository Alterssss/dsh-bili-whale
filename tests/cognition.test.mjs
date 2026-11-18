import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createLifeStore} from '../tools/lib/life-store.mjs'
import {createFormationWorker,formationPrompt} from '../lib/formation-worker.js'
import {createScopedDelivery} from '../lib/scoped-delivery.js'
import {prepareExpression,finalizeExpression} from '../tools/lib/expression.mjs'
import {createPrivateIngress} from '../lib/private-ingress.js'

function setup(t,config={}) {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-cognition-'))
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
 let at=Date.parse('2026-10-20T15:00:00Z'),seq=0
 const store=createLifeStore({dshHome:home,account:'1',owner:'2',config,now:()=>at})
 return {home,store,advance:days=>at+=days*86400000,receive:text=>store.ingestOwnerMessage({actor:'2',messageId:String(++seq),text})}
}
function candidate(events,extra={}) {return {key:'a',type:'understanding',text:'最近晚上较疲惫，原因尚不确定',sourceIds:events.map(e=>e.id),quotes:events.map(e=>({eventId:e.id,text:e.text})),scope:{scenes:['private-reply','private-recommendation']},visibility:'private',appliesTo:'晚上且正在疲惫',doThis:'减轻交流负担，允许推迟推荐',falsifiedBy:'主人说明并不疲惫或希望继续交流时收窄判断',alternatives:['可能只是这几天事情较多'],behaviorLinks:[{when:'晚上且正在疲惫',adjustment:'减轻交流负担，允许推迟推荐',limits:'不诊断、不每天机械提醒'}],...extra}}
const accepted=c=>({key:c.key,action:'accept',reason:'原话支持有限理解，保留不确定性',grounded:true,scopeClear:true,overgeneralized:false})
async function form(store,candidates){const job=await store.planFormation({force:true});await store.submitFormation(job.jobId,job.token,{candidates,summary:'经历汇总'});const review=await store.claimReview();return store.commitFormation(review.jobId,review.token,{decisions:candidates.map(accepted)})}

test('owner ingress is immediate, deduplicated and hidden from public contexts',async t=>{
 const {store,receive}=setup(t);const e=await receive('今晚好累')
 assert.match(store.context('','private-reply'),/今晚好累/)
 assert.doesNotMatch(store.context('','public-comment'),/今晚好累/)
 const again=await store.ingestOwnerMessage({actor:'2',messageId:'1',text:'今晚好累'})
 assert.equal(again.id,e.id);assert.equal(store.learningStatus().working.exchanges.length,1)
 await assert.rejects(store.ingestOwnerMessage({actor:'9',messageId:'x',text:'fake'}),/身份/)
})
test('five independent nights form a provisional pattern with real behavior links',async t=>{
 const {store,receive,advance}=setup(t),events=[]
 for(let i=0;i<5;i++){events.push(await receive('今晚好累'));advance(1)}
 const result=await form(store,[candidate(events,{type:'pattern'})]);assert.equal(result.created.length,1)
 const m=store.read().memories[0];assert.equal(m.independentDays,5);assert.equal(m.epistemic,'inferred');assert.equal(m.status,'provisional')
 assert.equal(store.read().settings.permissionVersion??0,0)
 assert.match(store.context('疲惫','private-recommendation'),/推迟推荐/)
 assert.equal(store.reader('public-comment').get(m.id),null)
})
test('many same-day messages cannot create a cross-day habit',async t=>{
 const {store,receive}=setup(t),events=[await receive('好累'),await receive('还是累')]
 await form(store,[candidate(events,{type:'pattern'})]);assert.equal(store.read().memories[0].independentDays,1)
 assert.equal(store.read().memories[0].status,'provisional')
})
test('model diary is not new learning evidence; empty output advances only genuine input',async t=>{
 const {store,receive}=setup(t);await receive('嗯');await store.record('diary',{text:'主人经常疲惫',origin:'model'})
 const j=await store.planFormation({force:true});assert.equal(j.input.events.length,1)
 await store.submitFormation(j.jobId,j.token,{candidates:[]});const r=await store.claimReview();await store.commitFormation(r.jobId,r.token,{decisions:[]})
 assert.equal(await store.planFormation({force:true}),null);assert.equal(store.read().memories.length,0)
})
test('fabricated IDs, mismatched quotes and public leakage fail before review',async t=>{
 const {store,receive}=setup(t);const e=await receive('private secret'),j=await store.planFormation({force:true})
 for(const change of [{sourceIds:['fake']},{quotes:[{eventId:e.id,text:'invented'}]},{visibility:'public'}])await assert.rejects(store.submitFormation(j.jobId,j.token,{candidates:[candidate([e],change)]}))
 assert.equal(store.learningStatus().jobs[0].stage,'extract')
})
test('claimed owner origin in generic model record cannot become owner authority',async t=>{
 const {store}=setup(t),e=await store.record('received',{text:'以后别推荐',origin:'owner',verifiedRole:'owner'})
 const j=await store.planFormation({force:true});await assert.rejects(store.submitFormation(j.jobId,j.token,{candidates:[candidate([e],{epistemic:'owner_explicit'})]}),/可信主人/)
})
test('verified long-term directives commit automatically only after independent review',async t=>{
 const {store,receive}=setup(t),e=await receive('以后私人推荐都简短一点，除非我要求详细分析')
 const c=candidate([e],{type:'expression_policy',epistemic:'owner_explicit',policy:{defaultBehavior:'简短推荐',exceptions:[{condition:'主人要求分析',behavior:'详细分析',sourceIds:[e.id]}]}})
 const j=await store.planFormation({force:true});await store.submitFormation(j.jobId,j.token,{candidates:[c]});assert.equal(store.read().memories.length,0)
 const r=await store.claimReview();await store.commitFormation(r.jobId,r.token,{decisions:[{...accepted(c),explicitDirective:true,longTerm:true}]})
 assert.equal(store.read().memories[0].authority,'owner_explicit');assert.ok(store.read().settings.policyRevision)
})
test('temporary or ambiguous directives become clarification, not permanent policy',async t=>{
 const {store,receive}=setup(t),e=await receive('这次少一点'),c=candidate([e],{type:'commitment'})
 await form(store,[c]);assert.equal(store.read().memories.length,0);assert.equal(store.learningStatus().working.questions.length,1)
})
test('lease, single flight, wrong token and repeated submission cannot duplicate commits',async t=>{
 const {store,receive,advance}=setup(t);const e=await receive('好累'),j=await store.planFormation({force:true})
 assert.equal(await store.planFormation({force:true}),null)
 await assert.rejects(store.submitFormation(j.jobId,'wrong',{candidates:[]}),/无效/)
 advance(1);await assert.rejects(store.submitFormation(j.jobId,j.token,{candidates:[]}),/过期/)
 await store.maintainCognition();advance(61/86400)
 const retry=await store.claimFormationRetry();assert.equal(retry.jobId,j.jobId)
 const c=candidate([e]);await store.submitFormation(retry.jobId,retry.token,{candidates:[c]})
 const review=await store.claimReview();await store.commitFormation(review.jobId,review.token,{decisions:[accepted(c)]});assert.equal(store.read().memories.length,1)
})
test('pause then resume invalidates an outstanding task',async t=>{
 const {store,receive}=setup(t);await receive('hi');const j=await store.planFormation({force:true})
 await store.pause(true);await assert.rejects(store.submitFormation(j.jobId,j.token,{candidates:[]}),/暂停/)
 await store.pause(false);await assert.rejects(store.submitFormation(j.jobId,j.token,{candidates:[]}),/版本/)
})
test('disabled learning and zero daily budget make no jobs',async t=>{
 for(const config of [{learningEnabled:false},{learningDailyJobs:0},{enabled:false}]){const {store,receive}=setup(t,config);await receive('hi');assert.equal(await store.planFormation({force:true}),null)}
})
test('expired interpretations stop recall and invalidate old task generation only once',async t=>{
 const {store,receive,advance}=setup(t),e=await receive('好累');await form(store,[candidate([e])]);advance(31)
 await store.maintainCognition();assert.equal(store.reader('private-reply').get(store.read().memories[0].id),null)
 const version=store.read().settings.permissionVersion;await store.maintainCognition();assert.equal(store.read().settings.permissionVersion,version)
})
test('decision trace references actual supplied memory and links a draft to acceptance',async t=>{
 const {store,receive}=setup(t),e=await receive('好累');await form(store,[candidate([e])]);const m=store.read().memories[0]
 await store.captureContext('task-1','疲惫','private-reply','session-1')
 await assert.rejects(store.recordDecision({taskId:'task-1',action:'reply',reason:'x',memoryIds:['fake']}),/引用/)
 await store.recordDecision({taskId:'task-1',action:'reply',reason:'减少负担',memoryIds:[m.id],output:'今天先休息吧'})
 const d=await prepareExpression(store,{taskId:'task-1',scene:'private-reply',text:'今天先休息吧',target:'2'});await finalizeExpression(store,d.id)
 const token=await store.reserve({draftId:d.id,scene:'private-reply',channel:'dm',target:'2',text:d.text});await store.dispatch(token,()=>Promise.resolve());await store.settle(token,{status:'sent',receipt:'r1'})
 const trace=store.decisionTraces()[0];assert.equal(trace.stage,'apiAccepted');assert.equal(trace.outcomes[0].receipt,'r1')
})
test('verified external sender binding uses the same private working memory',async t=>{
 const {store}=setup(t)
 await assert.rejects(store.ingestOwnerMessage({channel:'qq',actor:'qq-2',messageId:'1',text:'A'}),/绑定/)
 await store.bindChannel({channel:'qq',senderId:'qq-2'})
 await store.ingestOwnerMessage({channel:'qq',actor:'qq-2',messageId:'1',text:'A'})
 assert.match(store.context('','private-reply'),/"text":"A"/)
 await store.bindChannel({channel:'qq',senderId:'qq-2',enabled:false})
 await assert.rejects(store.ingestOwnerMessage({channel:'qq',actor:'qq-2',messageId:'2',text:'B'}),/绑定/)
})
test('private reply and recommendation share host session; public tasks do not',async t=>{
 const {home}=setup(t),calls=[]
 const d=createScopedDelivery({dshHome:home,cwd:home,config:()=>({self:{mid:'1'},owner:{mid:'2'}}),persona:()=>'',memoryContext:()=>'',controller:{create:async()=>{},prompt:async r=>calls.push(r)}})
 for(const [requestId,memoryScene] of [['a','private-reply'],['b','private-recommendation'],['c','public-comment'],['d','public-comment']])await d.send({requestId,memoryScene,content:[]})
 assert.equal(calls[0].sessionId,calls[1].sessionId);assert.notEqual(calls[2].sessionId,calls[3].sessionId)
})
test('pure completion returns JSON; program submits extract and review without sessions',async t=>{
 const {store,receive}=setup(t),e=await receive('累了'),calls=[]
 const worker=createFormationWorker({complete:async request=>{calls.push(request);return JSON.stringify(request.stage==='review'?{decisions:[accepted({key:'a'})]}:{candidates:[candidate([e])]})},store:()=>store,config:()=>({self:{mid:'1'},owner:{mid:'2'}})})
 assert.equal((await worker.tick()).status,'review_pending');assert.equal(store.read().memories.length,0)
 assert.equal((await worker.tick()).status,'committed');assert.equal(store.read().memories.length,1)
 assert.equal(calls.length,2);assert.ok(calls.every(c=>!c.prompt.includes('induce-submit')&&!c.prompt.includes('提交命令')))
})
test('unverified host API disables automatic formation without creating jobs',async t=>{
 const {store,receive}=setup(t);await receive('hi')
 const worker=createFormationWorker({controller:{create:()=>assert.fail(),prompt:()=>assert.fail()},store:()=>store,config:()=>({self:{mid:'1'},owner:{mid:'2'}})})
 assert.equal((await worker.tick()).status,'unavailable');assert.equal(store.learningStatus().jobs.length,0);assert.equal(store.learningStatus().unprocessed,1)
})
test('formation prompt has readable sources and no execution capability',()=>{
 const prompt=formationPrompt({jobId:'job-a',token:'secret',stage:'review',input:{events:[{id:'e1',at:0,text:'你好',verifiedRole:'owner'}]}})
 assert.match(prompt,/来源 e1/);assert.match(prompt,/你好/);assert.doesNotMatch(prompt,/secret|whale-formation-|induce-review/)
})

test('a repeated summary cannot add evidence; a correction can replace a belief with CAS',async t=>{
 const {store,receive,advance}=setup(t),e=await receive('晚上好累');await form(store,[candidate([e])]);const m=store.read().memories[0]
 advance(1);const correction=await receive('我只是今天运动累了，平常没熬夜')
 const c=candidate([correction],{text:'疲惫可能来自运动，不能判断经常熬夜',baseId:m.id,baseVersion:m.version,counterEvidenceIds:[correction.id]})
 const j=await store.planFormation({force:true});await store.submitFormation(j.jobId,j.token,{candidates:[c]});const review=await store.claimReview()
 const result=await store.commitFormation(review.jobId,review.token,{decisions:[accepted(c)]})
 assert.equal(result.created.length,1);assert.equal(store.read().memories.filter(m=>m.active).length,1)
 assert.ok(store.read().settings.permissionVersion);assert.equal(store.read().memories.at(-1).version,2)
 await assert.rejects(store.commitFormation(review.jobId,review.token,{decisions:[accepted(c)]}),/阶段/)
})
test('revocation during review rejects stale results',async t=>{
 const {store,receive}=setup(t),e=await receive('晚上累');await form(store,[candidate([e])]);const m=store.read().memories[0]
 const newer=await receive('今天不累'),c=candidate([newer],{baseId:m.id,baseVersion:1})
 const j=await store.planFormation({force:true});await store.submitFormation(j.jobId,j.token,{candidates:[c]});const r=await store.claimReview();await store.revoke(m.id)
 await assert.rejects(store.commitFormation(r.jobId,r.token,{decisions:[accepted(c)]}),/版本/)
})
test('a recorded postponement blocks the associated recommendation at the send gate',async t=>{
 const {store,receive}=setup(t);await receive('今晚不想看')
 await store.captureContext('later','今晚','private-recommendation','main')
 await store.recordDecision({taskId:'later',action:'postpone',reason:'减少负担',memoryIds:[]})
 assert.equal(store.check({taskId:'later',channel:'dm',target:'2',text:'看看这个',scene:'private-recommendation'}).allow,false)
 assert.equal(store.read().events.some(e=>e.kind==='sent'),false)
})
test('external adapter authenticates first and retries retain the same delivery identity',async t=>{
 const {store}=setup(t),calls=[];await store.bindChannel({channel:'qq',senderId:'qq2'})
 const receive=createPrivateIngress({authenticate:async e=>e.valid?{channel:'qq',actor:'qq2',messageId:'m1',text:'你好'}:null,store:()=>store,delivery:{send:async r=>calls.push(r)}})
 await assert.rejects(receive({valid:false}),/认证/);assert.equal(store.read().events.length,0)
 await receive({valid:true});await receive({valid:true});assert.equal(calls[0].requestId,calls[1].requestId);assert.equal(calls[0].memoryScene,'private-reply')
})
test('long incoming text cannot wedge the bounded formation queue',async t=>{
 const {store,receive}=setup(t);await receive('长消息'.repeat(3000))
 const j=await store.planFormation({force:true});assert.equal(j.input.events[0].truncated,true)
 assert.ok(Buffer.byteLength(JSON.stringify(j.input))<=32768)
 await store.submitFormation(j.jobId,j.token,{candidates:[]});const r=await store.claimReview();await store.commitFormation(r.jobId,r.token,{decisions:[]})
 assert.equal(store.learningStatus().unprocessed,0)
})
test('rephrasing an old interpretation does not accumulate additional memories',async t=>{
 const {store,receive}=setup(t),e=await receive('好累');await form(store,[candidate([e])]);await receive('嗯')
 await form(store,[candidate([e],{text:'换种说法：当前疲惫'})])
 assert.equal(store.read().memories.length,1);assert.equal(store.read().memories[0].independentEvidence,1)
})
test('restart preserves the job and accepts the original one-stage capability exactly once',async t=>{
 const {store,receive,home}=setup(t);await receive('你好');const j=await store.planFormation({force:true})
 const next=createLifeStore({dshHome:home,account:'1',owner:'2',now:store.now})
 await next.submitFormation(j.jobId,j.token,{candidates:[]})
 await assert.rejects(next.submitFormation(j.jobId,j.token,{candidates:[]}),/阶段/)
 assert.equal(next.learningStatus().jobs[0].stage,'review_pending')
})

test('actionable understanding survives review, persistence and scoped recall',async t=>{
 const {store,home,receive}=setup(t),e=await receive('晚上有点累'),c=candidate([e])
 const j=await store.planFormation({force:true});await store.submitFormation(j.jobId,j.token,{candidates:[c]})
 const r=await store.claimReview();assert.equal(r.input.candidates[0].falsifiedBy,c.falsifiedBy)
 await store.commitFormation(r.jobId,r.token,{decisions:[accepted(c)]})
 const reopened=createLifeStore({dshHome:home,account:'1',owner:'2',now:store.now})
 const m=reopened.read().memories[0]
 for(const k of ['appliesTo','doThis','falsifiedBy'])assert.equal(m[k],c[k])
 assert.ok(m.behaviorLinks.some(x=>x.when===c.appliesTo&&x.adjustment===c.doThis&&x.limits===c.falsifiedBy))
 const context=store.context('疲惫','private-reply');assert.match(context,/"appliesTo"/);assert.match(context,/"falsifiedBy"/)
 assert.doesNotMatch(store.context('疲惫','public-comment'),/"falsifiedBy"/)
})

test('cognitive candidates require bounded actionable fields before review',async t=>{
 const {store,receive}=setup(t),e=await receive('累'),j=await store.planFormation({force:true})
 for(const type of ['pattern','understanding'])for(const [field,max] of [['appliesTo',500],['doThis',800],['falsifiedBy',500]]){
   for(const value of [undefined,'   ',{},'x'.repeat(max+1)]){
     await assert.rejects(store.submitFormation(j.jobId,j.token,{candidates:[candidate([e],{type,[field]:value})]}),new RegExp(field))
   }
 }
 assert.equal(store.learningStatus().jobs[0].stage,'extract');assert.equal(store.read().memories.length,0)
})

test('actionable fields retain all four additional behavior limits',async t=>{
 const {store,receive}=setup(t),e=await receive('累'),links=Array.from({length:4},(_,i)=>({when:'情境'+i,adjustment:'建议'+i,limits:'限制'+i}))
 await form(store,[candidate([e],{behaviorLinks:links})])
 const saved=store.read().memories[0].behaviorLinks
 assert.equal(saved.length,5);for(const link of links)assert.ok(saved.some(x=>x.limits===link.limits))
})

test('automatic type whitelist rejects invented types and fact requires trusted owner evidence',async t=>{
 const {store}=setup(t),e=await store.record('observed',{text:'今天工作很晚',origin:'model'}),j=await store.planFormation({force:true})
 await assert.rejects(store.submitFormation(j.jobId,j.token,{candidates:[candidate([e],{type:'insight'})]}),/不支持/)
 await assert.rejects(store.submitFormation(j.jobId,j.token,{candidates:[candidate([e],{type:'fact'})]}),/事实需要/)
})

test('important episodes and explicit owner facts do not require inference fields',async t=>{
 const {store,receive}=setup(t),e=await receive('今天第一次换了工作')
 const c=candidate([e],{type:'fact',text:'主人明确说今天第一次换了工作',appliesTo:undefined,doThis:undefined,falsifiedBy:undefined,behaviorLinks:[]})
 const result=await form(store,[c]);assert.equal(result.created.length,1)
 const next=await receive('第一次分享自己的作品')
 const episodic=candidate([next],{type:'episodic',appliesTo:undefined,doThis:undefined,falsifiedBy:undefined,behaviorLinks:[]})
 assert.equal((await form(store,[episodic])).created.length,1)
})

test('formation prompts prioritize understanding without forcing conclusions or type quotas',()=>{
 const extract=formationPrompt({stage:'extract',input:{}}),review=formationPrompt({stage:'review',input:{}})
 for(const field of ['appliesTo','doThis','falsifiedBy'])assert.ok(extract.includes(field))
 assert.match(extract,/允许零条/);assert.match(extract,/单次理解/)
 assert.match(review,/暂定理解/);assert.match(review,/逐项覆盖/)
})

// Session invalidation is independent of formation/task CAS versions.
import {sessionBoundaryFingerprint} from '../tools/lib/session-boundary.mjs'
function boundaryDelivery(home,store,calls,extra={}) {
 const cfg={self:{mid:'1'},owner:{mid:'2'},sessionRotateDays:0}
 return createScopedDelivery({dshHome:home,cwd:home,config:()=>cfg,persona:()=>'',contextGeneration:()=>sessionBoundaryFingerprint(store.read(),cfg),memoryContext:()=>'',controller:{create:async()=>{},prompt:async r=>calls.push(r)},...extra})
}
const sessionRequest=id=>({requestId:id,memoryScene:'private-reply',content:[{type:'text',text:'继续聊'}]})
test('actual formation replacement keeps conversation across version bumps, pause, and restart; revoke rotates once',async t=>{
 const {home,store,receive,advance}=setup(t),calls=[]
 const e=await receive('晚上好累');await form(store,[candidate([e])]);const m=store.read().memories[0]
 let d=boundaryDelivery(home,store,calls);await d.send(sessionRequest('boundary-1'))
 const version=store.read().settings.permissionVersion??0,epoch=store.read().settings.sessionBoundaryVersion??0
 advance(1);const correction=await receive('今天只是运动累了，平常没熬夜')
 await form(store,[candidate([correction],{text:'疲惫可能来自运动',baseId:m.id,baseVersion:m.version,counterEvidenceIds:[correction.id]})])
 assert.ok(store.read().settings.permissionVersion>version)
 assert.equal(store.read().settings.sessionBoundaryVersion??0,epoch)
 await d.send(sessionRequest('boundary-2'));await store.pause(true);await store.pause(false)
 d=boundaryDelivery(home,store,calls);await d.send(sessionRequest('boundary-3'))
 assert.equal(new Set(calls.map(r=>r.sessionId)).size,1)
 await store.revoke(m.id);await d.send(sessionRequest('boundary-4'));await d.send(sessionRequest('boundary-5'))
 assert.notEqual(calls[3].sessionId,calls[2].sessionId);assert.equal(calls[4].sessionId,calls[3].sessionId)
})
test('owner-approved text replacement retains session; narrowing scopes and suppression invalidate it',async t=>{
 const {home,store,receive}=setup(t),calls=[],e=await receive('这是一条记忆')
 let p=await store.propose({type:'memory',text:'原记忆',sourceIds:[e.id],scope:{scenes:['private-reply','private-recommendation']}});await store.review(p.id,'accept');let m=store.read().memories.find(m=>m.active)
 const d=boundaryDelivery(home,store,calls);await d.send(sessionRequest('accepted-1'))
 p=await store.propose({type:'memory',text:'更新正文',sourceIds:[e.id],baseId:m.id,scope:m.scope});await store.review(p.id,'accept');m=store.read().memories.find(m=>m.active)
 await d.send(sessionRequest('accepted-2'));assert.equal(calls[0].sessionId,calls[1].sessionId)
 p=await store.propose({type:'memory',text:'更新适用范围',sourceIds:[e.id],baseId:m.id,scope:{scenes:['private-reply']}});await store.review(p.id,'accept');m=store.read().memories.find(m=>m.active)
 await d.send(sessionRequest('accepted-3'));assert.notEqual(calls[1].sessionId,calls[2].sessionId)
 await store.suppress(m.id);await d.send(sessionRequest('accepted-4'));assert.notEqual(calls[2].sessionId,calls[3].sessionId)
})
test('revocation during context assembly still blocks host dispatch',async t=>{
 const {home,store,receive}=setup(t),calls=[],e=await receive('晚上好累');await form(store,[candidate([e])]);const m=store.read().memories[0]
 const d=boundaryDelivery(home,store,calls,{memoryContext:async()=>{await store.revoke(m.id);return ''}})
 await assert.rejects(d.send(sessionRequest('racing-revoke')),/记忆权限已变化/);assert.equal(calls.length,0)
})
test('session fingerprint ignores counters and tuning but detects identity, persona and expression boundary changes',()=>{
 const state={settings:{permissionVersion:10}},cfg={self:{mid:'1'},owner:{mid:'2'}}
 const first=sessionBoundaryFingerprint(state,cfg)
 assert.equal(sessionBoundaryFingerprint({settings:{permissionVersion:30,memoryRevision:80}}, {...cfg,life:{paused:true,memoryChars:6000}}),first)
 for(const changed of [{...cfg,owner:{mid:'3'}},{...cfg,persona:{name:'changed'}},{...cfg,life:{hardMode:'enforce'}}])assert.notEqual(sessionBoundaryFingerprint(state,changed),first)
 assert.notEqual(sessionBoundaryFingerprint(state,cfg,'new persona'),first)
})

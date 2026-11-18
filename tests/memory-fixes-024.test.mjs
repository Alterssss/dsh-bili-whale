import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createLifeStore} from '../tools/lib/life-store.mjs'
import {normalizeRelationProposals} from '../tools/lib/memory-relations.mjs'
import {createFormationWorker} from '../lib/formation-worker.js'

function setup(t){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-024-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
 let at=Date.parse('2026-10-30T12:00:00+08:00'),n=0
 const open=()=>createLifeStore({dshHome:home,account:'1',owner:'2',now:()=>at})
 const store=open()
 return {store,open,advance:()=>at+=86400000,receive:text=>store.ingestOwnerMessage({actor:'2',messageId:String(++n),text})}
}
const candidate=(e,extra={})=>({key:'c',subject:'owner',type:'understanding',text:'最近深夜疲惫',sourceIds:[e.id],quotes:[{eventId:e.id,text:e.text}],scope:{scenes:['private-reply']},visibility:'private',appliesTo:'深夜讨论作息',doThis:'关心当前作息',falsifiedBy:'最近改为早睡',alternatives:['阶段性忙碌'],...extra})
async function accept(store,job){
 const review=await store.claimReview();assert.equal(review.jobId,job.jobId)
 return store.commitFormation(review.jobId,review.token,{decisions:review.input.candidates.map(c=>({key:c.key,action:'accept',reason:'本次来源支持'})),relationDecisions:review.input.relations.map(r=>({key:r.key,action:'accept',reason:'来源与关系一致'}))},{isolateInvalid:true})
}
test('external facts survive extraction, review, reopen and public dynamic recall',async t=>{
 const x=setup(t)
 const e=await x.store.record('video-read',{target:'BV1va411c7va',origin:'video',text:'作者称立绘绑定教程附工程文件，可复现'})
 const c=candidate(e,{subject:'world',type:'fact',text:'立绘绑定教程作者称提供可复现工程文件',scope:{scenes:['public-comment']},visibility:'public',epistemic:'inferred'})
 const job=await x.store.planFormation({force:true});await x.store.submitFormation(job.jobId,job.token,{candidates:[c]});await accept(x.store,job)
 const saved=x.open().read().memories[0];assert.equal(saved.authority,'inferred');assert.equal(saved.sourceIds[0],e.id)
 const snapshot=x.open().contextSnapshot('立绘绑定工程文件','public-comment')
 assert.ok(snapshot.segments.some(s=>s.kind==='recall'&&s.refs.some(r=>r.id===saved.id)))
 assert.match(snapshot.text,/作者称/)
})
test('observation facts do not need owner confirmation; owner directives still need owner evidence',async t=>{
 const x=setup(t),e=await x.store.record('observed',{text:'观察到新版本界面增加了字幕按钮',origin:'tool',visibility:'public'})
 const job=await x.store.planFormation({force:true})
 await assert.rejects(x.store.submitFormation(job.jobId,job.token,{candidates:[candidate(e,{subject:'world',type:'fact',epistemic:'owner_explicit'})]}),/可信主人/)
 await x.store.submitFormation(job.jobId,job.token,{candidates:[candidate(e,{subject:'world',type:'fact',epistemic:'inferred'})]});await accept(x.store,job)
 assert.equal(x.store.read().memories.length,1)
})
function relationFixture(){
 const e={id:'e',kind:'received',origin:'owner',text:'最近早睡了，精神好多了',at:1000,originEvidenceIds:['e']}
 const s={events:[e],memories:[{id:'m',version:1,active:true,recallEnabled:true,visibility:'private',scope:{scenes:['private-reply']}}]}
 const j={inputs:[{id:'e'}],memoryVersions:{m:1}}
 const r={key:'r',memoryId:'m',memoryVersion:1,eventId:'e',relation:'supplement',quote:e.text}
 return {s,j,r}
}
test('identical relation payload collapses even with alternate keys',()=>{
 const {s,j,r}=relationFixture(),rejected=[]
 const rows=normalizeRelationProposals(s,j,[r,{...r},{...r,key:'alias'}],{isolateInvalid:true,rejected})
 assert.equal(rows.length,1);assert.equal(rows[0].key,'r');assert.deepEqual(rejected,[])
})
test('conflicting groups are fully isolated, regardless of order or duplicate aliases',()=>{
 const {s,j,r}=relationFixture()
 for(const rows of [[r,{...r,key:'alias'},{...r,key:'other',relation:'contradict'}],[{...r,relation:'contradict'},r]]){
  const rejected=[];assert.deepEqual(normalizeRelationProposals(s,j,rows,{isolateInvalid:true,rejected}),[]);assert.equal(rejected.length,2)
 }
 const rejected=[];assert.equal(normalizeRelationProposals(s,j,[null,{...r,quote:'不存在的原话'},r],{isolateInvalid:true,rejected}).length,1);assert.equal(rejected.length,2)
})
test('worker commits valid candidates despite a conflicting relation group',async t=>{
 const x=setup(t),e=await x.receive('最近早睡了，精神好多了')
 await x.store.tx(s=>s.memories.push({id:'old',version:1,active:true,recallEnabled:true,at:x.store.now(),text:'最近作息晚',type:'understanding',visibility:'private',scope:{scenes:['private-reply']},sourceIds:[]}))
 const relation={key:'r',memoryId:'old',memoryVersion:1,eventId:e.id,relation:'support',quote:e.text}
 const worker=createFormationWorker({store:()=>x.store,config:()=>({self:{mid:'1'},owner:{mid:'2'}}),complete:async({stage})=>JSON.stringify(stage==='extract'?{candidates:[candidate(e)],relations:[relation,{...relation,key:'opposite',relation:'contradict'}]}:{decisions:[{key:'c',action:'accept',reason:'保留有用理解'}],relationDecisions:[]})})
 assert.equal((await worker.tick()).status,'review_pending')
 const result=await worker.tick({allowNew:false});assert.equal(result.status,'committed');assert.equal(result.result.created.length,1);assert.equal(result.result.rejectedRelations.length,2)
 assert.equal(x.open().learningStatus().jobs[0].rejectedRelations.length,2)
})
test('related old memory is supplied beyond the latest thirty with its correction conditions',async t=>{
 const x=setup(t),e=await x.receive('深夜疲惫，想改变睡眠作息'),j=await x.store.planFormation({force:true})
 await x.store.submitFormation(j.jobId,j.token,{candidates:[candidate(e)]});await accept(x.store,j)
 const id=x.store.read().memories[0].id
 await x.store.tx(s=>{for(let i=0;i<35;i++)s.memories.push({id:'unrelated-'+i,version:1,active:true,at:x.store.now()+i+1,type:'episodic',text:'无关园艺盆栽记录',scope:{scenes:['private-reply']},visibility:'private',sourceIds:[]})})
 x.advance();await x.receive('睡眠作息改变，最近早睡后不再深夜疲惫')
 const next=await x.store.planFormation({force:true}),old=next.input.memories.find(m=>m.id===id)
 assert.ok(old);assert.equal(old.version,1);assert.equal(old.falsifiedBy,'最近改为早睡');assert.equal(old.doThis,'关心当前作息')
})
test('explicit correction updates stable id/version and replaces the dynamically recalled judgement',async t=>{
 const x=setup(t),e=await x.receive('最近总是深夜疲惫'),j=await x.store.planFormation({force:true})
 await x.store.submitFormation(j.jobId,j.token,{candidates:[candidate(e)]});await accept(x.store,j)
 const old=x.store.read().memories[0];x.advance();const changed=await x.receive('最近已经早睡，精神改善了')
 const next=await x.store.planFormation({force:true})
 await x.store.submitFormation(next.jobId,next.token,{candidates:[candidate(changed,{baseId:old.id,baseVersion:old.version,text:'过去曾深夜疲惫，现在早睡且精神改善',doThis:'按当前作息交流，不再按旧状态提醒'})]})
 const review=await x.store.claimReview();assert.equal(review.input.memories[0].falsifiedBy,old.falsifiedBy)
 await x.store.commitFormation(review.jobId,review.token,{decisions:[{key:'c',action:'accept',reason:'新经历明确改变当前状态'}]})
 const reopened=x.open(),memories=reopened.read().memories;assert.equal(memories.length,1);assert.equal(memories[0].id,old.id);assert.equal(memories[0].version,2)
 const snapshot=reopened.contextSnapshot('深夜疲惫早睡','private-reply')
 const recalls=snapshot.segments.filter(s=>s.kind==='recall').map(s=>JSON.parse(s.text))
 assert.ok(recalls.some(m=>m.id===old.id&&m.version===2&&m.text.includes('现在早睡')));assert.ok(!recalls.some(m=>m.text===old.text))
})

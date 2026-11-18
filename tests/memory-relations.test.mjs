import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createLifeStore} from '../tools/lib/life-store.mjs'
import {addRelation,relationRoots,validateRelations} from '../tools/lib/memory-relations.mjs'
import {rankMemories} from '../tools/lib/memory-lifecycle.mjs'
import {dynamicConfig} from '../tools/lib/dynamic-memory-config.mjs'
import {compileContext} from '../tools/lib/memory-context.mjs'
const DAY=86400000
function setup(t,dynamicMemory={enabled:true,shadow:false}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-relations-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
 let at=Date.parse('2026-10-29T12:00:00Z'),seq=0
 const open=()=>createLifeStore({dshHome:home,account:'1',owner:'2',config:{dynamicMemory},now:()=>at})
 const store=open()
 const put=(id='m',extra={})=>store.tx(s=>s.memories.push({id,version:1,at,acceptedAt:at,active:true,recallEnabled:true,type:'episodic',text:'最近晚上经常疲惫',visibility:'private',scope:{scenes:['private-reply']},sourceIds:[],originEvidenceIds:[],independentEvidence:1,...extra}))
 const receive=(text='最近晚上经常疲惫',id=String(++seq))=>store.ingestOwnerMessage({actor:'2',messageId:id,text})
 return {store,open,put,receive,advance:d=>at+=d*DAY,view:()=>store.memoryExplain('m').view}
}
async function reviewRelation(store,e,relation='support',extra={}){
 const j=await store.planFormation({force:true})
 await store.submitFormation(j.jobId,j.token,{candidates:[],relations:[{key:'r',memoryId:'m',memoryVersion:1,eventId:e.id,relation,quote:e.text,...extra}]})
 const r=await store.claimReview()
 return {r,commit:()=>store.commitFormation(r.jobId,r.token,{decisions:[],relationDecisions:[{key:'r',action:'accept',reason:'原文支持此分类，保留范围'}]})}
}
test('new related material credits automatically without fetch or decision',async t=>{
 const {store,put,receive,view}=setup(t);await put();await receive()
 assert.equal(view().relation.count,1);assert.equal(view().relation.counts.related,1)
 assert.equal(store.read().dynamicMemory?.access?.m,undefined)
 assert.equal(store.read().memories[0].independentEvidence,1)
})
test('unrelated material does not add tags',async t=>{
 const {put,receive,view}=setup(t);await put();await receive('周末去海边摄影');assert.equal(view().relation.count,0)
})
test('tired synonyms relate and retrieve without inventing a late-night habit',async t=>{
 const {store,put,receive,view}=setup(t);await put('m',{text:'主人最近晚上疲惫'});await put('late',{text:'主人经常熬夜'})
 await receive('我好累');assert.equal(view().relation.count,1)
 assert.equal(store.memoryExplain('late').view.relation.count,0)
 assert.ok(store.memoryCatalog({query:'我好累'}).items.some(m=>m.id==='m'))
 await receive('今天不累了');assert.equal(view().relation.counts.related,2);assert.equal(view().relation.counts.support,0)
})
test('repeated injection and preview cannot manufacture relevance',async t=>{
 const {store,put,receive,view}=setup(t);await put();await receive()
 for(let i=0;i<10;i++){store.contextSnapshot('疲惫','private-reply');await store.captureContext('t'+i,'疲惫','private-reply','main')}
 assert.equal(view().relation.count,1)
})
test('incoming retry and restart still count one origin',async t=>{
 const {store,open,put,receive,view}=setup(t);await put();await receive('最近晚上经常疲惫','same');await receive('最近晚上经常疲惫','same')
 await open().ingestOwnerMessage({actor:'2',messageId:'same',text:'最近晚上经常疲惫'})
 assert.equal(view().relation.count,1);assert.equal(store.read().memories[0].relevance.tags.length,1)
})
test('cold memory outside default injection can revive on a new related event',async t=>{
 const {store,put,receive,view}=setup(t);await put('m',{at:store.now()-400*DAY,acceptedAt:store.now()-400*DAY})
 assert.equal(view().tier,'dormant');assert.equal(store.memoryCatalog().items.length,0)
 await receive();assert.equal(view().tier,'hot');assert.equal(store.memoryCatalog().items[0].id,'m')
})
test('repetition strengthens retention, not factual confidence',async t=>{
 const {store,put,receive,advance,view}=setup(t);await put()
 await receive();await receive();assert.notEqual(view().retentionStage,'long-term')
 advance(1);await receive();assert.equal(view().retentionStage,'long-term')
 assert.equal(store.read().memories[0].independentEvidence,1);assert.equal(store.read().memories[0].epistemic,undefined)
})
test('low relevance decays into soft forgetting without deleting evidence',async t=>{
 const {store,put,receive,advance,view}=setup(t);await put();await receive();advance(100)
 assert.equal(view().retentionStage,'dormant');assert.equal(store.memoryCatalog().items.length,0)
 assert.equal(store.memoryCatalog({query:'疲惫',historical:true}).items.length,1)
 assert.equal(store.read().memories.length,1)
})
test('protected commitments never become forgetting candidates',async t=>{
 const {put,advance,view}=setup(t);await put('m',{type:'commitment'});advance(1000)
 assert.equal(view().retentionStage,'protected')
})
test('private source cannot heat public memory or expose relation metadata',async t=>{
 const {put,receive,view}=setup(t);await put('m',{visibility:'public',scope:{scenes:['public-comment']}});await receive();assert.equal(view().relation.count,0)
})
for(const mode of [{enabled:false,shadow:false},{enabled:true,shadow:true}])test('legacy disabled/shadow settings now accumulate relevance '+JSON.stringify(mode),async t=>{
 const {put,receive,view}=setup(t,mode);await put();await receive();assert.equal(view().relation.count,1)
})
test('suppressed and paused memory do not gain tags',async t=>{
 const {store,put,receive,view}=setup(t);await put('m',{recallEnabled:false});await receive();assert.equal(view().relation.count,0)
 await store.tx(s=>{s.memories[0].recallEnabled=true});await store.pause(true);await receive();assert.equal(view().relation.count,0)
})
test('model reflection and own output are not fresh evidence',async t=>{
 const {store,put,view}=setup(t);await put()
 await store.record('reflection',{text:'最近晚上经常疲惫',origin:'model'})
 await store.record('observed',{text:'最近晚上经常疲惫',origin:'model'})
 assert.equal(view().relation.count,0)
})
test('same video reread counts once despite different event ids',async t=>{
 const {store,put,view}=setup(t);await put()
 for(let i=0;i<2;i++)await store.record('video-read',{text:'最近晚上经常疲惫',target:'BV1234567890',origin:'tool'})
 assert.equal(view().relation.count,1)
})
test('derived event and original resolve to the same independent key',async t=>{
 const {store,put,receive,view}=setup(t);await put();const e=await receive()
 await store.tx(s=>{const derived={id:'derived',at:store.now(),kind:'observed',origin:'tool',text:e.text,originEvidenceIds:[e.id]};s.events.push(derived);assert.deepEqual(relationRoots(s,e),relationRoots(s,derived));addRelation(s,s.memories[0],derived,'related')})
 assert.equal(view().relation.count,1)
})
test('reviewed support refines lexical tag without recounting or raising independent evidence',async t=>{
 const {store,put,receive,view}=setup(t);await put();const e=await receive();const {commit}=await reviewRelation(store,e)
 await commit();assert.equal(view().relation.count,1);assert.equal(view().relation.counts.support,1);assert.equal(view().relation.counts.related,0)
 assert.equal(store.read().memories[0].independentEvidence,1)
})
test('reviewed contradiction suspends inferred claim and invalidates prepared context',async t=>{
 const {store,put,receive,view}=setup(t);await put('m',{type:'understanding',epistemic:'inferred'});const e=await receive('最近晚上不再疲惫了')
 const version=store.read().settings.permissionVersion??0
 const {commit}=await reviewRelation(store,e,'contradict');await commit()
 assert.equal(view().validity,'disputed');assert.equal(view().relation.counts.support,0)
 assert.ok(store.read().settings.permissionVersion>version);assert.equal(store.memoryCatalog({query:'晚上'}).items.length,0)
 assert.ok(!compileContext(store.read(),{query:'晚上',scene:'private-reply',dynamicMemory:{enabled:false,shadow:false},limit:5000}).segments.some(s=>s.kind==='recall'&&s.refs.some(r=>r.id==='m')))
})
test('inferred contradiction cannot revoke explicit owner commitment',async t=>{
 const {store,put,receive,view}=setup(t);await put('m',{type:'commitment',authority:'owner_explicit'});const e=await receive()
 const {commit}=await reviewRelation(store,e,'contradict');await commit()
 assert.equal(view().validity,'current');assert.equal(store.read().memories[0].relevance.reviewNeeded,true)
})
test('relation proposals reject fabricated quotes and stale target versions',async t=>{
 const {store,put,receive}=setup(t);await put();const e=await receive();const j=await store.planFormation({force:true})
 const r={key:'r',memoryId:'m',memoryVersion:1,eventId:e.id,relation:'support',quote:e.text}
 for(const extra of [{quote:'invented'},{memoryVersion:99},{eventId:'missing'}])await assert.rejects(store.submitFormation(j.jobId,j.token,{candidates:[],relations:[{...r,...extra}]}))
})
test('missing relation review or stale commit cannot alter tags',async t=>{
 const {store,put,receive,view}=setup(t);await put();const e=await receive();const {r,commit}=await reviewRelation(store,e)
 await assert.rejects(store.commitFormation(r.jobId,r.token,{decisions:[]}),/覆盖/)
 await store.tx(s=>{s.memories[0].version=2});await assert.rejects(commit(),/版本/)
 assert.equal(view().relation.count,0)
})
test('retrieval use cannot beat relevance count on equal current topics',async t=>{
 const {store,put,receive}=setup(t);await put('a');await receive();await put('b')
 const s=store.read(),ranked=rankMemories(s.memories,{query:'疲惫',scene:'private-reply',at:store.now(),cfg:dynamicConfig(),access:{b:{useMass:32,lastTaskUseAt:store.now(),evaluatedAt:store.now()}}})
 assert.equal(ranked[0].memory.id,'a')
})
test('malformed or duplicate origin ledger is rejected',()=>{
 const key='a'.repeat(64),tag={key,eventId:'e',at:0,relation:'related',method:'lexical'}
 assert.throws(()=>validateRelations({memories:[{relevance:{schema:1,version:1,tags:[tag,tag]}}]}))
 assert.throws(()=>validateRelations({memories:[{relevance:{schema:99,version:1,tags:[]}}]}))
})
test('review rejection preserves lexical related and cannot claim support',async t=>{
 const {store,put,receive,view}=setup(t);await put();const e=await receive();const {r}=await reviewRelation(store,e)
 await store.commitFormation(r.jobId,r.token,{decisions:[],relationDecisions:[{key:'r',action:'reject',reason:'只是话题相关'}]})
 assert.equal(view().relation.counts.related,1);assert.equal(view().relation.counts.support,0)
})
test('relation classification rolls back when candidate review fails in same transaction',async t=>{
 const {store,put,receive,view}=setup(t);await put();const e=await receive();const j=await store.planFormation({force:true})
 const candidate={key:'candidate',type:'episodic',text:'一个经历',sourceIds:[e.id],quotes:[{eventId:e.id,text:e.text}],scope:{scenes:['private-reply']},visibility:'private'}
 await store.submitFormation(j.jobId,j.token,{candidates:[candidate],relations:[{key:'r',memoryId:'m',memoryVersion:1,eventId:e.id,relation:'support',quote:e.text}]})
 const r=await store.claimReview()
 await assert.rejects(store.commitFormation(r.jobId,r.token,{decisions:[{key:'candidate',action:'invalid',reason:'无效动作'}],relationDecisions:[{key:'r',action:'accept',reason:'支持'}]}))
 assert.equal(view().relation.counts.support,0);assert.equal(store.learningStatus().cursor,0)
})
test('life configuration pause also disables relevance writes',async t=>{
 const {store,put}=setup(t);await put()
 const paused=createLifeStore({dshHome:path.resolve(store.dir,'../..'),account:'1',owner:'2',config:{paused:true,dynamicMemory:{enabled:true,shadow:false}},now:store.now})
 await paused.ingestOwnerMessage({actor:'2',messageId:'paused-config',text:'最近晚上经常疲惫'})
 assert.equal(paused.memoryExplain('m').view.relation.count,0)
})

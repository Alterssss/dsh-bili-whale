import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createLifeStore} from '../tools/lib/life-store.mjs'
import {createFormationWorker} from '../lib/formation-worker.js'
import {createHostTextComplete} from '../lib/host-text-complete.js'

function fixture(t,complete){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-direct-'));t.after(()=>fs.rmSync(home,{force:true,recursive:true}))
 let at=Date.parse('2026-10-29T12:00:00+08:00')
 const store=createLifeStore({dshHome:home,account:'1',owner:'2',now:()=>at})
 const worker=createFormationWorker({complete,store:()=>store,config:()=>({self:{mid:'1'},owner:{mid:'2'}}),now:()=>at})
 return {home,store,worker,advance:n=>at+=n,receive:()=>store.ingestOwnerMessage({actor:'2',messageId:String(at),text:'今天读了这本书'})}
}
test('verified host text stream completes extraction and independent review without any sessions or files',async t=>{
 const calls=[];let event
 const ctx={get:k=>k==='agentDefaultModel'?{currentSelection:()=>({provider:'test-provider',model:'test-model'})}:k==='llm'?{stream:async function*(r){
  calls.push(r);const review=r.messages[0].content[0].text.includes('独立审核候选')
  const output=review?{decisions:[{key:'c',action:'accept',reason:'明确描述本次经历',grounded:true,scopeClear:true,overgeneralized:false}]}:{candidates:[{key:'c',subject:'owner',type:'episodic',text:'主人今天说读了这本书',sourceIds:[event.id],quotes:[{eventId:event.id,text:event.text}],visibility:'private',scope:{scenes:['private-reply']}}]}
  yield {type:'reasoning-delta',text:'not part of JSON'};yield {type:'text-delta',text:JSON.stringify(output)};yield {type:'finish',reason:{kind:'stop'}}
 }}:null}
 const x=fixture(t,createHostTextComplete(ctx,{maxInputBytes:65536,maxBytes:32768,codePrefix:'FORMATION'}));event=await x.receive()
 assert.equal((await x.worker.tick()).status,'review_pending');assert.equal((await x.worker.tick({allowNew:false})).status,'committed')
 assert.equal(calls.length,2);assert.equal(x.store.read().memories.length,1);assert.ok(x.store.learningStatus().cursor>0)
 assert.ok(calls.every(c=>!c.tools&&!JSON.stringify(c.messages).includes('job.token')))
 assert.equal(fs.existsSync(path.join(x.home,'whale-work')),false)
})
test('review failure releases lease immediately, retries the same job and never reruns extraction',async t=>{
 let reviews=0,extracts=0
 const x=fixture(t,async({prompt})=>{if(prompt.includes('独立审核候选')){if(++reviews===1)throw Error('host offline');return '{"decisions":[]}'}extracts++;return '{"candidates":[]}'})
 await x.receive();await x.worker.tick();const id=x.store.learningStatus().jobs[0].id
 assert.equal((await x.worker.tick({allowNew:false})).status,'failed')
 let j=x.store.learningStatus().jobs[0];assert.equal(j.stage,'retry_pending');assert.equal(j.lastDiagnostic.stage,'review');assert.ok(j.lastDiagnostic.reason)
 assert.equal((await x.worker.tick({allowNew:false})).status,'idle');x.advance(61000)
 assert.equal((await x.worker.tick({allowNew:false})).status,'committed');assert.equal(x.store.learningStatus().jobs[0].id,id);assert.equal(extracts,1);assert.equal(reviews,2);assert.equal(x.store.learningStatus().jobs[0].reason,undefined);assert.equal(x.store.learningStatus().jobs[0].lastDiagnostic,undefined);assert.equal(x.store.learningStatus().jobs[0].result.empty,true)
})
test('bounded failures stop after three attempts and old review tokens are rejected',async t=>{
 const x=fixture(t,async({prompt})=>{if(prompt.includes('独立审核候选'))throw Error('network unavailable');return '{"candidates":[]}'})
 await x.receive();await x.worker.tick();const old=await x.store.claimReview()
 await x.store.failFormationAttempt(old.jobId,old.token,'review',{code:'FORMATION_LLM_TIMEOUT'})
 await assert.rejects(x.store.commitFormation(old.jobId,old.token,{decisions:[]}),/无效/)
 for(let i=0;i<2;i++){x.advance(121000);assert.equal((await x.worker.tick({allowNew:false})).status,'failed')}
 assert.equal(x.store.learningStatus().jobs[0].stage,'failed');assert.equal(x.store.learningStatus().jobs[0].failures.review,3);assert.equal(x.store.learningStatus().cursor,0)
 assert.equal((await x.worker.tick({allowNew:false})).status,'idle')
})
test('crash lease expiry keeps a stage-specific reason and bounded retry, cursor unchanged',async t=>{
 const x=fixture(t,async()=>'{"candidates":[]}');await x.receive();const old=await x.store.planFormation({force:true})
 x.advance(601000);await x.store.maintainCognition();const status=x.store.learningStatus()
 assert.equal(status.jobs[0].stage,'retry_pending');assert.equal(status.history.at(-1).code,'FORMATION_LEASE_EXPIRED');assert.equal(status.history.at(-1).stage,'extract');assert.equal(status.cursor,0)
 await assert.rejects(x.store.submitFormation(old.jobId,old.token,{candidates:[]}),/无效/)
 x.advance(61000);assert.equal((await x.worker.tick({allowNew:false})).status,'review_pending')
})
test('formation adapter rejects abnormal finish, oversized input and cancellation',async()=>{
 let calls=0
 const ctx={get:k=>k==='llm'?{stream:async function*(){calls++;yield {type:'text-delta',text:'{}'};yield {type:'finish',reason:{kind:'length'}}}}:{currentSelection:()=>({provider:'p',model:'m'})}}
 const complete=createHostTextComplete(ctx,{maxInputBytes:20,codePrefix:'FORMATION'})
 await assert.rejects(complete({prompt:'short'}),e=>e.code==='FORMATION_FINISH_INVALID'&&e.details.kind==='length'&&e.details.outputBytes===2)
 await assert.rejects(complete({prompt:'猫'.repeat(10)}),e=>e.code==='FORMATION_INPUT_SIZE')
 const stop=new AbortController();stop.abort(Error('cancelled'));await assert.rejects(complete({prompt:'short',signal:stop.signal}),/cancelled/);assert.equal(calls,1)
})

test('finish diagnostics persist on the job without consuming experiences',async t=>{
 const ctx={get:k=>k==='llm'?{stream:async function*(){yield {type:'text-delta',text:'{"candidates":[]}'};yield {type:'finish',reason:{kind:'length'}}}}:{currentSelection:()=>({provider:'p',model:'m'})}}
 const x=fixture(t,createHostTextComplete(ctx,{codePrefix:'FORMATION'}));await x.receive()
 const result=await x.worker.tick();assert.equal(result.status,'failed');assert.equal(x.store.learningStatus().cursor,0)
 const diagnostic=x.store.learningStatus().jobs[0].lastDiagnostic;assert.equal(diagnostic.details.kind,'length');assert.deepEqual(diagnostic.details.reasonKeys,['kind'])
})

test('invalid candidates are isolated at extraction and review; valid memory still commits',async t=>{
 let e
 const x=fixture(t,async({prompt})=>{
  if(prompt.includes('独立审核候选'))return JSON.stringify({decisions:['good','weak-self'].map(key=>({key,action:'accept',reason:'独立检查本次来源',grounded:true,scopeClear:true,overgeneralized:false,selfBehaviorOnly:true,claimsExternal:false}))})
  const base={sourceIds:[e.id],quotes:[{eventId:e.id,text:e.text}],visibility:'private',scope:{scenes:['private-reply']}}
  return JSON.stringify({candidates:[{key:'bad-type',type:'invented'},{...base,key:'good',type:'episodic',subject:'owner',text:'主人今天读了书'},{...base,key:'weak-self',type:'understanding',subject:'self',text:'我通常会聊读书',appliesTo:'谈书时',doThis:'继续交流',falsifiedBy:'以后不同则收窄',alternatives:['可能是偶然']}]})
 })
 e=await x.receive();assert.equal((await x.worker.tick()).status,'review_pending')
 const done=await x.worker.tick({allowNew:false});assert.equal(done.status,'committed');assert.equal(done.result.created.length,2);assert.equal(done.result.rejected.length,1)
 assert.ok(x.store.learningStatus().cursor>0)
})

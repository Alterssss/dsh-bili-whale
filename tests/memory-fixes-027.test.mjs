import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createLifeStore} from '../tools/lib/life-store.mjs'
import {createFormationWorker} from '../lib/formation-worker.js'
import {createHostTextComplete} from '../lib/host-text-complete.js'
import {startScheduler} from '../lib/scheduler.js'
function setup(t){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-027-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
 let at=Date.parse('2026-11-04T12:00:00+08:00'),n=0
 const open=()=>createLifeStore({dshHome:home,account:'1',owner:'2',now:()=>at,config:{learningDailyJobs:100}})
 return {store:open(),open,advance:ms=>at+=ms,record:async(store,text)=>store.record('video-read',{origin:'video',target:'BV'+(++n),text})}
}
async function commitEmpty(s,j){await s.submitFormation(j.jobId,j.token,{candidates:[]});const rev=await s.claimReview();return s.commitFormation(rev.jobId,rev.token,{decisions:[]})}
const limited={code:'FORMATION_FINISH_INVALID',details:{kind:'max-tokens',outputBytes:0}}
test('background timer starts extraction without a wake and respects the next-batch interval',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-timer-027-'))
 const oldEnv=process.env.BILI_WHALE_CONFIG,original=globalThis.setInterval,timers=[]
 process.env.BILI_WHALE_CONFIG=path.join(home,'config.json')
 fs.writeFileSync(process.env.BILI_WHALE_CONFIG,JSON.stringify({self:{mid:'1'},owner:{mid:'2'},listen:{dm:false,comment:false},life:{learningIntervalSec:300}}))
 globalThis.setInterval=(fn,ms)=>{timers.push({fn,ms});return {unref(){}}}
 let scheduler,calls=0
 t.after(()=>{scheduler?.stop();globalThis.setInterval=original;if(oldEnv===undefined)delete process.env.BILI_WHALE_CONFIG;else process.env.BILI_WHALE_CONFIG=oldEnv;fs.rmSync(home,{recursive:true,force:true})})
 const s=createLifeStore({dshHome:home,account:'1',owner:'2'})
 await s.record('video-read',{origin:'video',target:'BVtimer',text:'定时归纳材料'})
 scheduler=startScheduler({}, {dshHome:home,cwd:home,formationComplete:async({stage})=>{calls++;return stage==='extract'?'{"candidates":[]}':'{"decisions":[]}'}})
 const timer=timers.find(x=>x.ms===60000);assert.ok(timer)
 async function tick(){timer.fn();for(let i=0;i<200&&scheduler.formationStatus().status==='running';i++)await new Promise(r=>setTimeout(r,5))}
 await tick();assert.equal(scheduler.formationStatus().status,'review_pending');assert.equal(calls,1)
 await tick();assert.equal(scheduler.formationStatus().status,'committed');assert.equal(calls,2)
 await s.record('video-read',{origin:'video',target:'BVnext',text:'下一批材料'})
 await tick();assert.equal(calls,2);assert.equal(s.learningStatus().unprocessed,1)
})
test('oldest and newest evidence both progress; continuous arrivals do not starve backlog',async t=>{
 const x=setup(t),initial=[]
 for(let i=0;i<36;i++)initial.push(await x.record(x.store,'视频内容 '+i))
 const processed=new Set()
 for(let batch=0;batch<8&&initial.some(e=>!processed.has(e.id));batch++){
  const latest=await x.record(x.store,'最新视频 '+batch)
  const j=await x.store.planFormation({force:true})
  const oldest=initial.find(e=>!processed.has(e.id));assert.ok(j.input.events.some(e=>e.id===oldest.id));assert.ok(j.input.events.some(e=>e.id===latest.id))
  const fresh=j.input.events.filter(e=>e.seq>x.store.read().cognition.cursor&&!x.store.read().cognition.consumed?.includes(e.seq))
  for(const e of fresh){assert.ok(!processed.has(e.id));processed.add(e.id)}
  await commitEmpty(x.store,j)
 }
 assert.ok(initial.every(e=>processed.has(e.id)));assert.equal(x.store.learningStatus().unprocessed,0)
})
test('token exhaustion reduces retry input, preserves cursor, and leaves omitted evidence for later jobs',async t=>{
 const x=setup(t),events=[];for(let i=0;i<12;i++)events.push(await x.record(x.store,'材料 '+i))
 const j=await x.store.planFormation({force:true});assert.equal(j.input.events.length,12)
 await x.store.failFormationAttempt(j.jobId,j.token,'extract',limited);assert.equal(x.store.learningStatus().cursor,0)
 x.advance(61000);const retry=await x.store.claimFormationRetry();assert.equal(retry.input.events.length,6)
 await commitEmpty(x.store,retry);assert.equal(x.store.learningStatus().unprocessed,6)
 const next=await x.store.planFormation({force:true});await commitEmpty(x.store,next)
 assert.equal(x.open().learningStatus().unprocessed,0);assert.equal(x.open().learningStatus().cursor,events.at(-1).seq)
})
test('network failure retries unchanged input and does not reduce batch limit',async t=>{
 const x=setup(t);for(let i=0;i<8;i++)await x.record(x.store,'网络材料 '+i)
 const j=await x.store.planFormation({force:true});await x.store.failFormationAttempt(j.jobId,j.token,'extract',{code:'FORMATION_LLM_TIMEOUT'})
 x.advance(61000);const retry=await x.store.claimFormationRetry();assert.deepEqual(retry.input.events.map(e=>e.id),j.input.events.map(e=>e.id));assert.equal(x.store.read().cognition.extractBatchLimit,undefined)
})
test('legacy terminal token failure starts a smaller new job without consuming history',async t=>{
 const x=setup(t);for(let i=0;i<30;i++)await x.record(x.store,'历史视频 '+i)
 await x.store.tx(s=>s.cognition.jobs.push({id:'legacy',stage:'failed',at:x.store.now(),inputs:Array.from({length:21},(_,i)=>({id:'legacy-'+i})),lastDiagnostic:{...limited,stage:'extract'}}))
 const j=await x.store.planFormation({force:true});assert.equal(j.input.events.length,10);assert.equal(x.store.learningStatus().unprocessed,30)
})
test('review token failure increases output allowance but keeps all candidates and evidence',async t=>{
 const x=setup(t);await x.record(x.store,'本次材料');let reviews=0;const inputs=[]
 const w=createFormationWorker({store:()=>x.store,config:()=>({self:{mid:'1'},owner:{mid:'2'}}),complete:async({stage,job,maxTokens})=>{
  if(stage==='extract')return '{"candidates":[]}'
  inputs.push({input:job.input,maxTokens});if(++reviews===1)throw Object.assign(Error('limit'),limited)
  return '{"decisions":[]}'
 }})
 await w.tick();assert.equal((await w.tick({allowNew:false})).status,'failed');x.advance(61000)
 assert.equal((await w.tick({allowNew:false})).status,'committed');assert.deepEqual(inputs[0].input,inputs[1].input)
 assert.equal(inputs[0].maxTokens,10000);assert.equal(inputs[1].maxTokens,20000)
})
test('finish diagnostics count reasoning without storing reasoning text',async()=>{
 const ctx={get:k=>k==='llm'?{stream:async function*(){yield {type:'reasoning-delta',text:'hidden reasoning'};yield {type:'finish',reason:{kind:'max-tokens'}}}}:{currentSelection:()=>({provider:'p',model:'m'})}}
 const call=createHostTextComplete(ctx,{codePrefix:'FORMATION'})
 await assert.rejects(call({prompt:'source',maxTokens:10000}),e=>e.details.maxTokens===10000&&e.details.reasoningBytes===16&&e.details.inputBytes===6&&e.details.outputBytes===0&&!JSON.stringify(e.details).includes('hidden'))
})

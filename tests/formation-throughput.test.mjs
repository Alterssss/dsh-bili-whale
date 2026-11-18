import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createLifeStore} from '../tools/lib/life-store.mjs'

function setup(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'whale-throughput-'))
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
  let now=Date.now()
  const open=()=>createLifeStore({dshHome:directory,account:'1',owner:'2',now:()=>now,config:{learningDailyJobs:100}})
  const store=open()
  return {store,open,advance:()=>{now+=61000},record:text=>store.record('video-read',{origin:'video',text})}
}
async function commitEmpty(store, job) {
  await store.submitFormation(job.jobId,job.token,{candidates:[]})
  const review=await store.claimReview()
  return store.commitFormation(review.jobId,review.token,{decisions:[]})
}
const large='中'.repeat(2000)

test('a non-fitting fresh event does not block smaller events or get consumed prematurely',async t=>{
  const {store,record}=setup(t)
  const events=[]
  for(let index=0;index<10;index++)events.push(await record([0,1,8,9].includes(index)?large:'小材料'))
  const job=await store.planFormation({force:true})
  const selected=new Set(job.input.events.map(event=>event.id))
  assert.equal(selected.has(events[8].id),false)
  for(const event of events.slice(2,8))assert.ok(selected.has(event.id))
  assert.ok(job.input.events.reduce((sum,event)=>sum+Buffer.byteLength(JSON.stringify(event)),0)<=24576)
  await commitEmpty(store,job)
  assert.equal(store.learningStatus().unprocessed,1)
  assert.equal(store.learningStatus().cursor,events[7].seq)
  const next=await store.planFormation({force:true})
  assert.ok(next.input.events.some(event=>event.id===events[8].id))
  await commitEmpty(store,next)
  assert.equal(store.learningStatus().unprocessed,0)
  assert.equal(store.learningStatus().cursor,events[9].seq)
})

test('reinforcement skips a non-fitting old event and still considers the remaining three',async t=>{
  const {store,record}=setup(t)
  const old=[]
  for(const text of [large,'旧二','旧三','旧四'])old.push(await record(text))
  await commitEmpty(store,await store.planFormation({force:true}))
  for(const text of [large,large,large,'新材料'])await record(text)
  const job=await store.planFormation({force:true})
  const prior=job.input.events.filter(event=>event.seq<=old[3].seq)
  assert.deepEqual(prior.map(event=>event.id),old.slice(1).map(event=>event.id))
  assert.ok(prior.length<=4)
  assert.ok(job.input.events.reduce((sum,event)=>sum+Buffer.byteLength(JSON.stringify(event)),0)<=24576)
})

test('oversized evidence stays pending and an all-oversized batch still fails explicitly',async t=>{
  const {store,record}=setup(t)
  const oversized=await store.record('video-read',{origin:'video',text:'大元数据',target:'x'.repeat(30000)})
  // Simulate imported legacy metadata beyond the normal record() field limit.
  await store.tx(state=>{state.events.find(event=>event.id===oversized.id).target='x'.repeat(30000)})
  const small=await record('可处理')
  const job=await store.planFormation({force:true})
  assert.deepEqual(job.input.events.map(event=>event.id),[small.id])
  await commitEmpty(store,job)
  assert.equal(store.learningStatus().cursor,0)
  assert.equal(store.learningStatus().unprocessed,1)
  await assert.rejects(store.planFormation({force:true}),/单事件超过归纳预算/)
  assert.ok(store.read().events.some(event=>event.id===oversized.id))
})

test('persisted one-item limits recover gradually after successful fresh batches and survive reopen',async t=>{
  const {store,open,record}=setup(t)
  for(let index=0;index<100;index++)await record('材料 '+index)
  await store.tx(state=>{state.cognition.extractBatchLimit=1})
  for(let limit=1;limit<12;limit++){
    const current=open()
    const before=current.read().cognition
    const job=await current.planFormation({force:true})
    const fresh=job.input.events.filter(event=>event.seq>before.cursor&&!(before.consumed??[]).includes(event.seq))
    assert.equal(fresh.length,limit)
    // Compatibility with jobs created before freshLimit was recorded.
    if(limit===1)await current.tx(state=>{delete state.cognition.jobs.find(row=>row.id===job.jobId).freshLimit})
    await commitEmpty(current,job)
    assert.equal(open().read().cognition.extractBatchLimit,limit+1)
  }
  await commitEmpty(store,await store.planFormation({force:true}))
  assert.equal(store.read().cognition.extractBatchLimit,12)
})

test('reinforcement alone cannot justify increasing a reduced batch limit',async t=>{
  const {store,record}=setup(t)
  for(let index=0;index<4;index++)await record('旧材料')
  await commitEmpty(store,await store.planFormation({force:true}))
  await store.tx(state=>{state.cognition.extractBatchLimit=3})
  await record('唯一新材料')
  const job=await store.planFormation({force:true})
  assert.equal(job.input.events.length,5)
  await commitEmpty(store,job)
  assert.equal(store.read().cognition.extractBatchLimit,3)
})

test('a token failure still reduces the recovered limit and does not consume excluded events',async t=>{
  const {store,record,advance}=setup(t)
  for(let index=0;index<15;index++)await record('材料 '+index)
  await store.tx(state=>{state.cognition.extractBatchLimit=4})
  const job=await store.planFormation({force:true})
  await store.failFormationAttempt(job.jobId,job.token,'extract',{
    code:'FORMATION_FINISH_INVALID',details:{kind:'max-tokens',outputBytes:0},
  })
  assert.equal(store.read().cognition.extractBatchLimit,2)
  assert.equal(store.learningStatus().unprocessed,15)
  advance()
  const retry=await store.claimFormationRetry()
  assert.equal(retry.input.events.length,2)
  await commitEmpty(store,retry)
  assert.equal(store.learningStatus().unprocessed,13)
  assert.equal(store.read().cognition.extractBatchLimit,3)
})

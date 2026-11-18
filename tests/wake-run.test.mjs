import test from 'node:test'
import assert from 'node:assert/strict'
import {createWakeRunner} from '../lib/wake-run.js'
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)}}
const flush=()=>new Promise(r=>setImmediate(r))

test('local timeout releases a noncooperative body and an old continuation cannot release its successor',async()=>{
  const runner=createWakeRunner({timeoutMs:20}),a=deferred(),b=deferred();let old,newer
  const first=assert.rejects(runner.run(async lease=>{old=lease;await a.promise;lease.check();assert.fail('old effect reached')}),e=>e.code==='WAKE_FORCED_RELEASE')
  await first;assert.equal(runner.current,null)
  const next=runner.run(async lease=>{newer=lease;await b.promise;lease.check()})
  await flush();a.resolve();await flush()
  assert.equal(runner.current,newer);assert.notEqual(old.id,newer.id);assert.equal(old.valid,false)
  b.resolve();await next;assert.equal(runner.current,null)
})

test('initialization failure cannot leak ownership',async()=>{
  const real=globalThis.AbortController,runner=createWakeRunner()
  try{
    globalThis.AbortController=class{constructor(){throw Error('host initialization failed')}}
    await assert.rejects(runner.run(()=>assert.fail('not reached')),/initialization failed/)
    assert.equal(runner.current,null)
  }finally{globalThis.AbortController=real}
  assert.equal(await runner.run(()=>42),42)
})

test('finally write failures and diagnostic failures still release ownership',async()=>{
  const runner=createWakeRunner({onChange:()=>{throw Error('diagnostic write failed')}})
  await assert.rejects(runner.run(async()=>{try{return 1}finally{throw Error('plan write failed')}}),/plan write failed/)
  assert.equal(runner.current,null);assert.equal(await runner.run(()=>2),2)
})

test('timestamp watchdog invalidates immediately even if the body and observer ignore cancellation',async()=>{
  let now=0;const runner=createWakeRunner({now:()=>now,timeoutMs:1000,onForced:()=>{throw Error('observer failed')}})
  const first=assert.rejects(runner.run(()=>new Promise(()=>{})),e=>e.code==='WAKE_FORCED_RELEASE')
  await flush();now=1001;runner.expire();assert.equal(runner.current,null)
  await first;assert.equal(await runner.run(()=>3),3)
})

test('parent stop cancels local wait without requiring body cooperation',async()=>{
  const stop=new AbortController(),runner=createWakeRunner({signal:stop.signal})
  const first=assert.rejects(runner.run(()=>new Promise(()=>{})),e=>e.code==='WAKE_STOPPED')
  await flush();stop.abort();await first;assert.equal(runner.current,null)
})

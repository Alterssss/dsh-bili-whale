import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createSessionDelivery} from '../lib/session-delivery.js'
import {readDeliveries, deliveryStatus} from '../lib/delivery-state.js'

function fixture(t,controller) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-recovery-'))
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const opts={dshHome:dir,cwd:dir,sessionId:'whale',config:()=>({}),persona:()=>'',timeoutMs:25,controller}
  return {dir,opts,make:()=>createSessionDelivery(opts)}
}
const request=id=>({requestId:id,content:[{type:'text',text:'task'}]})
const flush=()=>new Promise(r=>setImmediate(r))

test('never-settling prompt frees queue; same request stays blocked across restart; late success is recorded',async t=>{
  let release;const sent=[]
  const f=fixture(t,{create:async()=>{},prompt:r=>{sent.push(r.requestId);return sent.length===1?new Promise(r=>release=r):Promise.resolve()}})
  const d=f.make(),id='bili-whale-wake:first'
  const first=assert.rejects(d.send(request(id)),e=>e.code==='DELIVERY_UNCONFIRMED')
  const second=d.send(request('different-channel'))
  await Promise.all([first,second]);assert.deepEqual(sent,[id,'different-channel'])
  await assert.rejects(d.send(request(id)),e=>e.code==='DELIVERY_UNCONFIRMED')
  await assert.rejects(f.make().send(request(id)),e=>e.code==='DELIVERY_UNCONFIRMED')
  assert.equal(deliveryStatus(f.dir).lastWake.status,'unconfirmed')
  release();await flush();await flush()
  assert.equal(readDeliveries(f.dir).find(r=>r.requestId===id).status,'accepted')
  await f.make().send(request(id));assert.equal(sent.length,2)
})

test('timed-out create never goes on to prompt after late resolution and does not block other work',async t=>{
  let release,creates=0;const sent=[]
  const f=fixture(t,{create:()=>++creates===1?new Promise(r=>release=r):Promise.resolve(),prompt:async r=>sent.push(r.requestId)})
  const d=f.make()
  await assert.rejects(d.send(request('first')),e=>e.code==='DELIVERY_TIMEOUT')
  await d.send(request('second'));release();await flush()
  assert.deepEqual(sent,['second'])
  await d.send(request('first'));assert.deepEqual(sent,['second','first'])
})

test('abort settles ignored host promise promptly and retains durable uncertainty',async t=>{
  let started;const ready=new Promise(r=>started=r)
  const f=fixture(t,{create:async()=>{},prompt:()=>{started();return new Promise(()=>{})}})
  f.opts.timeoutMs=60_000
  const abort=new AbortController(),d=f.make()
  const pending=assert.rejects(d.send(request('abort'),abort.signal),e=>e.code==='DELIVERY_UNCONFIRMED')
  await ready;abort.abort();await pending
  await assert.rejects(f.make().send(request('abort')),e=>e.code==='DELIVERY_UNCONFIRMED')
})

test('accepted DM retries only its acknowledgement across restart',async t=>{
  let prompts=0
  const f=fixture(t,{create:async()=>{},prompt:async()=>{prompts++}})
  const id='bili-whale-dm-receipt'
  await f.make().send(request(id),undefined,{retainUntilAck:true})
  const restarted=f.make();await restarted.send(request(id),undefined,{retainUntilAck:true})
  assert.equal(prompts,1);assert.equal(readDeliveries(f.dir)[0].retained,true)
  await restarted.confirm(id);assert.equal(readDeliveries(f.dir)[0].retained,false)
})

test('late rejection is observed without poisoning following requests',async t=>{
  let reject,calls=0
  const f=fixture(t,{create:async()=>{},prompt:()=>++calls===1?new Promise((_,r)=>reject=r):Promise.resolve()})
  const d=f.make();await assert.rejects(d.send(request('late-fail')),e=>e.code==='DELIVERY_UNCONFIRMED')
  reject(Error('host rejected'));await flush();await flush()
  assert.equal(readDeliveries(f.dir)[0].status,'failed')
  await d.send(request('late-fail'));assert.equal(calls,2)
})

test('corrupt delivery journal fails closed before host dispatch',t=>{
  const f=fixture(t,{create:async()=>assert.fail('not reached'),prompt:async()=>assert.fail('not reached')})
  fs.writeFileSync(path.join(f.dir,'whale-delivery.json'),'broken')
  assert.throws(f.make,/投递账本无法读取/)
})

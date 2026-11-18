import {preserveRetryTimers} from './retry-timers.mjs'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {setTimeout as wait} from 'node:timers/promises'
const RealDate=Date
let now=new RealDate('2026-10-28T05:10:00').getTime()
globalThis.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[now]))}static now(){return now}}
globalThis.setInterval=globalThis.setTimeout=()=>({})
globalThis.clearInterval=globalThis.clearTimeout=()=>{}
preserveRetryTimers()
const {startScheduler}=await import('../../lib/scheduler.js')
const {makePlan}=await import('../../tools/lib/night-plan.mjs')
const {readDeliveries}=await import('../../lib/delivery-state.js')
const {lifeStore}=await import('../../tools/lib/life-runtime.mjs')
const home=process.env.HOME,dsh=process.env.DSH_HOME,file=path.join(dsh,'whale-night.json')
const cfg={self:{mid:'111'},owner:{mid:'222'},night:{windows:[{start:'00:00',end:'08:00',wakes:4}],skipChance:0,minGapMin:10},listen:{dm:true,comment:true,allDay:true,live:false},diary:{push:false}}
fs.writeFileSync(process.env.BILI_WHALE_CONFIG,JSON.stringify(cfg))
process.env.TEST_DM_FILE=path.join(home,'recovery-dm.json')
fs.writeFileSync(process.env.TEST_DM_FILE,JSON.stringify({timestamp:Math.floor(now/1000),msg_key:'recovery-dm',sender_uid:222,content:JSON.stringify({content:'hello'})}))
process.env.TEST_FEEDS=path.join(home,'recovery-feeds.json')
fs.writeFileSync(process.env.TEST_FEEDS,JSON.stringify({reply:[],at:[]}))
const first=makePlan(cfg.night,{},now,()=>0)
fs.writeFileSync(file,JSON.stringify(first))
let late;const sent=[];const formationRequests=[];const logs=[]
const scheduler=startScheduler({sessionController:{create:async()=>{},prompt:r=>{
  if(r.requestId.startsWith('whale-formation:')){formationRequests.push(r.requestId);return Promise.resolve({accepted:true})}
  sent.push(r.requestId)
  return sent.length===1?new Promise(resolve=>late=resolve):Promise.resolve()
}}},{dshHome:dsh,cwd:home,biliMjs:fileURLToPath(new URL('../../tools/bili.mjs',import.meta.url)),deliveryTimeoutMs:25,log:m=>logs.push(m)})
try{
  await scheduler.tick()
  const after=JSON.parse(fs.readFileSync(file));assert.equal(after.deliveryStatus,'unconfirmed');assert.equal(after.woke,false);assert.equal(after.usedCount[first.windowKey],1)
  await scheduler.tick();assert.equal(sent.length,1,'same wake must not be repeated')
  await scheduler.dmTick();assert.equal(sent.length,2,'DM must pass a stuck wake in the shared queue')
  await scheduler.listenTick() // Initial inbox baseline.
  now+=11*60000
  fs.writeFileSync(process.env.TEST_FEEDS,JSON.stringify({reply:[],at:[{id:'new-comment',at_time:Math.floor(now/1000),user:{mid:222,nickname:'Owner'},item:{source_content:'hello'}}]}))
  await scheduler.listenTick();assert.equal(sent.length,3,'comment listening must continue')
  const next=makePlan(cfg.night,JSON.parse(fs.readFileSync(file)),now,()=>0)
  fs.writeFileSync(file,JSON.stringify(next));await scheduler.tick()
  assert.equal(sent.length,4,'later wake must continue without restarting')
  const beforeLate=JSON.parse(fs.readFileSync(file))
  late();await wait(80)
  assert.equal(formationRequests.length,0,'formation never dispatches through a session')
  assert.equal(scheduler.formationStatus().status,'unavailable')
  assert.deepEqual(JSON.parse(fs.readFileSync(file)),beforeLate,'late result must not overwrite later plan')
  assert.equal(readDeliveries(dsh).find(r=>r.requestId===sent[0]).status,'accepted')
  assert.ok(lifeStore(cfg,{dshHome:dsh}).read().events.some(e=>e.kind==='wake-delivery-unconfirmed'))
  assert.ok(logs.some(s=>s.includes('已释放等待')))
}finally{late?.();scheduler.stop();await wait(60)}

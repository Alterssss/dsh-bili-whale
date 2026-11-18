import {preserveRetryTimers} from './retry-timers.mjs'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {setTimeout as wait} from 'node:timers/promises'
const RealDate=Date, RealController=AbortController, rename=fs.renameSync
let now=new RealDate('2026-10-28T12:00:00').getTime()
globalThis.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[now]))}static now(){return now}}
const intervals=new Map()
globalThis.setInterval=(f,ms)=>{intervals.set(ms,f);return {}}
globalThis.setTimeout=()=>({})
globalThis.clearInterval=globalThis.clearTimeout=()=>{}
preserveRetryTimers()
AbortSignal.any=undefined
AbortSignal.prototype.throwIfAborted=undefined
const {startScheduler}=await import('../../lib/scheduler.js')
const {makePlan}=await import('../../tools/lib/night-plan.mjs')
const {readSchedulerHealth}=await import('../../lib/scheduler-health.js')
const {requestNightTrigger}=await import('../../lib/night-trigger.js')
const home=process.env.HOME,dsh=process.env.DSH_HOME,file=path.join(dsh,'whale-night.json')
const cfg={self:{mid:'111'},owner:{mid:'222'},night:{windows:[{start:'00:00',end:'24:00',wakes:4}],skipChance:0,minGapMin:10},listen:{dm:false,comment:false,live:false},diary:{push:false}}
fs.writeFileSync(process.env.BILI_WHALE_CONFIG,JSON.stringify(cfg))
fs.writeFileSync(file,JSON.stringify(makePlan(cfg.night,{},now,()=>0)))
const scenario=process.argv[2];let calls=0,release
const scheduler=startScheduler({sessionController:{create:async()=>{},prompt:()=>{calls++;return scenario==='write'||scenario==='timeout'?new Promise(r=>release=r):Promise.resolve()}}},{dshHome:dsh,cwd:home,wakeTimeoutMs:scenario==='timeout'?300:300000,deliveryTimeoutMs:2000})
try{
 if(scenario==='setup'){globalThis.AbortController=class{constructor(){throw Error('setup-failed')}};await scheduler.tick();assert.equal(readSchedulerHealth(dsh).activeRun,null);assert.match(readSchedulerHealth(dsh).lastError.message,/setup-failed/);globalThis.AbortController=RealController}
 if(scenario==='manual'){
  fs.writeFileSync(file,JSON.stringify(makePlan(cfg.night,{},now,()=>0.5)))
  await scheduler.tick()
  await requestNightTrigger(dsh,{getSnapshot:()=>({night:cfg.night,state:JSON.parse(fs.readFileSync(file))})})
  intervals.get(5000)();await wait(100)
  assert.equal(JSON.parse(fs.readFileSync(file)).atMs,now+5000)
  now+=6000;intervals.get(5000)();for(let i=0;i<100&&(!JSON.parse(fs.readFileSync(file)).fired||readSchedulerHealth(dsh).activeRun);i++)await wait(20)
 }else if(scenario==='write'){
  const pending=scheduler.tick();for(let i=0;i<100&&!calls;i++)await wait(10)
  assert.equal(calls,1);scheduler.invalidate(true)
  fs.renameSync=(a,b)=>{if(b===file)throw Error('plan-write-failed');return rename(a,b)}
  release();await pending;assert.equal(readSchedulerHealth(dsh).activeRun,null);assert.equal(JSON.parse(fs.readFileSync(file)).fired,false)
  fs.renameSync=rename;await scheduler.tick();assert.equal(calls,1,'accepted delivery must not be repeated after write error')
 }else if(scenario==='timeout'){
  await scheduler.tick();assert.equal(readSchedulerHealth(dsh).activeRun,null);assert.equal(readSchedulerHealth(dsh).lastReleased.code,'WAKE_FORCED_RELEASE');assert.equal(JSON.parse(fs.readFileSync(file)).deliveryStatus,'unconfirmed')
  const before=fs.readFileSync(file,'utf8');release();await wait(100);assert.equal(fs.readFileSync(file,'utf8'),before)
 }else await scheduler.tick()
 assert.equal(calls,1)
 assert.equal(readSchedulerHealth(dsh).activeRun,null)
 assert.equal(readSchedulerHealth(dsh).runtime.abortSignalAny,false)
 assert.ok(fs.existsSync(path.join(dsh,'whale-delivery.json')))
 assert.equal(JSON.parse(fs.readFileSync(file)).fired,true)
}finally{globalThis.AbortController=RealController;fs.renameSync=rename;release?.();scheduler.stop();await wait(80)}

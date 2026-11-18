import {preserveRetryTimers} from './retry-timers.mjs'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
const RealDate=Date
let now=new RealDate('2026-10-25T20:00:00+08:00').getTime()
globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]))}static now(){return now}}
globalThis.setInterval=globalThis.setTimeout=()=>({})
globalThis.clearInterval=globalThis.clearTimeout=()=>{}
preserveRetryTimers()
const {startScheduler}=await import('../../lib/scheduler.js')
const {makePlan}=await import('../../tools/lib/night-plan.mjs')
const {lifeStore}=await import('../../tools/lib/life-runtime.mjs')
const cfg={owner:{mid:'222',name:'Owner'},self:{mid:'111'},life:{autonomy:true,autonomyDelayMinutes:10},share:{via:'comment'},night:{windows:[{start:'00:00',end:'24:00',wakes:1}],skipChance:0},listen:{comment:false,dm:false,live:false},diary:{push:false}}
fs.writeFileSync(process.env.BILI_WHALE_CONFIG,JSON.stringify(cfg))
const state=path.join(process.env.DSH_HOME,'whale-night.json')
fs.writeFileSync(state,JSON.stringify(makePlan(cfg.night,{},now,()=>0)))
const messages=[],logs=[]
const scheduler=startScheduler({sessionController:{create:async()=>{},prompt:async p=>messages.push(p.content[0].text)}},{dshHome:process.env.DSH_HOME,cwd:process.env.HOME,biliMjs:'unused',log:m=>logs.push(m)})
try{
 await scheduler.tick()
 assert.equal(messages.length,1,logs.join('\n'));assert.match(messages[0],/【生物钟】/);assert.match(messages[0],/评论区 @/)
 assert.doesNotMatch(messages[0],/【附加开放活动】/)
 const life=lifeStore(cfg),queue=life.status().activities
 assert.equal(queue.length,1);assert.equal(queue[0].status,'queued');assert.equal(life.status().leases.length,0)
 const completed=JSON.parse(fs.readFileSync(state))
 await scheduler.tick();assert.equal(messages.length,1)
 now+=9*60000;await scheduler.tick();assert.equal(messages.length,1)
 now+=2*60000;await scheduler.tick();assert.equal(messages.length,2,logs.join('\n'))
 assert.match(messages[1],/【附加开放活动】/);assert.match(messages[1],/不替代正常作息/)
 assert.equal(life.status().activities[0].status,'delivered');assert.equal(life.status().leases.length,1)
 assert.deepEqual(JSON.parse(fs.readFileSync(state)).usedCount,completed.usedCount)
 now+=20*60000;await scheduler.tick();assert.equal(messages.length,2)
}finally{scheduler.stop()}

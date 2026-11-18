import {preserveRetryTimers} from './retry-timers.mjs'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
const RealDate = Date, realTimeout = setTimeout
let now = new RealDate('2026-10-23T12:00:00').getTime()
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [now])) } static now() { return now } }
globalThis.setInterval = globalThis.setTimeout = () => ({})
globalThis.clearInterval = globalThis.clearTimeout = () => {}
preserveRetryTimers()
const { startScheduler } = await import('../../lib/scheduler.js')
const { makePlan } = await import('../../tools/lib/night-plan.mjs')
const dsh = process.env.DSH_HOME, home = process.env.HOME
for (const channel of ['tick', 'listenTick', 'dmTick']) {
  const cfg = {self:{mid:'111'}, owner:{mid:'222'}, night:{windows:[{start:'00:00',end:'24:00',wakes:2}],skipChance:0}, listen:{dm:channel==='dmTick',comment:channel==='listenTick',allDay:true,live:false}, diary:{push:false} }
  fs.writeFileSync(process.env.BILI_WHALE_CONFIG, JSON.stringify(cfg))
  fs.writeFileSync(path.join(dsh,'whale-night.json'), JSON.stringify(makePlan(cfg.night,{},now,()=>0)))
  process.env.TEST_FEEDS = path.join(home,'timeout-feeds.json')
  fs.writeFileSync(process.env.TEST_FEEDS, JSON.stringify({reply:[],at:[]}))
  process.env.TEST_DM_FILE = path.join(home,'timeout-dm.json')
  fs.writeFileSync(process.env.TEST_DM_FILE, JSON.stringify({timestamp:Math.floor(now/1000),msg_key:'timeout-msg',sender_uid:222,content:JSON.stringify({content:'hello'})}))
  let calls = 0, release
  const sched = startScheduler({sessionController:{create:async()=>{},prompt:()=>{calls++;return new Promise(r=>{release=r})}}}, {dshHome:dsh,cwd:home,biliMjs:fileURLToPath(new URL('../../tools/bili.mjs',import.meta.url))})
  let pending
  try {
    if(channel==='listenTick') {
      await sched.listenTick(); now+=901000
      fs.writeFileSync(process.env.TEST_FEEDS, JSON.stringify({reply:[],at:[{id:'timeout-at',at_time:Math.floor(now/1000),user:{mid:222,nickname:'Owner'},item:{source_content:'hello'}}]}))
    }
    pending = sched[channel]()
    for(let i=0;i<400 && !calls;i++) await new Promise(r=>realTimeout(r,10))
    assert.equal(calls,1,channel+' must reach prompt')
    now+=16*60000
    await sched[channel](); await sched[channel]()
    assert.equal(calls,1,channel+' must not redeliver an unresolved prompt')
    release(); await pending
    const before=calls
    await sched[channel]()
    assert.equal(calls,before,channel+' must preserve completion/cursor after late success')
  } finally { release?.(); await pending; sched.stop() }
}

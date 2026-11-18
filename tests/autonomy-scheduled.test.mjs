import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {createLifeStore} from '../tools/lib/life-store.mjs'
function setup(t,config={}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-activity2-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
 let now=Date.now();return {home,store:createLifeStore({dshHome:home,account:'1',owner:'2',config:{autonomy:true,...config},now:()=>now}),advance:ms=>now+=ms}
}
test('scheduled activity is durable, separately budgeted, and deduplicated by normal trigger',async t=>{
 const {store,home,advance}=setup(t),due=store.now()+60000
 const first=await store.scheduleActivity('normal-plan-1',due),again=await store.scheduleActivity('normal-plan-1',due)
 assert.equal(first.id,again.id);assert.equal(await store.beginScheduledActivity(),null)
 advance(60001)
 const claimed=await store.beginScheduledActivity();assert.ok(claimed);assert.equal(await store.beginScheduledActivity(),null)
 const restart=createLifeStore({dshHome:home,account:'1',owner:'2',config:{autonomy:true}})
 assert.equal(restart.status().activities[0].status,'dispatching')
 await store.finishScheduledActivity(first.id,true);assert.equal(store.status().activities[0].status,'delivered')
 assert.equal(await store.beginScheduledActivity(),null)
})
test('pause and daily budget preserve queued activity rather than consuming normal plan',async t=>{
 const {store}=setup(t,{autonomyDaily:0});await store.scheduleActivity('normal',store.now())
 assert.equal(await store.beginScheduledActivity(),null);assert.equal(store.status().activities[0].status,'queued')
 await store.pause(true);assert.equal(await store.beginScheduledActivity(),null)
})
test('failed activity delivery is visible and cannot spin on retries',async t=>{
 const {store}=setup(t);const q=await store.scheduleActivity('normal',store.now());await store.beginScheduledActivity()
 await store.finishScheduledActivity(q.id,false);assert.equal(store.status().activities[0].status,'delivery-failed');assert.equal(await store.beginScheduledActivity(),null)
})

test('uncertain activity is not labelled delivered or retried and keeps its limited lease',async t=>{
 const {store}=setup(t);const q=await store.scheduleActivity('unknown',store.now());await store.beginScheduledActivity()
 await store.finishScheduledActivity(q.id,'unconfirmed')
 assert.equal(store.status().activities[0].status,'delivery-unconfirmed');assert.equal(await store.beginScheduledActivity(),null)
 assert.equal(store.status().leases[0].status,'active')
})
test('real scheduler preserves normal share wake and dispatches additional activity later',t=>{
 const {home}=setup(t),dsh=path.join(home,'profile');fs.mkdirSync(dsh);fs.mkdirSync(path.join(home,'.bili-ai'))
 fs.writeFileSync(path.join(home,'.bili-ai/credentials.json'),JSON.stringify({sessdata:'synthetic',bili_jct:'a'.repeat(32)}))
 const r=spawnSync(process.execPath,[fileURLToPath(new URL('./helpers/autonomy-scheduled.mjs',import.meta.url))],{env:{...process.env,USERPROFILE:home,HOME:home,DSH_HOME:dsh,DSH_NODE:process.execPath,BILI_WHALE_CONFIG:path.join(dsh,'bili-whale.config.json')},encoding:'utf8',timeout:15000,windowsHide:true})
 assert.equal(r.status,0,r.stdout+r.stderr)
})

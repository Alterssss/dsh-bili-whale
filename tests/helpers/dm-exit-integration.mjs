import {preserveRetryTimers} from './retry-timers.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import cp from 'node:child_process'
import assert from 'node:assert/strict'
import {syncBuiltinESMExports} from 'node:module'
import {fileURLToPath} from 'node:url'
const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-real-exit-')),dsh=path.join(home,'.dsh')
fs.mkdirSync(dsh);fs.mkdirSync(path.join(home,'.bili-ai'))
Object.assign(process.env,{HOME:home,USERPROFILE:home,DSH_HOME:dsh,DSH_NODE:process.execPath,BILI_WHALE_CONFIG:path.join(dsh,'bili-whale.config.json'),TEST_HISTORY:path.join(home,'sessions.json'),NODE_OPTIONS:'--import='+new URL('./history-fetch.mjs',import.meta.url).href,BILI_TRAFFIC_TEST:'1',NODE_TEST_CONTEXT:'child-v8'})
fs.writeFileSync(process.env.BILI_WHALE_CONFIG,JSON.stringify({self:{mid:'111'},owner:{mid:'222'},listen:{dm:true,comment:false,dmIntervalSec:60},night:{windows:[]}}))
fs.writeFileSync(path.join(home,'.bili-ai/credentials.json'),JSON.stringify({sessdata:'fake',bili_jct:'fake'}))
const RealDate=Date;let now=Date.now()
globalThis.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[now]))}static now(){return now}}
globalThis.setTimeout=globalThis.setInterval=()=>({});globalThis.clearTimeout=globalThis.clearInterval=()=>{}
// Observe real child exits. Never replace their stdout, error or exit status.
const realExec=cp.execFile,exits=[]
cp.execFile=(exe,args,options,cb)=>realExec(exe,args,options,(err,out,stderr)=>{
  exits.push({code:err?err.code:0,ack:args.includes('--ack'),out});cb(err,out,stderr)
});syncBuiltinESMExports()
const write=(value)=>fs.writeFileSync(process.env.TEST_HISTORY,JSON.stringify(value))
const empty=()=>write({code:0,data:{messages:[],has_more:0}})
empty()
preserveRetryTimers()
const {startScheduler}=await import('../../lib/scheduler.js')
let prompts=0;let received=[]
const scheduler=startScheduler({sessionController:{create:async()=>{},prompt:async(request)=>{prompts++;received.push(request)}}},{dshHome:dsh,cwd:home,biliMjs:fileURLToPath(new URL('../../tools/bili.mjs',import.meta.url))})
try {
  for(let i=0;i<6;i++) {
    const n=exits.length;await scheduler.dmTick()
    assert.equal(exits.length,n+1,'empty inbox must be checked each base interval')
    assert.equal(exits.at(-1).code,1);assert.equal(JSON.parse(exits.at(-1).out).hit,false)
    now+=60000
  }
  assert.equal(prompts,0)
  write({code:-500,message:'simulated API error'})
  await scheduler.dmTick();assert.equal(exits.at(-1).code,3)
  const n=exits.length;now+=60000;await scheduler.dmTick();assert.equal(exits.length,n)
  now+=60000;empty();await scheduler.dmTick();assert.equal(exits.at(-1).code,1)
  now+=60000;await scheduler.dmTick();assert.equal(exits.length,n+2,'successful empty read resets failure backoff')
  now+=60000
  write({code:0,data:{messages:[{sender_uid:222,timestamp:Math.floor(now/1000),msg_key:'real-exit-test',content:JSON.stringify({content:'X'.repeat(500)+'TAIL_MUST_REACH_AGENT'})}],has_more:0}})
  await scheduler.dmTick();assert.equal(prompts,1)
  assert.equal(exits.at(-2).code,0);assert.ok(JSON.parse(exits.at(-2).out).receipt)
  assert.match(JSON.stringify(received),/TAIL_MUST_REACH_AGENT/);assert.equal(exits.at(-1).ack,true);assert.equal(exits.at(-1).code,0)
  now+=60000;await scheduler.dmTick();assert.equal(prompts,1);assert.equal(exits.at(-1).code,1)
  assert.equal(fs.existsSync(path.join(home,'.bili-ai/dm-tick-err.log')),true)
  console.log('PASS real CLI: empty=1 stays fixed, API failure=3 backs off, hit=0 delivers, ack=0 confirms, repeat=1')
} finally {scheduler.stop();fs.rmSync(home,{recursive:true,force:true})}

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import cp from 'node:child_process'
import assert from 'node:assert/strict'
import {syncBuiltinESMExports} from 'node:module'
import {fileURLToPath} from 'node:url'
const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-poll-')),dsh=path.join(home,'.dsh')
fs.mkdirSync(dsh);fs.mkdirSync(path.join(home,'.bili-ai'))
process.env.HOME=process.env.USERPROFILE=home;process.env.DSH_HOME=dsh
process.env.BILI_WHALE_CONFIG=path.join(dsh,'bili-whale.config.json');process.env.DSH_NODE=process.execPath
process.env.BILI_TRAFFIC_TEST='1';process.env.NODE_TEST_CONTEXT='child-v8'
fs.writeFileSync(path.join(home,'.bili-ai/credentials.json'),JSON.stringify({sessdata:'fake',bili_jct:'fake'}))
const RealDate=Date;let now=new RealDate('2026-10-24T12:00:00').getTime()
globalThis.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[now]))}static now(){return now}}
globalThis.setInterval=globalThis.setTimeout=()=>({});globalThis.clearInterval=globalThis.clearTimeout=()=>{}
let dmCalls=0,commentCalls=0,failDm=false,failComment=false,failAt=false,invalidDm=false,hit=false,receipt=0
cp.execFile=(exe,args,opts,cb)=>{
  if(args.includes('--ack')){queueMicrotask(()=>cb(null,'ok',''));return {kill(){}}}
  dmCalls++
  // 2026-10-24 修：真实的 dm-await 退出码是 0=命中 / 1=没命中 / 3=出错 ✗
  //   以前这里「没命中」也回调 err=null（= 退出 0）✗
  //   → 掩盖了 scheduler 把「正常空收件箱」当失败的 bug ✗
  const out=invalidDm?'not-json':JSON.stringify(hit?{hit:true,receipt:String(++receipt),text:'hello',mid:222}:{hit:false})
  let err=null
  if(failDm)err=Object.assign(Error('offline'),{code:3})
  else if(!invalidDm&&!hit)err=Object.assign(Error('no hit'),{code:1})
  queueMicrotask(()=>cb(err,out,''))
  return {kill(){}}
};syncBuiltinESMExports()
globalThis.fetch=async url=>{
  if(String(url).includes('/at')&&failAt)throw Error('at offline')
  if(String(url).includes('/reply'))commentCalls++
  if(failComment)throw Error('reply offline')
  return new Response(JSON.stringify({code:0,data:{items:hit?[{id:String(now),reply_time:Math.floor(now/1000),user:{mid:222,nickname:'Owner'},item:{source_content:'hello'}}]:[]}}))
}
// 2026-10-27：listenTick 支持 onlyOwner（入口只留主人）；测试显式配置主人 mid，与 FakeFeed 的 user.mid 一致
const cfg={owner:{mid:222},listen:{dm:true,comment:true,allDay:true,scope:'reply',dmIntervalSec:60,commentIntervalSec:60,onlyOwner:true},night:{windows:[]}}
const save=()=>fs.writeFileSync(process.env.BILI_WHALE_CONFIG,JSON.stringify(cfg));save()
const {startScheduler}=await import('../../lib/scheduler.js')
const {trafficGuard}=await import('../../tools/lib/traffic.mjs')
let deliveries=0
const s=startScheduler({sessionController:{create:async()=>{},prompt:async()=>{deliveries++}}},{dshHome:dsh,cwd:home,biliMjs:fileURLToPath(new URL('../../tools/bili.mjs',import.meta.url))})
const both=async()=>{await s.dmTick();await s.listenTick()}
const counts=()=>[dmCalls,commentCalls]
const delta=(before,expected)=>assert.deepEqual(counts().map((n,i)=>n-before[i]),expected)
try {
  await both()
  for(let i=0;i<20;i++){now+=60000;const before=counts();await both();delta(before,[1,1])}
  hit=true;now+=60000;await both();assert.equal(deliveries,2);hit=false
  // Both channels back off on consecutive errors, then recover after an empty success.
  failDm=failComment=true;now+=60000;await both()
  let before=counts();now+=60000;await both();delta(before,[0,0])
  now+=60000;await both();delta(before,[1,1]);before=counts()
  now+=120000;await both();delta(before,[0,0])
  failDm=failComment=false;now+=120000;await both();delta(before,[1,1]);before=counts()
  now+=60000;await both();delta(before,[1,1])
  // Malformed DM output is a failure, not an empty inbox.
  invalidDm=true;now+=60000;await s.dmTick();before=counts();now+=60000;await s.dmTick();delta(before,[0,0]);invalidDm=false
  // Re-enable resets both failures and timestamps.
  cfg.listen.dm=cfg.listen.comment=false;save();await both()
  cfg.listen.dm=cfg.listen.comment=true;save();before=counts();await both();delta(before,[1,1])
  cfg.listen.allDay=false;save();now+=60000;before=counts();await s.listenTick();delta(before,[0,0])
  cfg.night.windows=[{start:'00:00',end:'24:00'}];save();now+=30000;await s.listenTick();delta(before,[0,1])
  // A failed @ feed must not advance the reply cursor past unseen @ messages.
  cfg.listen.scope='both';save();hit=true;failAt=true;now+=60000
  const cursor=fs.readFileSync(path.join(dsh,'whale-listen.json'),'utf8')
  await s.listenTick();assert.equal(fs.readFileSync(path.join(dsh,'whale-listen.json'),'utf8'),cursor)
  before=counts();now+=60000;await s.listenTick();delta(before,[0,0]);hit=false;failAt=false
  // Protection pauses still prevent either channel from polling.
  const guard=trafficGuard(),original=guard.pauseReason;guard.pauseReason=()=> 'test pause'
  now+=900000;before=counts();await both();delta(before,[0,0]);guard.pauseReason=original
  await both()
  s.invalidate(false);await new Promise(r=>setImmediate(r))
  // Saving unrelated settings must not force a read before the next interval.
  cfg.listen.dmIntervalSec=cfg.listen.commentIntervalSec=120;save();before=counts();s.invalidate(false)
  await new Promise(r=>setImmediate(r));delta(before,[1,1])
  cfg.diary={push:false};save();before=counts();s.invalidate(false)
  await new Promise(r=>setImmediate(r));delta(before,[0,0])
  console.log('PASS: fixed idle cadence, message arrival, failures/recovery, malformed DM, toggle, windows, partial feed, pause, unrelated save')
} finally {s.stop();fs.rmSync(home,{recursive:true,force:true})}

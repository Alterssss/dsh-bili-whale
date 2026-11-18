import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {setTimeout as wait} from 'node:timers/promises'
import {preserveRetryTimers} from './retry-timers.mjs'
const RealDate=Date
let now=new RealDate('2026-10-28T05:10:00').getTime()
globalThis.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[now]))}static now(){return now}}
globalThis.setInterval=globalThis.setTimeout=()=>({})
globalThis.clearInterval=globalThis.clearTimeout=()=>{}
preserveRetryTimers()
const {startScheduler}=await import('../../lib/scheduler.js')
const {makePlan}=await import('../../tools/lib/night-plan.mjs')
const home=process.env.HOME,dsh=process.env.DSH_HOME,scenario=process.argv[2]
const cfg={self:{mid:'111'},owner:{mid:'222'},night:{windows:[{start:'00:00',end:'08:00',wakes:4}],skipChance:0,minGapMin:10},listen:{dm:scenario==='dm',comment:scenario==='comment',allDay:true,live:false},notify:{type:'file'}}
fs.writeFileSync(process.env.BILI_WHALE_CONFIG,JSON.stringify(cfg))
process.env.TEST_DM_FILE=path.join(home,'listener-dm.json')
const message=key=>fs.writeFileSync(process.env.TEST_DM_FILE,JSON.stringify({timestamp:Math.floor(now/1000),msg_key:key,sender_uid:222,content:JSON.stringify({content:key})}))
process.env.TEST_FEEDS=path.join(home,'listener-feeds.json')
const items=[]
const feed=()=>fs.writeFileSync(process.env.TEST_FEEDS,JSON.stringify({reply:[],at:items}))
const item=id=>({id,at_time:Math.floor(now/1000),user:{mid:222,nickname:'Owner'},item:{source_content:id}})
feed();message('first')
let late;const requests=[]
const scheduler=startScheduler({sessionController:{create:async()=>{},prompt:r=>{
  requests.push(r)
  return (scenario==='notify'||requests.length===1)?new Promise(resolve=>late=resolve):Promise.resolve()
}}},{dshHome:dsh,cwd:home,biliMjs:fileURLToPath(new URL('../../tools/bili.mjs',import.meta.url)),deliveryTimeoutMs:30})
try{
  if(scenario==='dm'){
    await scheduler.dmTick();assert.equal(requests.length,1)
    now+=3*60000;await scheduler.dmTick();assert.equal(requests.length,1,'pending uncertain DM must not be redelivered')
    late();await wait(100)
    now+=5*60000;await scheduler.dmTick();assert.equal(requests.length,1,'late acceptance retries only ack')
    assert.equal(JSON.parse(fs.readFileSync(path.join(home,'.bili-ai/dm-await-state.json'))).pending,undefined)
    now+=5*60000;message('second');await scheduler.dmTick();assert.equal(requests.length,2)
  }else if(scenario==='comment'){
    await scheduler.listenTick();now+=60000;items.push(item('first'));feed()
    await scheduler.listenTick();assert.equal(requests.length,1)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dsh,'whale-listen.json'))).deliveryStatus,'unconfirmed')
    now+=3*60000;items.push(item('second'));feed();await scheduler.listenTick()
    assert.equal(requests.length,2);assert.match(requests[1].content[0].text,/【有人找你】1 条新消息/)
    const cursor=fs.readFileSync(path.join(dsh,'whale-listen.json'),'utf8')
    late();await wait(100)
    assert.equal(fs.readFileSync(path.join(dsh,'whale-listen.json'),'utf8'),cursor)
    now+=3*60000;await scheduler.listenTick();assert.equal(requests.length,2)
  }else if(scenario==='notify'){
    const stateFile=path.join(dsh,'whale-night.json')
    for(let i=0;i<3;i++){
      const old=i?JSON.parse(fs.readFileSync(stateFile)):{}
      fs.writeFileSync(stateFile,JSON.stringify(makePlan(cfg.night,old,now,()=>0)))
      await scheduler.tick();now+=11*60000
    }
    const notices=path.join(dsh,'whale-notify.log')
    for(let i=0;i<100&&!fs.existsSync(notices);i++)await wait(20)
    assert.ok(fs.existsSync(notices),'configured notification should report repeated wake failures')
    await wait(200)
    const lines=fs.readFileSync(notices,'utf8').trim().split('\n')
    assert.equal(lines.length,1,'one notification per continuous failure streak')
    assert.match(lines[0],/连续两次/)
  }else assert.fail('unknown scenario')
}finally{late?.();scheduler.stop();await wait(150)}

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
const RealDate=Date
let now=new RealDate('2026-10-21T22:00:00').getTime()
globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]))}static now(){return now}}
const timers=[]
globalThis.setInterval=globalThis.setTimeout=(fn)=>{const t={fn};timers.push(t);return t}
globalThis.clearInterval=globalThis.clearTimeout=t=>{t.cleared=true}
const {startScheduler}=await import('../../lib/scheduler.js')
const {makePlan,completePlan,historyOf}=await import('../../tools/lib/night-plan.mjs')
const dsh=process.env.DSH_HOME,state=path.join(dsh,'whale-night.json')
const cfg={night:{windows:[{start:'23:00',end:'01:00',wakes:1}],skipChance:0},listen:{comment:false,dm:false,live:false},diary:{push:false}}
cfg.personaOncePerSession=true
cfg.voice={personality:'测试稳定人格',replyStyle:'默认短句',multipleStyles:['测试本次语气'],multipleProbability:1,expressionTopK:0}
fs.writeFileSync(process.env.BILI_WHALE_CONFIG,JSON.stringify(cfg))
const persona=path.join(process.env.USERPROFILE,'.bili-ai/persona.md')
fs.writeFileSync(persona,'测试专属人设')
const messages=[]
let fail=true,attempts=0
const sched=startScheduler({sessionController:{create:async()=>{},prompt:async p=>{attempts++;if(fail)throw Error('delivery failure');messages.push(p.content[0].text)}}},
  {dshHome:dsh,biliMjs:'unused',cwd:process.env.USERPROFILE})
const samples=[.75,.9];const p=makePlan(cfg.night,{},now,()=>samples.shift())
fs.writeFileSync(state,JSON.stringify(p))
await sched.tick();assert.equal(attempts,0)
now=new RealDate('2026-10-22T00:30:00').getTime()
await sched.tick();assert.equal(attempts,1)
assert.equal(JSON.parse(fs.readFileSync(state)).fired,false)
fail=false;await sched.tick();assert.equal(attempts,2)
assert.ok(messages[0].includes('测试专属人设'))
assert.match(messages[0],/测试稳定人格/)
assert.match(messages[0],/测试本次语气/)
assert.ok(messages[0].includes('关掉了推送'))

await sched.tick();assert.equal(attempts,2)
const before=JSON.parse(fs.readFileSync(state))
sched.invalidate(true)
const after=JSON.parse(fs.readFileSync(state))
assert.deepEqual(after.usedCount,before.usedCount)
sched.stop();assert.ok(timers.every(t=>t.cleared))
for(const t of timers)t.fn()
await new Promise(r=>setImmediate(r));assert.equal(attempts,2)
// Skip branch uses the same persisted history and respects diary.push=false.
now=new RealDate('2026-10-23T23:00:00').getTime()
cfg.night.skipChance=1;fs.writeFileSync(process.env.BILI_WHALE_CONFIG,JSON.stringify(cfg))
const skip=makePlan(cfg.night,historyOf(before,now),now,()=>0)
fs.writeFileSync(state,JSON.stringify(skip))
const s2=startScheduler({sessionController:{create:async()=>{},prompt:async p=>messages.push(p.content[0].text)}},{dshHome:dsh,biliMjs:'unused',cwd:process.env.USERPROFILE})
await s2.tick();s2.stop()
assert.match(messages.at(-1),/今晚不看/);assert.ok(messages.at(-1).includes('关掉了推送'))
assert.ok(messages.at(-1).includes('测试专属人设'))
const end=JSON.parse(fs.readFileSync(state));assert.ok((end.usedCount?.[skip.windowKey]??0)>0,'skip 应消耗一次机会')
// Owner mention summary is wired into the real listener, once per fresh batch.
now=new RealDate('2026-10-24T12:00:00').getTime()
cfg.owner={mid:'222'};cfg.listen={comment:true,allDay:true,commentIntervalSec:60,dm:false,live:false,mentionSummary:true}
fs.writeFileSync(process.env.BILI_WHALE_CONFIG,JSON.stringify(cfg))
process.env.TEST_FEEDS=path.join(process.env.USERPROFILE,'listen-feeds.json')
fs.writeFileSync(process.env.TEST_FEEDS,JSON.stringify({reply:[],at:[]}))
const s3=startScheduler({sessionController:{create:async()=>{},prompt:async p=>messages.push(p.content[0].text)}},{dshHome:dsh,biliMjs:'unused',cwd:process.env.USERPROFILE})
await s3.listenTick()
now+=901000
fs.writeFileSync(process.env.TEST_FEEDS,JSON.stringify({reply:[],at:[{id:'request1',at_time:Math.floor(now/1000),user:{mid:'222',nickname:'Owner'},item:{source_content:'请总结这个视频',uri:'https://www.bilibili.com/video/BV1234567890'}}]}))
const countBefore=messages.length
await s3.listenTick();assert.equal(messages.length,countBefore+1);assert.match(messages.at(-1),/【主人请求总结】/)
now+=901000;await s3.listenTick();assert.equal(messages.length,countBefore+1)
const sameSecond = JSON.parse(fs.readFileSync(process.env.TEST_FEEDS))
sameSecond.at.push({...sameSecond.at[0], id:'request2'})
fs.writeFileSync(process.env.TEST_FEEDS, JSON.stringify(sameSecond))
now+=901000;await s3.listenTick();assert.equal(messages.length,countBefore+2)
assert.doesNotMatch(messages.at(-1),/测试稳定人格/)
assert.match(messages.at(-1),/测试本次语气/)
cfg.voice.multipleProbability=0
fs.writeFileSync(process.env.BILI_WHALE_CONFIG,JSON.stringify(cfg))
now+=901000;await s3.listenTick();assert.equal(messages.length,countBefore+2)
const listenFile=path.join(dsh,'whale-listen.json')
const cursor=JSON.parse(fs.readFileSync(listenFile))
s3.invalidate(false)
assert.deepEqual(JSON.parse(fs.readFileSync(listenFile)),cursor,'saving settings must retain listener cursor')
s3.stop()

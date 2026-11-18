import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {fileURLToPath,pathToFileURL} from 'node:url'
const repo=process.argv[2]??fileURLToPath(new URL('../../',import.meta.url))
const RealDate=Date;let now=new RealDate('2026-10-29T21:00:00+08:00').getTime()
globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]))}static now(){return now}}
globalThis.setInterval=()=>({});globalThis.clearInterval=()=>{}
const {startScheduler}=await import(pathToFileURL(path.join(repo,'lib/scheduler.js')))
const {makePlan}=await import(pathToFileURL(path.join(repo,'tools/lib/night-plan.mjs')))
const cfg={self:{mid:'111'},owner:{mid:'222'},share:{via:'comment',aiCommentGuard:false},persona:{name:'测试角色',ownerTitle:'主人'},night:{windows:[{start:'20:00',end:'23:00',wakes:1}],skipChance:0},listen:{dm:true,allDay:true,comment:false,live:false},diary:{push:false},life:{learningEnabled:false},personaOncePerSession:true}
fs.writeFileSync(process.env.BILI_WHALE_CONFIG,JSON.stringify(cfg))
fs.writeFileSync(path.join(process.env.USERPROFILE,'.bili-ai','persona.md'),'我是测试角色；喜欢猫与新鲜见闻。回应主人时自然表达，必要时详细解释。\n'.repeat(10))
const stickerRoot=path.join(process.env.USERPROFILE,'.bili-ai','stickers');fs.mkdirSync(path.join(stickerRoot,'small'),{recursive:true})
fs.writeFileSync(path.join(stickerRoot,'index.json'),JSON.stringify({stickers:Array.from({length:22},(_,i)=>({cn:'表情'+i,mood:'mood'+i,path:'small/'+i+'.png',desc:'用于表达当时的情绪，不需要每次发送。'}))}))
const calls=[],create=()=>startScheduler({sessionController:{create:async()=>{},prompt:async p=>calls.push(p)}},{dshHome:process.env.DSH_HOME,cwd:process.env.USERPROFILE,biliMjs:path.join(repo,'tools/bili.mjs')})
process.env.TEST_DM_FILE=path.join(process.env.USERPROFILE,'dm-input.json')
let scheduler=create()
async function dm(id){fs.writeFileSync(process.env.TEST_DM_FILE,JSON.stringify({timestamp:Math.floor(now/1000),msg_key:id,sender_uid:222,content:JSON.stringify({content:'合成消息：有点累，想聊两句。'})}));await scheduler.dmTick()}
await dm('one');now+=1800000;await dm('two');scheduler.stop();scheduler=create();now+=1800000;await dm('three')
const dmCalls=calls.slice();assert.equal(dmCalls.length,3)
for(let i=0;i<3;i++){
 now=new RealDate('2026-10-'+(29+i)+'T21:00:00+08:00').getTime();if(i===2)now=new RealDate('2026-10-31T21:00:00+08:00').getTime()
 cfg.share.via=i===1?'dm':'comment';fs.writeFileSync(process.env.BILI_WHALE_CONFIG,JSON.stringify(cfg))
 fs.writeFileSync(path.join(process.env.DSH_HOME,'whale-night.json'),JSON.stringify(makePlan(cfg.night,{},now,()=>0)))
 await scheduler.tick()
}
scheduler.stop()
const wakeCalls=calls.slice(3);assert.equal(wakeCalls.length,3)
const metric=p=>({characters:Array.from(p.content[0].text).length,utf8Bytes:Buffer.byteLength(p.content[0].text),sessionId:p.sessionId})
if(process.env.BEHAVIOR_EXPECT_NEW==='1'){
 for(const p of [...dmCalls,...wakeCalls])assert.match(p.content[0].text,/当前角色状态：平静/)
 assert.equal(new Set(wakeCalls.map(p=>p.sessionId)).size,1)
 assert.notEqual(wakeCalls[0].sessionId,dmCalls[0].sessionId)
 assert.equal(new Set(dmCalls.map(p=>p.sessionId)).size,1)
 assert.equal((dmCalls[0].content[0].text.match(/合成消息：有点累，想聊两句。/g)??[]).length,1)
 assert.match(dmCalls[1].content[0].text,/# 主人私信/)
 assert.doesNotMatch(dmCalls[1].content[0].text,/debrief|真人中位|small\\/)
 for(const p of calls)for(const key of ['memoryQuery','sourceEventIds','sessionRole','taskKind','memoryScene'])assert.equal(Object.hasOwn(p,key),false)
}
console.log(JSON.stringify({dmCold:metric(dmCalls[0]),dmWarm:metric(dmCalls[1]),dmRestart:metric(dmCalls[2]),wakes:wakeCalls.map(metric)},null,2))

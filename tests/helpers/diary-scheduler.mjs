import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
const RealDate=Date;let now=RealDate.now();globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]))}static now(){return now}}
globalThis.setInterval=()=>({});globalThis.clearInterval=()=>{};globalThis.fetch=()=>{throw Error('unexpected platform request')}
const {startScheduler}=await import('../../lib/scheduler.js')
const {createLifeStore}=await import('../../tools/lib/life-store.mjs')
const cfg=JSON.parse(fs.readFileSync(process.env.BILI_WHALE_CONFIG)),store=createLifeStore({dshHome:process.env.DSH_HOME,account:cfg.self.mid,owner:cfg.owner.mid,config:cfg.life,fullConfig:cfg,now:()=>now})
await store.record('video-read',{origin:'video',target:'BV0000000001',text:'猫咪胡须感知纸箱的宽度',data:{subtitle:true}});now+=180000
const scheduler=startScheduler({sessionController:{create:async()=>{},prompt:async()=>{throw Error('unexpected delivery')}}},{dshHome:process.env.DSH_HOME,cwd:process.env.USERPROFILE,biliMjs:path.resolve('tools/bili.mjs'),affectComplete:async()=>'{"moodEffects":[],"topicEffects":[],"contextHints":[]}',diaryComplete:async()=>{const j=store.read().settings.diary.jobs.public;return JSON.stringify({action:'write',text:'今天读到猫咪胡须感知宽度的有趣细节。',quotes:[{eventId:j.sources[0].id,text:'猫咪胡须感知纸箱的宽度'}]})}})
try{await scheduler.affectTick();assert.equal(store.diaryEntries('public').length,1);assert.equal(scheduler.diaryStatus().status,'committed');assert.match(fs.readFileSync(store.diaryStatus().paths.public,'utf8'),/有趣细节/);const event=store.diaryEntries('public')[0];assert.equal(store.diaryStatus().lastPush.status,'sent');await scheduler.affectTick();assert.equal(await store.claimDiaryPush(event.id),null);if(cfg.notify.type==='file'){
 const lines=fs.readFileSync(cfg.notify.path,'utf8').trim().split('\n');assert.equal(lines.length,1);assert.equal(JSON.parse(lines[0]).text,event.text)
}else{
 const sent=store.read().events.filter(e=>e.kind==='sent'&&e.channel==='dm');assert.equal(sent.length,1);assert.equal(sent[0].text,event.text);assert.equal(sent[0].target,cfg.owner.mid)
}
console.log('PASS scheduler diary')}finally{scheduler.stop()}

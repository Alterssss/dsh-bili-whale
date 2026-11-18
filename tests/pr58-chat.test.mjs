import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createLifeStore} from '../tools/lib/life-store.mjs'
import {parseMessages,createBatch,sendBatch,cancelBatch} from '../tools/lib/dm-batch.mjs'
import {chatConfig} from '../tools/lib/chat-config.mjs'
import {chatOpportunity} from '../tools/lib/chat-opportunity.mjs'
import {createSocialWorker,queueShareReplies,shareReplyContext} from '../lib/social-worker.js'
import {prepareExpression,finalizeExpression} from '../tools/lib/expression.mjs'

function fixture(t,chat={}){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-pr58-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  let at=Date.parse('2026-11-11T12:00:00+08:00')
  const full={self:{mid:'111'},owner:{mid:'222',name:'Owner'},night:{windows:[{start:'00:00',end:'24:00'}]},chat,life:{autonomy:true,requireDraft:true}}
  const store=createLifeStore({dshHome:home,account:'111',owner:'222',config:full.life,fullConfig:()=>full,now:()=>at})
  const calls=[]
  const run=async(args,signal)=>{
    signal?.throwIfAborted();calls.push(args)
    const d=store.read().drafts.find(d=>d.id===args[args.indexOf('--draft')+1])
    const req={channel:args[0]==='dynamic'?'dynamic':'dm',scene:d.scene,target:d.target,text:d.text,auto:true,share:false,draftId:d.id,...(args.includes('--social-job')?{socialJobId:args[args.indexOf('--social-job')+1]}:{})}
    const check=store.check(req);if(!check.allow)return {ok:false,err:check.reason}
    if(args.includes('--dry'))return {ok:true}
    const token=await store.reserve(req);await store.dispatch(token,async()=>({}));await store.settle(token,{status:'sent',receipt:'receipt-'+calls.length});return {ok:true}
  }
  return {home,full,store,run,calls,at:()=>at,add:n=>at+=n}
}
test('parse short messages: skip tokens never sent; over-cap and long text rejected without truncation',()=>{
  for(const s of ['不回','（不说）','(不发)',''])assert.deepEqual(parseMessages(s),[])
  assert.deepEqual(parseMessages('第一句\n---\n第二句\n（不说）'),['第一句','第二句'])
  assert.throws(()=>parseMessages(Array.from({length:7},(_,i)=>String(i))),/未截断/)
  assert.throws(()=>parseMessages(['x'.repeat(301)]),/未截断/)
  assert.throws(()=>parseMessages(['x','x']),/重复/)
  assert.equal(chatConfig({dynamic:true,chance:4,maxParts:100}).maxParts,6)
})
test('multi-message partial failure resumes only remaining drafts and preserves exact bodies',async t=>{
  const x=fixture(t),b=await createBatch(x.store,['第一句','第二句','第三句'],{config:x.full})
  let go=0
  const fail=async(args,sig)=>args.includes('--go')&&++go===2?{ok:false,err:'explicit failure'}:x.run(args,sig)
  await assert.rejects(sendBatch(x.store,b.id,{run:fail,config:x.full}),/未确认/)
  assert.deepEqual(x.store.read().settings.dmBatches[0].parts.map(p=>p.status),['sent','ready','ready'])
  assert.equal((await createBatch(x.store,['第一句','第二句','第三句'],{config:x.full})).id,b.id)
  await sendBatch(x.store,b.id,{run:x.run,config:x.full})
  assert.deepEqual(x.store.read().events.filter(e=>e.kind==='sent').map(e=>e.text),['第一句','第二句','第三句'])
})
test('unknown batch receipt blocks resend and holds remaining messages',async t=>{
  const x=fixture(t),b=await createBatch(x.store,['one','two'],{config:x.full})
  const run=async args=>{
    if(args.includes('--dry'))return {ok:true}
    const d=x.store.read().drafts.find(d=>d.id===args[2]),token=await x.store.reserve({channel:'dm',target:'222',scene:'private-reply',text:d.text,auto:true,draftId:d.id})
    await x.store.dispatch(token,()=>Promise.resolve());return {ok:false}
  }
  await assert.rejects(sendBatch(x.store,b.id,{run,config:x.full}))
  await assert.rejects(sendBatch(x.store,b.id,{run:()=>assert.fail('must not send'),config:x.full}),/回执未知/)
  assert.equal(x.store.read().settings.dmBatches[0].parts[1].text,'two')
})
test('batch cancellation after dry, changed policy and pause prevent dispatch',async t=>{
  const x=fixture(t),b=await createBatch(x.store,['one'],{config:x.full}),c=new AbortController()
  await assert.rejects(sendBatch(x.store,b.id,{config:x.full,signal:c.signal,run:async args=>{assert.ok(args.includes('--dry'));c.abort();return {ok:true}}}))
  await x.store.pause(true)
  await assert.rejects(sendBatch(x.store,b.id,{config:x.full,run:x.run}),/策略变化/)
  assert.equal(x.store.read().events.filter(e=>e.kind==='sent').length,0)
})
test('explicitly cancelling unsent batch preserves text and prevents future resume',async t=>{
  const x=fixture(t),b=await createBatch(x.store,['保留这句未发正文'],{config:x.full})
  await cancelBatch(x.store,b.id)
  assert.equal(x.store.read().settings.dmBatches[0].parts[0].text,'保留这句未发正文')
  await assert.rejects(sendBatch(x.store,b.id,{config:x.full,run:()=>assert.fail('cancelled')}),/取消/)
})
test('social send guard rechecks toggle and incoming owner messages at actual dispatch',async t=>{
  const x=fixture(t,{dynamic:true}),d=await prepareExpression(x.store,{channel:'dynamic',scene:'public-comment',target:'111',text:'待发公开动态',share:false})
  await finalizeExpression(x.store,d.id)
  await x.store.tx(s=>{s.settings.socialJobs=[{id:'j',kind:'dynamic',status:'sending',draftId:d.id,at:x.at(),ownerAt:s.affect.lastOwnerAt}]})
  const req={channel:'dynamic',scene:'public-comment',target:'111',text:d.text,draftId:d.id,auto:true,share:false,socialJobId:'j'}
  const token=await x.store.reserve(req)
  x.full.chat.dynamic=false
  await assert.rejects(x.store.dispatch(token,()=>assert.fail('disabled send')),/设置变化/)
  x.full.chat.dynamic=true
  await x.store.ingestOwnerMessage({channel:'bili-dm',actor:'222',messageId:'new',text:'先等一下'})
  await assert.rejects(x.store.dispatch(token,()=>assert.fail('stale send')),/设置变化/)
})
test('followup and idle opportunities bind contact, avoid fresh rerolls and respect settings',()=>{
  const at=100000000,s={affect:{lastOwnerAt:at-120000},events:[{id:'o',seq:1,kind:'received',channel:'bili-dm',actor:'2',verifiedRole:'owner',text:'小猫呢',at:at-120000},{id:'r',seq:2,kind:'sent',channel:'dm',target:'2',receipt:'ack',text:'在纸箱里',at:at-60000}]},full={owner:{mid:'2'},chat:{followup:true,idle:true,chance:1}}
  const p=chatOpportunity(s,full,at);assert.equal(p.kind,'followup')
  s.affect.chatAttempts=[p.key];assert.equal(chatOpportunity(s,full,at),null)
  assert.equal(chatOpportunity(s,full,at+4*3600000).kind,'idle')
  full.chat.chance=0;assert.equal(chatOpportunity(s,full,at+4*3600000),null)
})
test('public dynamic uses public sources only, settles actual receipt, daily cap and wake dedup',async t=>{
  const x=fixture(t,{dynamic:true,dynamicChance:1}),prompts=[]
  await x.store.ingestOwnerMessage({channel:'bili-dm',actor:'222',messageId:'1',text:'PRIVATE_SECRET_123'})
  const worker=createSocialWorker({store:()=>x.store,config:()=>x.full,now:x.at,run:x.run,complete:async p=>{prompts.push(p.prompt);return JSON.stringify({action:'send',text:'小猫的视频真有意思。'})}})
  await worker.wake('wake-1');x.add(60000)
  await x.store.record('video-read',{origin:'tool',target:'BV1234567890',text:'小猫在草地玩耍'})
  assert.equal((await worker.tick()).status,'sent')
  assert.doesNotMatch(prompts[0],/PRIVATE_SECRET_123/)
  assert.equal(x.store.read().events.find(e=>e.kind==='sent').channel,'dynamic')
  assert.equal((await worker.tick()).status,'idle')
  await worker.wake('wake-2');x.add(60000);await x.store.record('video-read',{origin:'tool',text:'新视频'})
  assert.equal((await worker.tick()).status,'idle');assert.equal(prompts.length,1)
})
test('dynamic off during generation prevents send; late completion after stop cannot mutate state',async t=>{
  const x=fixture(t,{dynamic:true,dynamicChance:1}),c=new AbortController();let finish,started
  const gate=new Promise(r=>started=r)
  const worker=createSocialWorker({store:()=>x.store,config:()=>x.full,now:x.at,run:()=>assert.fail('no send'),signal:c.signal,complete:()=>{started();return new Promise(r=>finish=r)}})
  await worker.wake('wake');await x.store.record('video-read',{origin:'tool',text:'真实视频内容'})
  const task=worker.tick();await gate;c.abort();assert.equal((await task).status,'failed')
  const revision=x.store.read().revision;finish('{"action":"send","text":"不能发"}');await new Promise(r=>setTimeout(r,10));assert.equal(x.store.read().revision,revision)
})
test('dynamic setting change during dry is rejected before go',async t=>{
  const x=fixture(t,{dynamic:true,dynamicChance:1})
  const worker=createSocialWorker({store:()=>x.store,config:()=>x.full,now:x.at,complete:async()=>'{"action":"send","text":"公开感想"}',run:async args=>{assert.ok(args.includes('--dry'));x.full.chat.dynamic=false;return {ok:true}}})
  await worker.wake('wake');await x.store.record('video-read',{origin:'tool',text:'真实视频内容'})
  assert.equal((await worker.tick()).status,'failed');assert.equal(x.store.read().events.filter(e=>e.kind==='sent').length,0)
})
test('share reply only matches actual shared top-level receipt; notification never auto-replies publicly',async t=>{
  const x=fixture(t,{shareReply:true});const req={channel:'comment',scene:'public-comment',target:'BV1234567890',thread:'1:123:top',text:'一起看看这个',share:true,auto:false}
  const token=await x.store.reserve(req);await x.store.settle(token,{status:'sent',receipt:'999'})
  const items=[{kind:'reply',id:'item1',root:'999',parent:'1000',oid:'123',business:1,mid:'333',who:'访客',source:'你的想法很有意思'}]
  assert.deepEqual(await queueShareReplies(x.store,items,x.full),['reply:item1'])
  await queueShareReplies(x.store,items,x.full);assert.equal(x.store.read().settings.shareReplyInbox.length,1)
  assert.deepEqual(await queueShareReplies(x.store,[{...items[0],id:'other',root:'888'}],x.full),[])
  const worker=createSocialWorker({store:()=>x.store,config:()=>x.full,now:x.at,run:x.run})
  assert.equal((await worker.tick()).status,'sent')
  assert.ok(x.calls.every(args=>args[0]==='dm'))
  assert.equal(x.store.read().settings.shareReplyInbox[0].status,'notified')
})
test('stale social task reconciles sent draft on restart and does not duplicate',async t=>{
  const x=fixture(t,{dynamic:true,dynamicChance:1}),d=await prepareExpression(x.store,{channel:'dynamic',scene:'public-comment',target:'111',text:'已发过的动态',share:false})
  await finalizeExpression(x.store,d.id);await x.run(['dynamic','post','--draft',d.id,'--go'])
  await x.store.tx(s=>{s.settings.socialJobs=[{id:'old',at:x.at(),kind:'dynamic',trigger:'wake',draftId:d.id,status:'sending'}]})
  const worker=createSocialWorker({store:()=>x.store,config:()=>x.full,now:x.at,run:()=>assert.fail('no replay')})
  await worker.tick();assert.equal(x.store.read().settings.socialJobs[0].status,'sent')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createLifeStore} from '../tools/lib/life-store.mjs'
const DAY=86400000
function setup(t,config={}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-025-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
 let at=Date.parse('2026-10-31T12:00:00+08:00')
 const open=()=>createLifeStore({dshHome:home,account:'1',owner:'2',config,now:()=>at})
 return {store:open(),open,advance:days=>at+=days*DAY}
}
const memory=(id,at,sourceIds=[],extra={})=>({id,version:1,at,acceptedAt:at,active:true,recallEnabled:true,status:'provisional',type:'episodic',subject:'owner',text:'吃面的一次闲聊',scope:{scenes:['private-reply']},visibility:'private',sourceIds,...extra})
test('maintenance deletes expired ordinary memory and releases source events without archiving the memory',async t=>{
 const x=setup(t),e=await x.store.ingestOwnerMessage({actor:'2',messageId:'1',text:'今天吃面'})
 await x.store.tx(s=>{s.memories.push(memory('old',e.at,[e.id]));s.cognition.cursor=s.cognition.seq;s.affect.cursor=s.cognition.seq})
 x.advance(100)
 const result=await x.store.maintainCognition();assert.equal(result.forgotten,1)
 const s=x.open().read();assert.equal(s.memories.length,0);assert.ok(!s.events.some(r=>r.id===e.id));assert.equal(s.archives.length,0)
 assert.equal(s.settings.forgottenMemories,1);assert.equal(x.store.dynamicStatus().automaticDeletion,true)
 assert.equal((await x.store.maintainCognition()).forgotten,0)
 assert.ok(!x.open().contextSnapshot('吃面','private-reply').text.includes('吃面的一次闲聊'))
})
test('important preferences, commitments and protected memories survive and remain usable',async t=>{
 const x=setup(t),at=x.store.now()
 await x.store.tx(s=>s.memories.push(
  memory('preference',at,[],{type:'preference',text:'不推荐带货',scope:{scenes:['private-recommendation'],scene:'recommend',field:'keyword',value:'带货'},effect:'exclude'}),
  memory('promise',at,[],{type:'commitment',text:'答应以后一起看纪录片'}),
  memory('protected',at,[],{lifecycle:{schema:1,recallControl:'enabled',retention:{class:'protected'}}})
 ))
 x.advance(100);assert.equal((await x.store.maintainCognition()).forgotten,0)
 assert.equal(x.open().read().memories.length,3)
 assert.match(x.open().contextSnapshot('带货','private-recommendation').text,/不推荐带货/)
})
test('in-flight formation keeps its base memory until the job expires',async t=>{
 const x=setup(t)
 await x.store.tx(s=>s.memories.push(memory('base',x.store.now())))
 x.advance(100)
 await x.store.ingestOwnerMessage({actor:'2',messageId:'1',text:'阳台种花很有趣'})
 const job=await x.store.planFormation({force:true});assert.ok(job.input.memories.some(m=>m.id==='base'))
 await x.store.submitFormation(job.jobId,job.token,{candidates:[]})
 assert.equal((await x.store.maintainCognition()).forgotten,0)
 x.advance(1);assert.equal((await x.store.maintainCognition()).forgotten,1)
})
test('a cold but not expired memory is not deleted merely because its tier is dormant',async t=>{
 const x=setup(t)
 await x.store.tx(s=>s.memories.push(memory('understanding',x.store.now(),[],{type:'understanding'})))
 x.advance(31);assert.equal((await x.store.maintainCognition()).forgotten,0)
 assert.equal(x.open().read().memories.length,1)
})

test('explicit autoDelete false retains expired records without misreporting deletion',async t=>{
 const x=setup(t,{dynamicMemory:{autoDelete:false}})
 await x.store.tx(s=>s.memories.push(memory('old',x.store.now())))
 x.advance(100);assert.equal((await x.store.maintainCognition()).forgotten,0)
 assert.equal(x.open().read().memories.length,1);assert.equal(x.store.dynamicStatus().automaticDeletion,false)
})

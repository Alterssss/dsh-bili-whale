import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {parseJsonExact} from '../tools/lib/json-exact.mjs'
import {latestFeedback} from '../tools/lib/dm-feedback.mjs'
import {createTrafficGuard,RISK_DEFAULTS} from '../tools/lib/traffic.mjs'
import {createCredentialStore} from '../lib/credentials.js'
import {createSessionDelivery} from '../lib/session-delivery.js'

function box(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-fixes-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir}
test('issue 39: exact JSON preserves IDs, quoted content, escaped quotes and ordinary numbers',()=>{
 const text=String.raw`{"id":1262823889456594949,"negative":-1262823889456594949,"nested":[9007199254740993],"safe":9007199254740991,"number":1.25e3,"content":"a,1234567890123456789] and \"1234567890123456789\""}`
 const j=parseJsonExact(text)
 assert.equal(j.id,'1262823889456594949');assert.equal(j.negative,'-1262823889456594949');assert.equal(j.nested[0],'9007199254740993')
 assert.equal(j.safe,Number.MAX_SAFE_INTEGER);assert.equal(j.number,1250)
 assert.equal(j.content,'a,1234567890123456789] and "1234567890123456789"')
 assert.throws(()=>parseJsonExact('{"id":01}'))
})
test('issue 32: silence uses actual incoming timestamp, ignores baseline, other owner and future dates',t=>{
 const home=box(t);fs.mkdirSync(path.join(home,'.bili-ai'))
 const file=path.join(home,'.bili-ai/dm-await-state.json'),now=Date.now(),old=new Date(now-7*86400000).toISOString(),ts=Math.floor((now-60000)/1000)
 fs.writeFileSync(file,JSON.stringify({owner:'222',lastSeen:now/1000,lastIncoming:ts}))
 assert.equal(latestFeedback(old,'222',home,now),new Date(ts*1000).toISOString())
 assert.equal(latestFeedback(old,'333',home,now),old)
 fs.writeFileSync(file,JSON.stringify({owner:'222',lastSeen:now/1000}))
 assert.equal(latestFeedback(old,'222',home,now),old)
 fs.writeFileSync(file,JSON.stringify({owner:'222',lastIncoming:now/1000+3600}))
 assert.equal(latestFeedback(old,'222',home,now),old)
})
const comment='https://api.bilibili.com/x/v2/reply/add',dm='https://api.vc.bilibili.com/web_im/v1/web_im/send_msg'
function traffic(t,{gap=60,transport}={}){
 let time=Date.now();const waits=[],calls=[]
 const guard=createTrafficGuard({directory:box(t),now:()=>time,sleep:async ms=>{waits.push(ms);time+=ms},settings:()=>({...RISK_DEFAULTS,dmGapSec:gap}),transport:async(u,o)=>{
   calls.push({url:u,time});if(transport)return transport(u,o)
   return new Response('{"code":0}',{headers:{'content-type':'application/json'}})
 }})
 return {guard,waits,calls,send:(url,body,waitWriteMs)=>guard.fetch(url,{method:'POST',headers:{cookie:'SESSDATA=fake'},body,waitWriteMs})}
}
test('issue 38: comment then DM waits cooldown and dispatches each exactly once',async t=>{
 const b=traffic(t);await b.send(comment,'message=comment');await b.send(dm,'message=notify',180000)
 assert.equal(b.calls.length,2);assert.ok(b.calls[1].time-b.calls[0].time>=60000)
 assert.equal(Object.keys(b.guard.status().operations).length,2)
})
test('issue 38: ordinary writes still reject cooldown; wait is bounded',async t=>{
 const b=traffic(t,{gap:300});await b.send(comment,'message=first')
 await assert.rejects(b.send(dm,'message=second',180000),/冷却/)
 await assert.rejects(b.send(comment,'message=third'),/冷却/)
 assert.equal(b.calls.length,1)
})
test('issue 38: uncertain send is never retried by cooldown waiting',async t=>{
 const b=traffic(t,{transport:async()=>{throw Error('connection lost')}})
 await assert.rejects(b.send(dm,'message=notify',180000),/结果不确定/)
 assert.equal(b.calls.length,1)
 await assert.rejects(b.send(dm,'message=notify',180000),/重复/)
 assert.equal(b.calls.length,1)
})
test('issue 38: waiting never bypasses pause, manual login or budgets',async t=>{
 const directory=box(t);const guard=createTrafficGuard({directory,settings:()=>RISK_DEFAULTS})
 fs.writeFileSync(path.join(directory,'traffic-state.json'),JSON.stringify({until:Date.now()+60000}))
 await assert.rejects(guard.fetch(dm,{method:'POST',body:'message=1',waitWriteMs:180000}),/暂停/)
})
const cred=n=>({sessdata:('cookie-'+n).padEnd(24,'x'),bili_jct:'a'.repeat(32),buvid3:''})
test('PR 35 bugfix: failed verification or file protection preserves old credential bytes',async t=>{
 const directory=box(t),file=path.join(directory,'credentials.json'),pending=path.join(directory,'pending.json'),old=JSON.stringify(cred('old'))
 fs.writeFileSync(file,old)
 const store=createCredentialStore({file,pending,verify:async()=>{throw Error('invalid cookie')},protect:()=>{}})
 await assert.rejects(store.save(cred('new')));assert.equal(fs.readFileSync(file,'utf8'),old)
 const failed=createCredentialStore({file,pending,verify:async()=>({mid:'222'}),protect:()=>{throw Error('disk error')}})
 await assert.rejects(failed.save(cred('new')));assert.equal(fs.readFileSync(file,'utf8'),old)
 assert.equal(fs.readdirSync(directory).length,1)
})
test('PR 35 bugfix: pending drafts prevent account changes; same account can refresh',async t=>{
 const directory=box(t),file=path.join(directory,'credentials.json'),pending=path.join(directory,'pending.json')
 fs.writeFileSync(file,JSON.stringify(cred('old')));fs.writeFileSync(pending,'{"items":[{"id":"draft"}]}')
 const store=createCredentialStore({file,pending,verify:async c=>({mid:c.sessdata.includes('other')?'333':'222'}),protect:()=>{}})
 await assert.rejects(store.save(cred('other')),/待审/)
 assert.equal(JSON.parse(fs.readFileSync(file)).sessdata,cred('old').sessdata)
 await store.save(cred('new'));assert.equal(JSON.parse(fs.readFileSync(file)).sessdata,cred('new').sessdata)
})
test('PR 35 bugfix: malformed pending queue blocks replacing account',async t=>{
 const directory=box(t),file=path.join(directory,'credentials.json'),pending=path.join(directory,'pending.json')
 fs.writeFileSync(file,JSON.stringify(cred('old')));fs.writeFileSync(pending,'broken')
 const store=createCredentialStore({file,pending,verify:async()=>({mid:'222'}),protect:()=>{}})
 await assert.rejects(store.save(cred('new')),/待审/)
 assert.equal(JSON.parse(fs.readFileSync(file)).sessdata,cred('old').sessdata)
})

test('DM retry stays in same session across rotation deadline and restart until receipt ack',async t=>{
 const dshHome=box(t);let now=Date.now();const requests=[],seen=new Set()
 const options={dshHome,cwd:dshHome,sessionId:'initial',config:()=>({sessionRotateDays:1}),persona:()=>'',now:()=>now,controller:{create:async()=>{},prompt:async r=>{requests.push(r);seen.add(r.sessionId+':'+r.requestId)}}}
 let delivery=createSessionDelivery(options)
 const request={requestId:'dm-receipt',content:[{type:'text',text:'hello'}]}
 await delivery.send(request,undefined,{retainUntilAck:true})
 now+=2*86400000;delivery=createSessionDelivery(options)
 await delivery.send(request,undefined,{retainUntilAck:true})
 assert.equal(requests.length,1,'accepted prompt must not be repeated when retrying ack');assert.equal(seen.size,1)
 await delivery.confirm(request.requestId);now+=9*60000
 await delivery.send({requestId:'next',content:[]})
 assert.notEqual(requests[1].sessionId,requests[0].sessionId)
})

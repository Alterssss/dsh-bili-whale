import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createTrafficGuard, RISK_DEFAULTS } from '../tools/lib/traffic.mjs'
import { pollDelay } from '../tools/lib/poll-policy.mjs'
const endpoint='https://api.bilibili.com/x/v2/reply/add'
const headers={cookie:'SESSDATA=test-secret'}
const ok=()=>new Response(JSON.stringify({code:0,data:{}}),{headers:{'content-type':'application/json'}})
function setup(t, override={},startAt=Date.now()) {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'whale-traffic-'))
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
 let time=startAt,calls=0
 const options={directory,settings:()=>({...RISK_DEFAULTS,...override}),now:()=>time,sleep:async ms=>{time+=ms},transport:async()=>{calls++;return ok()}}
 return {directory,options,guard:createTrafficGuard(options),advance:ms=>{time+=ms},calls:()=>calls,time:()=>time}
}
test('identical in-flight reads share one request and independent response bodies',async t=>{
 const s=setup(t)
 const results=await Promise.all([1,2,3].map(()=>s.guard.fetch('https://api.bilibili.com/x/web-interface/nav')))
 assert.equal(s.calls(),1)
 for(const r of results)assert.equal((await r.json()).code,0)
})
test('cross-process and cross-instance budgets survive restarts',async t=>{
 const s=setup(t,{readHourly:2})
 await s.guard.fetch('https://api.bilibili.com/x/one')
 await createTrafficGuard(s.options).fetch('https://api.bilibili.com/x/two')
 await assert.rejects(s.guard.fetch('https://api.bilibili.com/x/three'),/预算/)
 assert.equal(s.calls(),2)
 s.advance(3600001);await s.guard.fetch('https://api.bilibili.com/x/three');assert.equal(s.calls(),3)
})
test('HTTP Retry-After pauses every endpoint and cannot be bypassed by no-cache',async t=>{
 const s=setup(t)
 const guard=createTrafficGuard({...s.options,transport:async()=>new Response('',{status:429,headers:{'retry-after':'1200'}})})
 await guard.fetch('https://api.bilibili.com/x/one')
 assert.ok(guard.status().until>=s.time()+1200000)
 process.env.BILI_NO_CACHE='1';t.after(()=>delete process.env.BILI_NO_CACHE)
 await assert.rejects(createTrafficGuard(s.options).fetch('https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions'),/暂停/)
 assert.equal(s.calls(),0)
})
test('playback -412 also triggers a conservative pause',async t=>{
 const s=setup(t)
 const guard=createTrafficGuard({...s.options,transport:async()=>new Response(JSON.stringify({code:-412}),{headers:{'content-type':'application/json'}})})
 await guard.fetch('https://api.bilibili.com/x/player/wbi/playurl')
 assert.ok(guard.status().until>s.time())
})
test('captcha and expired credentials require explicit resume',async t=>{
 const s=setup(t)
 const guard=createTrafficGuard({...s.options,transport:async()=>new Response(JSON.stringify({code:12015}),{headers:{'content-type':'application/json'}})})
 await guard.fetch('https://api.bilibili.com/x/one',{headers})
 await assert.rejects(s.guard.fetch('https://api.bilibili.com/x/two',{headers}),/人工/)
 await s.guard.resume(headers)
 await s.guard.fetch('https://api.bilibili.com/x/two',{headers});assert.equal(s.calls(),1)
})
test('uncertain writes persist across restart, ignore volatile fields, require review',async t=>{
 const s=setup(t)
 const guard=createTrafficGuard({...s.options,transport:async()=>{throw new Error('socket closed')}})
 await assert.rejects(guard.fetch(endpoint,{method:'POST',headers,body:'message=private-text&csrf=old&timestamp=1'}),/结果不确定/)
 s.advance(200000)
 await assert.rejects(s.guard.fetch(endpoint,{method:'POST',headers,body:'timestamp=2&csrf=new&message=private-text'}),/重复/)
 const [id]=Object.keys(s.guard.status().operations)
 assert.doesNotMatch(fs.readFileSync(path.join(s.directory,'traffic-state.json'),'utf8'),/private-text|test-secret/)
 await s.guard.resolve(id,'not-sent')
 await s.guard.fetch(endpoint,{method:'POST',headers,body:'timestamp=3&message=private-text'})
 assert.equal(s.calls(),1)
 await assert.rejects(s.guard.fetch(endpoint,{method:'POST',headers,body:'timestamp=4&message=private-text'}),/重复/)
})
test('different writes still obey cooldown and daily caps',async t=>{
 // Keep this same-day assertion away from the real midnight boundary.
 const s=setup(t,{writeDaily:2},new Date().setHours(12,0,0,0))
 const send=text=>s.guard.fetch(endpoint,{method:'POST',headers,body:'message='+text})
 await send('one');await assert.rejects(send('two'),/冷却/)
 s.advance(120001);await send('two');s.advance(120001);await assert.rejects(send('three'),/预算/)
 assert.equal(s.calls(),2)
})
test('unrelated webhooks are not included in Bilibili request budgets',async t=>{
 const s=setup(t,{writeDaily:1})
 await s.guard.fetch('https://example.test/webhook',{method:'POST',body:'one'})
 await s.guard.fetch('https://example.test/webhook',{method:'POST',body:'two'})
 assert.equal(s.calls(),2);assert.deepEqual(s.guard.status(),{})
})
test('corrupt protection state refuses network instead of resetting budgets',async t=>{
 const s=setup(t);fs.writeFileSync(path.join(s.directory,'traffic-state.json'),'{broken')
 await assert.rejects(s.guard.fetch('https://api.bilibili.com/x/one'),/损坏/);assert.equal(s.calls(),0)
})
test('failed polling backs off to fifteen minutes and resets after success',()=>{
 assert.equal(pollDelay(60,0),60000);assert.equal(pollDelay(60,1),120000)
 assert.equal(pollDelay(60,20),900000);assert.equal(pollDelay(300,2),900000)
 assert.equal(pollDelay(60,0),60000)
})
test('independent Node processes share actual request spacing',async t=>{
 const s=setup(t)
 const file=fileURLToPath(new URL('./helpers/traffic-worker.mjs',import.meta.url))
 const run=i=>new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[file,s.directory,String(i)],{stdio:['ignore','pipe','pipe'],windowsHide:true})
   let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b)
   child.on('error',reject);child.on('exit',code=>code?reject(Error(err)):resolve(Number(out.trim())))
 })
 const times=(await Promise.all([1,2,3,4].map(run))).sort((a,b)=>a-b)
 for(let i=1;i<times.length;i++)assert.ok(times[i]-times[i-1]>=90,JSON.stringify(times))
 assert.equal(Object.values(s.guard.status().accounts)[0].readDay,4)
})

test('unauthenticated nav does not block public reads; another account stays independent',async t=>{
 const s=setup(t)
 const guard=createTrafficGuard({...s.options,transport:async()=>new Response('{"code":-101}',{headers:{'content-type':'application/json'}})})
 await guard.fetch('https://api.bilibili.com/x/web-interface/nav')
 assert.equal(guard.pauseReason({}),null)
 await guard.fetch('https://api.bilibili.com/x/web-interface/nav',{headers})
 assert.match(guard.pauseReason(headers),/人工/)
 assert.equal(guard.pauseReason({cookie:'SESSDATA=new-session'}),null)
})

test('actual CLI protects POST against duplicate invocations without test bypass',t=>{
 const s=setup(t)
 const data=path.join(s.directory,'.bili-ai');fs.mkdirSync(data)
 fs.writeFileSync(path.join(data,'credentials.json'),JSON.stringify({sessdata:'fake',bili_jct:'a'.repeat(32)}))
 const root=fileURLToPath(new URL('../',import.meta.url))
 const env={...process.env,HOME:s.directory,USERPROFILE:s.directory,DSH_HOME:path.join(s.directory,'.dsh'),TEST_REQUESTS:path.join(s.directory,'requests.log'),NODE_OPTIONS:'--import='+pathToFileURL(path.join(root,'tests/helpers/traffic-cli-fetch.mjs')).href}
 delete env.BILI_TRAFFIC_TEST
 const run=()=>spawnSync(process.execPath,[path.join(root,'tools/commands/comment-del.mjs'),'--oid','1','--rpid','2','--go'],{env,encoding:'utf8',timeout:15000})
 const first=run();assert.equal(first.status,0,first.stderr)
 const second=run();assert.notEqual(second.status,0);assert.match(second.stderr,/重复/)
 assert.equal(fs.readFileSync(env.TEST_REQUESTS,'utf8').trim().split('\n').length,1)
})

test('slow requests have only one active API request across guard instances',async t=>{
 const s=setup(t),starts=[]
 let active=0,max=0
 const options={directory:s.directory,settings:()=>({...RISK_DEFAULTS,minGapMs:20}),transport:async()=>{
   active++;max=Math.max(max,active);starts.push(Date.now());await new Promise(r=>setTimeout(r,100));active--;return ok()
 }}
 await Promise.all([1,2,3].map(i=>createTrafficGuard(options).fetch('https://api.bilibili.com/x/test?id='+i)))
 assert.equal(max,1);assert.equal(starts.length,3)
})

test('every backend fetch caller imports the traffic wrapper',()=>{
 const root=fileURLToPath(new URL('../',import.meta.url))
 for(const p of fs.readdirSync(path.join(root,'tools'),{recursive:true}).filter(p=>p.endsWith('.mjs'))) {
  if(p.replaceAll('\\','/')==='lib/traffic.mjs')continue
  const src=fs.readFileSync(path.join(root,'tools',p),'utf8')
  if(/\bfetch\(/.test(src))assert.match(src,/guardedFetch as fetch/,p)
 }
})

test('transport receives only fetch options and diagnostics distinguish transport failure',async t=>{
 const s=setup(t),error=Object.assign(Error('secret'),{code:'ECONNRESET'})
 const guard=createTrafficGuard({...s.options,transport:async(input,options)=>{assert.equal(options.waitWriteMs,undefined);assert.equal(options.dispatch,undefined);throw error}})
 await assert.rejects(guard.fetch('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg',{method:'POST',headers,body:'content=fixture',waitWriteMs:180000}),/结果不确定/)
 assert.equal(guard.status().last.phase,'transport');assert.equal(guard.status().last.errorCode,'ECONNRESET')
 assert.doesNotMatch(JSON.stringify(guard.status()),/secret/)
})

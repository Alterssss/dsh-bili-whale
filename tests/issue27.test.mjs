import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {createSessionDelivery} from '../lib/session-delivery.js'
import {watchOptions} from '../tools/lib/watch-options.mjs'

function fixture(t,cfg={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-27-'))
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  let time=10*86400000,block='PERSONA-A',busy=false,fail=false,createFail=false
  const sent=[],created=[]
  const args={dshHome:dir,cwd:dir,sessionId:'bili-whale',config:()=>cfg,persona:()=>block,now:()=>time,isBusy:()=>busy,
    controller:{async create(r){if(createFail)throw Error('create failed');created.push(r)},async prompt(r){if(fail)throw Error('send failed');sent.push(r)}}}
  const request={content:[{type:'text',text:'TASK'}]}
  return {dir,args,sent,created,request,make:()=>createSessionDelivery(args),advance:n=>time+=n,persona:s=>block=s,busy:b=>busy=b,fail:b=>fail=b,createFail:b=>createFail=b}
}
test('defaults repeat persona and do not create session state',async t=>{
  const f=fixture(t),d=f.make();await d.send(f.request);await d.send(f.request)
  assert.equal(f.sent.length,2);assert.ok(f.sent.every(r=>r.content[0].text.includes('PERSONA-A')))
  assert.equal(fs.existsSync(path.join(f.dir,'whale-session.json')),false)
})
test('failed delivery retries persona; concurrent channels inject only once; edits reinject',async t=>{
  const f=fixture(t,{personaOncePerSession:true}),d=f.make();f.fail(true)
  await assert.rejects(d.send(f.request),/send failed/);f.fail(false)
  await Promise.all([d.send(f.request),d.send(f.request),d.send(f.request)])
  assert.equal(f.sent.filter(r=>r.content[0].text.includes('PERSONA-A')).length,1)
  f.persona('PERSONA-B');await d.send(f.request);assert.match(f.sent.at(-1).content[0].text,/PERSONA-B/)
  // 2026-10-24 改（审查报告第 3 条）：重启后【第一次投递】现在会重新注入人设 ✓
  //   原因：DSH 的 create() 分不出"新建会话"还是"复用"，接口里没有那个信息 ✗
  //   与其赌"宿主会话还在"→ 她重启后失忆 ✗，不如每次重启多重注入一次（~1000 字）✓
  await f.make().send(f.request);assert.match(f.sent.at(-1).content[0].text,/PERSONA-B/)
})
test('rotation waits for idle, preserves old session and restores persona/diary',async t=>{
  const f=fixture(t,{sessionRotateDays:1,personaOncePerSession:true}),d=f.make()
  await d.send(f.request);f.advance(86400001);f.busy(true);await d.send(f.request)
  assert.equal(f.sent.at(-1).sessionId,'bili-whale')
  f.busy(false);f.advance(8*60000);await d.send(f.request)
  const r=f.sent.at(-1);assert.match(r.sessionId,/^[0-9a-f-]{36}$/);assert.match(r.content[0].text,/PERSONA-A/);assert.match(r.content[0].text,/whale-diary-private.md/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'whale-session.json'))).rotatedFrom,'bili-whale')
  await f.make().send(f.request);assert.equal(f.sent.at(-1).sessionId,r.sessionId)
})
test('restart respects delivery cooldown even when rotation becomes due',async t=>{
  const cfg={sessionRotateDays:0,personaOncePerSession:true},f=fixture(t,cfg)
  await f.make().send(f.request);f.advance(86400001);await f.make().send(f.request)
  cfg.sessionRotateDays=1;await f.make().send(f.request)
  assert.equal(f.sent.at(-1).sessionId,'bili-whale')
})
test('rotation creation failure does not commit a new session; aborted queue does not send',async t=>{
  const f=fixture(t,{sessionRotateDays:1}),d=f.make();await d.send(f.request);f.advance(86400001);f.createFail(true)
  await assert.rejects(d.send(f.request),/create failed/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'whale-session.json'))).id,'bili-whale')
  const abort=new AbortController();abort.abort();await assert.rejects(d.send(f.request,abort.signal));assert.equal(f.sent.length,1)
})
test('invalid state is reported without overwriting it',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.dir,'whale-session.json'),'broken')
  assert.throws(f.make,/会话状态损坏/);assert.equal(fs.readFileSync(path.join(f.dir,'whale-session.json'),'utf8'),'broken')
})
test('tile options do not consume positional output directory; invalid widths rejected',()=>{
  assert.deepEqual(watchOptions(['BVtest','--tile','800','4x4','out'],'default'),{bvid:'BVtest',grid:'4x4',outDir:'out',tile:800})
  assert.equal(watchOptions(['BVtest','--tile=1280'],'default').tile,1280)
  assert.equal(watchOptions(['BVtest'],'default').tile,720)
  for(const v of ['','NaN','239','1281','720.5'])assert.throws(()=>watchOptions(['BVtest','--tile='+v],'default'))
})
test('custom DSH_HOME is used by deps, notify and selftest without touching default .dsh',t=>{
  const f=fixture(t),dsh=path.join(f.dir,'custom-dsh');fs.mkdirSync(dsh)
  const env={...process.env,USERPROFILE:f.dir,HOME:f.dir,DSH_HOME:dsh,DSH_NODE:process.execPath,BILI_WHALE_CONFIG:'',NODE_OPTIONS:''}
  fs.writeFileSync(path.join(dsh,'bili-whale.config.json'),JSON.stringify({night:{windows:[{start:'20:00',end:'24:00'}]},notify:{type:'file'}}))
  fs.writeFileSync(path.join(dsh,'whale-night.json'),JSON.stringify({action:'wake',atMs:Date.now()+3600000}))
  const cli=fileURLToPath(new URL('../tools/bili.mjs',import.meta.url))
  const run=(...args)=>spawnSync(process.execPath,[cli,...args],{env,encoding:'utf8',timeout:30000})
  const deps=run('deps','--json');assert.equal(deps.error,undefined)
  assert.equal(JSON.parse(deps.stdout).items.find(i=>i.name==='生物钟').ok,true)
  const notice=run('notify','local path test');assert.equal(notice.status,0,notice.stderr)
  assert.match(fs.readFileSync(path.join(dsh,'whale-notify.log'),'utf8'),/local path test/)
  const self=run('selftest');assert.equal(self.error,undefined)
  assert.ok(self.stdout.split('\n').some(line=>line.includes('目录 DSH_HOME')&&line.includes(dsh)&&line.includes('✓')),self.stdout)
  assert.equal(fs.existsSync(path.join(f.dir,'.dsh')),false)
})

test('turn context is delivered every time without changing stable persona acknowledgement',async t=>{
  const f=fixture(t,{personaOncePerSession:true});let turn='TEMP-A'
  const d=createSessionDelivery({...f.args,turnContext:request=>{assert.equal(request,f.request);return turn}})
  await d.send(f.request)
  const firstHash=JSON.parse(fs.readFileSync(path.join(f.dir,'whale-session.json'))).personaHash
  turn='TEMP-B';await d.send(f.request)
  assert.doesNotMatch(f.sent[1].content[0].text,/PERSONA-A/)
  assert.match(f.sent[1].content[0].text,/TEMP-B/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'whale-session.json'))).personaHash,firstHash)
  f.persona('PERSONA-C');await d.send(f.request)
  assert.match(f.sent[2].content[0].text,/PERSONA-C/)
  turn='TEMP-RETRY';f.fail(true);await assert.rejects(d.send(f.request));f.fail(false)
  await d.send(f.request);assert.match(f.sent.at(-1).content[0].text,/TEMP-RETRY/)
  assert.equal(f.request.content[0].text,'TASK')
})

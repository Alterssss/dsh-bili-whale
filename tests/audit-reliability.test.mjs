import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {createFormationWorker,parseFormationOutput} from '../lib/formation-worker.js'
import {createLifeStore} from '../tools/lib/life-store.mjs'
import {createJsonCache} from '../lib/json-cache.js'
import {createDiagnostics} from '../tools/lib/diagnostics.mjs'
import {createTrafficGuard} from '../tools/lib/traffic.mjs'
import {cognitionIndexes} from '../tools/lib/cognition.mjs'
import {withOperationSignal} from '../tools/lib/operation-context.mjs'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

const cfg=()=>({self:{mid:'1'},owner:{mid:'2'}})
function setup(t){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-audit-'))
 t.after(()=>fs.rmSync(home,{force:true,recursive:true}))
 const store=createLifeStore({dshHome:home,account:'1',owner:'2'})
 return {home,store}
}
test('maintenance hang times out; concurrent tick is busy; next tick recovers',async()=>{
 let hang=true
 const store={read:()=>({settings:{}}),maintainCognition:()=>hang?new Promise(()=>{}):Promise.resolve(),claimReview:async()=>null,planFormation:async()=>null}
 const w=createFormationWorker({complete:()=>assert.fail(),store:()=>store,config:cfg,timeoutMs:30})
 const pending=w.tick();assert.equal((await w.tick()).status,'busy')
 assert.equal((await pending).status,'timeout');hang=false
 assert.equal((await w.tick()).status,'idle')
})
test('maintenance remains active when direct model adapter is unavailable',async()=>{
 let calls=0
 const w=createFormationWorker({store:()=>({read:()=>({settings:{}}),maintainCognition:async()=>calls++,claimReview:()=>assert.fail()}),config:cfg})
 assert.equal((await w.tick()).status,'unavailable');assert.equal(calls,1)
})
test('stalled claim cannot invoke model after timeout',async()=>{
 let resume,calls=0
 const store={read:()=>({settings:{}}),maintainCognition:async()=>{},claimReview:()=>new Promise(r=>resume=r)}
 const w=createFormationWorker({complete:()=>calls++,store:()=>store,config:cfg,timeoutMs:20})
 assert.equal((await w.tick()).status,'timeout')
 resume({jobId:'late',stage:'review',input:{}});await delay(5);assert.equal(calls,0)
})
test('late model result is not submitted after deadline',async t=>{
 const {store}=setup(t);await store.ingestOwnerMessage({actor:'2',messageId:'1',text:'你好'})
 let resume,modelSignal
 const w=createFormationWorker({complete:r=>{modelSignal=r.signal;return new Promise(resolve=>resume=resolve)},store:()=>store,config:cfg,timeoutMs:100})
 assert.equal((await w.tick()).status,'timeout');assert.equal(modelSignal.aborted,true)
 resume('{"candidates":[]}');await delay(10)
 assert.equal(store.learningStatus().jobs[0].stage,'retry_pending');assert.equal(store.learningStatus().cursor,0)
})
test('stop aborts model and reports stopped separately',async()=>{
 const controller=new AbortController()
 const w=createFormationWorker({complete:()=>new Promise(()=>{}),store:()=>({read:()=>({settings:{}}),maintainCognition:async()=>{},claimReview:async()=>null,planFormation:async()=>({stage:'extract',input:{}})}),config:cfg,signal:controller.signal})
 const pending=w.tick();controller.abort();assert.equal((await pending).status,'stopped');assert.equal((await w.tick()).status,'stopped')
})
test('cancelled transaction cannot commit after delayed callback',async t=>{
 const {store}=setup(t),controller=new AbortController();let resume,entered
 const ready=new Promise(r=>entered=r)
 const pending=withOperationSignal(controller.signal,()=>store.tx(async s=>{entered();await new Promise(r=>resume=r);s.settings.late=true}))
 await ready;controller.abort(Error('expired'));resume()
 await assert.rejects(pending,/expired/);assert.equal(store.read().settings.late,undefined)
 await store.tx(s=>{s.settings.recovered=true});assert.equal(store.read().settings.recovered,true)
})
test('empty maintenance and idle planning do not increment revision or rewrite files',async t=>{
 const {store}=setup(t);await store.maintainCognition()
 const before=store.read().revision
 for(let i=0;i<5;i++){await store.maintainCognition();await store.claimReview();await store.planFormation()}
 assert.equal(store.read().revision,before)
})
test('no-op still returns result and runs afterCommit',async t=>{
 const {store}=setup(t);await store.maintainCognition()
 assert.equal(await store.tx(()=>7,x=>x+1),8)
})
test('no-op repairs missing or behind projection without a new checkpoint revision',async t=>{
 const {store}=setup(t);await store.maintainCognition()
 const old=store.read();await store.tx(s=>{s.settings.newValue=1})
 const revision=store.read().revision
 fs.writeFileSync(store.file,JSON.stringify(old));await store.maintainCognition()
 assert.equal(JSON.parse(fs.readFileSync(store.file)).revision,revision)
 fs.rmSync(store.file);await store.maintainCognition()
 assert.equal(JSON.parse(fs.readFileSync(store.file)).revision,revision)
 assert.equal(store.read().settings.newValue,1)
})
test('output rejects acknowledgement, markdown, scalars and oversized content',()=>{
 for(const raw of [{accepted:true},'null','[]','1','```json\n{}\n```',' '.repeat(32769)])assert.throws(()=>parseFormationOutput(raw))
 assert.deepEqual(parseFormationOutput('{"candidates":[]}'),{candidates:[]})
})
test('invalid model output leaves cursor unchanged and surfaces failed stage',async t=>{
 const {store}=setup(t);await store.ingestOwnerMessage({actor:'2',messageId:'1',text:'hi'})
 const w=createFormationWorker({complete:async()=>'{"candidates":"invalid-batch"}',store:()=>store,config:cfg})
 assert.equal((await w.tick()).status,'failed');assert.equal(store.learningStatus().cursor,0)
})
test('cache avoids duplicate parses, returns independent objects, observes atomic replacement',t=>{
 const {home}=setup(t),file=path.join(home,'c.json'),cache=createJsonCache()
 fs.writeFileSync(file,'{"v":1}');const first=cache.read(file);first.v=99
 assert.equal(cache.read(file).v,1)
 fs.writeFileSync(file+'.tmp','{"v":2}');fs.renameSync(file+'.tmp',file)
 assert.equal(cache.read(file).v,2)
 fs.writeFileSync(file,'broken');assert.throws(()=>cache.read(file))
 fs.rmSync(file);assert.throws(()=>cache.read(file),{code:'ENOENT'})
})
test('diagnostics are throttled and do not print raw private error messages',()=>{
 let at=0;const lines=[],d=createDiagnostics({now:()=>at,emit:x=>lines.push(x)})
 const e=Object.assign(Error('SECRET_COOKIE'),{code:'EIO'})
 d('storage',e);d('storage',e);assert.equal(lines.length,1);assert.ok(!lines[0].includes('SECRET_COOKIE'))
 at=300000;d('storage',e);assert.equal(lines.length,2)
})
test('corrupt legacy traffic ban blocks transport instead of ignoring protection',async t=>{
 const {home}=setup(t);fs.writeFileSync(path.join(home,'api-ban.json'),'broken')
 let calls=0
 const g=createTrafficGuard({directory:home,transport:async()=>{calls++},settings:()=>({minGapMs:1})})
 await assert.rejects(g.fetch('https://api.bilibili.com/x/test'),/风控状态/);assert.equal(calls,0)
})
test('invalid traffic state blocks transport',async t=>{
 const {home}=setup(t);fs.writeFileSync(path.join(home,'traffic-state.json'),'broken')
 const g=createTrafficGuard({directory:home,transport:async()=>assert.fail(),settings:()=>({})})
 await assert.rejects(g.fetch('https://api.bilibili.com/x/test'),/状态损坏/)
})
test('origin index tracks references and rebuilds on event append and replacement',()=>{
 const s={events:[{id:'a'},{id:'b',originEvidenceIds:['a']}]}
 assert.deepEqual([...cognitionIndexes(s).byOrigin.get('a')],['a','b'])
 const first=cognitionIndexes(s);assert.equal(cognitionIndexes(s),first)
 s.events.push({id:'c',originEvidenceIds:['a']});assert.equal(cognitionIndexes(s).byOrigin.get('a').size,3)
 s.events=[{id:'d'}];assert.equal(cognitionIndexes(s).byId.has('a'),false)
})
test('life settings are removed from the UI',()=>{
 const src=fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8')
 const fields=src.split('\n').filter(x=>x.startsWith('{"group":')).map(x=>JSON.parse(x.trim().replace(/,$/,''))).filter(x=>x.path[0]==='life')
 assert.equal(fields.length,0)
 assert.doesNotMatch(src,/直播间监听/)
 assert.ok(fields.every(x=>!['number','list'].includes(x.kind)))
})
for(const mode of ['request-log','ban-write'])test('API storage failure semantics: '+mode,t=>{
 const {home}=setup(t)
 const r=spawnSync(process.execPath,[fileURLToPath(new URL('./helpers/audit-api-failure.mjs',import.meta.url)),mode],{encoding:'utf8',timeout:10000,env:{...process.env,USERPROFILE:home,HOME:home,DSH_HOME:home,BILI_WHALE_CONFIG:path.join(home,'cfg.json'),BILI_NO_CACHE:'0',BILI_TRAFFIC_TEST:'1'}})
 assert.equal(r.status,0,r.stdout+r.stderr);assert.doesNotMatch(r.stderr,/private/)
})

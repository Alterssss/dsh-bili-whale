process.env.BILI_TRAFFIC_TEST = '1'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url))
function sandbox(t,cfg={}) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'bili-whale-test-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  const dsh=path.join(home,'portable/profile')
  fs.mkdirSync(dsh,{recursive:true});fs.mkdirSync(path.join(home,'.bili-ai'))
  fs.writeFileSync(path.join(dsh,'bili-whale.config.json'),JSON.stringify({self:{mid:'111'},owner:{mid:'222',name:'Owner'},listen:{comment:false,dm:false,live:false},...cfg}))
  fs.writeFileSync(path.join(home,'.bili-ai/credentials.json'),JSON.stringify({sessdata:'test-cookie-not-a-real-account',bili_jct:'a'.repeat(32)}))
  return {...process.env,USERPROFILE:home,HOME:home,DSH_HOME:dsh,DSH_NODE:process.execPath,BILI_WHALE_CONFIG:path.join(dsh,'bili-whale.config.json'),TEST_REQUESTS:path.join(home,'requests.jsonl'),NODE_OPTIONS:'--import='+pathToFileURL(path.join(root,'tests/helpers/mock-fetch.mjs')).href}
}
function run(env,file,args=[]) { const r=spawnSync(process.execPath,[path.join(root,file),...args],{env,encoding:'utf8',timeout:15000});assert.ifError(r.error);return r }
const requests=env=>fs.existsSync(env.TEST_REQUESTS)?fs.readFileSync(env.TEST_REQUESTS,'utf8'):''
const args=['--msg','BV1234567890','--share','--go','--reason','这是值得分享的视频','--score','15','--rank','1']

for(const via of ['dm','comment'])test('affect plan actual CLI dry/go sends once with share route '+via,t=>{
 const chat=via==='comment'?{idle:true,idleHours:3,chance:1}:{}
 const env=sandbox(t,{life:{autonomy:true},share:{via},chat,night:{windows:[{start:'00:00',end:'24:00',wakes:2}]}})
 env.TEST_AFFECT_NOW=String(Date.parse('2026-10-29T12:00:00+08:00'))
 const setup=run(env,'tests/helpers/affect-cli.mjs');assert.equal(setup.status,0,setup.stdout+setup.stderr)
 const p=JSON.parse(setup.stdout),args=['--draft',p.draftId,'--affect-plan',p.planId]
 const dry=run(env,'tools/commands/dm.mjs',[...args,'--dry']);assert.equal(dry.status,0,dry.stdout+dry.stderr);assert.doesNotMatch(requests(env),/POST/)
 const go=run(env,'tools/commands/dm.mjs',[...args,'--go']);assert.equal(go.status,0,go.stdout+go.stderr)
 const folder=path.join(env.DSH_HOME,'whale-life'),ns=fs.readdirSync(folder)[0],state=JSON.parse(fs.readFileSync(path.join(folder,ns,'state.json'),'utf8'))
 if(via==='comment')assert.equal(state.affect.pendingInitiative.opportunity.kind,'idle')
 assert.equal(state.affect.pendingInitiative.status,'sent');assert.equal(state.affect.share.value,80-12) // fixture balance minus the confirmed shared-interest topic
 const again=run(env,'tools/commands/dm.mjs',[...args,'--go']);assert.notEqual(again.status,0);assert.equal(requests(env).split('\n').filter(l=>l.includes('/send_msg')).length,1)
})

test('platform success without message id retains unknown write instead of fabricating a receipt',t=>{
 const env=sandbox(t);env.TEST_NO_DM_RECEIPT='1'
 const first=run(env,'tools/commands/dm.mjs',['--msg','receipt uncertainty fixture','--go'])
 assert.notEqual(first.status,0);assert.match(first.stderr,/回执/)
 const again=run(env,'tools/commands/dm.mjs',['--msg','receipt uncertainty fixture','--go'])
 assert.notEqual(again.status,0);assert.equal(requests(env).split('\n').filter(l=>l.includes('/send_msg')).length,1)
})
test('scheduler public diary sends its committed text once through simulated owner DM',t=>{
 const env=sandbox(t,{life:{hardMode:'off'},diary:{enabled:true,push:true},notify:{type:'dm'}})
 const r=run(env,'tests/helpers/diary-scheduler.mjs');assert.equal(r.status,0,r.stdout+r.stderr)
 assert.equal(requests(env).split('\n').filter(line=>line.includes('/send_msg')).length,1)
})
test('notify dry never sends a DM',t=>{const env=sandbox(t,{notify:{type:'dm'}});const r=run(env,'tools/commands/notify.mjs',['preview','--dry']);assert.equal(r.status,0,r.stderr);assert.equal(requests(env),'')})
test('disabled DM share is rejected before network access',t=>{const env=sandbox(t,{share:{enabled:false}});const r=run(env,'tools/commands/dm.mjs',args);assert.notEqual(r.status,0);assert.equal(requests(env),'')})
test('unscored DM share is rejected before network access',t=>{const env=sandbox(t);const r=run(env,'tools/commands/dm.mjs',['--msg','BV1234567890','--share','--go']);assert.notEqual(r.status,0);assert.equal(requests(env),'')})
test('valid DM share works and repeated video is blocked',t=>{const env=sandbox(t);const r=run(env,'tools/commands/dm.mjs',args);assert.equal(r.status,0,r.stderr);assert.equal((requests(env).match(/POST/g)??[]).length,1);const again=run(env,'tools/commands/dm.mjs',args);assert.notEqual(again.status,0);assert.equal((requests(env).match(/POST/g)??[]).length,1)})
test('ordinary owner DM does not require sharing score',t=>{const env=sandbox(t,{share:{enabled:false}});const r=run(env,'tools/commands/dm.mjs',['--msg','hello','--go']);assert.equal(r.status,0,r.stderr)})
test('comment uses the same score rule',t=>{const env=sandbox(t);const r=run(env,'tools/commands/comment.mjs',['--oid','1','--bvid','BV1234567890','--message','hello','--share','--auto','--go']);assert.notEqual(r.status,0);assert.equal(requests(env),'')})

test('issue 39 actual comment CLI: invalid dynamic target blocks go and dry; valid dry never posts',t=>{
 const env=sandbox(t),args=['--oid','1262823889456594949','--type','17','--referer','https://www.bilibili.com/opus/1262823889456594949','--message','hello']
 env.TEST_TARGET_CODE='-404'
 for(const mode of ['--go','--dry']){const r=run(env,'tools/commands/comment.mjs',[...args,mode]);assert.equal(r.status,6,r.stdout+r.stderr);assert.match(r.stderr,/目标不存在/)}
 env.TEST_TARGET_CODE='0';const r=run(env,'tools/commands/comment.mjs',[...args,'--dry']);assert.equal(r.status,0,r.stdout+r.stderr)
 assert.doesNotMatch(requests(env),/POST/)
})
test('custom home, persona, diary and failed approval recovery',t=>{const r=run(sandbox(t),'tests/helpers/plugin.mjs');assert.equal(r.status,0,r.stderr)})
test('successful approval removes draft',t=>{const env=sandbox(t);env.TEST_SEND_SUCCESS='1';const r=run(env,'tests/helpers/plugin.mjs');assert.equal(r.status,0,r.stderr)})

test('real DM command writes life receipt and blocks repeat before second POST',t=>{
 const env=sandbox(t),args=['--msg','life receipt fixture','--go']
 const first=run(env,'tools/commands/dm.mjs',args);assert.equal(first.status,0,first.stdout+first.stderr)
 const root=path.join(env.DSH_HOME,'whale-life'),namespace=fs.readdirSync(root)[0]
 const state=JSON.parse(fs.readFileSync(path.join(root,namespace,'state.json'),'utf8'))
 assert.equal(state.events.filter(e=>e.kind==='sent').length,1);assert.equal(Object.keys(state.pending).length,0)
 const second=run(env,'tools/commands/dm.mjs',args);assert.notEqual(second.status,0);assert.match(second.stderr,/相同内容/)
 assert.equal(requests(env).split('\n').filter(line=>line.includes('/send_msg')).length,1)
})
test('debrief without frames records provenance without claiming images were seen',t=>{
 const env=sandbox(t);env.NODE_OPTIONS='--import='+pathToFileURL(path.join(root,'tests/helpers/debrief-fetch.mjs')).href
 const r=run(env,'tools/commands/debrief.mjs',['BV1234567890','--no-frames']);assert.equal(r.status,0,r.stdout+r.stderr)
 const folder=path.join(env.DSH_HOME,'whale-life'),namespace=fs.readdirSync(folder)[0]
 const state=JSON.parse(fs.readFileSync(path.join(folder,namespace,'state.json'),'utf8')),e=state.events.find(e=>e.kind==='video-read')
 assert.equal(e.data.framesPrepared,false);assert.equal(e.data.readByModel,false);assert.equal(e.data.aid,'123');assert.match(r.stdout,/来源事件 ID/)
 assert.equal(e.data.tid,218);assert.equal(e.data.tname,'动物圈');assert.match(r.stdout,/写法参考数据/);assert.match(r.stdout,/seed:20261027/)
})
test('missing runtime reports scheduler failure',t=>{const env=sandbox(t);delete env.DSH_NODE;env.PATH='';delete env.ProgramFiles;env.TEST_NO_NODE='1';const r=run(env,'tests/helpers/plugin.mjs');assert.equal(r.status,0,r.stderr)})
test('real scheduler: midnight, retries, history, persona and disposal',t=>{const r=run(sandbox(t),'tests/helpers/scheduler.mjs');assert.equal(r.status,0,r.stderr)})
test('DM delivery retries persisted message and acknowledges only after success',t=>{const r=run(sandbox(t),'tests/helpers/dm-delivery.mjs');assert.equal(r.status,0,r.stderr)})

test('late delivery and watchdog recovery preserve deduplication for all three channels',t=>{
  const r=run(sandbox(t),'tests/helpers/scheduler-timeout.mjs');assert.equal(r.status,0,r.stdout+r.stderr)
})

test('hung wake releases actual scheduler and queue; DM, comments and later wake continue',t=>{
  const r=run(sandbox(t),'tests/helpers/scheduler-recovery.mjs');assert.equal(r.status,0,r.stdout+r.stderr)
})

for(const scenario of ['dm','comment','notify'])test('real scheduler recovery and uncertainty handling '+scenario,t=>{
  const r=run(sandbox(t),'tests/helpers/listener-recovery.mjs',[scenario]);assert.equal(r.status,0,r.stdout+r.stderr)
})

test('health check distinguishes a completed plan from a later overdue plan',t=>{
  const env=sandbox(t,{night:{windows:[{start:'00:00',end:'24:00',wakes:2}]}})
  const dir=env.DSH_HOME;fs.mkdirSync(dir,{recursive:true})   // 2026-10-23: 状态文件跟 DSH_HOME 走 ✓ 不是 HOME/.dsh ✗
  fs.writeFileSync(path.join(dir,'whale-scheduler.json'),JSON.stringify({schema:1,instanceId:'test-host',recent:[],status:'idle',lastTickAt:Date.now()}))
  for(const fired of [false,true]) {
    fs.writeFileSync(path.join(dir,'whale-night.json'),JSON.stringify({action:'wake',wakes:1,atMs:Date.now()-3600000,fired,woke:fired}))
    const r=run(env,'tools/commands/deps.mjs',['--json'])
    const item=JSON.parse(r.stdout).items.find(x=>x.name==='生物钟')
    assert.equal(item.ok,fired,JSON.stringify(item))
    assert.match(item.detail, fired ? /已执行/ : /还没执行/)
  }
})
test('dynamic root comment check uses type 11 and normalizes root zero',t=>{
 const env=sandbox(t)
 const r=run(env,'tools/commands/comment.mjs',['--oid','1','--root','0','--parent','9','--type','11','--check'])
 assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/是主人/);assert.doesNotMatch(requests(env),/POST/)
})
test('CLI plan is stable between processes',t=>{const env=sandbox(t);const a=run(env,'tools/commands/whale-night.mjs',['plan']);const b=run(env,'tools/commands/whale-night.mjs',['plan']);assert.equal(a.status,0,a.stderr);assert.deepEqual(JSON.parse(a.stdout),JSON.parse(b.stdout))})

test('digest uses custom config, exact identity and clean JSON on partial failure',t=>{
  const env=sandbox(t), now=Math.floor(Date.now()/1000)
  env.TEST_FEEDS=path.join(env.HOME,'feeds.json')
  const item=(id,mid,nickname)=>({id,user:{mid,nickname},reply_time:now,item:{source_content:'Owner 222 mentioned in text',source_id:id}})
  fs.writeFileSync(env.TEST_FEEDS,JSON.stringify({reply:[item('1',999,'Owner'),item('2',222,'Renamed')],at:[]}))
  let r=run(env,'tools/commands/comment-digest.mjs',['--json']);assert.equal(r.status,0,r.stderr)
  let j=JSON.parse(r.stdout);assert.equal(j.ownerReplies,1);assert.equal(j.ownerReplyItems[0].id,'2')
  fs.writeFileSync(env.TEST_FEEDS,JSON.stringify({reply:{error:true},at:[]}))
  r=run(env,'tools/commands/comment-digest.mjs',['--json']);j=JSON.parse(r.stdout);assert.equal(j.ok,false);assert.equal(j.ownerReplies,0)
})
test('quota react does not refresh silence when an old result disappears',t=>{
  const env=sandbox(t), now=Math.floor(Date.now()/1000)-3600
  env.TEST_FEEDS=path.join(env.HOME,'feeds.json')
  const a={id:'1',user:{mid:222,nickname:'Owner'},reply_time:now,item:{source_content:'reply A',source_id:'1'}}
  const b={...a,id:'2',reply_time:now+10,item:{source_content:'reply B',source_id:'2'}}
  fs.writeFileSync(env.TEST_FEEDS,JSON.stringify({reply:[a,b],at:[],like:[]}))
  let r=run(env,'tools/commands/quota.mjs',['react','--auto']);assert.equal(r.status,0,r.stderr)
  const file=path.join(env.HOME,'.bili-ai/feedback.json'),before=JSON.parse(fs.readFileSync(file))
  assert.equal(before.events.length,1);assert.equal(Date.parse(before.last),(now+10)*1000)
  fs.writeFileSync(env.TEST_FEEDS,JSON.stringify({reply:[b],at:[],like:[]}))
  r=run(env,'tools/commands/quota.mjs',['react','--auto']);assert.equal(r.status,0,r.stderr)
  const after=JSON.parse(fs.readFileSync(file));assert.equal(after.last,before.last);assert.equal(after.events.length,1)
})
test('stable device ID reused across sends and persistence failure stops send',t=>{
  const env=sandbox(t), id=path.join(env.HOME,'.bili-ai/dev_id')
  assert.equal(run(env,'tools/commands/dm.mjs',['--msg','one','--go']).status,0)
  const first=fs.readFileSync(id,'utf8')
  assert.equal(run(env,'tools/commands/dm.mjs',['--msg','two','--go']).status,0)
  assert.equal(fs.readFileSync(id,'utf8'),first)
  fs.unlinkSync(id);fs.mkdirSync(id)
  assert.notEqual(run(env,'tools/commands/dm.mjs',['--msg','three','--go']).status,0)
  assert.equal((requests(env).match(/POST/g)??[]).length,2)
})

test('notify returns failure when DM delivery fails',t=>{
  const env=sandbox(t,{notify:{type:'dm'},owner:{mid:'',name:''}})
  const r=run(env,'tools/commands/notify.mjs',['summary'])
  assert.notEqual(r.status,0);assert.equal((requests(env).match(/POST/g)??[]).length,0)
})

for(const scenario of ['compat','setup','write','timeout','manual'])test('host recovery actual scheduler '+scenario,t=>{
 const r=run(sandbox(t),'tests/helpers/scheduler-host-recovery.mjs',[scenario]);assert.equal(r.status,0,r.stdout+r.stderr)
})
test('manual trigger CLI requires explicit action and dry writes no mailbox',t=>{
 const env=sandbox(t,{night:{windows:[{start:'00:00',end:'24:00',wakes:2}],skipChance:0}})
 assert.notEqual(run(env,'tools/bili.mjs',['night','trigger']).status,0)
 const r=run(env,'tools/bili.mjs',['night','trigger','--dry']);assert.equal(r.status,0,r.stdout+r.stderr)
 assert.equal(fs.existsSync(path.join(env.DSH_HOME,'whale-night-trigger.json')),false)
 assert.notEqual(run(env,'tools/bili.mjs',['night','trigger','--go']).status,0)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {createScopedDelivery,legacyScopeKeys} from '../lib/scoped-delivery.js'
import {readDeliveries,updateDelivery} from '../lib/delivery-state.js'
import {BEHAVIOR_ROOT,loadBehavior} from '../tools/lib/behavior.mjs'
import {listStickers,getSticker,stickerHint} from '../tools/lib/stickers.mjs'
import {createLifeStore} from '../tools/lib/life-store.mjs'
import {expressionPrompt,prepareExpression} from '../tools/lib/expression.mjs'

function fixture(t,extra={}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-behavior-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
 let generation=0;const calls=[],created=[],cfg={self:{mid:'1'},owner:{mid:'2'},personaOncePerSession:true}
 const opts={dshHome:home,cwd:home,config:()=>cfg,persona:()=> '合成测试人设',permissionVersion:()=>generation,memoryContext:()=>({text:'',blocked:false}),controller:{create:async r=>created.push(r),prompt:async r=>calls.push(r)},...extra}
 return {home,calls,created,cfg,opts,make:()=>createScopedDelivery(opts),revoke:()=>generation++}
}
const req=(id,extra={})=>({requestId:id,memoryScene:'private-reply',taskKind:'private-reply',memoryQuery:'累了',sourceEventIds:['event-now'],content:[{type:'text',text:'当前消息'}],...extra})
const browse=id=>req(id,{memoryScene:'public-recommendation',sessionRole:'browse-main',taskKind:'browse'})

test('stable browse survives share switches and restart, separate from private and public tasks',async t=>{
 const f=fixture(t);let d=f.make()
 for(const via of ['comment','dm','comment']){f.cfg.share={via};await d.send(browse('wake-'+via+'-'+f.calls.length))}
 assert.equal(new Set(f.calls.map(x=>x.sessionId)).size,1)
 const browsing=f.calls[0].sessionId;d=f.make();await d.send(browse('restart'));assert.equal(f.calls.at(-1).sessionId,browsing)
 await d.send(req('private'));assert.notEqual(f.calls.at(-1).sessionId,browsing)
 const privateId=f.calls.at(-1).sessionId;await d.send(req('private-rec',{memoryScene:'private-recommendation'}));assert.equal(f.calls.at(-1).sessionId,privateId)
 await d.send(req('public-1',{memoryScene:'public-comment'}));const p=f.calls.at(-1).sessionId
 await d.send(req('public-2',{memoryScene:'public-comment'}));assert.notEqual(f.calls.at(-1).sessionId,p)
 f.revoke();await d.send(browse('permission'));assert.notEqual(f.calls.at(-1).sessionId,browsing)
})

test('internal routing, query and source metadata never reach host prompt schema',async t=>{
 const seen=[],f=fixture(t,{memoryContext:r=>{seen.push(r);return {text:''}}}),d=f.make()
 await d.send(browse('meta'))
 assert.equal(seen[0].memoryQuery,'累了');assert.equal(seen[0].sessionRole,'browse-main')
 for(const k of ['memoryQuery','sourceEventIds','sessionRole','taskKind','memoryScene'])assert.equal(Object.hasOwn(f.calls[0],k),false,k)
 assert.throws(()=>d.send(req('unsafe',{sessionRole:'browse-main'})),/角色/)
})

test('legacy accepted and uncertain browsing deliveries cannot be replayed into new scope',async t=>{
 const f=fixture(t),d=f.make()
 for(const [i,status] of ['accepted','unconfirmed','dispatching'].entries()){
   const id='old-'+i,scope=legacyScopeKeys('1','2','private-recommendation',id)[0]
   updateDelivery(f.home,id,{attempt:'attempt',sessionId:'old-session',startedAt:1,updatedAt:1,status,scopeKey:scope,retained:true})
   fs.writeFileSync(path.join(f.home,'whale-session-'+scope+'.json'),JSON.stringify({id:'old-session',startedAt:1,pendingRequest:id}))
   if(status==='accepted'){await d.send(browse(id));await d.confirm(id);assert.equal(readDeliveries(f.home).find(x=>x.requestId===id).retained,false);assert.equal(JSON.parse(fs.readFileSync(path.join(f.home,'whale-session-'+scope+'.json'))).pendingRequest,undefined)}
   else await assert.rejects(d.send(browse(id)),e=>e.code==='DELIVERY_UNCONFIRMED')
 }
 assert.equal(f.calls.length,0)
 const id='foreign';updateDelivery(f.home,id,{attempt:'a',sessionId:'s',startedAt:1,updatedAt:1,status:'accepted',scopeKey:legacyScopeKeys('9','2','public-recommendation',id)[0]})
 await assert.rejects(d.send(browse(id)),/另一账号/)
})

test('blocked browse delivery does not block private queue or create a replacement browse session',async t=>{
 const f=fixture(t,{timeoutMs:40});let blockedId
 f.opts.controller.prompt=async r=>{if(r.requestId==='stuck'){blockedId=r.sessionId;return new Promise(()=>{})}f.calls.push(r)}
 const d=f.make(),pending=assert.rejects(d.send(browse('stuck')),e=>e.code==='DELIVERY_UNCONFIRMED')
 await d.send(req('answer'));await pending;assert.equal(f.calls[0].requestId,'answer')
 await d.send(browse('next'));assert.equal(f.calls.at(-1).sessionId,blockedId)
})

test('norm chapters stay complete on every task, reload and restart',async t=>{
 const f=fixture(t),root=path.join(f.home,'behavior');fs.cpSync(BEHAVIOR_ROOT,root,{recursive:true});f.opts.behaviorRoot=root
 let d=f.make();await d.send(req('first'));assert.match(f.calls.at(-1).content[0].text,/# 主人私信/)
 await d.send(req('second'));assert.match(f.calls.at(-1).content[0].text,/# 主人私信/);assert.match(f.calls.at(-1).content[0].text,/# 通用边界/)
 const file=path.join(root,'private-reply.md');fs.appendFileSync(file,'\n本版新增说明。\n')
 await d.send(req('changed'));assert.match(f.calls.at(-1).content[0].text,/本版新增说明/);assert.match(f.calls.at(-1).content[0].text,/# 通用边界/)
 const id=f.calls.at(-1).sessionId;d=f.make();await d.send(req('boot'));assert.equal(f.calls.at(-1).sessionId,id);assert.match(f.calls.at(-1).content[0].text,/# 主人私信/)
})

test('failed prompt never marks normative chapters delivered',async t=>{
 const f=fixture(t);let fail=true
 f.opts.controller.prompt=async r=>{if(fail)throw Error('rejected');f.calls.push(r)}
 const d=f.make();await assert.rejects(d.send(req('first')),/rejected/)
 for(const file of fs.readdirSync(f.home).filter(x=>x.startsWith('whale-session-')))assert.equal(JSON.parse(fs.readFileSync(path.join(f.home,file))).behaviorDelivered,undefined)
 fail=false;await d.send(req('second'));assert.match(f.calls[0].content[0].text,/# 主人私信/)
})

test('missing or modified normative files fail before dispatch and cannot read arbitrary paths',async t=>{
 const f=fixture(t),root=path.join(f.home,'behavior');fs.cpSync(BEHAVIOR_ROOT,root,{recursive:true});f.opts.behaviorRoot=root
 assert.throws(()=>loadBehavior(['../package.json'],{root}),/未知/)
 fs.appendFileSync(path.join(root,'common.md'),'bad')
 await f.make().send(req('modified'));assert.match(f.calls[0].content[0].text,/bad/)
 fs.rmSync(path.join(root,'common.md'));await assert.rejects(f.make().send(req('missing')),/ENOENT/);assert.equal(f.calls.length,1)
})

test('new norm references preserve explicit persona repetition preference',async t=>{
 const f=fixture(t);f.cfg.personaOncePerSession=false;const d=f.make()
 await d.send(req('1'));await d.send(req('2'));assert.match(f.calls[1].content[0].text,/合成测试人设/);assert.match(f.calls[1].content[0].text,/# 通用边界/)
})

test('private expression prompts exclude public tutorials and obey draft configuration',()=>{
 const p=expressionPrompt('private-reply','cat-draft',{requireDraft:true})
 assert.doesNotMatch(p,/真人中位|debrief|styleRefIds|@ 前缀|硬形态/);assert.match(p,/requireDraft=true/)
 assert.match(expressionPrompt('private-reply','direct',{requireDraft:false}),/可直接发送/)
})

function state(t,dynamicMemory){
 const f=fixture(t),store=createLifeStore({dshHome:f.home,account:'1',owner:'2',now:()=>Date.parse('2026-10-29T01:00:00Z'),config:{dynamicMemory}})
 return {store,...f}
}
const memory=(id,text,extra={})=>({id,text,type:'understanding',version:1,active:true,recallEnabled:true,at:Date.parse('2026-10-29T00:00:00Z'),visibility:'private',scope:{scenes:['private-reply']},sourceIds:[],...extra})

test('irrelevant recall and administrative records excluded in all modes, constraints remain whole',async t=>{
 for(const mode of [{enabled:false},{enabled:true,shadow:true},{enabled:true,shadow:false}]){
 const {store}=state(t,mode)
 await store.tx(s=>{s.memories.push(memory('tired','最近疲惫',{appliesTo:'晚上疲惫时',doThis:'少推荐',falsifiedBy:'主人明确说不累',behaviorLinks:[{when:'晚上疲惫时',adjustment:'少推荐',limits:'主人明确说不累'},{when:'有急事',adjustment:'直接答复',limits:'不延迟必要事项'}],alternatives:['可能是运动']}),memory('money','赚钱一百万'),memory('rule','不要推荐剧透',{type:'expression_policy',policy:{defaultBehavior:'不剧透',exceptions:[{condition:'主人明确要求',behavior:'可以讨论',sourceIds:[]}]}}));s.events.push({id:'admin',kind:'session-delivery-accepted',text:'ADMIN_SENTINEL',at:store.now()},{id:'test',kind:'observed',text:'TEST_SENTINEL',at:store.now(),data:{test:true}})})
 const before=store.read(),snapshot=store.contextSnapshot('好累啊喵 蹭蹭你','private-reply')
 assert.match(snapshot.text,/最近疲惫/);assert.match(snapshot.text,/不延迟必要事项|主人明确要求/);assert.doesNotMatch(snapshot.text,/赚钱一百万|ADMIN_SENTINEL|TEST_SENTINEL/)
 assert.equal((snapshot.text.match(/主人明确说不累/g)??[]).length,1)
 assert.deepEqual(store.read(),before)
 const tiny=store.contextSnapshot('累了','private-reply',{limit:180});assert.equal(tiny.blocked,true)
 }
})

test('working conversation sorted and current message excluded without discarding sources',async t=>{
 const {store}=state(t),at=store.now()
 await store.tx(s=>{s.cognition??={working:{outbound:[],exchanges:[],questions:[]}};s.cognition.working={outbound:[{id:'reply',at:at-2000,text:'答复',visibility:'private',phase:'apiAccepted'}],exchanges:[{id:'ask',at:at-3000,text:'提问',visibility:'private'},{id:'current',at:at-1000,text:'当前唯一正文',visibility:'private'}],questions:[{text:'你想赚多少钱',sourceIds:['ask'],expiresAt:at+10000}]};s.events.push({id:'current',kind:'received',text:'当前唯一正文',at})})
 const snap=await store.captureContext('task','好累','private-reply','session',{excludeEventIds:['current']})
 assert.ok(snap.text.indexOf('提问')<snap.text.indexOf('答复'));assert.doesNotMatch(snap.text,/当前唯一正文|你想赚多少钱/)
 assert.ok(store.read().events.some(x=>x.id==='current'))
})

test('browse trace supports both actual share outlets without opening private recall',async t=>{
 const {store}=state(t,{enabled:true,shadow:false})
 await store.tx(s=>s.memories.push(memory('secret','PRIVATE_SENTINEL')))
 const snap=await store.captureContext('browse','PRIVATE_SENTINEL','public-recommendation','s',{sessionRole:'browse-main'})
 assert.doesNotMatch(snap.text,/PRIVATE_SENTINEL/)
 await assert.rejects(store.memoryTaskCatalog({taskId:'browse',scene:'private-recommendation',query:''}),/权限|上下文/)
 assert.ok((await prepareExpression(store,{taskId:'browse',scene:'private-recommendation',target:'2',text:'分享公开视频'})).id)
 assert.ok((await prepareExpression(store,{taskId:'browse',scene:'public-comment',target:'123',thread:'1:123:top',text:'公开反应'})).id)
 await assert.rejects(prepareExpression(store,{taskId:'browse',scene:'private-reply',target:'2',text:'跨场景'}),/本场景/)
 await assert.rejects(store.captureContext('bad','','private-reply','s',{sessionRole:'browse-main'}),/公开/)
})

test('sticker directory is bounded, stable IDs resolve exact files and unsafe paths fail',t=>{
 const f=fixture(t),root=path.join(f.home,'stickers');fs.mkdirSync(path.join(root,'small'),{recursive:true})
 const stickers=Array.from({length:22},(_,i)=>({cn:'情绪'+i,mood:'mood'+i,path:'small/'+i+'.png',desc:'描述'}))
 for(let i=0;i<22;i++)fs.writeFileSync(path.join(root,'small',i+'.png'),'fixture')
 stickers.push({cn:'越界',path:'../secret.png'});fs.writeFileSync(path.join(root,'index.json'),JSON.stringify({stickers}))
 const page=listStickers({root});assert.equal(page.items.length,20);assert.equal(page.nextOffset,20);assert.equal(listStickers({root,offset:20}).items.length,3)
 assert.equal(getSticker('mood0',{root}).path,path.join(root,'small','0.png'));assert.equal(getSticker(page.items[0].id,{root}).name,'情绪0')
 assert.doesNotMatch(stickerHint({root}),/small|\.png|描述/)
 assert.throws(()=>getSticker('越界',{root}),/路径/);fs.rmSync(path.join(root,'small','0.png'));assert.throws(()=>getSticker('mood0',{root}),/ENOENT/)
 assert.equal(stickerHint({root:path.join(f.home,'absent')}),'')
})

test('behavior and sticker commands are callable through real CLI without account or network',t=>{
 const f=fixture(t),cli=new URL('../tools/bili.mjs',import.meta.url)
 for(const args of [['behavior','read','private-reply'],['behavior','reload'],['stickers','list']]){
  const r=spawnSync(process.execPath,[cli.pathname.replace(/^\/(.:)/,'$1'),...args],{encoding:'utf8',env:{...process.env,DSH_HOME:f.home,USERPROFILE:f.home},windowsHide:true})
  assert.equal(r.status,0,r.stderr)
 }
})

test('actual scheduler reuses browsing across share routes and compacts private task inputs',t=>{
 const f=fixture(t),dsh=path.join(f.home,'dsh');fs.mkdirSync(dsh);fs.mkdirSync(path.join(f.home,'.bili-ai'))
 fs.writeFileSync(path.join(f.home,'.bili-ai','credentials.json'),JSON.stringify({sessdata:'test-cookie',bili_jct:'a'.repeat(32)}))
 const helper=new URL('./helpers/behavior-scheduler.mjs',import.meta.url),mock=new URL('./helpers/mock-fetch.mjs',import.meta.url)
 const r=spawnSync(process.execPath,[helper.pathname.replace(/^\/(.:)/,'$1')],{encoding:'utf8',timeout:15000,windowsHide:true,env:{...process.env,USERPROFILE:f.home,HOME:f.home,DSH_HOME:dsh,BILI_WHALE_CONFIG:path.join(dsh,'bili-whale.config.json'),DSH_NODE:process.execPath,BILI_TRAFFIC_TEST:'1',TEST_REQUESTS:path.join(f.home,'requests.jsonl'),NODE_OPTIONS:'--import='+mock.href,BEHAVIOR_EXPECT_NEW:'1'}})
 assert.equal(r.status,0,r.stdout+r.stderr)
})

test('legacy failed private browsing trace can migrate only via verified failure recovery',async t=>{
 const f=fixture(t),store=createLifeStore({dshHome:f.home,account:'1',owner:'2'}),id='legacy-failed'
 await store.captureContext(id,'private','private-recommendation','old')
 const draft=await prepareExpression(store,{taskId:id,scene:'private-recommendation',target:'2',text:'旧草稿'})
 updateDelivery(f.home,id,{attempt:'a',sessionId:'old',startedAt:1,updatedAt:1,status:'failed',scopeKey:legacyScopeKeys('1','2','private-recommendation',id)[0]})
 f.opts.memoryContext=r=>store.captureContext(r.requestId,r.memoryQuery,r.memoryScene,r.sessionId,{sessionRole:r.sessionRole,migrateFailedLegacy:r.migrateFailedLegacy})
 await f.make().send(browse(id))
 const trace=store.decisionTraces().find(x=>x.taskId===id)
 assert.equal(trace.scene,'public-recommendation');assert.equal(trace.migratedFromScene,'private-recommendation')
 assert.equal(store.read().drafts.find(x=>x.id===draft.id).status,'discarded')
})

test('explicit private hard policy remains visible although unrelated public tutorial is removed',()=>{
 const prompt=expressionPrompt('private-reply','direct',{requireDraft:false,hardMode:'enforce',hardScenes:['private-reply'],hardMaxChars:120,hardWarnAt:80})
 assert.match(prompt,/120/);assert.doesNotMatch(prompt,/真人中位|debrief/)
})

test('every browse task receives complete comment rules and configured expression limits',async t=>{
 const f=fixture(t);f.cfg.life={hardMode:'warn',hardMaxChars:90,hardWarnAt:70};const d=f.make()
 await d.send(browse('first'));await d.send(browse('second'))
 for(const c of f.calls){const text=c.content[0].text;assert.match(text,/# 公开评论/);assert.match(text,/反应、判断、联想或玩笑/);assert.match(text,/超过 90 字/);assert.match(text,/超过 70 字/);assert.doesNotMatch(text,/已投递；需要时/)}
})

test('host returned session id becomes the exact prompt target and audit identity',async t=>{
 const f=fixture(t);f.opts.controller.create=async r=>{f.created.push(r);return {sessionId:'actual-host-session'}}
 await f.make().send(req('actual-id'));assert.equal(f.calls[0].sessionId,'actual-host-session')
 const record=readDeliveries(f.home).find(r=>r.requestId==='actual-id')
 assert.equal(record.createdSessionId,'actual-host-session');assert.equal(record.sessionId,'actual-host-session');assert.notEqual(record.requestedSessionId,record.sessionId);assert.ok(record.promptCharacters>0)
})

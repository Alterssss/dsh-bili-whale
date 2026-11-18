import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createLifeStore} from '../tools/lib/life-store.mjs'
import {lifeConfig} from '../tools/lib/life-config.mjs'
import {prepareExpression,editExpression,finalizeExpression,expressionPrompt} from '../tools/lib/expression.mjs'
import {activityCommand,activityFetch,activityRemaining} from '../tools/lib/activity.mjs'
import {compareExpressions} from '../tools/lib/expression-eval.mjs'
import {migrateLegacy} from '../tools/lib/life-migration.mjs'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {legacyVideoIndex} from '../tools/lib/legacy-index.mjs'
function setup(t,config={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-life-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
 let clock=new Date('2026-10-25T12:00:00+08:00').getTime()
 const store=createLifeStore({dshHome:dir,account:'1',owner:'2',config,now:()=>clock})
 return {store,dir,advance:ms=>clock+=ms}
}
const request=(text='hello',extra={})=>({channel:'comment',target:'BV1234567890',thread:'1:123:456',parent:'789',text,auto:true,scene:'reply',...extra})
async function sent(store,r=request()){const token=await store.reserve(r);await store.settle(token,{status:'sent',receipt:'1234'});return token}
test('uncertain write survives restart and blocks changed wording',async t=>{
 const {store,dir}=setup(t);await store.reserve(request());const restarted=createLifeStore({dshHome:dir,account:'1',owner:'2'})
 assert.equal(restarted.check(request('other')).allow,false)
 assert.equal(restarted.status().pending.length,1)
})
test('only explicit rejection or verified not-sent releases pending',async t=>{
 const {store}=setup(t);const token=await store.reserve(request());await assert.rejects(store.settle(token,{status:'not-sent'}))
 await store.settle(token,{status:'rejected'});assert.equal(store.check(request()).allow,true)
})
test('successful receipt preserves duplicate and handled-parent guards',async t=>{
 const {store}=setup(t);await sent(store);assert.equal(store.check(request()).allow,false)
 assert.equal(store.check(request('new')).allow,false)
 assert.equal(store.check(request('new',{parent:'790'})).allow,true)
})
test('same-target concurrent reservation permits only one',async t=>{
 const {store}=setup(t);const r=await Promise.allSettled([store.reserve(request()),store.reserve(request('other'))])
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(store.status().pending.length,1)
})
test('thread reopen needs new coordinates, approval, cooldown; retains daily budget',async t=>{
 const {store,advance}=setup(t,{threadReplies:1,threadDaily:2,cooldownMinutes:1});await sent(store)
 advance(1);const e=await store.record('received',{target:'1:123:456',text:'new question',data:{parent:'800'}})
 await assert.rejects(store.reopenThread('1:123:456',e.id,{approved:true}),/冷却/)
 advance(60001);await assert.rejects(store.reopenThread('1:123:456',e.id),/确认/)
 await store.reopenThread('1:123:456',e.id,{approved:true});await sent(store,request('second',{parent:'800'}))
 assert.equal(store.read().threads['1:123:456'].daily,2)
 advance(60001);assert.equal(store.check(request('third',{parent:'801'})).allow,false)
})
test('top-level receipt seeds real thread state',async t=>{
 const {store}=setup(t);await sent(store,request('top',{thread:'1:123:top',parent:''}))
 assert.equal(store.read().threads['1:123:1234'].count,1)
})
test('paused activity does not suppress explicit private reply',async t=>{
 const {store}=setup(t);await store.pause(true)
 assert.equal(store.check(request()).allow,false)
 assert.equal(store.check(request('reply',{channel:'dm',auto:false})).allow,true)
})
async function preference(store,scope,effect='exclude',extra={}){
 const e=await store.record('received',{text:'explicit owner preference',origin:'owner'})
 const p=await store.propose({type:'preference',text:'constraint',sourceIds:[e.id],scope,effect,...extra})
 await store.review(p.id,'accept');return store.read().memories.at(-1)
}
test('preference proposal needs evidence, approval and respects scene/expiry/revoke',async t=>{
 const {store,advance}=setup(t);await assert.rejects(store.propose({text:'invented',sourceIds:['missing']}))
 const m=await preference(store,{scene:'watch',field:'author',value:'42'},'exclude',{expiresAt:store.now()+100})
 assert.equal(store.preferences({author:'42'},'watch').excluded,true)
 assert.equal(store.preferences({author:'42'},'recommend').excluded,false)
 advance(101);assert.equal(store.preferences({author:'42'},'watch').excluded,false)
 await store.revoke(m.id);assert.equal(store.read().memories.at(-1).active,false)
})
test('correction replaces exact active base and keeps history',async t=>{
 const {store}=setup(t);const m=await preference(store,{scene:'all',field:'author',value:'42'})
 await preference(store,{scene:'watch',field:'author',value:'43'},'exclude',{baseId:m.id})
 assert.equal(store.preferences({author:'42'}).excluded,false)
 assert.equal(store.preferences({author:'43'}).excluded,true)
 assert.equal(store.read().memories.length,2)
})
test('public context does not include private memory, DM receipts or reflections',async t=>{
 const {store}=setup(t);const e=await store.record('received',{text:'private unique secret',origin:'owner'})
 const p=await store.propose({text:'private unique secret',sourceIds:[e.id]});await store.review(p.id,'accept')
 await store.record('reflection',{text:'private unique secret'})
 await sent(store,request('private unique secret',{channel:'dm'}))
 assert.doesNotMatch(store.context('','public'),/unique secret/)
 assert.match(store.context('','private'),/unique secret/)
})
test('send guard enforces reviewed exclusions beyond feed',async t=>{
 const {store}=setup(t);await preference(store,{scene:'recommend',field:'author',value:'42'})
 assert.equal(store.check(request('recommend',{share:true,channel:'dm',video:'BV1234567890'})).allow,false)
 await store.record('video-read',{target:'BV1234567890',data:{title:'hello',author:'42'}})
 assert.equal(store.check(request('recommend',{share:true,channel:'dm',video:'BV1234567890'})).allow,false)
 assert.equal(store.check(request('ordinary',{share:false})).allow,true)
})
test('explicit no public mention preference acts without leaking its private source',async t=>{
 const {store}=setup(t);await preference(store,{scene:'public',field:'mention-owner',value:'true'})
 assert.equal(store.check(request('@Alice hi',{ownerName:'Alice'})).allow,false)
})
test('archive preserves unresolved sends; searchable sources and export checksums',async t=>{
 const {store,advance}=setup(t,{retentionDays:7,maxEvents:100,forgetExpiredEvents:false});const e=await store.record('observed',{text:'archive needle'})
 await store.reserve(request());advance(8*86400000);await store.archive()
 assert.equal(store.status().pending.length,1);assert.equal(store.search('needle',{archives:true})[0].id,e.id)
 const p=await store.propose({text:'remember',sourceIds:[e.id]});assert.ok(p.id)
 assert.equal(store.export().archiveContents.length,1)
 const name=store.read().archives[0].name;fs.appendFileSync(path.join(store.dir,'archive',name),'x')
 assert.throws(()=>store.export(),/校验/)
})
test('receipt still protects duplicates after hot event count overflow',async t=>{
 const {store}=setup(t,{maxEvents:100});await sent(store,request('duplicate',{channel:'dm'}))
 for(let i=0;i<105;i++)await store.record('observed',{text:String(i)})
 assert.equal(store.check(request('duplicate',{channel:'dm'})).allow,false)
})
test('draft permits one edit, preserves literal code and binds all coordinates',async t=>{
 const {store}=setup(t,{requireDraft:true});const d=await prepareExpression(store,{scene:'reply',text:'`x < 2`',target:'BV1234567890',thread:'1:123:456',parent:'789'})
 await editExpression(store,d.id,'`x < 3`');await assert.rejects(editExpression(store,d.id,'third'))
 const final=await finalizeExpression(store,d.id);assert.equal(final.text,'`x < 3`')
 assert.equal(store.check(request(final.text,{draftId:d.id})).allow,true)
 assert.equal(store.check(request(final.text,{draftId:d.id,parent:'different'})).allow,false)
 assert.equal(store.check(request(final.text)).allow,false)
})
test('claims require actual source quote, never fabricate evidence',async t=>{
 const {store}=setup(t);const e=await store.record('video-read',{text:'actual title'})
 await assert.rejects(prepareExpression(store,{scene:'public-comment',target:'BV1234567890',text:'x',sourceIds:[e.id],claims:[{sourceId:e.id,quote:'not present'}]}))
})
test('persona is versioned overlay and revocable',async t=>{
 const {store}=setup(t);const e=await store.record('reflection',{text:'learned interest',data:{visibility:'public'}})
 const p=await store.propose({type:'persona',text:'enjoy astronomy',sourceIds:[e.id],visibility:'public'});await store.review(p.id,'accept')
 assert.match(store.context('','public'),/enjoy astronomy/)
 await store.revoke(store.read().memories.at(-1).id);assert.doesNotMatch(store.context('','public'),/enjoy astronomy/)
})
test('account and owner namespaces isolate state',async t=>{
 const {store,dir}=setup(t);await store.record('received',{text:'private'})
 assert.equal(createLifeStore({dshHome:dir,account:'9',owner:'2'}).read().events.length,0)
 assert.equal(createLifeStore({dshHome:dir,account:'1',owner:'8'}).read().events.length,0)
})
test('autonomy has durable daily, read and time budgets',async t=>{
 const {store,advance}=setup(t,{autonomy:true,autonomyReads:1});const l=await store.beginActivity();assert.ok(l)
 assert.equal(await store.beginActivity(),null);await store.consumeActivity(l.id);await assert.rejects(store.consumeActivity(l.id))
 await store.endActivity(l.id);assert.equal(await store.beginActivity(),null)
 advance(86400000);assert.ok(await store.beginActivity())
})
test('activity descendants reject writes and expired execution',()=>{
 const env={WHALE_ACTIVITY_DEADLINE:String(Date.now()+100000)}
 assert.throws(()=>activityCommand('comment',env));assert.doesNotThrow(()=>activityCommand('feed',env))
 assert.throws(()=>activityFetch('https://example.com',{method:'POST'},env))
 assert.ok(activityFetch('https://example.com',{},env).signal)
 assert.throws(()=>activityRemaining({WHALE_ACTIVITY_DEADLINE:'1'}))
})
test('migration is idempotent and legacy narrative remains unverified',async t=>{
 const {store,dir}=setup(t);fs.writeFileSync(path.join(dir,'whale-diary.md'),'old private diary')
 assert.equal((await migrateLegacy(store,dir)).length,1);assert.equal((await migrateLegacy(store,dir)).length,0)
 assert.equal(store.search('old private',{archives:true})[0].origin,'legacy-unverified')
 assert.equal(store.read().memories.length,0)
})
test('offline comparison keeps identical context and abstention without judging identity',()=>{
 const r=compareExpressions({context:'facts',candidates:{direct:'', 'cat-draft':'hi'}})
 assert.equal(r.candidates[0].abstain,true);assert.equal(r.context,'facts');assert.equal(r.checklist.length,5)
 assert.match(expressionPrompt('public-comment','cat-draft'),/最多编辑一次/)
})
test('context budget and config validation',async t=>{
 const {store}=setup(t,{memoryChars:500});await store.record('video-read',{text:'z'.repeat(10000)})
 assert.ok(store.context().length<=500);assert.throws(()=>lifeConfig({autonomyReads:0}));assert.throws(()=>lifeConfig({enabled:'yes'}))
})
test('parallel processes retain every transaction without lost updates',async t=>{
 const {store,dir}=setup(t)
 const worker=i=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[fileURLToPath(new URL('./helpers/life-worker.mjs',import.meta.url)),dir,String(i)],{stdio:'ignore',windowsHide:true});p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error('worker exit '+code)))})
 await Promise.all([worker(1),worker(2),worker(3)])
 assert.equal(store.read().events.length,30);assert.equal(new Set(store.read().events.map(e=>e.text)).size,30)
})
test('closed-thread wake review is bounded without reopening the thread',async t=>{
 const {store,advance}=setup(t,{cooldownMinutes:1});await store.closeThread('1:123:456')
 assert.equal(await store.reviewWake('1:123:456'),false);advance(60001)
 assert.equal(await store.reviewWake('1:123:456'),true);assert.equal(await store.reviewWake('1:123:456'),false)
 assert.equal(store.read().threads['1:123:456'].status,'closed')
})
test('legacy index invalidates after update and never promotes its preferences',async t=>{
 const {dir}=setup(t),file=path.join(dir,'old.md');fs.writeFileSync(file,'BV1234567890')
 assert.deepEqual(legacyVideoIndex(file,path.join(dir,'cache')).seen,['BV1234567890'])
 fs.appendFileSync(file,' BV1234567891');assert.equal(legacyVideoIndex(file,path.join(dir,'cache')).seen.length,2)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {createLifeStore} from '../tools/lib/life-store.mjs'
import {lifeConfig} from '../tools/lib/life-config.mjs'
import {lifecycleView,recallEligibility,rankMemories} from '../tools/lib/memory-lifecycle.mjs'
import {dynamicConfig} from '../tools/lib/dynamic-memory-config.mjs'
import {prepareExpression,finalizeExpression} from '../tools/lib/expression.mjs'
import {createScopedDelivery} from '../lib/scoped-delivery.js'
const DAY=86400000
function setup(t,dynamicMemory={enabled:true,shadow:false},extra={}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-dynamic-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
 let at=Date.parse('2026-10-29T12:00:00Z')
 const config={dynamicMemory,...extra},store=createLifeStore({dshHome:home,account:'1',owner:'2',config,now:()=>at})
 return {home,store,config,advance:d=>at+=d*DAY,reopen:()=>createLifeStore({dshHome:home,account:'1',owner:'2',config,now:()=>at})}
}
const put=(store,id,extra={})=>store.tx(s=>{const m={id,version:1,at:store.now(),acceptedAt:store.now(),active:true,recallEnabled:true,text:'一起看过的电影',type:'episodic',visibility:'private',scope:{scenes:['private-reply','private-recommendation']},sourceIds:[],originEvidenceIds:['source'],independentEvidence:1,epistemic:'inferred',...extra};s.memories.push(m);return m})
const prepare=(store,id='task',scene='private-reply')=>store.captureContext(id,'电影',scene,'main')
const fetchMemory=(store,id='m',extra={})=>store.memoryFetch({id,expectedVersion:1,taskId:'task',scene:'private-reply',...extra})

test('DM01 previews and catalog reads never heat memory or change evidence',async t=>{
 const {store}=setup(t);await put(store,'m');const before=store.read()
 for(let i=0;i<100;i++){store.contextSnapshot('电影','private-reply');store.memoryCatalog({query:'电影'});store.memoryExplain('m')}
 assert.deepEqual(store.read(),before)
})
test('DM02 repeated fetch counts once, still charges each actual response to task budget',async t=>{
 const {store}=setup(t);await put(store,'m');await prepare(store)
 await fetchMemory(store);const first=store.read();await fetchMemory(store);const second=store.read()
 assert.equal(second.dynamicMemory.access.m.effectiveUseCount,1);assert.ok(second.cognition.traces[0].memoryUsage.bytes>first.cognition.traces[0].memoryUsage.bytes)
 assert.deepEqual(second.memories,first.memories);assert.equal(second.settings.permissionVersion,first.settings.permissionVersion)
})
test('DM03 self-reported decisions do not claim effective use',async t=>{
 const {store}=setup(t);await put(store,'m');await prepare(store)
 await store.recordDecision({taskId:'task',action:'abstain',reason:'先不打扰',memoryIds:['m']})
 assert.equal(store.read().dynamicMemory,undefined);assert.equal(store.decisionTraces()[0].stage,'model-reported')
})
test('DM05 relevant dormant memory beats unrelated hot memory',async t=>{
 const {store}=setup(t);await put(store,'cold',{at:store.now()-365*DAY,acceptedAt:store.now()-365*DAY});await put(store,'hot',{text:'主人喜欢喝咖啡'})
 const rows=store.memoryCatalog({query:'电影'}).items;assert.equal(rows[0].id,'cold');assert.equal(rows[0].tier,'dormant');assert.equal(rows.length,1)
 assert.match(store.context('电影','private-reply'),/一起看过的电影/)
})
test('DM06 inactive attention never removes a mandatory preference or its exception',async t=>{
 const {store,advance}=setup(t);await put(store,'rule',{type:'expression_policy',policy:{defaultBehavior:'简短',exceptions:[{condition:'明确要求分析',behavior:'详细说明',sourceIds:[]}]}})
 advance(900);const snapshot=store.contextSnapshot('随便聊聊','private-reply');assert.match(snapshot.text,/明确要求分析/);assert.ok(snapshot.segments.some(x=>x.mandatory&&x.refs.some(r=>r.id==='rule')))
})
test('DM07 expired current state is historical; fresh user context remains',async t=>{
 const {store,advance}=setup(t);await put(store,'tired',{text:'昨晚很累',temporalKind:'current_state'});advance(2)
 await store.ingestOwnerMessage({actor:'2',messageId:'today',text:'今天精神很好'})
 const s=store.contextSnapshot('累','private-reply');assert.ok(!s.segments.some(x=>x.refs.some(r=>r.id==='tired')));assert.match(s.text,/今天精神很好/)
 assert.equal(store.memoryCatalog({query:'累',historical:true}).items[0].validity,'historical')
 await prepare(store);await fetchMemory(store,'tired',{historical:true});assert.equal(store.memoryExplain('tired').view.validity,'historical')
})
test('DM08 retrieving a dormant episode records use but cannot generate relevance tags',async t=>{
 const {store}=setup(t);const m=await put(store,'m',{at:store.now()-400*DAY,acceptedAt:store.now()-400*DAY});assert.equal(store.memoryExplain('m').view.tier,'dormant')
 await prepare(store);await fetchMemory(store);assert.equal(store.memoryExplain('m').view.tier,'dormant');assert.equal(store.read().memories[0].at,m.at)
})
test('DM09 public catalog, source history and explanations cannot reveal private titles',async t=>{
 const {store}=setup(t);await put(store,'secret',{text:'私人约定'});await store.record('observed',{text:'私人原文'})
 assert.deepEqual(store.memoryCatalog({scene:'public-comment'}).items,[]);assert.deepEqual(store.memoryHistory({scene:'public-comment'}).items,[]);assert.equal(store.memoryExplain('secret','public-comment'),null)
 assert.equal(store.reader('public-comment').catalog({scene:'private-reply'}).items.length,0)
})
test('DM10 revocation between catalog and fetch refuses stale result and credit',async t=>{
 const {store}=setup(t);await put(store,'m');await prepare(store);store.memoryCatalog();await store.revoke('m')
 await assert.rejects(fetchMemory(store),/权限|不可/);assert.equal(store.read().dynamicMemory,undefined)
})
test('DM11 superseded high-use beliefs cannot return through ranking or direct read',async t=>{
 const {store}=setup(t);await put(store,'m');await prepare(store);await fetchMemory(store)
 await store.tx(s=>{s.memories[0].active=false;s.memories[0].status='superseded'})
 assert.equal(store.memoryCatalog({historical:true}).items.length,0);await assert.rejects(fetchMemory(store),/不可/)
})
test('DM12 protection preserves suppression and does not grant public visibility',async t=>{
 const {store}=setup(t);await put(store,'m');await store.suppress('m');await store.memoryRetention('m',{protect:true,reason:'重要经历'})
 assert.equal(store.memoryCatalog({historical:true}).items.length,0);assert.equal(store.memoryExplain('m').view.retention.class,'protected')
 assert.equal(store.memoryExplain('m','public-comment'),null)
})
test('DM13 decay is pure, stable over restart and insensitive to repeated maintenance',async t=>{
 const {store,advance,reopen}=setup(t);await put(store,'m');await prepare(store);await fetchMemory(store);advance(20)
 const before=store.memoryExplain('m').view;await store.maintainCognition();await store.maintainCognition()
 assert.deepEqual(store.memoryExplain('m').view,before);assert.deepEqual(reopen().memoryExplain('m').view,before)
})
test('DM14 use updates do not rotate session or increment semantic versions',async t=>{
 const {home,store}=setup(t),calls=[];await put(store,'m')
 const delivery=createScopedDelivery({dshHome:home,cwd:home,config:()=>({self:{mid:'1'},owner:{mid:'2'}}),persona:()=>'',permissionVersion:()=>store.read().settings.permissionVersion??0,memoryContext:r=>store.captureContext(r.requestId,'电影',r.memoryScene,r.sessionId),controller:{create:async()=>{},prompt:async r=>calls.push(r)}})
 await delivery.send({requestId:'task',memoryScene:'private-reply',content:[]});const before=store.read().memories[0];await fetchMemory(store)
 await delivery.send({requestId:'next',memoryScene:'private-recommendation',content:[]});assert.equal(calls[0].sessionId,calls[1].sessionId);assert.deepEqual(store.read().memories[0],before)
 assert.match(calls[0].content[0].text,/memory-catalog/)
})
test('DM15 UTF8 pages have exact wire budget and reassemble full content',async t=>{
 const {store}=setup(t,{enabled:true,shadow:false,fetchBytes:1024,taskFetchBytes:16384});const m=await put(store,'m',{text:'电影🐳'.repeat(400)})
 await prepare(store);let offsetBytes=0,contentHash,combined=''
 for(let i=0;i<20;i++){
  const page=await fetchMemory(store,'m',{offsetBytes,contentHash});assert.ok(Buffer.byteLength(JSON.stringify(page))<=1024);assert.doesNotMatch(page.fragment,/�/);combined+=page.fragment
  if(page.complete)break;offsetBytes=page.nextOffsetBytes;contentHash=page.contentHash
 }
 assert.equal(JSON.parse(combined).text,m.text)
 await assert.rejects(fetchMemory(store,'m',{offsetBytes:1,contentHash:'wrong'}),/变化/)
})
test('task budget survives retries and re-preparing the same request',async t=>{
 const {store}=setup(t,{enabled:true,shadow:false,fetchBytes:1024,taskFetchBytes:1024});await put(store,'m',{text:'电影'.repeat(1000)});await prepare(store)
 await fetchMemory(store);await prepare(store);await assert.rejects(fetchMemory(store),/预算/)
})
test('DM16 platform acceptance upgrades one retrieval credit, not evidence or owner approval',async t=>{
 const {store}=setup(t);await put(store,'m');await prepare(store);await fetchMemory(store)
 await store.recordDecision({taskId:'task',action:'reply',reason:'相关经历',memoryIds:['m']})
 const d=await prepareExpression(store,{taskId:'task',scene:'private-reply',text:'记得那部电影',target:'2'});await finalizeExpression(store,d.id)
 const token=await store.reserve({draftId:d.id,scene:'private-reply',channel:'dm',target:'2',text:d.text});await store.dispatch(token,()=>Promise.resolve());await store.settle(token,{status:'sent',receipt:'receipt'})
 const s=store.read();assert.equal(s.dynamicMemory.access.m.effectiveUseCount,1);assert.equal(s.dynamicMemory.access.m.useMass,1);assert.equal(s.dynamicMemory.receipts.at(-1).phase,'applied');assert.equal(s.memories[0].independentEvidence,1)
})
test('DM17 postponement stays blocked despite a hot memory',async t=>{
 const {store}=setup(t);await put(store,'m');await prepare(store,'task','private-recommendation');await fetchMemory(store,'m',{scene:'private-recommendation'})
 await store.recordDecision({taskId:'task',action:'postpone',reason:'不打扰',memoryIds:['m']});assert.equal(store.check({taskId:'task',scene:'private-recommendation',channel:'dm',target:'2',text:'推荐视频'}).allow,false)
})
test('DM18 dry-run migration is read-only and legacy suppressed data stays blocked',async t=>{
 const {store}=setup(t);await put(store,'m',{recallEnabled:false,stale:true});const before=store.read()
 assert.equal(store.dynamicMigrate().legacyBlocked,1);assert.deepEqual(store.read(),before)
 await store.dynamicMigrate({apply:true});assert.equal(store.read().memories[0].lifecycle.recallControl,'legacy_blocked');assert.deepEqual(store.memoryCatalog({historical:true}).items,[])
 assert.equal((await store.dynamicMigrate({apply:true})).count,0)
})
test('DM19 cold source fetch verifies archive digest and task scene',async t=>{
 const {store,advance}=setup(t,undefined,{retentionDays:7,forgetExpiredEvents:false});const e=await store.record('observed',{text:'很多年前的电影'})
 advance(8);await store.archive();const row=store.memoryHistory({query:'电影'}).items[0];assert.equal(row.id,e.id);assert.ok(row.archive)
 await prepare(store);const out=await fetchMemory(store,e.id,{kind:'event',historical:true,archive:row.archive});assert.equal(JSON.parse(out.fragment).text,e.text)
 fs.appendFileSync(path.join(store.dir,'archive',row.archive),'bad')
 await assert.rejects(fetchMemory(store,e.id,{kind:'event',historical:true,archive:row.archive}),/校验/)
 const search=store.memoryHistory({query:'电影'});assert.equal(search.items.length,0);assert.ok(search.diagnostics.length)
})
test('DM20 catalog pagination is scoped and visits each visible memory once',async t=>{
 const {store}=setup(t)
 for(let i=0;i<45;i++)await put(store,'m'+i,{text:'电影 '+i})
 let cursor=null,ids=[];do{const page=store.memoryCatalog({query:'电影',limit:10,cursor});ids.push(...page.items.map(m=>m.id));cursor=page.cursor}while(cursor)
 assert.equal(ids.length,45);assert.equal(new Set(ids).size,45)
 const first=store.memoryCatalog({query:'电影',limit:10});assert.throws(()=>store.memoryCatalog({query:'咖啡',cursor:first.cursor}),/游标/)
})
test('DM21 usage mass is bounded, age never negative, evidence is independent',()=>{
 const c=dynamicConfig({enabled:true,shadow:false}),m={id:'m',type:'episodic',at:1000,active:true,text:'电影',sourceIds:[]}
 const v=lifecycleView(m,500,{lastTaskUseAt:1000,evaluatedAt:1000,useMass:32,effectiveUseCount:1000000},c)
 assert.ok(Number.isFinite(v.attention)&&v.attention<=1&&v.attention>=0)
 assert.equal(m.sourceIds.length,0)
})
test('DM22 legacy shadow setting is normalized to active mode',async t=>{
 const {store,home}=setup(t,{enabled:true,shadow:true});await put(store,'m',{text:'不相关咖啡'})
 const baseline=createLifeStore({dshHome:home,account:'1',owner:'2',now:store.now})
 const proposed=store.contextSnapshot('电影','private-reply');assert.equal(proposed.text,baseline.contextSnapshot('电影','private-reply').text);assert.equal(proposed.dynamicMemory.mode,'active')
 await prepare(store);await fetchMemory(store);assert.equal(store.read().dynamicMemory.access.m.effectiveUseCount,1)
})
test('expired ordinary patterns are historical before maintenance and collected afterward',async t=>{
 const {store,advance}=setup(t);await put(store,'m',{type:'pattern',text:'最近夜间疲惫'});advance(15)
 assert.equal(store.reader('private-reply').get('m'),null);assert.equal(store.memoryCatalog({historical:true}).items[0].validity,'needs_review')
 await store.maintainCognition();const version=store.read().settings.permissionVersion;await store.maintainCognition();assert.equal(store.read().settings.permissionVersion,version)
 assert.equal(store.read().memories.length,0);assert.equal(store.memoryCatalog({historical:true}).items.length,0)
})
test('cross-task retrieval within window gets no extra credit; expired task cannot reset counters',async t=>{
 const {store,advance}=setup(t);await put(store,'m');await prepare(store);await fetchMemory(store)
 await prepare(store,'another');await fetchMemory(store,'m',{taskId:'another'});assert.equal(store.read().dynamicMemory.access.m.effectiveUseCount,1)
 advance(2);await assert.rejects(fetchMemory(store),/过期/)
})
test('actual CLI catalog honors explicit scene and uses isolated configuration',async t=>{
 const {store,home}=setup(t);await put(store,'m');fs.writeFileSync(path.join(home,'bili-whale.config.json'),JSON.stringify({self:{mid:'1'},owner:{mid:'2'},life:{dynamicMemory:{enabled:true,shadow:false}}}))
 const query=path.join(home,'query.json');fs.writeFileSync(query,JSON.stringify({query:'电影',scene:'private-reply'}))
 const script=new URL('../tools/commands/life.mjs',import.meta.url)
 const run=scene=>spawnSync(process.execPath,[script.pathname.replace(/^\/(\w:)/,'$1'),'memory-catalog-preview',query,scene],{encoding:'utf8',env:{...process.env,DSH_HOME:home,BILI_WHALE_CONFIG:path.join(home,'bili-whale.config.json')}})
 const pub=run('public-comment'),priv=run('private-reply');assert.equal(pub.status,0,pub.stderr);assert.equal(priv.status,0,priv.stderr);assert.equal(JSON.parse(pub.stdout).items.length,0);assert.equal(JSON.parse(priv.stdout).items[0].id,'m')
})
test('configuration rejects nonboolean deletion and invalid budgets',()=>{
 for(const dynamicMemory of [{autoDelete:"yes"},{fetchBytes:2000,taskFetchBytes:1024},{maxUseBoost:1},{halfLives:{unknown:10}},{enabled:'yes'}])assert.throws(()=>lifeConfig({dynamicMemory}))
})
test('a newly consolidated old state retains the original observation time',async t=>{
 const {store}=setup(t);await put(store,'old',{temporalKind:'current_state',text:'当时疲惫',observationWindow:{from:store.now()-3*DAY,to:store.now()-2*DAY}})
 assert.equal(store.memoryExplain('old').view.validity,'historical');assert.equal(store.memoryCatalog({query:'疲惫'}).items.length,0)
})
test('concurrent fetches retain one effective use under the checkpoint lock',async t=>{
 const {store}=setup(t);await put(store,'m');await prepare(store)
 await Promise.all([fetchMemory(store),fetchMemory(store),fetchMemory(store)])
 assert.equal(store.read().dynamicMemory.access.m.effectiveUseCount,1)
})
test('a historical memory can support a historical reply without becoming current',async t=>{
 const {store,advance}=setup(t);await put(store,'m',{temporalKind:'current_state',text:'昨天累'});advance(2);await prepare(store);await fetchMemory(store,'m',{historical:true})
 await store.recordDecision({taskId:'task',action:'reply',reason:'回答昨天的经历',memoryIds:['m']})
 assert.equal(store.check({taskId:'task',scene:'private-reply',channel:'dm',target:'2',text:'你昨天说过累'}).allow,true)
 assert.equal(store.memoryExplain('m').view.validity,'historical')
})
test('tombstones override active rows, ranking, direct fetch and explanations',async t=>{
 const {store}=setup(t);await put(store,'m');await prepare(store);await store.tx(s=>s.cognition.deletedIds.push('m'))
 assert.equal(store.memoryCatalog({historical:true}).items.length,0);assert.equal(store.memoryExplain('m'),null);assert.equal(store.reader('private-reply').get('m'),null)
 await assert.rejects(fetchMemory(store),/不可/);assert.ok(!store.contextSnapshot('电影','private-reply').segments.some(x=>x.refs.some(r=>r.id==='m')))
})
test('unknown dynamic schema fails closed, never silently resets usage',async t=>{
 const {store}=setup(t);await put(store,'m');await prepare(store);await fetchMemory(store)
 await store.tx(s=>s.dynamicMemory.schema=99);assert.throws(()=>store.read(),/schema/)
})
test('usage updates do not conflict with an outstanding formation CAS',async t=>{
 const {store}=setup(t);const e=await store.ingestOwnerMessage({actor:'2',messageId:'feedback',text:'电影让我想到过去'})
 await put(store,'m');const job=await store.planFormation({force:true});await prepare(store);await fetchMemory(store)
 await store.submitFormation(job.jobId,job.token,{candidates:[{key:'new',type:'understanding',text:'这部电影让主人联想到过去',appliesTo:'谈及这部电影时',doThis:'允许主人谈自己的联想',falsifiedBy:'主人说明只是随口提及时',sourceIds:[e.id],quotes:[{eventId:e.id,text:e.text}],scope:{scenes:['private-reply']},visibility:'private',alternatives:['只是当下联想'],baseId:'m',baseVersion:1}]})
 const review=await store.claimReview();await store.commitFormation(review.jobId,review.token,{decisions:[{key:'new',action:'accept',reason:'有限解释，保留不确定性',grounded:true,scopeClear:true,overgeneralized:false}]})
 assert.equal(store.read().memories.filter(m=>m.active).length,1);assert.equal(store.read().memories.at(-1).version,2)
})
test('archive search limits failed file attempts and exposes a continuation',async t=>{
 const {store}=setup(t);await store.tx(s=>{for(let i=0;i<12;i++)s.archives.push({name:'missing-'+i+'.json',digest:'missing'})})
 const first=store.memoryHistory();assert.equal(first.diagnostics.length,8);assert.ok(first.cursor)
 const next=store.memoryHistory({cursor:first.cursor});assert.equal(next.diagnostics.length,4);assert.equal(next.cursor,null)
})
test('task catalog and full reads share one byte budget without heating previews',async t=>{
 const {store}=setup(t,{enabled:true,shadow:false,fetchBytes:1024,taskFetchBytes:2048})
 for(let i=0;i<12;i++)await put(store,'m'+i)
 await prepare(store);const first=await store.memoryTaskCatalog({taskId:'task',scene:'private-reply',query:'电影'})
 assert.ok(Buffer.byteLength(JSON.stringify(first))<=1024);assert.ok(first.cursor);assert.equal(store.read().dynamicMemory,undefined)
 const after=store.decisionTraces()[0].memoryUsage.bytes;await fetchMemory(store,'m0');assert.ok(store.decisionTraces()[0].memoryUsage.bytes>after)
 let blocked=false
 for(let i=0;i<5;i++){try{await store.memoryTaskCatalog({taskId:'task',scene:'private-reply',query:'电影'})}catch(e){assert.match(e.message,/预算/);blocked=true;break}}
 assert.equal(blocked,true)
})
test('actual CLI task catalog requires prepared identity and persists budget',async t=>{
 const {store,home}=setup(t);await put(store,'m')
 const cfg={self:{mid:'1'},owner:{mid:'2'},life:{dynamicMemory:{enabled:true,shadow:false}}};const configPath=path.join(home,'bili-whale.config.json');fs.writeFileSync(configPath,JSON.stringify(cfg))
 const live=createLifeStore({dshHome:home,account:'1',owner:'2',config:cfg.life});await live.captureContext('cli-task','电影','private-reply','cli-session')
 const query=path.join(home,'request.json');fs.writeFileSync(query,JSON.stringify({query:'电影',taskId:'cli-task'}))
 const script=new URL('../tools/commands/life.mjs',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')
 const result=spawnSync(process.execPath,[script,'memory-catalog',query,'private-reply'],{encoding:'utf8',env:{...process.env,DSH_HOME:home,BILI_WHALE_CONFIG:configPath}})
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).items[0].id,'m');assert.ok(live.decisionTraces()[0].memoryUsage.bytes>0)
 const blocked=spawnSync(process.execPath,[script,'memory-catalog',query,'public-comment'],{encoding:'utf8',env:{...process.env,DSH_HOME:home,BILI_WHALE_CONFIG:configPath}})
 assert.notEqual(blocked.status,0);assert.match(blocked.stderr,/上下文/)
})
test('DM04 new independent nights form a recent pattern under active lifecycle',async t=>{
 const {store,advance}=setup(t),events=[]
 for(let i=0;i<5;i++){events.push(await store.ingestOwnerMessage({actor:'2',messageId:'night-'+i,text:'今晚好累'}));advance(1)}
 const job=await store.planFormation({force:true});await store.submitFormation(job.jobId,job.token,{candidates:[{key:'tired',type:'pattern',temporalKind:'recent_pattern',text:'最近几个晚上常疲惫，原因未确定',appliesTo:'最近晚间对话',doThis:'减少额外推荐负担',falsifiedBy:'主人明确表示不累时',sourceIds:events.map(e=>e.id),quotes:events.map(e=>({eventId:e.id,text:e.text})),scope:{scenes:['private-reply']},alternatives:['可能最近工作繁忙']}]})
 const review=await store.claimReview();await store.commitFormation(review.jobId,review.token,{decisions:[{key:'tired',action:'accept',reason:'五夜独立观察，限定近期',grounded:true,scopeClear:true,overgeneralized:false}]})
 const m=store.read().memories[0];assert.equal(m.independentDays,5);assert.equal(m.lifecycle.temporalKind,'recent_pattern');assert.equal(m.lifecycle.reviewDueAt,events.at(-1).at+14*DAY)
})
test('failed durable read bookkeeping does not heat memory or return content',async t=>{
 const {store}=setup(t);await put(store,'m');await prepare(store);const rename=fs.renameSync
 fs.renameSync=(a,b)=>{if(b.endsWith('checkpoint.json'))throw Error('checkpoint fault');return rename(a,b)}
 try{await assert.rejects(fetchMemory(store),/checkpoint fault/)}finally{fs.renameSync=rename}
 assert.equal(store.read().dynamicMemory,undefined)
})
test('committed fetch survives projection failure and remains recoverable',async t=>{
 const {store,reopen}=setup(t);await put(store,'m');await prepare(store);const rename=fs.renameSync
 fs.renameSync=(a,b)=>{if(b===store.file)throw Error('projection fault');return rename(a,b)}
 try{assert.equal(JSON.parse((await fetchMemory(store)).fragment).id,'m')}finally{fs.renameSync=rename}
 assert.equal(reopen().read().dynamicMemory.access.m.effectiveUseCount,1)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {readMemory,MEMORY_LIMITS,memoryPrompt} from '../tools/lib/memory.mjs'
import {createMemoryContext} from '../lib/memory-context.js'
import {createSessionDelivery} from '../lib/session-delivery.js'
import {wakePrompt} from '../lib/scheduler.js'
const now=Date.parse('2026-10-26T12:00:00Z')
function fixture(t){const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-memory-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));return home}
function put(home,name,text){fs.writeFileSync(path.join(home,name),text)}
test('1, 30 and 365 days are bounded, recent-first, read-only and do not ingest private diary',t=>{
 for(const days of [1,30,365]) {
  const home=fixture(t), rows=Array.from({length:days},(_,i)=>({at:new Date(now-i*86400000).toISOString(),kind:'watch',note:'中文😀 BV1234567890'}))
  put(home,'whale-log.jsonl',rows.reverse().map(JSON.stringify).join('\r\n'))
  put(home,'whale-diary-private.md','## 2026-10-26\nPRIVATE_SENTINEL')
  const before=fs.readFileSync(path.join(home,'whale-log.jsonl')), result=readMemory(home,{now})
  assert.ok(result.records.length<=7);assert.equal(result.records[0].date,'2026-10-26')
  assert.ok(Array.from(JSON.stringify(result)).length<=MEMORY_LIMITS.outputChars)
  assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));assert.deepEqual(fs.readFileSync(path.join(home,'whale-log.jsonl')),before)
 }
})
test('recall validates dates, BV, literal keywords and private opt-in; no arbitrary paths',t=>{
 const home=fixture(t);put(home,'whale-diary.md','## 2026-01-01\r\nold BV1234567890 中文😀\r\n## 2026-10-26\r\nnew')
 put(home,'whale-diary-private.md','## 2026-01-01\nprivate')
 assert.equal(readMemory(home,{mode:'recall',date:'2026-01-01',bv:'BV1234567890',keyword:'中文😀'}).records.length,1)
 assert.equal(readMemory(home,{mode:'recall',keyword:'private'}).records.length,0)
 assert.equal(readMemory(home,{mode:'recall',keyword:'private',includePrivate:true}).records.length,1)
 for(const date of ['2026-02-30','../../secret'])assert.throws(()=>readMemory(home,{mode:'recall',date}))
 assert.throws(()=>readMemory(home,{mode:'recall',bv:'../../secret'}))
 assert.ok(readMemory(home,{mode:'recall'}).records.length)
 const cli=spawnSync(process.execPath,['tools/commands/memory.mjs','recall','--path','/etc/passwd'],{env:{...process.env,DSH_HOME:home},encoding:'utf8'})
 assert.equal(cli.status,2);assert.ok(!cli.stdout)
})
test('missing, malformed, undated, oversized and nonregular sources are diagnosed',t=>{
 const home=fixture(t);put(home,'whale-log.jsonl','bad\n'+JSON.stringify({at:'bad'})+'\n'+JSON.stringify({at:new Date(now).toISOString(),note:'x'.repeat(3000)}))
 put(home,'whale-diary.md','undated\n## 2026-10-26\ncomplete😀')
 fs.mkdirSync(path.join(home,'whale-memory-summary.md'))
 const result=readMemory(home,{now})
 assert.equal(result.records.length,2);assert.equal(result.omitted,1)
 assert.deepEqual(result.diagnostics.map(x=>x.status).sort(),['invalid-record','not-regular-file','undated-text-retained','oversized-record-omitted'].sort())
 put(home,'whale-log.jsonl','x'.repeat(MEMORY_LIMITS.scanBytes+50))
 assert.ok(readMemory(home,{now}).diagnostics.some(d=>d.status==='scan-window-limited'))
})
test('native context is scoped, cached, rotates and disposes; absent/throwing service falls back',t=>{
 const home=fixture(t);let definition,disposed=false
 const adapter=createMemoryContext({systemPrompt:{context:def=>{definition=def;return ()=>{disposed=true}}}},{dshHome:home,now:()=>now})
 assert.equal(adapter.mode,'native');adapter.refresh('whale')
 assert.equal(definition.text({}),'');assert.equal(definition.text({agent:{session:{id:'other'}}}),'')
 const snapshot=definition.text({agent:{session:{id:'whale'}}});assert.match(snapshot,/本地有界记忆/)
 put(home,'whale-diary.md','## 2026-10-26\nCHANGED {{secrets}}');assert.equal(definition.text({agent:{session:{id:'whale'}}}),snapshot)
 adapter.refresh('new');assert.equal(definition.text({agent:{session:{id:'whale'}}}),'');assert.match(definition.text({agent:{session:{id:'new'}}}),/CHANGED \{\{secrets\}\}/)
 adapter.stop();assert.ok(disposed);assert.equal(definition.text({agent:{session:{id:'new'}}}),'')
 for(const ctx of [{},{systemPrompt:{context(){throw Error()}}}]) {const fallback=createMemoryContext(ctx,{dshHome:home});assert.equal(fallback.mode,'fallback');assert.match(fallback.refresh('id'),/本地有界记忆/)}
})
test('shared delivery repeated calls and restart include one bounded fallback, not full-diary instructions',async t=>{
 const home=fixture(t),messages=[]
 const options={controller:{create:async()=>{},prompt:async p=>messages.push(p)},dshHome:home,cwd:home,sessionId:'whale',config:()=>({personaOncePerSession:true}),persona:()=> 'PERSONA',now:()=>now}
 const delivery=createSessionDelivery(options)
 for(const channel of ['wake','skip','dm','comment','live'])await delivery.send({content:[{type:'text',text:channel}]})
 await createSessionDelivery(options).send({content:[{type:'text',text:'restart'}]})
 for(const m of messages){const text=m.content[0].text;assert.equal(text.split('【本地有界记忆').length-1,1);assert.ok(!text.includes('先读本地日记'))}
 assert.ok(!wakePrompt({}).includes('读 DSH_HOME 下 whale-diary'))
})
test('legacy 看过 tables are recalled with CRLF; escaped summaries cannot exceed complete prompt budget',t=>{
 const home=fixture(t)
 put(home,'whale-diary.md','## 看过\r\n| 时间 | BV | 标题 | 简介 | 想法 |\r\n| --- | --- | --- | --- | --- |\r\n| 2026-10-26 | BV1234567890 | 中文😀 | 简介 | 感受 |\r\n## 想说\r\n- undated')
 assert.equal(readMemory(home,{mode:'recall',bv:'BV1234567890'}).records.length,1)
 for(const summary of ['\u0000'.repeat(2400),'😀'.repeat(2400),'"\\'.repeat(1200)]) {
  put(home,'whale-memory-summary.md',summary)
  assert.ok(Array.from(memoryPrompt(home,{now})).length<=MEMORY_LIMITS.outputChars)
 }
 let definition;createMemoryContext({systemPrompt:{context:def=>{definition=def}}},{dshHome:home})
 assert.equal(definition.interpolate,false)
})


test('all legacy prose and long Unicode sections survive read-only paged recall with exact ranges',t=>{
 const home=fixture(t)
 const original='自由开头😀\r\n## 看过\r\n| 2020-01-01 | BV1234567890 | ancient |\r\n## 想说\r\nfree after table\r\n# 2020-02-02\r\n'+('中文😀abc'.repeat(1800))+'\r\nTAIL_SENTINEL'
 put(home,'whale-diary.md',original)
 const before=fs.readFileSync(path.join(home,'whale-diary.md')), records=[]
 let offset=0
 for(let page=0;page<100;page++){
   const result=readMemory(home,{mode:'recall',offset})
   assert.ok(charsForTest(JSON.stringify(result))<=MEMORY_LIMITS.jsonChars)
   records.push(...result.records)
   if(result.nextOffset===null)break
   assert.ok(result.nextOffset>offset);offset=result.nextOffset
   assert.ok(page<99)
 }
 assert.equal(records.map(r=>r.text).join(''),original)
 for(const row of records){assert.equal(before.subarray(row.range.start,row.range.end).toString('utf8'),row.text);assert.ok(!row.text.includes('\ufffd'))}
 assert.deepEqual(fs.readFileSync(path.join(home,'whale-diary.md')),before)
 assert.ok(readMemory(home,{mode:'recall',keyword:'free after table'}).records.length)
 assert.ok(readMemory(home,{mode:'recall',keyword:'TAIL_SENTINEL'}).records.length)
 assert.ok(readMemory(home,{mode:'recall',date:'2020-02-02'}).records.length)
})
const charsForTest=text=>Array.from(text).length

test('recall reaches before the 256 KiB tail; context diagnoses its limited view',t=>{
 const home=fixture(t)
 put(home,'whale-diary.md','## 2010-01-01\nANCIENT_SENTINEL\n'+('legacy prose\n'.repeat(24000))+'## 2026-10-26\nrecent')
 const recalled=readMemory(home,{mode:'recall',keyword:'ANCIENT_SENTINEL'})
 assert.equal(recalled.records.length,1);assert.equal(recalled.records[0].date,'2010-01-01')
 const context=readMemory(home,{now})
 assert.ok(!JSON.stringify(context).includes('ANCIENT_SENTINEL'))
 assert.ok(context.diagnostics.some(d=>d.status==='scan-window-limited'))
 assert.ok(context.omitted>0)
})

test('private legacy continuity reaches whale native/fallback sessions but not public CLI context or summary',t=>{
 const home=fixture(t)
 put(home,'whale-diary-private.md','## 2010-01-01\nPRIVATE_SENTINEL\n## 心事\nprivate free prose')
 put(home,'whale-memory-summary.md','PUBLIC_SUMMARY')
 put(home,'whale-log.jsonl',Array.from({length:80},()=>JSON.stringify({at:new Date(now).toISOString(),note:'public activity'})).join('\n'))
 const before=fs.readFileSync(path.join(home,'whale-diary-private.md'))
 assert.ok(!JSON.stringify(readMemory(home,{now})).includes('PRIVATE_SENTINEL'))
 assert.ok(!JSON.stringify(readMemory(home,{mode:'recall'})).includes('PRIVATE_SENTINEL'))
 let definition
 const adapter=createMemoryContext({systemPrompt:{context:d=>{definition=d}}},{dshHome:home,now:()=>now})
 adapter.refresh('whale')
 assert.match(definition.text({agent:{session:{id:'whale'}}}),/PRIVATE_SENTINEL/)
 assert.equal(definition.text({agent:{session:{id:'other'}}}),'')
 const prompt=createMemoryContext({},{dshHome:home,now:()=>now}).refresh('whale')
 assert.match(prompt,/PRIVATE_SENTINEL/);assert.ok(charsForTest(prompt)<=MEMORY_LIMITS.outputChars)
 const output=JSON.parse(prompt.slice(prompt.indexOf('{')))
 assert.equal(output.summary.text,'PUBLIC_SUMMARY')
 assert.ok(output.records.filter(r=>r.source==='whale-diary-private.md').every(r=>r.private))
 assert.deepEqual(fs.readFileSync(path.join(home,'whale-diary-private.md')),before)
 adapter.stop();assert.equal(definition.text({agent:{session:{id:'whale'}}}),'')
})

test('CLI validates offsets, supports unfiltered pages and keeps private opt-in explicit',t=>{
 const home=fixture(t);put(home,'whale-diary-private.md','private only')
 const run=(...args)=>spawnSync(process.execPath,['tools/commands/memory.mjs',...args],{env:{...process.env,DSH_HOME:home},encoding:'utf8'})
 for(const args of [['recall','--offset','-1'],['recall','--offset','1.5'],['context','--offset','0'],['context','--private']])assert.equal(run(...args).status,2)
 assert.equal(JSON.parse(run('recall').stdout).records.length,0)
 assert.equal(JSON.parse(run('recall','--private').stdout).records[0].text,'private only')
})

test('escaped long diary and log records cannot stall paging or exceed output budget',t=>{
 const home=fixture(t)
 put(home,'whale-diary.md','\u0000'.repeat(24000)+'😀'.repeat(5000))
 put(home,'whale-log.jsonl',JSON.stringify({at:new Date(now).toISOString(),text:'\u0000'.repeat(2000)}))
 let offset=0, count=0
 for(let i=0;i<100;i++){
  const result=readMemory(home,{mode:'recall',offset})
  assert.ok(charsForTest(JSON.stringify(result))<=MEMORY_LIMITS.jsonChars)
  count+=result.records.filter(r=>r.source==='whale-diary.md').reduce((n,r)=>n+charsForTest(r.text),0)
  if(result.nextOffset===null)break
  assert.ok(result.nextOffset>offset);offset=result.nextOffset;assert.ok(i<99)
 }
 assert.equal(count,29000)
 assert.ok(charsForTest(memoryPrompt(home,{now}))<=MEMORY_LIMITS.outputChars)
})

test('automatic diary previews reserve room for both public and private continuity',t=>{
 const home=fixture(t)
 put(home,'whale-diary.md','\u0000'.repeat(1000))
 put(home,'whale-diary-private.md','PRIVATE_CONTINUITY')
 const result=readMemory(home,{includePrivate:true,now})
 assert.ok(result.records.some(r=>r.private && r.text==='PRIVATE_CONTINUITY'))
 assert.ok(result.diagnostics.some(d=>d.status.startsWith('context-excerpt-shortened')))
 for(const row of result.records){const bytes=fs.readFileSync(path.join(home,row.source));assert.equal(bytes.subarray(row.range.start,row.range.end).toString('utf8'),row.text)}
 assert.equal(readMemory(home,{mode:'recall'}).records[0].text.length,1000)
})

test('UTF-8 across 8192-byte physical reads and trailing whitespace reconstruct exactly',t=>{
 const home=fixture(t)
 for(const original of ['a'.repeat(8191)+'é'+'tail', 'a'.repeat(8191)+'😀'+'tail', 'a'.repeat(8190)+'中'+'tail', ('a'.repeat(8191)+'😀').repeat(5)+'\r\n'+' '.repeat(2500), ' '.repeat(3000)]) {
  put(home,'whale-diary.md',original)
  const bytes=Buffer.from(original), rows=[]
  let offset=0
  for(let page=0;page<100;page++) {
   const result=readMemory(home,{mode:'recall',offset})
   rows.push(...result.records)
   if(result.nextOffset===null)break
   assert.ok(result.nextOffset>offset);offset=result.nextOffset;assert.ok(page<99)
  }
  assert.equal(rows.map(r=>r.text).join(''),original)
  for(const row of rows)assert.equal(bytes.subarray(row.range.start,row.range.end).toString('utf8'),row.text)
  assert.deepEqual(fs.readFileSync(path.join(home,'whale-diary.md')),bytes)
 }
})

test('malformed UTF-8 exits with an explicit diagnostic instead of stalling or replacing bytes',t=>{
 const home=fixture(t)
 for(const bytes of [Buffer.alloc(9000,0x80),Buffer.concat([Buffer.from('valid prefix\n'),Buffer.from([0xc3,0x28])]),Buffer.from([0xf0,0x9f])]) {
  fs.writeFileSync(path.join(home,'whale-diary.md'),bytes)
  const child=spawnSync(process.execPath,['tools/commands/memory.mjs','recall'],{env:{...process.env,DSH_HOME:home},encoding:'utf8',timeout:3000})
  assert.ifError(child.error);assert.equal(child.status,0,child.stderr)
  const result=JSON.parse(child.stdout)
  assert.ok(result.diagnostics.some(d=>d.source==='whale-diary.md'&&d.status==='invalid-utf8'))
  assert.ok(!result.records.some(r=>r.text.includes('\ufffd')))
  assert.deepEqual(fs.readFileSync(path.join(home,'whale-diary.md')),bytes)
 }
})

test('bounded tail may begin inside a UTF-8 code point without corrupting later excerpts',t=>{
 const home=fixture(t), original='x'.repeat(12)+'😀\n'+'a'.repeat(MEMORY_LIMITS.scanBytes-2)
 put(home,'whale-diary.md',original)
 const result=readMemory(home,{now})
 assert.ok(result.diagnostics.some(d=>d.status==='scan-window-limited'))
 assert.ok(!result.diagnostics.some(d=>d.status==='invalid-utf8'))
 assert.ok(result.records.length)
 const bytes=Buffer.from(original)
 for(const row of result.records)assert.equal(bytes.subarray(row.range.start,row.range.end).toString('utf8'),row.text)
})

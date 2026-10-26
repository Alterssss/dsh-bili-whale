import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawn,spawnSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url))
const row=(seq,ts=1000,sender=222)=>({msg_seqno:seq,msg_key:String(seq),timestamp:ts,sender_uid:sender,content:JSON.stringify({content:'message '+seq})})
const page=(messages,has_more=0)=>({code:0,data:{messages,has_more}})
function box(t){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'dm-history-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
 fs.mkdirSync(path.join(home,'.bili-ai'));fs.mkdirSync(path.join(home,'.dsh'))
 const state=path.join(home,'.bili-ai/dm-await-state.json'),cfg=path.join(home,'.dsh/bili-whale.config.json'),fixture=path.join(home,'history.json'),log=path.join(home,'requests')
 fs.writeFileSync(path.join(home,'.bili-ai/credentials.json'),JSON.stringify({sessdata:'fake',bili_jct:'fake'}));fs.writeFileSync(cfg,JSON.stringify({owner:{mid:'222'}}))
 const env={...process.env,HOME:home,USERPROFILE:home,DSH_HOME:path.join(home,'.dsh'),BILI_WHALE_CONFIG:cfg,BILI_TRAFFIC_TEST:'1',NODE_TEST_CONTEXT:'child-v8',NODE_OPTIONS:'--import='+pathToFileURL(path.join(root,'tests/helpers/history-fetch.mjs')),TEST_HISTORY:fixture,TEST_REQUESTS:log}
 const run=(...args)=>spawnSync(process.execPath,[path.join(root,'tools/commands/dm-await.mjs'),'--json',...args],{env,encoding:'utf8',timeout:10000})
 return {home,env,state,log,run,put:d=>fs.writeFileSync(fixture,JSON.stringify(d)),save:d=>fs.writeFileSync(state,JSON.stringify(d)),read:()=>JSON.parse(fs.readFileSync(state)),peek:()=>{const r=run('--once','--peek');assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout)}}
}
test('real CLI queues consecutive owner messages chronologically despite own latest message; retries stable, ack drains without network',t=>{
 const b=box(t);b.save({owner:'222',lastSeen:900});b.put(page([row(3,1002,111),row(2,1001),row(1,1000)]))
 const a=b.peek();assert.equal(a.text,'message 1');const network=fs.readFileSync(b.log,'utf8')
 assert.equal(b.peek().receipt,a.receipt);assert.equal(b.run('--ack','wrong').status,2)
 assert.equal(b.run('--ack',a.receipt).status,0);const c=b.peek();assert.equal(c.text,'message 2')
 assert.equal(fs.readFileSync(b.log,'utf8'),network);assert.equal(b.run('--ack',c.receipt).status,0)
 assert.equal(b.run('--once','--peek').status,1);assert.equal(b.read().lastSeen,1001)
})
test('same-second IDs deduplicate across restart and page overlaps',t=>{
 const b=box(t);b.save({owner:'222',lastSeen:1000,lastKey:'1'});b.put({pages:{0:page([row(3),row(2)],1),2:page([row(2),row(1)],0)}})
 const a=b.peek();assert.equal(a.key,'2');assert.equal(b.run('--ack',a.receipt).status,0)
 const c=b.peek();assert.equal(c.key,'3');assert.equal(b.run('--ack',c.receipt).status,0)
 assert.equal(b.run('--once','--peek').status,1);assert.deepEqual(b.read().lastKeys,['1','2','3'])
})
test('partial history failure and non-progressing pagination do not advance state',t=>{
 const b=box(t);b.save({owner:'222',lastSeen:900});const before=fs.readFileSync(b.state,'utf8')
 b.put({pages:{0:page([row(3),row(2)],1),2:{code:-500}}});assert.equal(b.run('--peek').status,3);assert.equal(fs.readFileSync(b.state,'utf8'),before)
 b.put({pages:{0:page([row(3),row(2)],1),2:page([row(3),row(2)],1)}});assert.equal(b.run('--peek').status,3);assert.equal(fs.readFileSync(b.state,'utf8'),before)
})
test('empty is exit 1; baseline skips both directions; corrupt state is preserved; legacy pending remains ackable',t=>{
 const b=box(t);b.put(page([]));const r=b.run('--peek');assert.equal(r.status,1);assert.equal(JSON.parse(r.stdout).hit,false)
 b.put(page([row(2,1000,111),row(1,999)]));assert.equal(b.run('--baseline').status,0);assert.equal(b.run('--peek').status,1)
 b.save({owner:'222',pending:{mid:'222',hit:true,receipt:'legacy',ts:1001,key:'old',text:'pending'}});assert.equal(b.peek().receipt,'legacy');assert.equal(b.run('--ack','legacy').status,0)
 fs.writeFileSync(b.state,'broken');assert.equal(b.run('--peek').status,3);assert.equal(fs.readFileSync(b.state,'utf8'),'broken')
})
test('page cap fails without skipping unread messages',t=>{
 const b=box(t);b.save({owner:'222',lastSeen:1});const before=fs.readFileSync(b.state,'utf8'),pages={}
 let cursor='0';for(let i=0;i<10;i++){const seq=100-i;pages[cursor]=page([row(seq,1000)],1);cursor=String(seq)}
 b.put({pages});const r=b.run('--peek');assert.equal(r.status,3);assert.match(r.stderr,/10 页/);assert.equal(fs.readFileSync(b.state,'utf8'),before)
})

test('killed real CLI releases lock; concurrent CLI fails without touching state; legacy lock cannot wedge listener',async t=>{
 const b=box(t);b.put(page([row(1,1000)]));b.save({owner:'222',lastSeen:900})
 const before=fs.readFileSync(b.state,'utf8'),ready=path.join(b.home,'ready'),preload=path.join(b.home,'hang.mjs')
 fs.writeFileSync(preload,`import fs from 'node:fs';globalThis.fetch=()=>{fs.writeFileSync(${JSON.stringify(ready)},'ready');return new Promise(()=>{setInterval(()=>{},1000)})}`)
 const child=spawn(process.execPath,[path.join(root,'tools/commands/dm-await.mjs'),'--peek','--json'],{env:{...b.env,NODE_OPTIONS:'--import='+pathToFileURL(preload)},stdio:'ignore'})
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL')})
 const deadline=Date.now()+10000
 while(!fs.existsSync(ready)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25))
 assert.ok(fs.existsSync(ready),'child reached network under lock')
 const concurrent=b.run('--peek');assert.equal(concurrent.status,3);assert.match(concurrent.stderr,/锁不可用/)
 assert.equal(fs.readFileSync(b.state,'utf8'),before)
 const exited=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await exited
 fs.writeFileSync(b.state+'.lock','')
 const hit=b.peek();assert.equal(hit.key,'1');assert.equal(b.run('--ack',hit.receipt).status,0)
 assert.equal(b.run('--peek').status,1)
})

test('withdrawal and nontext events are not chat; revoked text in fetched batch is suppressed',t=>{
 const b=box(t);b.save({owner:'222',lastSeen:900})
 b.put(page([{...row(5,1004),msg_type:5,content:'"1"'},{...row(4,1003),msg_type:2},row(3,1002),row(2,1001,111),row(1,1000)]))
 const hit=b.peek();assert.equal(hit.key,'3');assert.equal(b.read().lastIncoming,1002)
 assert.equal(b.run('--ack',hit.receipt).status,0);assert.equal(b.run('--peek').status,1)
})

test('baseline does not count old messages as fresh owner feedback',t=>{
 const b=box(t);b.put(page([row(2,1000),row(1,999)]));assert.equal(b.run('--baseline').status,0)
 assert.equal(b.read().lastIncoming,undefined)
})

test('picture messages (msg_type=2 with url) are delivered as image references',t=>{
 const b=box(t);b.save({owner:'222',lastSeen:900})
 const url='https://message.biliimg.com/bfs/im_new/e3df234d.jpg'
 b.put(page([{msg_seqno:9,msg_key:'9',timestamp:1005,sender_uid:222,msg_type:2,content:JSON.stringify({url,width:1254,height:1254,imageType:'jpeg',original:1,size:'779'})}]))
 const hit=b.peek();assert.equal(hit.text,'[图片]');assert.deepEqual(hit.image,{url,width:1254,height:1254})
 assert.equal(b.run('--ack',hit.receipt).status,0);assert.equal(b.run('--peek').status,1)
})

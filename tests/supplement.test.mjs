process.env.BILI_TRAFFIC_TEST = '1'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {makePlan,completePlan,historyOf,inWindow} from '../tools/lib/night-plan.mjs'
import {apiGet,signWbi} from '../tools/lib/bili-api.mjs'
const root=fileURLToPath(new URL('../',import.meta.url))
function sandbox(t,cfg={}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-supplement-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const dsh=path.join(home,'.dsh'),data=path.join(home,'.bili-ai');fs.mkdirSync(dsh);fs.mkdirSync(data)
 fs.writeFileSync(path.join(dsh,'bili-whale.config.json'),JSON.stringify({owner:{mid:'222',name:'Owner'},self:{mid:'111'},share:{enabled:true},notify:{type:'none'},...cfg}))
 fs.writeFileSync(path.join(data,'credentials.json'),JSON.stringify({sessdata:'fake',bili_jct:'a'.repeat(32)}))
 const env={...process.env,USERPROFILE:home,HOME:home,DSH_HOME:dsh,DSH_NODE:process.execPath,BILI_WHALE_CONFIG:path.join(dsh,'bili-whale.config.json'),TEST_REQUESTS:path.join(home,'requests'),NODE_OPTIONS:'--import='+pathToFileURL(path.join(root,'tests/helpers/supplement-fetch.mjs')).href}
 return {home,dsh,data,env,write:(name,value)=>fs.writeFileSync(path.join(data,name),JSON.stringify(value)),run:(cmd,args=[])=>spawnSync(process.execPath,[path.join(root,'tools/commands/'+cmd+'.mjs'),...args],{env,encoding:'utf8',timeout:15000})}
}
const comment=['--oid','1','--bvid','BV1234567890','--message','test','--share','--auto','--reason','这个视频确实值得测试分享','--score','15','--rank','1','--dry']
const dm=['--msg','BV1234567890','--share','--reason','这个视频确实值得测试分享','--score','15','--rank','1','--dry']

test('issue 20: diary renders LF and CRLF narratives and JSONL identically', t=>{
 const s=sandbox(t),date=new Date().toLocaleDateString('sv-SE')
 const diary=`## 看过\n| 时间 | BV | 标题 | 简介 | 想法 |\n| --- | --- | --- | --- | --- |\n| ${date} | BV1234567890 | 测试标题 | 简介 | 感受 |\n## 想说\n- 测试想法\n`
 const event=JSON.stringify({at:new Date().toISOString(),kind:'test-event'})+'\n'
 const results=[]
 for(const newline of ['\n','\r\n']) {fs.writeFileSync(path.join(s.dsh,'whale-diary.md'),diary.replaceAll('\n',newline));fs.writeFileSync(path.join(s.dsh,'whale-log.jsonl'),event.replaceAll('\n',newline));const r=s.run('diary',['legacy-show']);assert.equal(r.status,0);assert.match(r.stdout,/看过 1 条/);assert.match(r.stdout,/想说但还没说 1 条/);assert.match(r.stdout,/test-event/);results.push(r.stdout);assert.match(s.run('diary',['tail']).stdout,/test-event/)}
 assert.equal(results[0],results[1])
})

test('issue 19: DM status explains both directions and unknown reverse state',t=>{
 const s=sandbox(t)
 for(const [outgoing,incoming] of [[0,0],[2,0],[0,2],[6,6]]) {
  s.env.TEST_RELATION=String(outgoing);s.env.TEST_BE_RELATION=String(incoming)
  const r=s.run('dm',['--status']);assert.equal(r.status,0)
  assert.ok(r.stdout.includes(`她 → 主人：${[2,6].includes(outgoing)?'已关注':'未关注'}`))
  assert.ok(r.stdout.includes(`主人 → 她：${[2,6].includes(incoming)?'已关注':'未关注'}`))
 }
 delete s.env.TEST_BE_RELATION;s.env.TEST_RELATION='2';assert.match(s.run('dm',['--status']).stdout,/主人 → 她：未知/)
 assert.doesNotMatch(fs.readFileSync(s.env.TEST_REQUESTS,'utf8'),/POST/)
})

test('issue 40: multi-day diary includes middle dates and empty cells do not shift columns',t=>{
 const s=sandbox(t),date=new Date(Date.now()-86400000).toLocaleDateString('sv-SE')
 fs.writeFileSync(path.join(s.dsh,'whale-diary.md'),`## 看过\n| 时间 | BV | 标题 | 简介 | 想法 |\n| --- | --- | --- | --- | --- |\n| ${date} | | 中间日期标题 | | 保留想法列 |\n`)
 const r=s.run('diary',['legacy-show','--days','3']);assert.equal(r.status,0,r.stderr)
 assert.match(r.stdout,/看过 1 条/);assert.match(r.stdout,/· 中间日期标题/);assert.match(r.stdout,/她的想法：保留想法列/)
})

const images={img_url:'https://i.test/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i.test/4932caff0ff746eab6f01bf08b70ac45.png'}
test('issue 18: affected metadata CLIs fail cleanly on HTTP 412 without writes',t=>{
 const s=sandbox(t);s.env.NODE_OPTIONS='--import='+pathToFileURL(path.join(root,'tests/helpers/api-fetch.mjs')).href;s.env.BILI_NO_CACHE='1'
 for(const [cmd,args] of [['comments',['BV1234567890','--json']],['subtitles',['BV1234567890']],['debrief',['BV1234567890','--no-frames']],['video-content',['BV1234567890']],['fav',['BV1234567890','--reason','这个视频值得收藏','--dry']]]) {
  const r=s.run(cmd,args);assert.equal(r.status,3,cmd+': '+r.stdout+r.stderr);assert.match(r.stdout+r.stderr,/HTTP 412/);assert.doesNotMatch(r.stdout+r.stderr,/SyntaxError|private diagnostic|at async/)
 }
 const requests=fs.readFileSync(s.env.TEST_REQUESTS,'utf8');assert.doesNotMatch(requests,/POST/);assert.doesNotMatch(requests,/web-interface\/view\?/)
})
test('issue 18: WBI signing matches the known canonical vector',()=>{
 assert.equal(signWbi({foo:'114',bar:'514',baz:1919810},images,1702204169000),'bar=514&baz=1919810&foo=114&wts=1702204169&w_rid=6149fdadf571698ca7e6a567265cd0ee')
 assert.throws(()=>signWbi({},{}),/密钥/)
})
test('issue 18: metadata and playback use signed endpoints; errors never expose HTML',async t=>{
 process.env.BILI_NO_CACHE='1'
 t.after(()=>{delete process.env.BILI_NO_CACHE})
 const calls=[];t.mock.method(globalThis,'fetch',async input=>{const u=new URL(input);calls.push(u);if(u.pathname.endsWith('/nav'))return new Response(JSON.stringify({code:0,data:{wbi_img:images}}));assert.match(u.pathname,/\/wbi\//);assert.match(u.searchParams.get('w_rid'),/^[a-f0-9]{32}$/);return new Response(JSON.stringify({code:0,data:{aid:42}}))})
 for(const endpoint of ['/x/web-interface/view?bvid=BV1234567890','/x/player/playurl?bvid=BV1234567890&cid=1'])assert.equal((await apiGet('https://api.bilibili.com'+endpoint)).data.aid,42)
 assert.equal(calls.length,4)
 for(const [status,body] of [[412,'<html>secret</html>'],[200,'<html>secret</html>'],[200,'null']]) {globalThis.fetch=async()=>new Response(body,{status});const r=await apiGet('https://api.bilibili.com/x/web-interface/nav');assert.notEqual(r.code,0);assert.match(r.message,/HTTP/);assert.doesNotMatch(r.message,/secret|SyntaxError/)}
 globalThis.fetch=async()=>{throw new Error('secret cookie')};assert.doesNotMatch((await apiGet('https://api.bilibili.com/x/web-interface/nav')).message,/secret/)
})
test('A4 dry comment and DM reject recently shared video without POST',t=>{
 for(const [cmd,args] of [['comment',comment],['dm',dm]]) {const s=sandbox(t);s.write('quota.json',{log:[{at:new Date().toISOString(),share:true,target:'BV:BV1234567890'}]});const r=s.run(cmd,args);assert.notEqual(r.status,0,cmd+' incorrectly passed dry run');assert.match(r.stdout+r.stderr,/7 天/);assert.doesNotMatch(fs.readFileSync(s.env.TEST_REQUESTS,'utf8'),/POST/)}
})
test('A5 reason, score and rank are independently rejected',t=>{
 const s=sandbox(t);for(const [flag,value] of [['--reason','短'],['--score','5'],['--rank','2']]){const a=[...comment];a[a.indexOf(flag)+1]=value;const r=s.run('comment',a);assert.notEqual(r.status,0)}assert.equal(fs.existsSync(s.env.TEST_REQUESTS),false)
})
test('A6 both transports reject disabled sharing before network',t=>{const s=sandbox(t,{share:{enabled:false}});for(const [cmd,args]of [['comment',comment],['dm',dm]])assert.notEqual(s.run(cmd,args).status,0);assert.equal(fs.existsSync(s.env.TEST_REQUESTS),false)})
test('A7 DM rejects non-mutual relation and a different daily recipient',t=>{const s=sandbox(t);s.env.TEST_RELATION='2';assert.equal(s.run('dm',['--msg','test','--dry']).status,4);s.env.TEST_RELATION='6';s.write('dm-quota.json',{date:new Date().toLocaleDateString('sv-SE'),mid:'999',count:1});assert.equal(s.run('dm',['--msg','test','--dry']).status,4)})
test('A9 notify propagates remote DM failure',t=>{const s=sandbox(t,{notify:{type:'dm'}});s.env.TEST_DM_CODE='-111';assert.equal(s.run('notify',['test']).status,1)})
test('B6 favorites use most recent duplicate, not first historical match',t=>{const s=sandbox(t);s.write('favorites.json',{items:[{account:'111',bv:'BV1234567890',at:new Date(Date.now()-40*864e5).toISOString()},{account:'111',bv:'BV1234567890',at:new Date(Date.now()-864e5).toISOString()}]});const r=s.run('fav',['--check','BV1234567890','--reason','收藏回归测试理由']);assert.notEqual(r.status,0,r.stdout)})
test('B6 daily favorite cap and category cap reject before network',t=>{const s=sandbox(t);s.write('favorites.json',{items:Array.from({length:3},(_,i)=>({account:'111',bv:'other'+i,at:new Date().toISOString(),kind:'其他'}))});assert.notEqual(s.run('fav',['--check','BV1234567890','--reason','收藏回归测试理由']).status,0)})
test('C1 failed deletion must return nonzero',t=>{const s=sandbox(t);assert.notEqual(s.run('comment-del',['--oid','1','--rpid','2','--go']).status,0)})
test('C3 file backend dry run must not create a notification',t=>{const out=path.join(os.tmpdir(),'whale-notify-'+process.pid+'-'+Date.now());t.after(()=>fs.rmSync(out,{force:true}));const s=sandbox(t,{notify:{type:'file',path:out}});assert.equal(s.run('notify',['test','--dry']).status,0);assert.equal(fs.existsSync(out),false)})
test('B1 skip consumes one opportunity; B2/B3 gap survives replan',()=>{const start=new Date('2026-10-22T03:00:00').getTime(),cfg={windows:[{start:'03:00',end:'03:20',wakes:5}],skipChance:1,minGapMin:10};const first=makePlan(cfg,{},start,()=>0),done=completePlan(first,start);const next=makePlan(cfg,historyOf(done,start+1000),start+1000,()=>0);assert.equal(next.action,'skip');assert.match(next.withinWindow,/2\/5/);assert.equal(next.atMs,start+600000);const after=completePlan(next,next.atMs);assert.equal(makePlan(cfg,after,next.atMs+1000,()=>0).action,'done');const longer={...cfg,windows:[{start:'03:00',end:'04:00',wakes:5}]};assert.notEqual(makePlan(longer,after,next.atMs+1000,()=>0).action,'done')})
test('B4/B5 midnight chooses earliest real deadline',()=>{const now=new Date('2026-10-22T00:30:00').getTime(),cfg={windows:[{start:'23:00',end:'01:00',wakes:1},{start:'00:00',end:'08:00',wakes:1}],skipChance:0};assert.equal(makePlan(cfg,{},now,()=>0).windowKey,'2026-10-21|23:00–01:00');for(const at of ['2026-10-21T23:30:00','2026-10-22T00:30:00'])assert.equal(inWindow({windows:[cfg.windows[0]]},Date.parse(at)),true)})
test('D2 silence lowers cap; D3 daily quota resets next day',t=>{const s=sandbox(t,{quota:{shareDaily:3}});s.write('feedback.json',{last:new Date(Date.now()-4*864e5).toISOString()});const silence=s.run('quota',['silence']);assert.equal(silence.status,0);assert.match(silence.stdout,/4/);s.write('quota.json',{log:Array.from({length:5},()=>({at:new Date().toISOString(),share:true,target:'different'}))});assert.equal(s.run('quota',['check','--share','--target','BV:new']).status,2);s.write('quota.json',{log:Array.from({length:5},()=>({at:new Date(Date.now()-864e5).toISOString(),share:true,target:'different'}))});assert.equal(s.run('quota',['check','--share','--target','BV:new']).status,0)})

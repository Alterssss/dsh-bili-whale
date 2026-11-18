import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createLifeStore} from '../tools/lib/life-store.mjs'
import {prepareExpression,finalizeExpression} from '../tools/lib/expression.mjs'
const root=fileURLToPath(new URL('../',import.meta.url))
function setup(t,life={}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-hard-cli-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
 const dsh=path.join(home,'portable'),data=path.join(home,'.bili-ai');fs.mkdirSync(dsh);fs.mkdirSync(data)
 const cfg={owner:{mid:'222',name:'Owner'},self:{mid:'111'},life:{requireDraft:true,commentVerifySeconds:1,hardMode:'enforce',...life},notify:{type:'none'}}
 const config=path.join(dsh,'bili-whale.config.json');fs.writeFileSync(config,JSON.stringify(cfg))
 fs.writeFileSync(path.join(data,'credentials.json'),JSON.stringify({sessdata:'synthetic',bili_jct:'a'.repeat(32)}))
 const env={...process.env,USERPROFILE:home,HOME:home,DSH_HOME:dsh,DSH_NODE:process.execPath,BILI_WHALE_CONFIG:config,TEST_REQUESTS:path.join(home,'requests.jsonl'),TEST_VISIBILITY:'public',NODE_OPTIONS:'--import='+pathToFileURL(path.join(root,'tests/helpers/life-hard-fetch.mjs')).href}
 const store=createLifeStore({dshHome:dsh,account:'111',owner:'222',ownerName:'Owner',config:cfg.life})
 return {env,store,run:(cmd,args)=>spawnSync(process.execPath,[path.join(root,'tools/commands/'+cmd+'.mjs'),...args],{env,encoding:'utf8',timeout:15000}),requests:()=>fs.existsSync(env.TEST_REQUESTS)?fs.readFileSync(env.TEST_REQUESTS,'utf8').trim().split('\n').map(JSON.parse):[]}
}
const shareArgs=['--share','--auto','--reason','这段素材适合本轮测试','--score','18','--rank','1']
async function draft(s,extra={}){const d=await prepareExpression(s.store,{scene:'public-comment',target:'BV1234567890',thread:'1:123:top',text:'白猫回头 [笑哭]',...extra});await finalizeExpression(s.store,d.id);return d.id}
test('requireDraft share succeeds first time without manually prepending @',async t=>{
 const s=setup(t),id=await draft(s)
 const dry=s.run('comment',['--draft',id,...shareArgs,'--dry']);assert.equal(dry.status,0,dry.stdout+dry.stderr);assert.equal(s.requests().filter(r=>r.method==='POST').length,0)
 const go=s.run('comment',['--draft',id,...shareArgs,'--go']);assert.equal(go.status,0,go.stdout+go.stderr)
 const post=s.requests().find(r=>r.url.includes('/reply/add'));assert.equal(new URLSearchParams(post.body).get('message'),'@Owner 白猫回头 [笑哭]')
 const sent=s.store.read().events.find(e=>e.kind==='sent');assert.equal(sent.visibility.status,'public');assert.equal(s.store.read().drafts[0].status,'sent')
 const second=s.run('comment',['--draft',id,...shareArgs,'--go']);assert.notEqual(second.status,0);assert.equal(s.requests().filter(r=>r.url.includes('/reply/add')).length,1)
})
test('both dry and go enforce explicit length before POST or reservation',t=>{
 const s=setup(t,{requireDraft:false})
 for(const mode of ['--dry','--go']){
  const r=s.run('comment',['--oid','123','--bvid','BV1234567890','--message','猫'.repeat(61),mode]);assert.notEqual(r.status,0,r.stdout+r.stderr);assert.match(r.stderr,/form:too-long/)
 }
 assert.equal(s.requests().filter(r=>r.method==='POST').length,0);assert.equal(s.store.status().pending.length,0)
})
test('DM uses same configured checker while default private replies remain untouched',t=>{
 const s=setup(t,{requireDraft:false,hardScenes:['private-reply']})
 for(const mode of ['--dry','--go']){const r=s.run('dm',['--msg','猫'.repeat(61),mode]);assert.notEqual(r.status,0);assert.match(r.stderr,/form:too-long/)}
 assert.equal(s.requests().filter(r=>r.method==='POST').length,0)
})
test('a conflicting CLI target never gets substituted into the saved draft',async t=>{
 const s=setup(t),id=await draft(s)
 const r=s.run('comment',['--draft',id,'--oid','999','--go']);assert.equal(r.status,2);assert.match(r.stderr,/oid 不匹配/);assert.equal(s.requests().filter(r=>r.method==='POST').length,0)
})
test('read-back transport failure preserves sent receipt, quota, exit success and no resend',async t=>{
 const s=setup(t),id=await draft(s);s.env.TEST_VISIBILITY='error'
 const r=s.run('comment',['--draft',id,...shareArgs,'--go']);assert.equal(r.status,0,r.stdout+r.stderr)
 assert.match(r.stdout,/不表示发送失败/);assert.equal(s.store.status().pending.length,0)
 assert.equal(s.store.read().events.find(e=>e.kind==='sent').visibility.status,'unconfirmed')
 assert.equal(s.requests().filter(r=>r.url.includes('/reply/add')).length,1)
})
test('legacy no-draft request explains exact prepare/finalize workflow',t=>{
 const s=setup(t),r=s.run('comment',['--oid','123','--bvid','BV1234567890','--message','白猫 [笑哭]',...shareArgs,'--dry'])
 assert.notEqual(r.status,0);assert.match(r.stderr,/prepare.*finalize/)
})
test('draft-only reply still enforces configured once-per-person gate',async t=>{
 const s=setup(t),id=await draft(s,{scene:'reply',thread:'1:123:456',parent:'789'})
 const file=s.env.BILI_WHALE_CONFIG,cfg=JSON.parse(fs.readFileSync(file,'utf8'));cfg.listen={oncePerPerson:true};fs.writeFileSync(file,JSON.stringify(cfg))
 const r=s.run('comment',['--draft',id,'--go']);assert.equal(r.status,2,r.stdout+r.stderr);assert.match(r.stderr,/没查到被回复者/)
 assert.equal(s.requests().filter(r=>r.method==='POST').length,0)
})

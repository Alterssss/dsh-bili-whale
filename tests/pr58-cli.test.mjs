import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {createLifeStore} from '../tools/lib/life-store.mjs'
import {prepareExpression,finalizeExpression} from '../tools/lib/expression.mjs'
function fixture(t,helper){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-pr58-cli-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
 const dsh=path.join(home,'.dsh');fs.mkdirSync(dsh);fs.mkdirSync(path.join(home,'.bili-ai'))
 const full={self:{mid:'111'},owner:{mid:'222'},life:{requireDraft:true}}
 const cfg=path.join(dsh,'bili-whale.config.json');fs.writeFileSync(cfg,JSON.stringify(full))
 fs.writeFileSync(path.join(home,'.bili-ai/credentials.json'),JSON.stringify({sessdata:'fixture-session-secret',bili_jct:'fixture-csrf-secret'}))
 const env={...process.env,HOME:home,USERPROFILE:home,DSH_HOME:dsh,DSH_NODE:process.execPath,BILI_WHALE_CONFIG:cfg,BILI_TRAFFIC_TEST:'1',NODE_TEST_CONTEXT:'child-v8',TEST_REQUESTS:path.join(home,'requests'),NODE_OPTIONS:'--import='+new URL('./helpers/'+helper,import.meta.url).href}
 const store=createLifeStore({dshHome:dsh,account:'111',owner:'222',config:full.life,fullConfig:full})
 const run=(args,extra={})=>{const r=spawnSync(process.execPath,[fileURLToPath(new URL('../tools/bili.mjs',import.meta.url)),...args],{env:{...env,...extra},encoding:'utf8',timeout:30000});assert.ifError(r.error);return r}
 return {home,dsh,store,run}
}
test('real dm-batch CLI previews with no writes, persists failure and resumes without duplicating first message',t=>{
 const x=fixture(t,'dm-media-fetch.mjs'),file=path.join(x.home,'reply.json');fs.writeFileSync(file,JSON.stringify(['first body','second body']))
 let r=x.run(['dm-batch','--file',file,'--dry']);assert.equal(r.status,0,r.stderr);assert.equal(fs.existsSync(path.join(x.dsh,'whale-life')),false)
 r=x.run(['dm-batch','--file',file,'--go'],{TEST_REJECT_TEXT:'second body'});assert.equal(r.status,1,r.stdout+r.stderr)
 const b=x.store.read().settings.dmBatches[0];assert.deepEqual(b.parts.map(p=>p.status),['sent','ready'])
 r=x.run(['dm-batch','--file',file,'--go']);assert.equal(r.status,0,r.stdout+r.stderr)
 assert.deepEqual(x.store.read().events.filter(e=>e.kind==='sent').map(e=>e.text),['first body','second body'])
 r=x.run(['dm-batch','--resume',b.id,'--go']);assert.equal(r.status,0,r.stderr)
 assert.equal(x.store.read().events.filter(e=>e.kind==='sent').length,2)
})
for(const mode of ['success','reject','transport','no-receipt'])test('real dynamic draft CLI truthfully handles '+mode,async t=>{
 const x=fixture(t,'dynamic-create-fetch.mjs')
 const d=await prepareExpression(x.store,{channel:'dynamic',scene:'public-comment',target:'111',text:'公开感想',share:false});await finalizeExpression(x.store,d.id)
 let r=x.run(['dynamic','post','--draft',d.id,'--auto','--dry']);assert.equal(r.status,0,r.stderr)
 r=x.run(['dynamic','post','--draft',d.id,'--auto','--go'],{TEST_DYNAMIC_RESULT:mode})
 assert.equal(r.status,mode==='success'?0:1,r.stdout+r.stderr)
 const s=x.store.read();assert.equal(s.events.filter(e=>e.kind==='sent').length,mode==='success'?1:0)
 assert.equal(Object.keys(s.pending).length,['transport','no-receipt'].includes(mode)?1:0)
 assert.doesNotMatch(r.stdout+r.stderr,/fixture-csrf-secret|fixture-session-secret/)
 if(mode==='success')assert.equal(s.events.find(e=>e.kind==='sent').receipt,'1262823889456594949')
 if(['transport','no-receipt'].includes(mode)){
   r=x.run(['dynamic','post','--draft',d.id,'--auto','--go']);assert.notEqual(r.status,0)
   assert.equal(x.store.read().events.filter(e=>e.kind==='sent').length,0)
 }
})

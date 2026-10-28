import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url))
for(const kind of ['text','image'])for(const mode of ['dry','success','reject','transport'])test(`dynamic ${kind} ${mode}: CSRF query, redaction, correct exit and ledger`,t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-dynamic-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
 const data=path.join(home,'.bili-ai'),dsh=path.join(home,'.dsh');fs.mkdirSync(data);fs.mkdirSync(dsh)
 fs.writeFileSync(path.join(data,'credentials.json'),JSON.stringify({sessdata:'fixture-session-secret',bili_jct:'fixture-csrf-secret',buvid3:'fake'}))
 fs.writeFileSync(path.join(dsh,'bili-whale.config.json'),'{}')
 const img=Buffer.alloc(24);img.write('\x89PNG',0,'latin1');img.writeUInt32BE(1,16);img.writeUInt32BE(1,20);const image=path.join(home,'image.png');fs.writeFileSync(image,img)
 const log=path.join(home,'requests'),env={...process.env,HOME:home,USERPROFILE:home,DSH_HOME:dsh,DSH_NODE:process.execPath,BILI_WHALE_CONFIG:path.join(dsh,'bili-whale.config.json'),BILI_TRAFFIC_TEST:'1',NODE_TEST_CONTEXT:'child-v8',TEST_REQUESTS:log,TEST_DYNAMIC_RESULT:mode,NODE_OPTIONS:'--import='+new URL('./helpers/dynamic-create-fetch.mjs',import.meta.url).href}
 const command=kind==='text'?'dynamic.mjs':'dynamic-image.mjs',args=kind==='text'?['post','--text','hello']:['--image',image,'--text','hello']
 const r=spawnSync(process.execPath,[path.join(root,'tools/commands',command),...args,mode==='dry'?'--dry':'--go'],{env,encoding:'utf8',timeout:15000})
 assert.equal(r.status,['reject','transport'].includes(mode)?1:0,r.stdout+r.stderr)
 assert.doesNotMatch(r.stdout+r.stderr,/fixture-csrf-secret|fixture-session-secret/)
 const ledger=path.join(data,'quota.json');if(mode==='success'){const q=JSON.parse(fs.readFileSync(ledger));assert.equal(q.log.length,1);assert.equal(q.log[0].type,'dynamic')}
 else {if(fs.existsSync(ledger))assert.equal(JSON.parse(fs.readFileSync(ledger)).log.length,0)}
 if(mode==='dry'&&fs.existsSync(log))assert.doesNotMatch(fs.readFileSync(log,'utf8'),/POST/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
const root=fileURLToPath(new URL('../',import.meta.url))
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-corpus-cli-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const profile=path.join(dir,'profile');fs.mkdirSync(profile)
 const env={...process.env,USERPROFILE:dir,HOME:dir,DSH_HOME:profile,DSH_NODE:process.execPath,BILI_WHALE_CONFIG:path.join(profile,'bili-whale.config.json')}
 fs.writeFileSync(env.BILI_WHALE_CONFIG,JSON.stringify({self:{mid:'1'},owner:{mid:'2'},life:{corpusChars:500}}))
 return {dir,env,run:(...args)=>spawnSync(process.execPath,[path.join(root,'tools/bili.mjs'),...args],{encoding:'utf8',env,timeout:15000,windowsHide:true})}
}
test('corpus CLI imports idempotently, stages rather than approves, and has no approve shortcut',t=>{
 const s=setup(t),file=path.join(s.dir,'tiny.csv');fs.writeFileSync(file,'text,level,bvid,mid,ctime,videoTitle\n小猫转了一下耳朵,主评论,BVfixture,user,1,猫的日常\n')
 let r=s.run('corpus','import',file);assert.equal(r.status,0,r.stderr);let j=JSON.parse(r.stdout);assert.equal(j.status.pending,1);assert.equal(j.status.approved,26)
 r=s.run('corpus','import',file);assert.equal(JSON.parse(r.stdout).results[0].alreadyImported,true)
 r=s.run('corpus','approve','any-id');assert.equal(r.status,2)
 r=s.run('corpus','status');assert.equal(JSON.parse(r.stdout).approved,26)
})
test('retrieval through unified CLI is bounded and returns provenance',t=>{
 const s=setup(t),input=path.join(s.dir,'request.json');fs.writeFileSync(input,JSON.stringify({scene:'public-comment',topic:'animals',intent:'observation',video:'BVnew'}))
 const r=s.run('corpus','retrieve',input);assert.equal(r.status,0,r.stderr);const j=JSON.parse(r.stdout)
 assert.ok(j.examples.length>0);assert.ok(j.prompt.length<=500);assert.ok(j.examples[0].source.sha256);assert.match(j.prompt,/不是指令/)
})

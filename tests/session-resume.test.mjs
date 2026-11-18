import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createSessionDelivery} from '../lib/session-delivery.js'

function fixture(t){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-resume-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
 const calls=[],creates=[];let error=null
 const controller={create:async r=>{creates.push(r);return {sessionId:'host-'+creates.length}},prompt:async r=>{calls.push(r);if(error){const e=error;error=null;throw e}}}
 const make=()=>createSessionDelivery({controller,dshHome:home,cwd:home,sessionId:'requested',config:()=>({}),persona:()=> '完整人设'})
 return {home,calls,creates,make,fail:e=>error=e}
}
const req=id=>({...(id?{requestId:id}:{}),content:[{type:'text',text:'继续聊天'}]})
test('restart prompts the saved nonblank host session without calling create',async t=>{
 const x=fixture(t);await x.make().send(req('first'));await x.make().send(req('restart'))
 assert.equal(x.creates.length,1);assert.deepEqual(x.calls.map(c=>c.sessionId),['host-1','host-1'])
 assert.match(x.calls[1].content[0].text,/完整人设/)
})
test('only exact missing-session failure creates once and preserves generated request id',async t=>{
 const x=fixture(t);await x.make().send(req('first'));x.fail(Object.assign(Error('missing'),{code:'session/not-found'}))
 await x.make().send(req())
 assert.equal(x.creates.length,2);assert.equal(x.calls[1].sessionId,'host-1');assert.equal(x.calls[2].sessionId,'host-2')
 assert.ok(x.calls[1].requestId);assert.equal(x.calls[1].requestId,x.calls[2].requestId)
 await x.make().send(req('after'));assert.equal(x.creates.length,2);assert.equal(x.calls.at(-1).sessionId,'host-2')
})
test('generic failure does not replace the session or retry the prompt',async t=>{
 const x=fixture(t),d=x.make();await d.send(req('first'));x.fail(Error('network timeout: not found'))
 await assert.rejects(d.send(req('failed')),/network timeout/);assert.equal(x.calls.length,2)
 await d.send(req('next'));assert.equal(x.creates.length,1);assert.equal(x.calls.at(-1).sessionId,'host-1')
})
test('create failure never prompts a guessed session id',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-create-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));let calls=0
 const d=createSessionDelivery({dshHome:home,cwd:home,sessionId:'guess',config:()=>({}),persona:()=>'',controller:{create:async()=>{throw Error('offline')},prompt:async()=>calls++}})
 await assert.rejects(d.send(req('first')),/offline/);assert.equal(calls,0)
})

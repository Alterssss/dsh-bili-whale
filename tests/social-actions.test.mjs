import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = `
import fs from 'node:fs'
let written = false
globalThis.fetch = async (input, options = {}) => {
 const url = new URL(input), method = options.method ?? 'GET'
 const params = new URLSearchParams(options.body ?? '')
 fs.appendFileSync(process.env.LOG, JSON.stringify({path:url.pathname,method, action:params.get('act') ?? params.get('like'), csrfInUrl:url.searchParams.has('csrf')})+'\\n')
 let result
 if (process.env.MODE === 'exception') throw Error('secret-session')
 if (url.pathname.endsWith('/nav')) result = {code:0,data:{isLogin:true,mid:process.env.MODE === 'wrong' ? 999 : 123}}
 else if (url.pathname.endsWith('/has/like')) result = {code:0,data:process.env.MODE === 'already' || (written && process.env.MODE !== 'readback') ? 1 : 0}
 else if (url.pathname === '/x/relation') result = {code:0,data:{attribute:process.env.MODE === 'already' || (written && process.env.MODE !== 'readback') ? 2 : 0}}
 else if (method === 'POST') { if (params.get('csrf') !== 'secret-csrf') throw Error('missing csrf'); written = true; result = {code:process.env.MODE === 'reject' ? -111 : 0} }
 else throw Error('unexpected endpoint')
 return new Response(JSON.stringify(result), {headers:{'content-type':'application/json'}})
}
`
for (const [command, target] of [['like','BV1234567890'], ['follow','456']]) {
 for (const mode of ['dry','check','success','already','wrong','reject','readback','conflict','exception']) test(`${command}: ${mode}`, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(),'social-action-')); t.after(() => fs.rmSync(home,{recursive:true,force:true}))
  const data = path.join(home,'.bili-ai'), dsh = path.join(home,'.dsh'); fs.mkdirSync(data); fs.mkdirSync(dsh)
  fs.writeFileSync(path.join(data,'credentials.json'),JSON.stringify({sessdata:'secret-session',bili_jct:'secret-csrf'}))
  fs.writeFileSync(path.join(dsh,'bili-whale.config.json'),JSON.stringify({self:{mid:'123'}}))
  const mock=path.join(home,'fixture.mjs'), log=path.join(home,'requests'); fs.writeFileSync(mock,fixture)
  const env={...process.env, HOME:home, USERPROFILE:home, BILI_WHALE_HOME:home, DSH_HOME:dsh, BILI_WHALE_CONFIG:path.join(dsh,'bili-whale.config.json'), BILI_TRAFFIC_TEST:'1', NODE_TEST_CONTEXT:'child-v8', NODE_OPTIONS:`--import=${mock}`, LOG:log, MODE:mode}
  const args=mode==='conflict'?['--dry','--go']:[mode==='dry'?'--dry':mode==='check'?'--check':'--go']
  const result=spawnSync(process.execPath,[path.join(root,'tools/commands',command+'.mjs'),target,...args],{env,encoding:'utf8',timeout:10000})
  assert.equal(result.status, ['wrong','reject','readback','exception'].includes(mode)?1:mode==='conflict'?2:0,result.stdout+result.stderr)
  assert.doesNotMatch(result.stdout+result.stderr,/secret-session|secret-csrf/)
  const calls=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse):[]
  assert.ok(calls.every(x=>!x.csrfInUrl))
  const posts=calls.filter(x=>x.method==='POST')
  assert.equal(posts.length,['success','reject','readback'].includes(mode)?1:0)
  if(posts.length) assert.equal(posts[0].action,'1')
  if(mode==='success'||mode==='readback') assert.equal(calls.filter(x=>x.path.endsWith('/has/like')||x.path==='/x/relation').length,2)
 })
}

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
const mode=process.argv[2],home=process.env.USERPROFILE
fs.mkdirSync(path.join(home,'.bili-ai'),{recursive:true})
globalThis.fetch=async()=>new Response(JSON.stringify({code:mode==='ban-write'?-412:0,data:{test:true}}),{headers:{'content-type':'application/json'}})
const append=fs.appendFileSync,write=fs.writeFileSync
if(mode==='request-log')fs.appendFileSync=(file,...args)=>{if(String(file).endsWith('api-requests.log'))throw Object.assign(Error('private'),{code:'EACCES'});return append(file,...args)}
if(mode==='ban-write')fs.writeFileSync=(file,...args)=>{if(String(file).endsWith('api-ban.json'))throw Object.assign(Error('private'),{code:'EACCES'});return write(file,...args)}
const {apiGet}=await import('../../tools/lib/bili-api.mjs')
const result=await apiGet('https://api.bilibili.com/x/test')
assert.equal(result.code,mode==='ban-write'?-1:0)
console.log('PASS '+mode)

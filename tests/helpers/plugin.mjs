process.env.LOCALAPPDATA = process.env.USERPROFILE // Tests must never discover the real Chrome.
import fs from 'node:fs'
import path from 'node:path'
import cp from 'node:child_process'
import {syncBuiltinESMExports} from 'node:module'
import {Readable} from 'node:stream'
import assert from 'node:assert/strict'
globalThis.setInterval=()=>({});globalThis.setTimeout=()=>({});globalThis.clearInterval=()=>{};globalThis.clearTimeout=()=>{}
cp.execFile=(exe,args,options,cb)=>{
  if(args.includes('comment')) {
    const success=process.env.TEST_SEND_SUCCESS==='1'
    queueMicrotask(()=>cb(success?null:new Error('mock send failure'),success?'code=0 rpid=123':'code=-101',''))
  } else {
    assert.ok(args.includes('take')||args.includes('add'))
    const r=cp.spawnSync(exe,args,{...options,encoding:'utf8'})
    queueMicrotask(()=>cb(r.status?new Error(r.stderr):null,r.stdout,r.stderr))
  }
  return {kill(){}}
}
syncBuiltinESMExports()
const {default:plugin}=await import('../../lib/index.js')
const routes=new Map()
plugin.apply({get:()=>({requestRejection:()=>null}),webServer:{register(r){routes.set(r.path,r.handler);return ()=>{}}},effect:()=>{}})
async function request(url,body={},method='POST') {
  return new Promise((resolve,reject)=>{
    const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method=method;req.headers={host:'127.0.0.1'}
    const res={statusCode:200,writeHead(code){this.statusCode=code},end(text){resolve({status:this.statusCode,data:JSON.parse(text)})}}
    routes.get('/dsh-bili/api/'+url)(req,res).catch(reject)
  })
}
if(process.env.TEST_NO_NODE) {
  const r=await request('deps',{},'GET')
  assert.equal(r.data.scheduler.ok,false)
  assert.match(r.data.scheduler.reason,/node/)
} else {
  const stateFile=path.join(process.env.DSH_HOME,'whale-night.json')
  const preserved={schema:2,date:new Date().toLocaleDateString('sv-SE'),action:'skip',fired:false,atMs:Date.now()+3600000,endsAt:Date.now()+7200000,usedCount:{},skippedWindows:[]}
  fs.writeFileSync(stateFile,JSON.stringify(preserved))
  const settings=await request('settings',{diary:{push:false}})
  assert.equal(settings.data.config.diary.push,false)
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile)),preserved)
  const sessionSettings=await request('settings',{sessionRotateDays:3,personaOncePerSession:true})
  assert.equal(sessionSettings.status,200)
  assert.equal(sessionSettings.data.config.sessionRotateDays,3)
  assert.equal(sessionSettings.data.config.personaOncePerSession,true)
  assert.equal((await request('settings',{sessionRotateDays:-1})).status,400)
  assert.equal((await request('settings',{personaOncePerSession:'false'})).status,400)
  const starter = (await request('settings',{},'GET')).data
  assert.equal(starter.settingsVersion,2)
  assert.deepEqual(starter.supportedDialogueModes,['local','character'])
  assert.equal(starter.config.voice.enabled,true)
  assert.ok(starter.config.voice.replyStyle.includes('评论区'))
  assert.deepEqual(starter.voiceDefaults,starter.config.voice)
  assert.equal((await request('login/start',{},'GET')).status,405)
  const attempt = await request('login/start')
  assert.equal(attempt.status,200)
  assert.equal(attempt.data.state,'connecting')
  await new Promise(r=>setImmediate(r))
  assert.equal((await request('login/poll',{id:attempt.data.id})).data.state,'error')
  assert.equal((await request('login/confirm',{id:attempt.data.id})).status,400)
  assert.equal((await request('login/cancel',{id:attempt.data.id})).data.state,'cancelled')
  assert.equal((await request('login/status')).data.state,'verified')
  assert.equal((await request('settings',{self:{mid:'stale'}})).data.config.self.mid,'')
  assert.equal((await request('settings',{owner:{mid:'https://space.bilibili.com/222'}})).data.config.owner.mid,'222')
  const voice = { enabled: true, personality: '稳定性格', behaviorStyle: '不硬找话题', replyStyle: '短句', multipleStyles: ['正式', '随意'], multipleProbability: 0.25, styleMode: 'random', expressionTopK: 2 }
  assert.equal((await request('settings',{voice})).status,200)
  assert.deepEqual((await request('settings',{},'GET')).data.config.voice,voice)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.DSH_HOME,'bili-whale.config.json'))).voice,voice)
  assert.equal((await request('settings',{voice:{replyStyle:'更短'}})).status,200)
  const stored = (await request('settings',{},'GET')).data.config.voice
  assert.equal(stored.personality,voice.personality)
  assert.equal(stored.replyStyle,'更短')
  for (const invalid of [null, [], 'bad', {enabled:'true'}, {multipleProbability:1.1}, {multipleProbability:'0.5'}, {expressionTopK:1.5}, {multipleStyles:[1]}, {styleMode:'unknown'}, {personality:'x'.repeat(3001)}]) {
    assert.equal((await request('settings',{voice:invalid})).status,400)
    assert.deepEqual((await request('settings',{},'GET')).data.config.voice,stored)
  }
  const text='测试人设：使用简洁句子。'
  assert.equal((await request('persona',{text})).status,200)
  assert.equal((await request('persona',{},'GET')).data.text,text)
  await request('persona',{text:''})
  assert.equal((await request('persona',{},'GET')).data.text,'')
  await request('cookie',{sessdata:'replacement-cookie-local-test',bili_jct:'b'.repeat(32)})
  const {loadCred}=await import('../../tools/lib/cred.mjs')
  assert.equal(loadCred().sessdata,'replacement-cookie-local-test')
  const pending=path.join(process.env.USERPROFILE,'.bili-ai/pending-replies.json')
  fs.writeFileSync(pending,JSON.stringify({items:[{id:'test',oid:'1',bvid:'BV1234567890',root:'2',parent:'2',message:'local draft'}]}))
  const response=await request('pending/approve',{id:'test'})
  await new Promise(r=>setImmediate(r))
  assert.equal(response.data.ok,process.env.TEST_SEND_SUCCESS==='1')
  const queue=JSON.parse(fs.readFileSync(pending,'utf8')).items
  assert.equal(queue.length,process.env.TEST_SEND_SUCCESS==='1'?0:1)
  assert.equal((await request('settings',{dialogueMode:'character'})).status,200)
  assert.equal((await request('settings',{dialogueMode:'natural-dialogue'})).status,200)
  assert.equal((await request('settings',{},'GET')).data.config.dialogueMode,'character')
  assert.equal((await request('persona',{text:'不应覆盖'})).status,409)
  assert.equal((await request('persona',{},'GET')).data.inactive,true)
  assert.equal((await request('settings',{dialogueMode:'unknown'})).status,400)
  assert.equal((await request('settings',{character:{name:''}})).status,400)
  assert.equal((await request('settings',{character:{name:'测试鱼',style:'短句'}})).status,200)
  assert.equal((await request('settings',{},'GET')).data.config.character.name,'测试鱼')
  const canonical=JSON.parse(fs.readFileSync(path.join(process.env.DSH_HOME,'bili-whale.config.json'),'utf8'))
  assert.equal(Object.hasOwn(canonical,'persona'),false)
  assert.deepEqual(canonical.voice,{enabled:false})
  const savedFile=path.join(process.env.DSH_HOME,'bili-whale.config.json')
  const savedText=fs.readFileSync(savedFile,'utf8')
  assert.equal((await request('settings',{character:{name:''}})).status,400)
  assert.equal(fs.readFileSync(savedFile,'utf8'),savedText)
  assert.equal(fs.readdirSync(process.env.DSH_HOME).filter(x=>x.startsWith('bili-whale.config.json.')&&x.endsWith('.tmp')).length,0)
  assert.equal((await request('settings',{dialogueMode:'local'})).status,200)
}

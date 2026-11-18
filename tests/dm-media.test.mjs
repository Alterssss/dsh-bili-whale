import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

function setup(t, config={}) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-dm-media-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  const dsh=path.join(home,'.dsh')
  fs.mkdirSync(dsh);fs.mkdirSync(path.join(home,'.bili-ai'))
  const configFile=path.join(dsh,'bili-whale.config.json')
  fs.writeFileSync(configFile,JSON.stringify({self:{mid:'111'},owner:{mid:'222',name:'Owner'},...config}))
  fs.writeFileSync(path.join(home,'.bili-ai/credentials.json'),JSON.stringify({sessdata:'fixture',bili_jct:'a'.repeat(32)}))
  const image=path.join(home,'meme.png')
  fs.writeFileSync(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9kAAAAASUVORK5CYII=','base64'))
  const requests=path.join(home,'requests.jsonl')
  const env={...process.env,HOME:home,USERPROFILE:home,DSH_HOME:dsh,DSH_NODE:process.execPath,
    BILI_WHALE_CONFIG:configFile,BILI_TRAFFIC_TEST:'1',NODE_TEST_CONTEXT:'child-v8',TEST_REQUESTS:requests,
    NODE_OPTIONS:'--import='+new URL('./helpers/dm-media-fetch.mjs',import.meta.url).href}
  const run=(args,extra={})=>{
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('../tools/bili.mjs',import.meta.url)),'dm',...args],
      {env:{...env,...extra},encoding:'utf8',timeout:20000})
    assert.ifError(result.error)
    return result
  }
  const readRequests=()=>fs.existsSync(requests)?fs.readFileSync(requests,'utf8').trim().split('\n').map(JSON.parse):[]
  const state=()=>{
    const root=path.join(dsh,'whale-life'),identity=fs.readdirSync(root)[0]
    return JSON.parse(fs.readFileSync(path.join(root,identity,'checkpoint.json'),'utf8')).state
  }
  return {home,dsh,image,run,state,env,requests:readRequests}
}

test('DM text and picture are separate messages with truthful separate receipts',t=>{
  const x=setup(t)
  const args=['--msg','hello meme','--pic',x.image]
  const dry=x.run([...args,'--dry']);assert.equal(dry.status,0,dry.stderr)
  assert.equal(x.requests().filter(row=>row.method==='POST').length,0)
  const sent=x.run([...args,'--go']);assert.equal(sent.status,0,sent.stdout+sent.stderr)
  const posts=x.requests().filter(row=>row.url.includes('/send_msg'))
  assert.deepEqual(posts.map(row=>row.type),['1','2'])
  assert.deepEqual(JSON.parse(posts[0].content),{content:'hello meme'})
  assert.equal(JSON.parse(posts[1].content).url,'https://i0.hdslb.com/bfs/fixture.png')
  const events=x.state().events.filter(event=>event.kind==='sent')
  assert.equal(events.length,2);assert.equal(events[0].text,'hello meme')
  assert.match(events[1].text,/^\[图片 sha256:/)
  assert.equal(events[1].data.attachmentOf,events[0].operationId)
  assert.deepEqual(events.map(event=>event.receipt),['9007199254740991','9007199254740992'])
  assert.equal(Object.keys(x.state().pending).length,0)
  assert.equal(JSON.parse(fs.readFileSync(path.join(x.home,'.bili-ai/dm-quota.json'),'utf8')).count,2)
  assert.notEqual(x.run([...args,'--go']).status,0)
  assert.equal(x.requests().filter(row=>row.url.includes('/send_msg')).length,2)
})

test('HTTP upload succeeds and old HTTP cache is reused as HTTPS without another upload',t=>{
  const x=setup(t),cacheFile=path.join(x.home,'.bili-ai/picture-uploads.json')
  let r=x.run(['--pic',x.image,'--go'],{TEST_UPLOAD_URL:'http://i0.hdslb.com/bfs/fixture.png',TEST_REJECT_TYPE:'2'})
  assert.equal(r.status,1)
  const cache=JSON.parse(fs.readFileSync(cacheFile,'utf8')),entry=Object.values(cache)[0]
  assert.equal(entry.picture.image_url,'https://i0.hdslb.com/bfs/fixture.png')
  entry.picture.image_url='http://i0.hdslb.com/bfs/fixture.png';fs.writeFileSync(cacheFile,JSON.stringify(cache))
  r=x.run(['--pic',x.image,'--go']);assert.equal(r.status,0,r.stdout+r.stderr)
  assert.equal(x.requests().filter(row=>row.url.includes('/upload_bfs')).length,1)
  for(const row of x.requests().filter(row=>row.type==='2'))assert.equal(JSON.parse(row.content).url,'https://i0.hdslb.com/bfs/fixture.png')
  assert.equal(Object.values(JSON.parse(fs.readFileSync(cacheFile,'utf8')))[0].picture.image_url,'https://i0.hdslb.com/bfs/fixture.png')
})

test('standalone picture records an image rather than an unsent caption',t=>{
  const x=setup(t),result=x.run(['--pic',x.image,'--go'])
  assert.equal(result.status,0,result.stdout+result.stderr)
  assert.deepEqual(x.requests().filter(row=>row.type).map(row=>row.type),['2'])
  const event=x.state().events.find(event=>event.kind==='sent')
  assert.equal(event.data.contentKind,'image');assert.match(event.text,/^\[图片 sha256:/)
})

test('failed image upload releases only the undispatched reservation',t=>{
  const x=setup(t),args=['--msg','upload failure','--pic',x.image,'--go']
  assert.notEqual(x.run(args,{TEST_UPLOAD_FAIL:'1'}).status,0)
  assert.equal(Object.keys(x.state().pending).length,0)
  assert.equal(x.state().events.filter(event=>event.kind==='sent').length,0)
  assert.equal(x.run(args).status,0)
})

for(const mode of ['reject','unknown','no-receipt'])test('text success with image '+mode+' preserves partial delivery',t=>{
  const x=setup(t),extra=mode==='reject'?{TEST_REJECT_TYPE:'2'}:mode==='unknown'?{TEST_UNKNOWN_TYPE:'2'}:{TEST_NO_RECEIPT_TYPE:'2'}
  const result=x.run(['--msg','partial '+mode,'--pic',x.image,'--go'],extra)
  assert.notEqual(result.status,0)
  assert.match(result.stderr,/文字已发送，图片未确认/)
  const state=x.state(),events=state.events.filter(event=>event.kind==='sent')
  assert.equal(events.length,1);assert.equal(events[0].text,'partial '+mode)
  assert.equal(Object.keys(state.pending).length,mode==='reject'?0:1)
  if(mode==='reject')assert.equal(x.run(['--pic',x.image,'--go']).status,0)
  else {
    assert.notEqual(x.run(['--pic',x.image,'--go']).status,0)
    assert.equal(x.requests().filter(row=>row.type==='2').length,1)
  }
})

test('unknown text outcome never sends the picture or claims text was delivered',t=>{
  const x=setup(t),result=x.run(['--msg','unknown text','--pic',x.image,'--go'],{TEST_UNKNOWN_TYPE:'1'})
  assert.notEqual(result.status,0)
  assert.deepEqual(x.requests().filter(row=>row.type).map(row=>row.type),['1'])
  assert.equal(x.state().events.filter(event=>event.kind==='sent').length,0)
  assert.equal(Object.keys(x.state().pending).length,1)
})

test('missing picture cannot leave an unsent reservation blocking future DMs',t=>{
  const x=setup(t)
  assert.notEqual(x.run(['--msg','bad picture','--pic',path.join(x.home,'missing.png'),'--go']).status,0)
  const next=x.run(['--msg','plain message','--go'])
  assert.equal(next.status,0,next.stderr)
})

test('real traffic protection allows image retry after explicit rejection without repeating upload or text',t=>{
  const x=setup(t,{risk:{minGapMs:0,writeGapSec:0,dmGapSec:0}})
  const first=x.run(['--msg','retry image','--pic',x.image,'--go'],{BILI_TRAFFIC_TEST:'0',TEST_REJECT_TYPE:'2'})
  assert.notEqual(first.status,0,first.stdout+first.stderr)
  const second=x.run(['--pic',x.image,'--go'],{BILI_TRAFFIC_TEST:'0'})
  assert.equal(second.status,0,second.stdout+second.stderr)
  assert.equal(x.requests().filter(row=>row.url.includes('/upload_bfs')).length,1)
  assert.deepEqual(x.requests().filter(row=>row.type).map(row=>row.type),['1','2','2'])
  assert.equal(x.state().events.filter(event=>event.kind==='sent').length,2)
})

test('a required finalized sharing draft authorizes only its own image and consumes one share quota',t=>{
  const x=setup(t,{life:{requireDraft:true},share:{via:'dm'}})
  const draft=spawnSync(process.execPath,[fileURLToPath(new URL('./helpers/dm-media-draft.mjs',import.meta.url))],
    {env:x.env,encoding:'utf8',timeout:15000})
  assert.equal(draft.status,0,draft.stdout+draft.stderr)
  const args=['--draft',draft.stdout.trim(),'--pic',x.image,'--reason','这是值得分享的视频','--score','15','--rank','1']
  const sent=x.run([...args,'--go'])
  assert.equal(sent.status,0,sent.stdout+sent.stderr)
  assert.deepEqual(x.requests().filter(row=>row.type).map(row=>row.type),['1','2'])
  assert.equal(x.state().drafts.find(row=>row.id===draft.stdout.trim()).status,'sent')
  const quota=JSON.parse(fs.readFileSync(path.join(x.home,'.bili-ai/quota.json'),'utf8'))
  assert.equal(quota.log.filter(row=>row.type==='dm').length,1)
})

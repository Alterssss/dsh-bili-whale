import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

function fixture(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'community-cli-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  fs.mkdirSync(path.join(home,'.bili-ai'));fs.mkdirSync(path.join(home,'.dsh'))
  fs.writeFileSync(path.join(home,'.bili-ai/credentials.json'),JSON.stringify({sessdata:'fixture',bili_jct:'fixture'}))
  const cfg=path.join(home,'.dsh/bili-whale.config.json')
  fs.writeFileSync(cfg,JSON.stringify({self:{mid:'111'},owner:{mid:'222'},preferences:{like:['DSH插件'],dislike:['标题党']}}))
  const log=path.join(home,'requests.jsonl')
  const env={...process.env,HOME:home,USERPROFILE:home,DSH_HOME:path.join(home,'.dsh'),DSH_NODE:process.execPath,
    BILI_WHALE_CONFIG:cfg,BILI_NO_CACHE:'1',BILI_TRAFFIC_TEST:'1',NODE_TEST_CONTEXT:'child-v8',FFMPEG:process.execPath,
    NODE_OPTIONS:'--import='+new URL('./helpers/community-fetch.mjs',import.meta.url).href,TEST_REQUESTS:log}
  const run=(args,extra={})=>spawnSync(process.execPath,[fileURLToPath(new URL('../tools/bili.mjs',import.meta.url)),...args],{env:{...env,...extra},encoding:'utf8',timeout:20000})
  return {home,run,requests:()=>fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse)}
}

test('normal feed command searches full interest phrase and filters configured dislikes',t=>{
  const x=fixture(t),result=x.run(['feed','--source','search'])
  assert.equal(result.status,0,result.stdout+result.stderr)
  assert.match(result.stdout,/DSH插件开发/);assert.doesNotMatch(result.stdout,/DSH插件标题党/)
  const search=x.requests().find(r=>r.url?.includes('/search/type'))
  assert.equal(new URL(search.url).searchParams.get('keyword'),'DSH插件')
})

for(const fallback of [false,true])test('normal watch-video connects segment extraction and full-download fallback '+fallback,t=>{
  const x=fixture(t),result=x.run(['watch-video','BV1234567890','2x2'],{TEST_SEGMENT_FAIL:fallback?'1':'0'})
  assert.equal(result.status,0,result.stdout+result.stderr)
  assert.match(result.stdout,/SHEET:/);assert.match(result.stdout,/SUBS:/)
  const requests=x.requests()
  assert.equal(requests.some(r=>r.url==='https://cdn.invalid/video.mp4'),fallback)
  assert.ok(requests.some(r=>r.ffmpeg?.includes('-headers')))
  const sheet=result.stdout.match(/SHEET: (.+)/)[1].trim()
  assert.ok(fs.existsSync(sheet))
})

test('normal subtitles command samples separate pages and writes source-labeled text',t=>{
  const x=fixture(t),result=x.run(['subtitles','BV1234567890','--sample-pages','2'])
  assert.equal(result.status,0,result.stdout+result.stderr)
  const queried=x.requests().filter(r=>r.url && new URL(r.url).pathname.endsWith('/v2')).map(r=>new URL(r.url).searchParams.get('cid'))
  assert.deepEqual(queried,['100','104'])
  const files=fs.readdirSync(path.join(x.home,'.dsh/shots/subs'))
  assert.ok(files.includes('BV1234567890-P1-zh-CN.txt'));assert.ok(files.includes('BV1234567890-P5-zh-CN.txt'))
  assert.match(fs.readFileSync(path.join(x.home,'.dsh/shots/subs/BV1234567890-P5-zh-CN.txt'),'utf8'),/P5/)
})

test('debrief sampling stores source-labeled multi-page evidence in the existing memory event',t=>{
 const x=fixture(t),result=x.run(['debrief','BV1234567890','--sample-pages','2','--no-frames'])
 assert.equal(result.status,0,result.stdout+result.stderr)
 const root=path.join(x.home,'.dsh/whale-life'),identity=fs.readdirSync(root)[0]
 const state=JSON.parse(fs.readFileSync(path.join(root,identity,'checkpoint.json'),'utf8')).state
 const event=state.events.find(e=>e.kind==='video-read')
 assert.deepEqual(event.data.subtitlePages,[1,5]);assert.match(event.text,/\[P5\]/);assert.match(event.text,/字幕\/104.json/)
})

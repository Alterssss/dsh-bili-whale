import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {ffmpegPath} from '../tools/lib/ffmpeg.mjs'
import {createDiaryWorker} from '../lib/diary-worker.js'
import {attachDiary} from '../tools/lib/diary-state.mjs'
import {checkOperation} from '../tools/lib/operation-context.mjs'
import {watchOptions} from '../tools/lib/watch-options.mjs'

const root = fileURLToPath(new URL('../',import.meta.url))
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'whale-regression-'))
const cfg = {self:{mid:'1'},owner:{mid:'2'}}
try {
  const state = {settings:{},events:[],archiveContents:[]}
  let committed = false
  const life = {dir,read:()=>state,export:()=>state,now:Date.now,
    async tx(fn) {
      await new Promise(resolve=>setTimeout(resolve,15))
      checkOperation()
      fn(state)
      committed=true
    },
    claimDiaryJob:async()=>null}
  attachDiary(life,{enabled:true},{fullConfig:cfg})
  const worker = createDiaryWorker({config:()=>cfg,store:()=>life,complete:async()=>{}})
  assert.equal((await worker.tick()).status,'idle')
  assert.equal(committed,true)
  for (const mode of ['success','timeout','stop']) {
    const host = new AbortController()
    let observed, failed=0
    const jobStore={renderDiary:async()=>({status:'rendered'}),claimDiaryJob:async()=>({scope:'private',sources:[]}),
      commitDiaryJob:async()=>({status:'committed'}),failDiaryJob:async()=>{failed++}}
    const w=createDiaryWorker({store:()=>jobStore,config:()=>cfg,signal:host.signal,
      timeoutMs:mode==='timeout'?15:500,complete:async({signal})=>{
        observed=signal
        if(mode==='success')return {}
        if(mode==='stop')setImmediate(()=>host.abort())
        return new Promise((_,reject)=>signal.addEventListener('abort',()=>setImmediate(()=>reject(signal.reason)),{once:true}))
      }})
    assert.equal((await w.tick()).status,mode==='success'?'committed':'failed')
    await new Promise(resolve=>setImmediate(resolve))
    assert.equal(observed.aborted,mode!=='success')
    assert.equal(failed,mode==='success'?0:1)
  }
  console.log('PASS diary render, completion, timeout and stop')
  const mock=path.join(dir,'platform.mjs')
  fs.writeFileSync(mock,`import fs from 'node:fs'
globalThis.fetch=async input=>{
 const url=new URL(input)
 if(url.pathname.endsWith('/nav'))return Response.json({code:0,data:{mid:1,wbi_img:{img_url:'https://fixture.invalid/'+'a'.repeat(32)+'.png',sub_url:'https://fixture.invalid/'+'b'.repeat(32)+'.png'}}})
 if(url.pathname.endsWith('/feed/space')){
   if(url.searchParams.get('host_mid')!=='1')throw Error('account')
   if(url.searchParams.get('offset')==='p2')return Response.json({code:0,data:{items:[]}})
   if(process.env.HTML)return new Response('<html>',{headers:{'content-type':'text/html'}})
   const items=[{desc:{text:'TEXT'}},{major:{opus:{summary:{text:'OPUS'}}}},{major:{archive:{title:'VIDEO'}}}].map((d,i)=>({id_str:String(i+1),modules:{module_author:{pub_ts:'1700000000'},module_dynamic:d}}))
   return Response.json({code:0,data:{items,has_more:true,offset:'p2'}})
 }
 if(url.pathname.endsWith('/view'))return Response.json({code:0,data:{pages:[{cid:1,duration:6}]}})
 if(url.pathname.endsWith('/playurl'))return Response.json({code:0,data:{durl:[{url:'https://fixture.invalid/video'}]}})
 if(url.hostname==='fixture.invalid')return new Response(fs.readFileSync(process.env.CLIP))
 throw Error('Unexpected request '+url.pathname)
}`)
  fs.mkdirSync(path.join(dir,'.bili-ai'))
  fs.writeFileSync(path.join(dir,'.bili-ai','credentials.json'),JSON.stringify({sessdata:'fixture',bili_jct:'fixture'}))
  function cli(file,args,extra={}) {
    const result=spawnSync(process.execPath,['--unhandled-rejections=strict','--import',pathToFileURL(mock).href,path.join(root,'tools/commands',file+'.mjs'),...args],
      {encoding:'utf8',timeout:40000,env:{...process.env,USERPROFILE:dir,HOME:dir,DSH_HOME:dir,BILI_TRAFFIC_TEST:'1',NODE_TEST_CONTEXT:'fixture',...extra}})
    if(result.error)throw result.error
    return {code:result.status,output:result.stdout+result.stderr}
  }
  const first=cli('dynamic',['list'])
  assert.equal(first.code,0,first.output)
  for(const value of ['TEXT','OPUS','VIDEO','--offset p2'])assert.ok(first.output.includes(value))
  assert.match(cli('dynamic',['list','--offset','p2']).output,/本页动态 0 条/)
  const bad=cli('dynamic',['list'],{HTML:'yes'})
  assert.notEqual(bad.code,0)
  assert.match(bad.output,/text\/html/)
  console.log('PASS dynamic list formats, pagination and invalid response')
  assert.equal(watchOptions(['--from','1:02:03'],'').fromSec,3723)
  for(const value of ['1:','1:99','2:3:99'])assert.throws(()=>watchOptions(['--to',value],''))
  assert.throws(()=>watchOptions(['--from','4','--to','3'],''))
  const ffmpeg=ffmpegPath()
  assert.ok(ffmpeg,'ffmpeg required for video regression')
  const clip=path.join(dir,'clip.mp4')
  const gen=spawnSync(ffmpeg,['-y','-loglevel','error','-f','lavfi','-i','color=c=blue:s=320x240:d=6','-c:v','mpeg4',clip],{encoding:'utf8'})
  assert.equal(gen.status,0,gen.stderr)
  const options=['BV1234567890','2x1',dir,'--full-download','--from','4','--to','8']
  const result=cli('bili-watch',options,{FFMPEG:ffmpeg,CLIP:clip})
  assert.equal(result.code,0,result.output)
  assert.match(result.output,/1=00:04.*2=00:05/)
  assert.ok(fs.statSync(result.output.match(/SHEET: (.+)/)[1].trim()).size>0)
  const outside=cli('bili-watch',[...options.slice(0,4),'--from','7'],{FFMPEG:ffmpeg})
  assert.equal(outside.code,2,outside.output)
  console.log('PASS range syntax, clipped end, actual JPEG and out-of-range start')
  const sheet=result.output.match(/SHEET: (.+)/)[1].trim()
  // 时间码现在贴在右下角、5 倍大、带半透明黑底：取那一块，要求同时有「白字」和「暗底」。
  // 单帧 320x240 按 tile=720 放大后是 720x540；时间码块 112x47，落在 (596,481)。
  const pixel=spawnSync(ffmpeg,['-v','error','-i',sheet,'-vf','crop=112:47:596:481,format=gray','-frames:v','1','-f','rawvideo','-'])
  assert.equal(pixel.status,0)
  const gray=[...pixel.stdout]
  assert.ok(gray.length>0,'timecode block should exist')
  assert.ok(Math.max(...gray)>200,'timecode digits should be white')
  assert.ok(Math.min(...gray)<80,'timecode plate should be dark for contrast')
  console.log('PASS timecode block: white digits on dark plate at bottom-right')
} finally {
  fs.rmSync(dir,{recursive:true,force:true})
}

import fs from 'node:fs'
import cp from 'node:child_process'
import {syncBuiltinESMExports} from 'node:module'

const log = value => fs.appendFileSync(process.env.TEST_REQUESTS, JSON.stringify(value)+'\n')
const keys={img_url:'https://example.invalid/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://example.invalid/4932caff0ff746eab6f01bf08b70ac45.png'}
globalThis.fetch=async(input,options={})=>{
  const url=new URL(input)
  log({url:url.href,method:options.method??'GET'})
  let data
  if(url.pathname.endsWith('/nav'))data={isLogin:true,mid:111,wbi_img:keys}
  else if(url.pathname.endsWith('/search/type'))data={result:[
    {bvid:'BV1234567890',title:'DSH插件开发',pubdate:Math.floor(Date.now()/1000),duration:'10:00',danmaku:100,play:1000,author:'作者',mid:3},
    {bvid:'BVabcdefghij',title:'DSH插件标题党',pubdate:Math.floor(Date.now()/1000),duration:'10:00',danmaku:100,play:1000,author:'作者',mid:3},
  ]}
  else if(url.pathname.endsWith('/view'))data={aid:10,cid:100,title:'DSH插件开发',duration:8000,pic:'https://cdn.invalid/cover.jpg',pubdate:Math.floor(Date.now()/1000),stat:{view:1,like:0,favorite:0,coin:0,danmaku:0,reply:0},owner:{mid:3,name:'作者'},
    pages:Array.from({length:8},(_,i)=>({page:i+1,cid:100+i,duration:1000,part:'第'+(i+1)+'集'}))}
  else if(url.pathname.endsWith('/playurl'))data={quality:64,durl:[{url:'https://cdn.invalid/video.mp4',size:4}]}
  else if(url.pathname.endsWith('/v2'))data={subtitle:{subtitles:[{lan:'ai-zh',subtitle_url:'https://cdn.invalid/ai.json'},{lan:'zh-CN',subtitle_url:'https://cdn.invalid/'+url.searchParams.get('cid')+'.json'}]}}
  else if(url.hostname==='cdn.invalid' && url.pathname.endsWith('.json'))return new Response(JSON.stringify({body:[{from:0,to:2,content:'字幕'+url.pathname}]}))
  else if(url.pathname==='/cover.jpg')return new Response('image')
  else if(url.hostname==='comment.bilibili.com')return new Response('<i></i>')
  else if(url.pathname==='/x/v2/reply')data={replies:[]}
  else if(url.pathname==='/video.mp4')return new Response('mp4!',{headers:{'content-length':'4'}})
  else throw Error('Unexpected test endpoint '+url.pathname)
  return new Response(JSON.stringify({code:0,data}),{headers:{'content-type':'application/json'}})
}

const spawn=cp.spawnSync,execute=cp.execFile
cp.spawnSync=(file,args,options)=>{
  if(file!==process.env.FFMPEG || !args.includes('-loglevel') && !args.includes('-hide_banner'))return spawn(file,args,options)
  log({ffmpeg:args})
  if(args.at(-1)!=='-')fs.writeFileSync(args.at(-1),'jpeg-fixture')
  return {status:0}
}
cp.execFile=(file,args,options,callback)=>{
  if(file!==process.env.FFMPEG || !args.includes('-loglevel'))return execute(file,args,options,callback)
  log({ffmpeg:args})
  if(process.env.TEST_SEGMENT_FAIL==='1')queueMicrotask(()=>callback(Error('fixture segment error'),'',''))
  else {
    fs.writeFileSync(args.at(-1).replace('%d','1'),'jpeg-fixture')
    queueMicrotask(()=>callback(null,'',''))
  }
  return {kill(){}}
}
syncBuiltinESMExports()

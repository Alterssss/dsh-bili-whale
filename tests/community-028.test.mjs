import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import {preferenceMatches, preferenceSearch} from '../tools/lib/feed-preferences.mjs'
import {parseShareCard} from '../tools/lib/dm-history.mjs'
import {downloadVideo} from '../tools/lib/video-download.mjs'
import {segmentFrames} from '../tools/lib/video-frames.mjs'
import {selectSubtitlePages, pickSubtitle} from '../tools/lib/subtitle-pages.mjs'
import {createSessionDelivery} from '../lib/session-delivery.js'
import {createLifeStore} from '../tools/lib/life-store.mjs'
import {renderQr} from '../lib/auth.js'

function temporary(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-community-'))
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  return dir
}

test('interest search preserves mixed phrases and generic words cannot claim unrelated preference hits',()=>{
  assert.equal(preferenceSearch(' DSH插件 '),'DSH插件')
  assert.equal(preferenceSearch('AI 工具与插件'),'AI 工具与插件')
  assert.equal(preferenceMatches('Steam实用插件','DSH插件'),false)
  assert.equal(preferenceMatches('DSH插件开发','DSH插件'),true)
  assert.equal(preferenceMatches('实用插件推荐','AI 工具与插件'),false)
  assert.equal(preferenceMatches('AI 插件推荐','AI 工具与插件'),true)
  assert.equal(preferenceMatches('trailer 插件','AI 工具与插件'),false)
  assert.equal(preferenceMatches('标题党合集','标题党'),true)
})

test('share parsing trusts explicit video fields and preserves exact author IDs',()=>{
  assert.equal(parseShareCard(JSON.stringify({title:'提到 BV1234567890 的标题',author:'UP'})).bvid,null)
  assert.equal(parseShareCard(JSON.stringify({title:'视频',url:'https://www.bilibili.com/video/BV1234567890/'})).bvid,'BV1234567890')
  assert.equal(parseShareCard('{"title":"视频","author_id":999999999999999999}').authorId,'999999999999999999')
  assert.deepEqual(parseShareCard(JSON.stringify({title:'视频',author:'UP',url:'not a URL'})),
    {title:'视频',author:'UP',authorId:'',bvid:null})
})

test('forwarded card material cannot become verified owner instructions',async t=>{
  const store=createLifeStore({dshHome:temporary(t),account:'1',owner:'2'})
  const card=await store.ingestOwnerMessage({messageId:'card',actor:'2',text:'[分享卡片] 作者主张',contentKind:'share'})
  assert.equal(card.origin,'external')
  assert.equal(card.verifiedRole,undefined)
  const message=await store.ingestOwnerMessage({messageId:'text',actor:'2',text:'我的要求'})
  assert.equal(message.verifiedRole,'owner')
})

test('settings API follows document base for root and reverse-proxy deployments',()=>{
  const client=fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8')
  const assignment=client.match(/const API = (.+);/)[1]
  for(const [base,expected] of [['https://host/','/dsh-bili/api'],['https://host/app/dsh/','/app/dsh/dsh-bili/api']]) {
    assert.equal(vm.runInNewContext(assignment,{URL,document:{baseURI:base}}),expected)
  }
})

test('new sessions attach workspace, saved sessions resume and missing service falls back to cwd',async t=>{
  const dir=temporary(t),creates=[]
  let workspaceCalls=0,clock=Date.now()
  const options={dshHome:dir,cwd:dir,sessionId:'initial',now:()=>clock,
    config:()=>({sessionRotateDays:1}),persona:()=>'',
    workspaceController:{create:async()=>{workspaceCalls++;return {workspace:{workspaceId:'workspace'}}}},
    controller:{create:async r=>{creates.push(r);return {sessionId:r.sessionId}},prompt:async()=>{}},
  }
  const request=id=>({requestId:id,content:[{type:'text',text:'hello'}]})
  await createSessionDelivery(options).send(request('first'))
  assert.equal(creates[0].workspaceId,'workspace');assert.equal(creates[0].cwd,undefined)
  await createSessionDelivery(options).send(request('resume'))
  assert.equal(workspaceCalls,1)
  clock+=2*86400000
  await createSessionDelivery(options).send(request('rotate'))
  assert.equal(workspaceCalls,2);assert.notEqual(creates[1].sessionId,'initial')
  await createSessionDelivery({...options,sessionFile:'fallback.json',workspaceController:{create:async()=>{throw Error('offline')}}}).send(request('fallback'))
  assert.equal(creates.at(-1).cwd,dir)
})

test('a hanging workspace service leaves time for cwd fallback and a late result cannot create twice', async t => {
  const directory = temporary(t)
  const creates = []
  let resolveWorkspace
  let prompts = 0
  const delivery = createSessionDelivery({
    dshHome:directory, cwd:directory, sessionId:'workspace-timeout', config:()=>({}), persona:()=>'', timeoutMs:1000,
    workspaceController:{create:()=>new Promise(resolve=>{resolveWorkspace=resolve})},
    controller:{create:async request=>{creates.push(request);return request},prompt:async()=>{prompts++}},
  })
  await delivery.send({requestId:'workspace-fallback',content:[]})
  assert.deepEqual(creates,[{sessionId:'workspace-timeout',cwd:directory}])
  assert.equal(prompts,1)
  resolveWorkspace({workspace:{workspaceId:'late-workspace'}})
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(creates.length,1)
  assert.equal(prompts,1)
})

test('workspace method getters can fail without blocking session creation', async t => {
  const directory = temporary(t)
  let created
  const delivery = createSessionDelivery({
    dshHome:directory,cwd:directory,sessionId:'workspace-getter',config:()=>({}),persona:()=>'',
    workspaceController:{get create(){throw Error('service disposed')}},
    controller:{create:async request=>{created=request;return request},prompt:async()=>{}},
  })
  await delivery.send({requestId:'getter-fallback',content:[]})
  assert.deepEqual(created,{sessionId:'workspace-getter',cwd:directory})
})

test('cancellation during workspace creation prevents cwd fallback and sending', async t => {
  const directory = temporary(t)
  const abort = new AbortController()
  let creates = 0
  let prompts = 0
  const delivery = createSessionDelivery({
    dshHome:directory,cwd:directory,sessionId:'workspace-cancel',config:()=>({}),persona:()=>'',
    workspaceController:{create(){abort.abort(Error('cancelled'));return new Promise(()=>{})}},
    controller:{create:async()=>{creates++},prompt:async()=>{prompts++}},
  })
  await assert.rejects(delivery.send({requestId:'cancel-workspace',content:[]},abort.signal),/cancelled/)
  assert.equal(creates,0)
  assert.equal(prompts,0)
})

test('download rejects wrong Content-Range and switches to an API backup URL',async t=>{
  const file=path.join(temporary(t),'video.mp4'),calls=[]
  const result=await downloadVideo({url:'https://primary.invalid/video',backup_url:['https://backup.invalid/video'],size:4},file,{
    fetch:async(url,options)=>{
      calls.push([url,options.headers.range])
      if(url.includes('primary'))return new Response('xxxx',{status:206,headers:{'content-range':'bytes 1-4/5'}})
      return new Response('good',{headers:{'content-length':'4'}})
    },
  })
  assert.equal(result.size,4);assert.equal(calls.length,4);assert.equal(fs.readFileSync(file,'utf8'),'good')
})

test('download resumes exact ranges and restarts when server ignores Range',async t=>{
  for(const ignored of [false,true]) {
    const file=path.join(temporary(t),'video.mp4');let calls=0
    await downloadVideo({url:'https://cdn.invalid/video',size:4},file,{fetch:async(url,options)=>{
      calls++
      if(calls===1)return new Response('ab',{status:206,headers:{'content-range':'bytes 0-1/4'}})
      assert.equal(options.headers.range,'bytes=2-')
      return ignored?new Response('abcd'):new Response('cd',{status:206,headers:{'content-range':'bytes 2-3/4'}})
    }})
    assert.equal(fs.readFileSync(file,'utf8'),'abcd')
  }
})

test('unknown-size broken downloads are never accepted just because bytes were written',async t=>{
  const file=path.join(temporary(t),'video.mp4')
  await assert.rejects(downloadVideo({url:'https://cdn.invalid/video'},file,{fetch:async()=>new Response(new ReadableStream({
    start(controller){controller.enqueue(new Uint8Array([1,2]));setTimeout(()=>controller.error(Error('broken')),5)},
  }))}),/未获得完整文件/)
  assert.equal(fs.existsSync(file),false)
})

test('segment extraction actually runs concurrently, short clips run serially, JPEG format is explicit',async t=>{
  for(const duration of [120,600]) {
    let active=0,peak=0
    await segmentFrames({ffmpeg:'fixture',url:'https://cdn.invalid/video',times:[10,30,50,70],directory:temporary(t),duration,
      run:async(file,args)=>{
        active++;peak=Math.max(peak,active)
        assert.match(args[args.indexOf('-vf')+1],/yuvj420p/)
        await new Promise(resolve=>setTimeout(resolve,5))
        fs.writeFileSync(args.at(-1).replace('%d','1'),'jpeg-fixture')
        active--
      },
    })
    assert.equal(peak,duration<300?1:3)
  }
})

test('multi-page sampling is bounded, explicit page is checked and native Chinese subtitles take priority',()=>{
  const view={pages:Array.from({length:80},(_,i)=>({page:i+1,cid:i+10}))}
  assert.deepEqual(selectSubtitlePages(view,{'sample-pages':4}).map(x=>x.page),[1,21,41,61])
  assert.equal(selectSubtitlePages(view)[0].page,1)
  assert.throws(()=>selectSubtitlePages(view,{'sample-pages':0}),/1–20/)
  assert.throws(()=>selectSubtitlePages(view,{page:81}),/不存在/)
  assert.equal(pickSubtitle([{lan:'ai-zh'},{lan:'zh-CN'}]).lan,'zh-CN')
  assert.equal(pickSubtitle([{lan:'ai-zh'}],'en'),undefined)
})

test('missing host QR encoder falls back to built-in rendering of a real PNG',async()=>{
  const result=await renderQr('https://passport.bilibili.com/scan?key=fixture',{encoder:{}})
  assert.equal(Buffer.from(result.split(',')[1],'base64').subarray(1,4).toString(),'PNG')
})

test('settings exposes four chat decisions and saves edits without replacing hidden preferences',async()=>{
 const config={chat:{multi:false,maxParts:2,chance:0.8,idleHours:14,dailyMax:1,dynamicChance:0.7,dynamicDailyMax:0,followup:false},night:{minGapMin:73},toolsPath:'custom-tools'}
 let posted,component,index=0
 const values=[config],react={
  createElement:(type,props,...children)=>({type,props,children:children.flat(Infinity)}),
  useCallback:fn=>fn,useEffect:()=>{},
  useState:initial=>{const i=index++;if(!(i in values))values[i]=initial
   return [values[i],fn=>{values[i]=typeof fn==='function'?fn(values[i]):fn}]}
 }
 vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'),{
  document:{baseURI:'https://host/'},URL,
  window:{__ModuleLoader__:{load:m=>{component=m.factory(()=>react).BiliWhaleSection}}},
  fetch:async(url,options)=>{posted=JSON.parse(options.body).config;return {ok:true,json:async()=>({config:posted})}}
 })
 function render(){index=0;return component()}
 function* walk(node){if(!node||typeof node!=='object')return;yield node;for(const child of node.children)yield* walk(child)}
 const tree=render(),account=tree.children.find(n=>n?.props?.key==='account')
 assert.equal(account.props.open,true);assert.equal(tree.children[1],account)
 const menuTitles=tree=>tree.children.filter(n=>n?.type==='details').map(n=>n.children[0].children[0])
 const menu=['角色与账号','兴趣与作息','分享','监听与通知','自主活动','运行与高级设置']
 assert.deepEqual(menuTitles(tree),menu)
 values[0]={...values[0],self:{mid:'111'}}
 const connected=render()
 assert.deepEqual(menuTitles(connected),menu);assert.equal(connected.children[1].props.open,false)
 const autonomous=tree.children.find(n=>n?.children?.[0]?.children?.[0]==='自主活动')
 const switches=[...walk(autonomous)].filter(n=>n.props?.f)
 assert.deepEqual(switches.map(n=>n.props.f.path.join('.')),['life.autonomy','diary.enabled','chat.followup','chat.idle','chat.shareReply','chat.dynamic'])
 switches[0].props.set(switches[0].props.f.path,true)
 const editor=name=>[...walk(tree)].find(n=>n.type?.name===name).type
 const share=editor('ShareEditor'),listen=editor('ListenEditor')
 const inputs=(node,id)=>[...walk(node)].filter(n=>n.props?.id===id)
 assert.equal(inputs(share({cfg:{share:{enabled:false}}}),'blw-share-via').length,0)
 assert.equal(inputs(share({cfg:{}}),'blw-share-via')[0].props.value,'dm')
 assert.equal(inputs(listen({cfg:{listen:{comment:false,dm:true}}}),'blw-listen-scope').length,0)
 assert.equal(inputs(listen({cfg:{listen:{comment:true,scope:'reply'}}}),'blw-listen-scope')[0].props.value,'reply')
 const modules=listen({cfg:{listen:{dm:true,comment:true}}}).children
 assert.deepEqual(modules.map(n=>n.props['aria-label']),['评论区监听','私信监听'])
 assert.ok([...walk(modules[1])].some(n=>n.props?.label==='接收主人的私信'))
 assert.ok(![...walk(modules[0])].some(n=>n.props?.label==='接收主人的私信'))
 const rows=[...walk(tree)].filter(n=>n.props?.f?.path[0]==='chat')
 assert.deepEqual(rows.map(n=>n.props.f.path[1]),['followup','idle','shareReply','dynamic'])
 rows[0].props.set(rows[0].props.f.path,true)
 const save=[...walk(render())].find(n=>n.type==='button'&&n.children.includes('保存'))
 await save.props.onClick()
 assert.equal(posted.life.autonomy,true)
 assert.deepEqual(posted.chat,{...config.chat,followup:true})
 assert.equal(posted.night.minGapMin,73);assert.equal(posted.toolsPath,'custom-tools')
})

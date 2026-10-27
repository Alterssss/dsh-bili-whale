import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {EventEmitter} from 'node:events'
import {createBrowserLogin,parseOwnerMid} from '../lib/login.js'
import {readChromeCookies} from '../lib/chrome-cookies.js'
const tick=()=>new Promise(r=>setImmediate(r))
const cred={sessdata:'fake-private-session',bili_jct:'a'.repeat(32),buvid3:'fake-device'}
function fixture(t,over={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-login-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
 let time=10000,owner='222',valid=true;const file=path.join(dir,'credentials.json'),saved=[],calls=[]
 const login=createBrowserLogin({credentialsFile:file,protect:()=>{},now:()=>time,getOwner:()=>owner,persistIdentity:a=>saved.push(a),readCookies:async()=>({...cred}),fetch:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({code:0,data:{isLogin:valid,mid:111,uname:'小号'}}))},...over})
 return {dir,file,saved,calls,login,owner:x=>owner=x,valid:x=>valid=x,advance:x=>time+=x}
}
test('read verifies identity, returns no secrets, saves only after explicit confirmation',async t=>{
 const f=fixture(t),a=await f.login.start();assert.equal(a.state,'connecting');assert.equal(fs.existsSync(f.file),false)
 await tick();const preview=await f.login.poll(a.id);assert.equal(preview.state,'confirm');assert.equal(preview.account.mid,'111')
 assert.doesNotMatch(JSON.stringify(preview),/fake-private|fake-device|aaaaaa/);assert.equal(fs.existsSync(f.file),false)
 assert.equal((await f.login.confirm(a.id)).state,'saved');assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),cred)
 assert.equal(f.saved.length,1);assert.equal((await f.login.status()).state,'verified');assert.ok(f.calls.every(x=>x.url.endsWith('/nav')&&!x.options.method))
 await assert.rejects(f.login.confirm(a.id),/失效/)
})
test('cancel or restart invalidates pending reads; disposal aborts browser connection',async t=>{
 const reads=[];const f=fixture(t,{readCookies:({signal})=>new Promise(resolve=>reads.push({resolve,signal}))})
 const a=await f.login.start();await assert.rejects(f.login.confirm(a.id),/获取/)
 const b=await f.login.start();assert.equal(reads[0].signal.aborted,true);reads[0].resolve(cred);await tick();await assert.rejects(f.login.poll(a.id),/失效/)
 await f.login.cancel(b.id);reads[1].resolve(cred);await tick();assert.equal(fs.existsSync(f.file),false)
 const c=await f.login.start();f.login.dispose();assert.equal(reads[2].signal.aborted,true);reads[2].resolve(cred);await tick();await assert.rejects(f.login.poll(c.id));assert.equal(f.saved.length,0)
})
test('main account, missing fields and expired credentials never replace old login',async t=>{
 const f=fixture(t);fs.writeFileSync(f.file,'old');f.owner('111');const a=await f.login.start();await tick();assert.equal((await f.login.poll(a.id)).state,'error');await assert.rejects(f.login.confirm(a.id))
 f.owner('222');const b=await f.login.start();await tick();f.valid(false);await assert.rejects(f.login.confirm(b.id),/无效/)
 assert.equal(fs.readFileSync(f.file,'utf8'),'old')
 const missing=fixture(t,{readCookies:async()=>({...cred,buvid3:''})});const m=await missing.login.start();await tick();assert.equal((await missing.login.poll(m.id)).state,'error');assert.equal(fs.existsSync(missing.file),false)
})
test('confirmation rechecks owner and TTL; metadata failure warns without reverting committed credentials',async t=>{
 const f=fixture(t,{persistIdentity:()=>{throw Error('failed')}});fs.writeFileSync(f.file,'old')
 const a=await f.login.start();await tick();f.owner('111');await assert.rejects(f.login.confirm(a.id),/主号/)
 f.owner('222');const saved=await f.login.confirm(a.id);assert.match(saved.account.warn,/显示信息未更新/);assert.deepEqual(JSON.parse(fs.readFileSync(f.file,'utf8')),cred)
 const expired=await f.login.start();await tick();f.advance(180001);await assert.rejects(f.login.confirm(expired.id),/过期/)
})
test('UID accepts main-account numbers and space links only',()=>{
 assert.equal(parseOwnerMid('123'),'123');assert.equal(parseOwnerMid('https://space.bilibili.com/123/?x=1'),'123');assert.equal(parseOwnerMid('https://evil.example/123'),'')
})

test('Chrome import preserves pending drafts and blocks cross-account replacement',async t=>{
 const old={...cred,sessdata:'old-account-session-value'}
 const f=fixture(t,{fetch:async(_url,o)=>new Response(JSON.stringify({code:0,data:{isLogin:true,mid:o.headers.cookie.includes(old.sessdata)?333:111,uname:'测试账号'}}))})
 fs.writeFileSync(f.file,JSON.stringify(old));const pending=path.join(f.dir,'pending-replies.json'),drafts=JSON.stringify({items:[{id:'draft'}]});fs.writeFileSync(pending,drafts)
 const attempt=await f.login.start();await tick();assert.equal((await f.login.poll(attempt.id)).state,'confirm')
 await assert.rejects(f.login.confirm(attempt.id),/待审草稿/)
 assert.deepEqual(JSON.parse(fs.readFileSync(f.file,'utf8')),old);assert.equal(fs.readFileSync(pending,'utf8'),drafts)
})

test('Chrome import allows same-account refresh but cancellation before commit preserves old bytes',async t=>{
 const f=fixture(t);fs.writeFileSync(f.file,JSON.stringify(cred));fs.writeFileSync(path.join(f.dir,'pending-replies.json'),JSON.stringify({items:[{id:'draft'}]}))
 const same=await f.login.start();await tick();assert.equal((await f.login.confirm(same.id)).state,'saved')
 let login;const cancelled=fixture(t,{protect:()=>{void login.cancel()}});login=cancelled.login
 fs.writeFileSync(cancelled.file,'old-credential-bytes');const attempt=await login.start();await tick()
 await assert.rejects(login.confirm(attempt.id));assert.equal(fs.readFileSync(cancelled.file,'utf8'),'old-credential-bytes')
})

test('Chrome account preview preserves large numeric IDs exactly',async t=>{
 const f=fixture(t,{fetch:async()=>new Response('{"code":0,"data":{"isLogin":true,"mid":1262823889456594949,"uname":"test"}}')})
 const attempt=await f.login.start();await tick();assert.equal((await f.login.poll(attempt.id)).account.mid,'1262823889456594949')
})
function transport(t,{tabs=true,hang=false}={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-cdp-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'port');fs.writeFileSync(file,'9222\n/devtools/browser/test')
 const calls=[],sockets=[]
 class FakeSocket extends EventEmitter {
  constructor(url){super();this.url=url;this.terminated=false;sockets.push(this);if(!hang)queueMicrotask(()=>this.emit('open'))}
  send(raw){const m=JSON.parse(raw);calls.push(m);let result={};if(m.method==='Target.getTargets')result={targetInfos:[{type:'page',url:'https://other.example/',targetId:'other'},...(tabs?[{type:'page',url:'https://www.bilibili.com/',targetId:'bili'}]:[])]};if(m.method==='Target.attachToTarget')result={sessionId:'session'};if(m.method==='Network.getCookies')result={cookies:[{name:'SESSDATA',value:cred.sessdata,domain:'.bilibili.com',httpOnly:true},{name:'bili_jct',value:cred.bili_jct,domain:'.bilibili.com'},{name:'buvid3',value:cred.buvid3,domain:'.bilibili.com'}]};queueMicrotask(()=>this.emit('message',Buffer.from(JSON.stringify({id:m.id,result}))))}
  terminate(){this.terminated=true;this.emit('close')}
 }
 return {file,calls,sockets,FakeSocket}
}
test('CDP only attaches Bilibili, reads scoped URLs, detaches without closing browser',async t=>{
 const f=transport(t);const result=await readChromeCookies({discoveryFile:f.file,WebSocketClass:f.FakeSocket})
 assert.deepEqual(result,cred);assert.equal(f.calls.find(c=>c.method==='Target.attachToTarget').params.targetId,'bili')
 assert.deepEqual(f.calls.find(c=>c.method==='Network.getCookies').params.urls,['https://www.bilibili.com/','https://api.bilibili.com/'])
 assert.ok(f.calls.some(c=>c.method==='Target.detachFromTarget'));assert.ok(!f.calls.some(c=>c.method==='Browser.close'));assert.equal(f.sockets[0].terminated,true)
})
test('missing debugging setup, no Bilibili tab, cancellation and timeout clean up',async t=>{
 await assert.rejects(readChromeCookies({discoveryFile:'missing-probe-file'}),/远程调试/)
 const a=transport(t,{tabs:false});await assert.rejects(readChromeCookies({discoveryFile:a.file,WebSocketClass:a.FakeSocket}),/标签页/);assert.equal(a.sockets[0].terminated,true)
 const b=transport(t,{hang:true}),controller=new AbortController();const pending=readChromeCookies({discoveryFile:b.file,WebSocketClass:b.FakeSocket,signal:controller.signal});controller.abort();await assert.rejects(pending);assert.equal(b.sockets[0].terminated,true)
 const c=transport(t,{hang:true});await assert.rejects(readChromeCookies({discoveryFile:c.file,WebSocketClass:c.FakeSocket,timeoutMs:10}),/允许/);assert.equal(c.sockets[0].terminated,true)
 fs.writeFileSync(c.file,'123\nhttps://evil.example/');await assert.rejects(readChromeCookies({discoveryFile:c.file,WebSocketClass:c.FakeSocket}),/无效/)
})

import vm from 'node:vm'

test('beginner guide changes only draft options; account/login/reply/share are separate',async()=>{
  let client,cursor=0;const state=[]
  const react={createElement:(type,props,...children)=>({type,props:props??{},children}),useEffect:()=>{},useCallback:f=>f,useState(value){const i=cursor++;if(!(i in state))state[i]=value;return [state[i],v=>state[i]=typeof v==='function'?v(state[i]):v]}}
  vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load({factory}){client=factory(()=>react)}}},fetch:()=>{throw Error('Guide must not make requests')}})
  state[0]={self:{mid:'111',name:'小号'},owner:{mid:'222'},voice:{},listen:{dm:false,comment:true,live:true},share:{enabled:true},notify:{type:'dm'}}
  const walk=n=>n&&typeof n==='object'?[n,...n.children.flat(Infinity).flatMap(walk)]:[]
  let parent=client.BiliWhaleSection(),tree=walk(parent)
  const component=name=>tree.find(n=>typeof n.type==='function'&&n.type.name===name)
  assert.ok(component('SmallAccountLogin'));assert.ok(component('PrivateReplyEditor'));assert.ok(component('ShareEditor'))
  const guide=component('SetupGuide');cursor=50
  const guideTree=guide.type(guide.props)
  const before=JSON.stringify(state[0])
  assert.ok(walk(guideTree).some(n=>n.type==='button'))
  assert.equal(JSON.stringify(state[0]),before)
  walk(guideTree).find(n=>n.type==='button').props.onClick()
  assert.equal(state[0].listen.dm,true);assert.equal(state[0].listen.comment,false);assert.equal(state[0].share.enabled,false);assert.equal(state[0].notify.type,'none')
  assert.equal(state[0].owner.mid,'222');assert.equal(state[0].self.mid,'111')
  const login=component('SmallAccountLogin');cursor=60
  const loginTree=login.type(login.props)
  assert.ok(walk(loginTree).some(n=>n.type==='button'&&n.children.includes('从当前 Chrome 获取登录态')))
  assert.ok(!walk(loginTree).some(n=>n.type==='img'))
})

test('notification test stops if draft settings fail to save',async()=>{
  let client,cursor=0;const calls=[],state=[]
  const react={createElement:(type,props,...children)=>({type,props:props??{},children}),useEffect:()=>{},useCallback:f=>f,useState(value){const i=cursor++;if(!(i in state))state[i]=value;return [state[i],v=>state[i]=typeof v==='function'?v(state[i]):v]}}
  vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load({factory}){client=factory(()=>react)}}},fetch:async(url)=>{calls.push(url);return {ok:false,status:400,json:async()=>({error:'保存失败'})}}})
  state[0]={self:{},owner:{},voice:{},listen:{},share:{},notify:{type:'dm'}}
  const walk=n=>n&&typeof n==='object'?[n,...n.children.flat(Infinity).flatMap(walk)]:[]
  const parent=client.BiliWhaleSection(),notify=walk(parent).find(n=>typeof n.type==='function'&&n.type.name==='NotifyEditor')
  cursor=60
  const ui=notify.type(notify.props)
  await walk(ui).find(n=>n.type==='button'&&n.children.includes('实际发送一条测试通知')).props.onClick()
  assert.deepEqual(calls,['/dsh-bili/api/settings'])
})

test('Chrome candidate UI shows identity and saves only when confirmation is clicked',async()=>{
 let client,cursor=0;const state=[],requests=[]
 const react={createElement:(type,props,...children)=>({type,props:props??{},children}),useEffect:()=>{},useCallback:f=>f,useState(value){const i=cursor++;if(!(i in state))state[i]=value;return [state[i],v=>state[i]=typeof v==='function'?v(state[i]):v]}}
 vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load({factory}){client=factory(()=>react)}}},fetch:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({ok:true,state:'saved',account:{mid:'111',name:'小号'}})}}})
 state[0]={owner:{mid:'222'},self:{},voice:{},listen:{},share:{},notify:{}}
 const walk=n=>n&&typeof n==='object'?[n,...n.children.flat(Infinity).flatMap(walk)]:[]
 const parent=client.BiliWhaleSection(),login=walk(parent).find(n=>typeof n.type==='function'&&n.type.name==='SmallAccountLogin')
 state[60]={id:'candidate',state:'confirm',account:{mid:'111',name:'小号'}};cursor=60
 const ui=login.type(login.props),nodes=walk(ui)
 assert.match(JSON.stringify(ui),/chrome:\/\/inspect\/#remote-debugging/)
 assert.match(JSON.stringify(ui),/UID 111/)
 assert.doesNotMatch(JSON.stringify(ui),/二维码|扫码/)
 assert.equal(requests.length,0)
 await nodes.find(n=>n.type==='button'&&n.children.includes('确认并保存这个小号')).props.onClick()
 assert.deepEqual(requests,[{url:'/dsh-bili/api/login/confirm',body:{id:'candidate'}}])
 assert.equal(state[0].self.mid,'111')
 state[60]={id:'new-candidate',state:'confirm',account:{mid:'222',name:'主号'}};cursor=60
 const conflict=login.type(login.props)
 assert.equal(walk(conflict).find(n=>n.type==='button'&&n.children.includes('确认并保存这个小号')).props.disabled,true)
})

test('upstream QR fallback and Chrome controls retain mutual exclusion without losing unsaved settings',()=>{
 let client,cursor=0;const state=[]
 const react={createElement:(type,props,...children)=>({type,props:props??{},children}),useEffect:()=>{},useCallback:f=>f,useState(v){const i=cursor++;if(!(i in state))state[i]=v;return[state[i],x=>state[i]=typeof x==='function'?x(state[i]):x]}}
 vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load({factory}){client=factory(()=>react)}}}})
 state[0]={dialogueMode:'character',character:{name:'鱼'},owner:{mid:'draft-owner'},self:{mid:'old'}};state[1]=JSON.stringify({...state[0],owner:{mid:'saved-owner'}});state[5]={sessdata:'test',bili_jct:'test'};state[11]=true
 const walk=n=>n&&typeof n==='object'?[n,...n.children.flat(Infinity).flatMap(walk)]:[]
 const nodes=walk(client.BiliWhaleSection()),chrome=nodes.find(n=>n.type?.name==='SmallAccountLogin'),qr=nodes.find(n=>n.type?.name==='QrLogin')
 assert.ok(qr);assert.equal(chrome.props.disabled,true)
 assert.equal(nodes.find(n=>n.type==='button'&&n.children.includes('保存')).props.disabled,true)
 assert.equal(nodes.find(n=>n.type==='button'&&n.children.includes('写入凭据')).props.disabled,true)
 chrome.props.onAccount({mid:'new',name:'new'})
 assert.equal(state[0].self.mid,'new');assert.equal(state[0].owner.mid,'draft-owner')
 assert.equal(JSON.parse(state[1]).self.mid,'new');assert.equal(JSON.parse(state[1]).owner.mid,'saved-owner')
 cursor=0;state[11]=false;state[12]=true
 assert.equal(walk(client.BiliWhaleSection()).find(n=>n.type?.name==='QrLogin').props.disabled,true)
})

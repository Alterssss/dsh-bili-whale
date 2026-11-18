import test from 'node:test'
import assert from 'node:assert/strict'
import {verifyCommentVisibility} from '../tools/lib/comment-visibility.mjs'
const rpid='1262823889456594949'
function harness(transport){let at=10000;return {oid:'1',rpid,headers:{cookie:'fake-secret',authorization:'fake-auth',referer:'https://www.bilibili.com/'},now:()=>at,sleep:async ms=>{at+=ms},transport}}
const response=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}})
test('public observation matches exact ID and does not disclose cookies to anonymous probe',async()=>{
 let calls=0
 const r=await verifyCommentVisibility(harness(async(url,opt)=>{calls++;assert.equal(new Headers(opt.headers).has('cookie'),false);assert.equal(new Headers(opt.headers).has('authorization'),false);return new Response('{"code":0,"data":{"root":{"rpid":1262823889456594949,"state":0}}}',{headers:{'content-type':'application/json'}})}))
 assert.equal(r.status,'public');assert.equal(calls,1)
})
test('root code 0 does not prove a specific nested reply visible',async()=>{
 const r=await verifyCommentVisibility({...harness(async()=>response({code:0,data:{root:{rpid:'other'}}})),root:'123'})
 assert.equal(r.status,'unconfirmed');assert.match(r.message,/不能据此重发/)
})
test('main list fallback can confirm a top-level comment',async()=>{
 const r=await verifyCommentVisibility(harness(async url=>String(url).includes('/reply/reply?')?response({code:12006}):response({code:0,data:{replies:[{rpid_str:rpid}]}})))
 assert.equal(r.status,'public')
})
test('only authenticated observation remains an unconfirmed-public result',async()=>{
 const r=await verifyCommentVisibility(harness(async(url,opt)=>response({code:0,data:new Headers(opt.headers).has('cookie')?{root:{rpid_str:rpid,state:17}}:{}})))
 assert.equal(r.status,'login-only-observed');assert.equal(r.publicObserved,false);assert.match(r.message,/不要重发/)
})
test('bounded missing sample preserves accepted-send semantics',async()=>{
 const r=await verifyCommentVisibility(harness(async()=>response({code:12006,message:'没有该评论'})))
 assert.equal(r.status,'unconfirmed');assert.equal(r.attempts,2);assert.match(r.message,/不表示发送失败/)
})
test('transport failure or risk stops further probes without resending',async()=>{
 for(const transport of [async()=>{throw Error('offline')},async()=>new Response('blocked',{status:412})]){
  let n=0;const r=await verifyCommentVisibility(harness(async(...args)=>{n++;return transport(...args)}))
  assert.equal(r.status,'unconfirmed');assert.equal(n,1);assert.ok(r.readError)
 }
})
test('deadline expiration prevents any further request',async()=>{
 let at=0,calls=0
 const r=await verifyCommentVisibility({...harness(null),seconds:1,now:()=>at,transport:async()=>{calls++;at+=2000;return response({code:12006})}})
 assert.equal(calls,1);assert.equal(r.status,'unconfirmed')
})

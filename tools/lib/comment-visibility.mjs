import {guardedFetch} from './traffic.mjs'
import {exactJson} from './json-exact.mjs'
import {setTimeout as delay} from 'node:timers/promises'
function findComment(data,rpid) {
  const visit=(node,depth=0)=>{
    if(!node||typeof node!=='object'||depth>5)return null
    if(String(node.rpid_str??node.rpid??'')===String(rpid))return node
    for(const key of ['root','replies','top_replies','upper','top']){
      const list=Array.isArray(node[key])?node[key]:[node[key]]
      for(const entry of list){const hit=visit(entry,depth+1);if(hit)return hit}
    }
    return null
  }
  return visit(data)
}
export async function verifyCommentVisibility({oid,rpid,root='',type='1',referer='https://www.bilibili.com/',headers={},seconds=30,transport=guardedFetch,now=Date.now,sleep=delay}={}) {
  if(![oid,rpid,type].every(v=>/^\d+$/.test(String(v))))throw Error('回读需要完整十进制 type / oid / rpid')
  const start=now(),deadline=start+Math.max(1,Math.min(30,Number(seconds)||30))*1000
  const result={receipt:String(rpid),status:'unconfirmed',attempts:0,checkedAt:start,publicObserved:false,loginObserved:false,evidence:[],message:''}
  const anonHeaders=new Headers(headers);anonHeaders.delete('cookie');anonHeaders.delete('authorization')
  const request=async(url,authenticated)=>{
    const remaining=deadline-now();if(remaining<=0)return null
    const response=await transport(url,{headers:authenticated?headers:anonHeaders,signal:AbortSignal.timeout(Math.max(1,Math.floor(remaining)))})
    const data=await exactJson(response)
    result.evidence.push({authenticated,http:response.status,code:data.code})
    if([412,429].includes(response.status)||[-412,-352,-799,-509,-10403,-101,12015,-105].includes(data.code))throw Error('回读被请求保护或账号状态中止')
    if(!response.ok||data.code!==0)return null
    return findComment(data.data,rpid)
  }
  try{
    for(let attempt=0;attempt<2&&now()<deadline;attempt++){
      if(attempt)await sleep(Math.min(10000,Math.max(0,deadline-now()-1000)))
      result.attempts++
      const endpoint='https://api.bilibili.com/x/v2/reply/reply?'+new URLSearchParams({type:String(type),oid:String(oid),root:String(root||rpid),pn:'1',ps:'20'})
      let hit=await request(endpoint,false)
      if(!hit&&!root&&now()<deadline)hit=await request('https://api.bilibili.com/x/v2/reply?'+new URLSearchParams({type:String(type),oid:String(oid),pn:'1',ps:'20',sort:'2'}),false)
      if(hit&&(hit.state===undefined||Number(hit.state)===0)){result.publicObserved=true;result.status='public';break}
      if(attempt===1&&now()<deadline){const own=await request(endpoint,true);result.loginObserved=!!own;if(own)result.status='login-only-observed'}
    }
  }catch(e){result.readError=e.name==='AbortError'||e.name==='TimeoutError'?'回读时间预算用完':String(e.message).replace(/https?:\/\/\S+/g,'[接口]').slice(0,200)}
  result.checkedAt=now()
  result.message=result.status==='public'?'平台已接受，匿名接口已读到该评论。':result.status==='login-only-observed'?'平台已接受；本次仅登录态读到，公开可见性尚未确认，可能审核中或接口延迟。不要重发。':'平台已接受，但在本次回读范围内暂时读不到；不表示发送失败，也不能据此重发。'
  return result
}

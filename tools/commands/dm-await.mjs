import { HOME } from '../lib/paths.mjs'
// Exit contract: 0 = message/ack/baseline; 1 + {hit:false} = normal empty; 2 = invalid input; 3 = failure.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {config} from '../lib/config.mjs'
import {readHistory} from '../lib/dm-history.mjs'
import {acquireProcessLock} from '../lib/process-lock.mjs'
const argv=process.argv.slice(2),peek=argv.includes('--peek'),json=argv.includes('--json')
const owner=String(config().owner?.mid??'').trim(),name=String(config().owner?.name??'主人')
const home=HOME
const file=path.join(home,'.bili-ai/dm-await-state.json')
function save(state) {
  const tmp=file+'.'+crypto.randomUUID()+'.tmp'
  try{fs.writeFileSync(tmp,JSON.stringify(state,null,2));fs.renameSync(tmp,file)}finally{fs.rmSync(tmp,{force:true})}
}
function acknowledge(state,message) {
  const same=Number(state.lastSeen)===message.ts
  return {...state,owner,lastSeen:message.ts,lastKey:message.key,lastKeys:[...new Set([...(same?(state.lastKeys??(state.lastKey?[state.lastKey]:[])):[]),message.key])],pending:undefined,queue:state.queue??[],at:new Date().toISOString()}
}
// 结果未知（宿主持久化/投递超时）不能卡住后面的消息：把这条按回执记为待核查，
// 同时推进已读位置，普通 --peek 就能取下一条。重启后既不重复投递，也不丢这条记录。
const UNCONFIRMED_MAX=50
function markUnconfirmed(state,receipt) {
  const p=state.pending
  if(!p||p.mid!==owner||p.receipt!==receipt)return null
  const entry={key:p.key,ts:p.ts,receipt:p.receipt,text:String(p.text??'').slice(0,200),at:new Date().toISOString()}
  const list=[...(state.unconfirmed??[]).filter(x=>x.key!==entry.key),entry].slice(-UNCONFIRMED_MAX)
  const next=acknowledge({...state,unconfirmed:list},p)
  return {...next,unconfirmed:list}
}
function pendingVerification(state){return (state.unconfirmed??[]).filter(x=>x&&x.key)}
function emit(message){console.log(json?JSON.stringify(message):'DM_HIT mid='+owner+' text='+message.text)}
async function main(){
  if(!owner){console.error('配置里 owner.mid 为空');return 2}
  let state={}
  try{state=JSON.parse(fs.readFileSync(file,'utf8'));if(!state||typeof state!=='object'||Array.isArray(state))throw Error('invalid state')}
  catch(e){if(e.code!=='ENOENT')throw Error('私信状态无法读取，已停止推进已读位置：'+e.message)}
  if(state.owner&&state.owner!==owner)state={}
  if(state.lastSeen!==undefined&&(!Number.isFinite(Number(state.lastSeen))||Number(state.lastSeen)<0))throw Error('私信游标损坏，已停止读取')
  if(state.queue!==undefined&&!Array.isArray(state.queue))throw Error('私信待交付队列损坏')
  if(state.unconfirmed!==undefined&&!Array.isArray(state.unconfirmed))throw Error('私信待核查列表损坏')
  const ackIndex=argv.indexOf('--ack')
  if(ackIndex>=0){
    if(!state.pending||state.pending.mid!==owner||state.pending.receipt!==argv[ackIndex+1]){console.error('私信确认凭据不匹配，未推进已读状态');return 2}
    save(acknowledge(state,state.pending));console.log('私信交付已确认');return 0
  }
  // 结果未知：按回执结案为"待核查"，不让它继续占着 pending 挡住后面的消息。
  const unconfirmedIndex=argv.indexOf('--mark-unconfirmed')
  if(unconfirmedIndex>=0){
    const receipt=argv[unconfirmedIndex+1]
    const next=markUnconfirmed(state,receipt)
    if(!next){console.error('没有与该回执匹配的待确认私信');return 2}
    save(next);console.log('私信结果未确认，已转入待核查：'+receipt);return 0
  }
  if(argv.includes('--list-unconfirmed')){
    const list=pendingVerification(state)
    console.log(JSON.stringify({count:list.length,items:list}));return 0
  }
  if(state.pending?.mid===owner&&!argv.includes('--baseline')){emit(state.pending);return 0}
  if(!state.queue?.length||argv.includes('--baseline')){
    const cred=JSON.parse(fs.readFileSync(path.join(home,'.bili-ai/credentials.json'),'utf8'))
    const headers={'user-agent':'Mozilla/5.0',referer:'https://www.bilibili.com/',cookie:'SESSDATA='+cred.sessdata+'; bili_jct='+cred.bili_jct+'; buvid3='+cred.buvid3}
    const result=await readHistory(owner,headers,state,{baseline:argv.includes('--baseline')})
    if(argv.includes('--baseline')){
      const latest=result.all.at(-1),ts=latest?.ts??0
      save({owner,lastSeen:ts,lastKey:latest?.key,lastKeys:result.all.filter(r=>r.ts===ts).map(r=>r.key),lastIncoming:state.lastIncoming,queue:[]})
      console.log('已把当前私信状态标记为已读');return 0
    }
    state={...state,owner,queue:result.messages,lastIncoming:Math.max(Number(state.lastIncoming??0),...result.messages.map(r=>r.ts))}
    save(state)
  }
  if(!state.queue.length){console.log(json?JSON.stringify({hit:false}):'无新私信');return 1}
  const [row,...rest]=state.queue
  const message={hit:true,mid:owner,name,text:row.text,image:row.image??null,share:row.share??null,contentKind:row.type===7?'share':'message',ts:row.ts,key:row.key,receipt:crypto.randomUUID()}
  state={...state,owner,queue:rest}
  if(peek)save({...state,pending:message})
  else save(acknowledge(state,message))
  emit(message);return 0
}
let release
try{
  fs.mkdirSync(path.dirname(file),{recursive:true})
  release=await acquireProcessLock(file)
  process.exitCode=await main()
}catch(e){console.error(e.message);process.exitCode=3}
finally{if(release)await release()}

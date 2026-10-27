import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import WebSocket from 'ws'

export const isBilibili = value => {try {const u=new URL(value);return u.protocol==='https:'&&(u.hostname==='bilibili.com'||u.hostname.endsWith('.bilibili.com'))}catch{return false}}

export async function readChromeCookies({signal,discoveryFile=path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'Google','Chrome','User Data','DevToolsActivePort'),WebSocketClass=WebSocket,timeoutMs=120000}={}) {
  signal?.throwIfAborted()
  let lines
  try{lines=fs.readFileSync(discoveryFile,'utf8').trim().split(/\r?\n/)}catch{throw Error('请先在正常 Chrome 打开 chrome://inspect/#remote-debugging 并开启远程调试（需 Chrome 144 或更新版本）')}
  const [port,endpoint]=lines
  if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535||!/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(endpoint))throw Error('Chrome 调试信息无效，请关闭并重新开启远程调试')
  const socket=new WebSocketClass(`ws://127.0.0.1:${port}${endpoint}`,{handshakeTimeout:timeoutMs,perMessageDeflate:false})
  const pending=new Map();let next=0,terminal=false,rejectOpen
  const fail=()=>{terminal=true;rejectOpen?.(Error('连接未完成，请在 Chrome 的本次连接弹窗中点击允许，或重新开启调试后再试'));for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Chrome 连接中断，请重新获取'))}pending.clear()}
  const abort=()=>{fail();socket.terminate()}
  socket.on('error',fail);socket.on('close',fail)
  socket.on('message',bytes=>{let msg;try{msg=JSON.parse(String(bytes))}catch{return}const p=pending.get(msg.id);if(!p)return;pending.delete(msg.id);clearTimeout(p.timer);if(msg.error)p.reject(Error('Chrome 不支持此读取操作，请更新浏览器后重试'));else p.resolve(msg.result)})
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    if(terminal||signal?.aborted){reject(Error('Chrome 连接已取消'));return}
    const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error('等待 Chrome 响应超时，请确认已允许连接'))},15000)
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))
  })
  signal?.addEventListener('abort',abort,{once:true})
  const deadline=setTimeout(abort,timeoutMs)
  try {
    await new Promise((resolve,reject)=>{rejectOpen=reject;socket.once('open',()=>{rejectOpen=null;resolve()});if(signal?.aborted)abort()})
    const {targetInfos}=await call('Target.getTargets')
    const target=targetInfos.find(t=>t.type==='page'&&isBilibili(t.url))
    if(!target)throw Error('请先在正常 Chrome 中打开已登录小号的 B 站标签页，再点击获取')
    const attached=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true})
    const {cookies}=await call('Network.getCookies',{urls:['https://www.bilibili.com/','https://api.bilibili.com/']},attached.sessionId)
    await call('Target.detachFromTarget',{sessionId:attached.sessionId})
    const value=name=>cookies.find(c=>c.name===name&&(c.domain==='bilibili.com'||c.domain.endsWith('.bilibili.com'))&&c.value)?.value??''
    const credentials={sessdata:value('SESSDATA'),bili_jct:value('bili_jct'),buvid3:value('buvid3')}
    if(!credentials.sessdata||!/^[a-f0-9]{32}$/i.test(credentials.bili_jct))throw Error('没有读到有效的小号登录态，请先在该 Chrome 中登录 B 站小号')
    if(!credentials.buvid3)throw Error('缺少 buvid3，请在正常 Chrome 刷新 B 站首页后重新获取')
    return credentials
  } finally {clearTimeout(deadline);signal?.removeEventListener('abort',abort);socket.terminate()}
}

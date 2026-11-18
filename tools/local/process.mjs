import {activityRemaining} from '../lib/activity.mjs'
import {spawn} from 'node:child_process'
import {NODE_EXE,NODE_ENV} from '../lib/nodebin.mjs'
export function runNode(file,args=[],{timeoutMs=900000,env={},signal}={}){
 const remaining=activityRemaining();if(remaining!==null)timeoutMs=Math.min(timeoutMs,remaining)
 return new Promise(resolve=>{
  let stdout='',stderr='',done=false,timedOut=false,overflow=false,stopping=false
  const child=spawn(NODE_EXE,[file,...args],{env:{...NODE_ENV,...env},windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']})
  const stop=()=>{if(stopping||!child.pid)return;stopping=true;if(process.platform==='win32'){const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});const fallback=setTimeout(()=>{child.kill();killer.kill()},1000);fallback.unref();killer.on('error',()=>child.kill());killer.on('close',()=>{clearTimeout(fallback);child.kill()})}else{try{process.kill(-child.pid,'SIGKILL')}catch{child.kill()}}};const timer=setTimeout(()=>{timedOut=true;stop()},timeoutMs)
  signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop()
  const finish=(code,error)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',stop);resolve({code,stdout,stderr,error:error?.message??null,timedOut,overflow})}
  const collect=key=>chunk=>{if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)+Buffer.byteLength(chunk)>16*1024*1024){overflow=true;stop();return}if(key==='stdout')stdout+=chunk.toString();else stderr+=chunk.toString()}
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8')
  child.stdout.on('data',collect('stdout'));child.stderr.on('data',collect('stderr'))
  child.on('error',error=>finish(null,error));child.on('close',code=>finish(code))
 })
}
export async function mapLimit(items,limit,worker){
 const results=new Array(items.length);let next=0
 await Promise.all(Array.from({length:Math.min(items.length,limit)},async()=>{while(next<items.length){const i=next++;results[i]=await worker(items[i],i)}}));return results
}
export function parseResult(result){
 if(result.code!==0||result.error||result.timedOut||result.overflow)throw Error(result.timedOut?'子进程超时':result.overflow?'子进程输出超限':result.stderr.slice(-500)||result.error||'子进程失败：'+result.code)
 try{return JSON.parse(result.stdout)}catch{throw Error('子进程未返回有效 JSON')}
}

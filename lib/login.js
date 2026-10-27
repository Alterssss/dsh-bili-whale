import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createCredentialStore } from './credentials.js'
import { parseJsonExact } from '../tools/lib/json-exact.mjs'

export function parseOwnerMid(value) {
  const text=String(value??'').trim()
  if (/^[1-9]\d*$/.test(text)) return text
  try {const u=new URL(text);if(u.protocol==='https:'&&u.hostname==='space.bilibili.com'&&/^\/[1-9]\d*\/?$/.test(u.pathname))return u.pathname.split('/')[1]} catch {}
  return ''
}

export function createBrowserLogin({fetch,readCookies,credentialsFile,getOwner=()=>'',persistIdentity=()=>{},saveCredentials,protect,now=Date.now}) {
  let session=null,disposed=false,saving=false
  const clear=()=>{session?.controller.abort();session=null}
  const assertLive=s=>{if(disposed||session!==s||s.controller.signal.aborted)throw Error('获取已取消，请重新获取');if(now()>=s.expiresAt){clear();throw Error('候选登录态已过期，请重新获取')}}
  const rejectOwner=account=>{if(String(getOwner())===account.mid)throw Error('获取到的是已绑定的主号，请在 Chrome 切换到小号后重新获取')}
  async function identify(cred,signal) {
    let j
    try {
      const r=await fetch('https://api.bilibili.com/x/web-interface/nav',{headers:{'user-agent':'Mozilla/5.0',referer:'https://www.bilibili.com/',cookie:`SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3??''}`},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)})
      if(!r.ok)throw Error();j=parseJsonExact(await r.text())
    }catch{throw Error('无法核验 B 站账号，请稍后重新获取')}
    if(j.code!==0||!j.data?.isLogin||!j.data.mid)throw Error('登录态无效或已过期，请在正常 Chrome 登录后重新获取')
    return {mid:String(j.data.mid),name:String(j.data.uname??'')}
  }
  const current=id=>{const s=session;if(!s||s.id!==id)throw Error('获取记录已失效，请重新获取');assertLive(s);return s}
  const writer = saveCredentials || createCredentialStore({file:credentialsFile,pending:path.join(path.dirname(credentialsFile),'pending-replies.json'),verify:(cred,{signal})=>identify(cred,signal),...(protect?{protect}:{})}).save
  return {
    async start(){
      if(disposed||saving)throw Error('登录操作暂不可用，请稍后再试')
      clear();const s={id:crypto.randomUUID(),state:'connecting',expiresAt:now()+300000,controller:new AbortController()};session=s
      void(async()=>{
        try{
          const cred=await readCookies({signal:s.controller.signal});assertLive(s)
          if(!cred?.sessdata||!/^[a-f0-9]{32}$/i.test(cred.bili_jct??'')||!cred.buvid3)throw Error('未获取到完整的三个字段，请先在正常 Chrome 登录并刷新 B 站首页')
          const account=await identify(cred,s.controller.signal);assertLive(s);rejectOwner(account)
          s.cred=cred;s.account=account;s.state='confirm';s.expiresAt=now()+180000
        }catch(e){if(session===s&&!disposed&&!s.controller.signal.aborted){s.state='error';s.error=e.message;s.cred=null}}
      })()
      return {id:s.id,state:'connecting',expiresAt:s.expiresAt}
    },
    async poll(id){const s=current(id);return {id:s.id,state:s.state,expiresAt:s.expiresAt,...(s.account?{account:s.account,fields:{SESSDATA:true,bili_jct:true,buvid3:true}}:{}),...(s.error?{error:s.error}:{})}},
    async confirm(id){
      if(saving)throw Error('正在保存，请勿重复点击')
      const s=current(id);if(s.state!=='confirm'||!s.cred)throw Error('请先完成获取并核对小号')
      saving=true
      try {
        const account=await identify(s.cred,s.controller.signal);assertLive(s);rejectOwner(account)
        if(account.mid!==s.account.mid)throw Error('账号身份已变化，请重新获取并确认')
        const saved=await writer(s.cred,{signal:s.controller.signal,check:()=>{assertLive(s);rejectOwner(account)}})
        let warning=saved.warn
        if(!saveCredentials)try{persistIdentity(saved)}catch{warning='登录态已保存，但账号显示信息未更新；请重新读取或检查配置权限。'}
        clear();return {state:'saved',account:{...saved,...(warning?{warn:warning}:{})}}
      }finally{saving=false}
    },
    async cancel(id){if(id===undefined||session?.id===id)clear();return {state:'cancelled'}},
    async status(){if(!fs.existsSync(credentialsFile))return {state:'missing'};let cred;try{cred=JSON.parse(fs.readFileSync(credentialsFile,'utf8'))}catch{throw Error('本地登录态损坏，请重新获取')};return {state:'verified',account:await identify(cred)}},
    dispose(){disposed=true;clear()},
  }
}

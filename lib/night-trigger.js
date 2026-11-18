import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {makePlan,historyOf,occurrences,maxWakes,dayOf} from '../tools/lib/night-plan.mjs'
import {acquireProcessLock} from '../tools/lib/process-lock.mjs'
import {readSchedulerHealth} from './scheduler-health.js'
import {readDeliveries} from './delivery-state.js'

export const planRequestId=st=>`bili-whale-wake:${st.windowKey}:${st.atMs}:${st.action}`
export const triggerFile=home=>path.join(home,'whale-night-trigger.json')
export function readNightTrigger(home){
  try{return JSON.parse(fs.readFileSync(triggerFile(home),'utf8'))}
  catch(e){if(e.code==='ENOENT')return null;throw Error('手动触发记录无法读取：'+e.message)}
}
function save(home,value){
  const file=triggerFile(home),temp=file+'.'+crypto.randomUUID()+'.tmp'
  fs.mkdirSync(home,{recursive:true})
  try{fs.writeFileSync(temp,JSON.stringify(value),{mode:0o600});fs.renameSync(temp,file)}finally{fs.rmSync(temp,{force:true})}
}
async function locked(home,fn){
  let release
  for(let i=0;i<20;i++){
    try{release=await acquireProcessLock(triggerFile(home));break}catch(e){if(i===19)throw e;await delay(50)}
  }
  try{return fn()}finally{await release()}
}
export function previewNightTrigger(night,state={},now=Date.now(),random=Math.random){
  const plan=makePlan(night,state,now,random),history=historyOf(state,now)
  if(!['wake','skip'].includes(plan.action))throw Error('没有可触发计划：'+(plan.reason??'今日额度已用完'))
  const occurrence=occurrences(night,now).find(w=>w.key===plan.windowKey&&w.startsAt<=now)
  if(!occurrence)throw Error('当前不在该计划的作息窗口内，不能提前到窗口外')
  if(history.wakes>=maxWakes(night)||(history.usedCount[occurrence.key]??0)>=occurrence.wakes)throw Error('当前窗口或今日机会已用完')
  const atMs=now+5000,last=Date.parse(history.wokeAt??'')
  const gap=Math.max(60_000,(Number.isFinite(Number(night.minGapMin))?Number(night.minGapMin):10)*60000)
  if(Number.isFinite(last)&&atMs<last+gap)throw Error('距离上一轮太近，仍需遵守最小唤醒间隔')
  if(atMs>=occurrence.endsAt)throw Error('窗口即将结束，已放不下本次触发')
  const d=new Date(atMs)
  return {...plan,atMs,at:d.getHours()*60+d.getMinutes(),atText:`${dayOf(atMs)} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`}
}
function validate(home,snapshot,now,random){
  if(snapshot.paused)throw Error('主动活动已暂停，不能手动触发')
  const current=snapshot.state??{}
  const existing=readDeliveries(home).find(r=>r.requestId===planRequestId(current))
  if(!current.fired&&existing&&['dispatching','unconfirmed','accepted'].includes(existing.status))throw Error('当前计划已经提交或结果未确认，请先核查宿主，不得改时间重发')
  return previewNightTrigger(snapshot.night,current,now,random)
}
export async function requestNightTrigger(home,{getSnapshot,dry=false,now=Date.now,random=Math.random}){
  const prepare=()=>{
    const health=readSchedulerHealth(home),time=now(),snapshot=getSnapshot()
    if(health?.activeRun)throw Error('唤醒轮次仍在进行中；若已卡住，请先重启宿主并检查运行概览')
    if(!dry&&health?.lastReason==='sessionController-missing')throw Error('宿主缺少会话投递接口，暂不能接受手动触发')
    if(!dry&&(!health?.instanceId||health.status==='stopped'||!health.lastTickAt||time-health.lastTickAt>150_000))throw Error('没有近期运行中的调度器，请先启动或重启宿主')
    const prior=readNightTrigger(home)
    if(prior?.status==='pending'&&prior.instanceId===health?.instanceId&&prior.expiresAt>=time||prior?.status==='applied'&&!snapshot.state?.fired&&snapshot.state?.manualTrigger?.id===prior.id)throw Error('已有手动触发待处理，不重复排队')
    const plan=validate(home,snapshot,time,random)
    if(dry)return {ok:true,dry:true,plan,hostAvailable:!!health?.lastTickAt,note:'仅预览，不修改文件；--go 后由宿主再次校验并设置五秒后的时间'}
    const request={schema:1,id:crypto.randomUUID(),status:'pending',instanceId:health.instanceId,requestedAt:time,expiresAt:time+120_000}
    save(home,request)
    return {ok:true,dry:false,request,preview:plan,note:'已排队给宿主；night status 查看 applied/rejected。不会直接调用模型或 B 站。'}
  }
  return dry?prepare():locked(home,prepare)
}
export async function consumeNightTrigger(home,{instanceId,getSnapshot,writeState,check,now=Date.now}){
  if(readNightTrigger(home)?.status!=='pending')return null
  return locked(home,()=>{
    check()
    const request=readNightTrigger(home)
    if(request?.status!=='pending')return null
    try{
      const time=now(),snapshot=getSnapshot()
      if(request.schema!==1||!request.id||request.instanceId!==instanceId)throw Error('宿主已更换，旧手动请求不会自动执行；请重新预览')
      if(!Number.isFinite(request.expiresAt)||time>request.expiresAt)throw Error('手动请求已过期，请重新预览')
      if(snapshot.state?.manualTrigger?.id===request.id){
        const result={...request,status:'applied',appliedAt:time,atMs:snapshot.state.atMs};save(home,result);return result
      }
      const plan=validate(home,snapshot,time)
      plan.manualTrigger={id:request.id,requestedAt:request.requestedAt,appliedAt:time,previousAtMs:snapshot.state?.atMs??null}
      check();writeState(plan)
      const result={...request,status:'applied',appliedAt:time,atMs:plan.atMs,action:plan.action};save(home,result);return result
    }catch(e){
      check()
      const result={...request,status:'rejected',resolvedAt:now(),error:e.message};save(home,result);return result
    }
  })
}

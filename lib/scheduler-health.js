import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export function readSchedulerHealth(dshHome){
  try{
    const value=JSON.parse(fs.readFileSync(path.join(dshHome,'whale-scheduler.json'),'utf8'))
    if(value.schema!==1||!value.instanceId||!Array.isArray(value.recent))throw Error('invalid schema')
    return value
  }catch(e){if(e.code==='ENOENT')return null;return {error:'调度诊断文件无法读取：'+e.message}}
}
export function createSchedulerHealth(dshHome,{now=Date.now,log=()=>{}}={}){
  const file=path.join(dshHome,'whale-scheduler.json'),throttled=new Map()
  const state={schema:1,instanceId:crypto.randomUUID(),pid:process.pid,startedAt:now(),lastTickAt:0,status:'starting',activeRun:null,recent:[],lastError:null,
    runtime:{node:process.versions.node,electron:process.versions.electron??null,abortSignalAny:typeof AbortSignal.any==='function'}}
  const output=text=>{try{log(text)}catch{}}
  function save(){
    const temp=file+'.'+crypto.randomUUID()+'.tmp'
    try{fs.mkdirSync(dshHome,{recursive:true});fs.writeFileSync(temp,JSON.stringify(state),{mode:0o600});fs.renameSync(temp,file)}
    catch(e){output('[bili-whale] 保存调度诊断失败：'+e.message)}
    finally{try{fs.rmSync(temp,{force:true})}catch{}}
  }
  save()
  return {state,
    started(){state.status='waiting';state.timersRegisteredAt=now();save()},
    failed(error){
      state.status='startup-failed'
      state.lastError={at:now(),stage:'startup',message:String(error?.message??error).slice(0,2000),code:error?.code??null}
      save()
    },
    tick(){state.lastTickAt=now();if(state.status==='waiting')state.status='idle';save()},
    note(kind,reason,details={},throttle=false){
      state.lastReason=reason
      const key=kind+':'+reason,last=throttled.get(key)
      if(throttle&&last!==undefined&&now()-last<300_000)return false
      if(!throttle||last===undefined||now()-last>=300_000){
        throttled.set(key,now())
        state.recent.push({at:now(),kind,reason,...details});state.recent=state.recent.slice(-5)
        output('[bili-whale] '+kind+' reason='+reason+(details.error?' · '+details.error:''))
      }
      save();return true
    },
    change(lease,status,error){
      state.status=status
      state.activeRun=status==='running'?{id:lease.id,startedAt:lease.startedAt,stage:lease.stage,requestId:lease.requestId??null}:null
      if(error)state.lastError={at:now(),stage:lease.stage,message:String(error.message??error),code:error.code??null}
      else if(status==='running'&&lease.stage==='completed'){state.lastError=null;state.lastReason='completed'}
      if(status==='released')state.lastReleased={id:lease.id,at:now(),stage:lease.stage,code:error?.code}
      save()
    },
    stop(){state.status='stopped';state.activeRun=null;save()},
  }
}

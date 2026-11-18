import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {readDeliveries} from '../../lib/delivery-state.js'

const key=parts=>crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0,24)
const boundedRead=file=>{const s=fs.lstatSync(file);if(s.isSymbolicLink()||!s.isFile()||s.size>128000)throw Error('会话状态文件无效');return JSON.parse(fs.readFileSync(file,'utf8'))}
export function sessionAudit(dshHome,cfg){
 const root=fs.realpathSync(dshHome),deliveries=readDeliveries(root),account=String(cfg.self?.mid??''),owner=String(cfg.owner?.mid??'')
 if(!account||!owner)throw Error('会话维护需要明确账号与主人')
 const active=new Set([key([account,owner,'private-main','main']),key([account,owner,2,'browse-main','main','main'])])
 const records=fs.readdirSync(root).filter(n=>/^whale-session-[a-f0-9]{24}\.json$/.test(n)).map(name=>{
  const file=path.join(root,name),s=boundedRead(file),scope=name.slice(14,-5)
  const refs=deliveries.filter(d=>d.sessionId===s.id||d.scopeKey===scope)
  const protectedReason=active.has(scope)||['private-main','browse-main'].includes(s.sessionRole)?'active-role':s.pendingRequest?'pending-request':refs.some(d=>d.retained||['dispatching','unconfirmed'].includes(d.status))?'unconfirmed-delivery':null
  return {name,id:s.id,role:s.sessionRole??null,deliveredAt:s.deliveredAt??s.startedAt??0,protectedReason,latestDelivery:refs.sort((a,b)=>b.startedAt-a.startedAt)[0]??null}
 })
 return {records,notes:'accepted 仅表示宿主接受投递，不证明会话消息已持久化或工具执行完成；用 latestDelivery.sessionId 与宿主实际会话对照。'}
}
// Archive plugin-owned pointers only. Host sessions and workspaces are never removed.
// Stop the plugin before --apply so no new request races the maintenance snapshot.
export function cleanupSessions(dshHome,cfg,{keep=3,apply=false,now=Date.now}={}){
 if(!Number.isInteger(keep)||keep<0||keep>100)throw Error('keep 需要是 0–100 的整数')
 const audit=sessionAudit(dshHome,cfg),stale=audit.records.filter(r=>!r.protectedReason).sort((a,b)=>b.deliveredAt-a.deliveredAt),selected=stale.slice(keep)
 const root=fs.realpathSync(dshHome),archive=path.join(root,'whale-session-archive',String(now())+'-'+crypto.randomUUID())
 const base=path.join(root,'whale-session-archive')
 if(fs.existsSync(base)&&fs.lstatSync(base).isSymbolicLink())throw Error('会话归档目录不能是链接')
 if(apply&&selected.length){
  fs.mkdirSync(archive,{recursive:true})
  for(const item of selected){
   const fresh=sessionAudit(root,cfg).records.find(r=>r.name===item.name)
   if(!fresh||fresh.protectedReason||fresh.id!==item.id||fresh.deliveredAt!==item.deliveredAt)throw Error('维护期间会话状态变化，停止归档')
   fs.renameSync(path.join(root,item.name),path.join(archive,item.name))
  }
 }
 return {dryRun:!apply,keep,selected:selected.map(r=>r.name),protected:audit.records.filter(r=>r.protectedReason),archive:apply&&selected.length?archive:null,hostSessionsRemoved:0}
}

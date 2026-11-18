import crypto from 'node:crypto'
import {createSessionDelivery} from './session-delivery.js'
import {assertScene} from '../tools/lib/memory-context.mjs'

const hash=parts=>crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0,24)
export function legacyScopeKeys(account,owner,scene,taskId){
 const privateScene=scene.startsWith('private-'),volatile=scene==='reply'
 return [...new Set([
  hash([account,owner,privateScene?'private-main':scene,privateScene?'main':taskId]),
  hash([account,owner,privateScene?'private-main':volatile?taskId:scene,privateScene?'main':volatile?taskId:'main'])
 ])]
}
// Routing metadata is trusted adapter input, never inferred from message text.
export function createScopedDelivery(options){
 const routes=new Map()
 function route(scene,taskId,role){
  assertScene(scene)
  const cfg=options.config(),account=String(cfg.self?.mid??''),owner=String(cfg.owner?.mid??'')
  if(!account||!owner)throw Error('会话需要明确账号和主人')
  role??=scene.startsWith('private-')?'private-main':'public-task'
  if(!['private-main','browse-main','public-task'].includes(role)||role==='private-main'&&!scene.startsWith('private-')||role==='browse-main'&&scene!=='public-recommendation'||role==='public-task'&&scene.startsWith('private-'))throw Error('会话角色与场景不一致')
  // Retain the verified private-main namespace; new roles use schema 2 keys.
  const key=role==='private-main'?hash([account,owner,'private-main','main']):hash([account,owner,2,role,role==='browse-main'?'main':scene,role==='browse-main'?'main':taskId])
  const legacy=role==='browse-main'?['public-recommendation','private-recommendation'].flatMap(s=>legacyScopeKeys(account,owner,s,taskId)):legacyScopeKeys(account,owner,scene,taskId)
  const checkIdentity=()=>{const current=options.config();if(String(current.self?.mid??'')!==account||String(current.owner?.mid??'')!==owner)throw Error('排队期间账号或主人变化，停止旧任务');return current}
  if(!routes.has(key))routes.set(key,createSessionDelivery({...options,sessionRole:role,scopeKey:key,config:checkIdentity,memoryContext:r=>{checkIdentity();return options.memoryContext?.(r)??''},sessionId:crypto.randomUUID(),sessionFile:'whale-session-'+key+'.json',contextGeneration:()=>{checkIdentity();return options.contextGeneration?.()??options.permissionVersion?.()??0}}))
  return {delivery:routes.get(key),role,legacy}
 }
 return {
  send(request,signal,flags){
   const {memoryScene,sessionRole,taskKind,memoryQuery,sourceEventIds,...hostRequest}=request
   const r=route(memoryScene,hostRequest.requestId,sessionRole)
   return r.delivery.send(hostRequest,signal,{...flags,memoryScene,sessionRole:r.role,taskKind,memoryQuery,sourceEventIds,compatibleScopeKeys:r.legacy})
  },
  async confirm(id){for(const r of routes.values())await r.confirm(id)},
 }
}

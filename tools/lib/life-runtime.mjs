import { config } from './config.mjs'
import { createLifeStore } from './life-store.mjs'
export function lifeStore(cfg=config(),extra={}) {
  return createLifeStore({account:String(cfg.self?.mid??''),owner:String(cfg.owner?.mid??''),ownerName:String(cfg.owner?.name??''),config:cfg.life,fullConfig:()=>config({fresh:true}),...extra})
}
export const threadKey=(type,oid,root)=>[String(type??1),String(oid),String(root||'top')].join(':')
export async function guardSend(request,{dry=false}={}) {
  const store=lifeStore()
  // Preferences are evaluated inside reserve as well; a concurrent approval
  // must not leave a check-to-send bypass window.
  request.ownerName=String(config().owner?.name??'')
  const result=store.check(request)
  if(!result.allow)throw Error(result.reason)
  if(dry)return {store,token:null}
  return {store,token:await store.reserve(request)}
}

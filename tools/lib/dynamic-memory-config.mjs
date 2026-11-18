export const TEMPORAL_KINDS=['current_state','recent_pattern','stable_preference','episodic','commitment','understanding']
export const DYNAMIC_DEFAULTS=Object.freeze({enabled:true,shadow:false,useWindowSec:3600,maxUseBoost:0.2,catalogLimit:20,fetchBytes:4096,taskFetchBytes:16384,autoDelete:true,
 halfLives:{current_state:21600,recent_pattern:259200,stable_preference:2592000,episodic:1209600,commitment:604800,understanding:2592000}})
export function dynamicConfig(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('dynamicMemory 必须为对象')
 for(const key of Object.keys(input))if(!Object.hasOwn(DYNAMIC_DEFAULTS,key))throw Error('未知 dynamicMemory 配置：'+key)
 const c={...DYNAMIC_DEFAULTS,...input,halfLives:{...DYNAMIC_DEFAULTS.halfLives,...input.halfLives}}
 for(const k of ['enabled','shadow','autoDelete'])if(typeof c[k]!=='boolean')throw Error('dynamicMemory.'+k+' 必须为布尔值')
 for(const [k,min,max] of [['useWindowSec',60,86400],['catalogLimit',1,50],['fetchBytes',1024,16384],['taskFetchBytes',1024,65536]])if(!Number.isInteger(c[k])||c[k]<min||c[k]>max)throw Error('dynamicMemory.'+k+' 超出范围')
 if(!Number.isFinite(c.maxUseBoost)||c.maxUseBoost<0||c.maxUseBoost>0.25)throw Error('使用加分应在 0–0.25 内')
 if(c.taskFetchBytes<c.fetchBytes)throw Error('任务总读取预算不能小于单次预算')
 for(const [k,v] of Object.entries(c.halfLives))if(!TEMPORAL_KINDS.includes(k)||!Number.isInteger(v)||v<3600||v>365*86400)throw Error('halfLives 应为已知类型的秒数，范围 1 小时至 365 天')
 return c
}
export const dynamicActive=cfg=>!!cfg?.enabled&&!cfg?.shadow

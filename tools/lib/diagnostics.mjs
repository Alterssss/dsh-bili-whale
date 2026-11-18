// Never log arbitrary exception text here: it may contain cookies or message bodies.
export function createDiagnostics({emit=message=>console.warn(message),now=Date.now,intervalMs=300000}={}){
  const seen=new Map()
  return (category,error)=>{
    const code=String(error?.code??error?.name??'error').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,60)
    const key=category+':'+code,previous=seen.get(key)
    if(previous!==undefined&&now()-previous<intervalMs)return false
    if(seen.size>=200)seen.delete(seen.keys().next().value)
    seen.set(key,now());try{emit(`[bili-whale] ${category} (${code})`)}catch{/* Diagnostics must not break cleanup. */}
    return true
  }
}
export const diagnose=createDiagnostics()

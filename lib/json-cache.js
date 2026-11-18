import fs from 'node:fs'
// Stat on every access. Atomic replacement and edits invalidate; errors never serve stale data.
export function createJsonCache(){
  const entries=new Map()
  const read=file=>{
    try{
      const st=fs.statSync(file,{bigint:true}),stamp=[st.dev,st.ino,st.size,st.mtimeNs,st.ctimeNs].join(':')
      if(entries.get(file)?.stamp===stamp)return structuredClone(entries.get(file).value)
      const value=JSON.parse(fs.readFileSync(file,'utf8'))
      if(entries.size>=32)entries.delete(entries.keys().next().value)
      entries.set(file,{stamp,value});return structuredClone(value)
    }catch(e){entries.delete(file);throw e}
  }
  return {read,clear:()=>entries.clear()}
}

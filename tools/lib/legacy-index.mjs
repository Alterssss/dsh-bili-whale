import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
// Cache only identifiers, never inject legacy narrative into the model prompt.
export function legacyVideoIndex(file,cacheDir) {
  let stat;try{stat=fs.statSync(file)}catch(e){if(e.code==='ENOENT')return {seen:[],preferences:[]};throw e}
  const cache=path.join(cacheDir,'legacy-index-'+crypto.createHash('sha256').update(path.resolve(file)).digest('hex')+'.json')
  try{const hit=JSON.parse(fs.readFileSync(cache,'utf8'));if(hit.size===stat.size&&hit.mtime===stat.mtimeMs)return hit}catch{}
  const raw=fs.readFileSync(file,'utf8'),line=raw.match(/^-\s*\*\*爱看\*\*：(.+)$/m)?.[1]
  const value={size:stat.size,mtime:stat.mtimeMs,seen:[...new Set([...raw.matchAll(/\bBV[0-9A-Za-z]{10}\b/g)].map(m=>m[0]))],preferences:line?line.split(/[·、,，]/).map(s=>s.trim()).filter(Boolean):[]}
  fs.mkdirSync(cacheDir,{recursive:true});const tmp=cache+'.'+crypto.randomUUID()+'.tmp'
  try{fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600});fs.renameSync(tmp,cache)}finally{fs.rmSync(tmp,{force:true})}
  return value
}

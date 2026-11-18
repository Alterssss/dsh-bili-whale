import fs from 'node:fs'
import path from 'node:path'
import { fingerprint,archiveDigest } from './life-store.mjs'
// Explicit, idempotent snapshot: legacy narratives never become verified facts.
export async function migrateLegacy(store,dshHome,{dryRun=false}={}) {
  const result=[]
  for(const name of ['whale-diary.md','whale-diary-private.md','whale-log.jsonl']){
    const file=path.join(dshHome,name)
    if(!fs.existsSync(file))continue
    const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024)throw Error('旧来源不是普通文件或超过迁移上限')
    const raw=fs.readFileSync(file,'utf8'),digest=archiveDigest(raw)
    if(store.read().settings['legacy:'+name]===digest)continue
    if(dryRun){result.push({name,characters:raw.length,digest,unverified:true,action:'snapshot-import',dryRun:true});continue}
    const events=[]
    for(let i=0;i<raw.length;i+=10000)events.push({id:'legacy-'+digest+'-'+i,at:Date.now(),kind:'legacy-narrative',text:raw.slice(i,i+10000),origin:'legacy-unverified',data:{visibility:'private',file:name}})
    await store.tx(s=>{
      const archiveName='legacy-'+digest+'.json',dir=path.join(store.dir,'archive')
      fs.mkdirSync(dir,{recursive:true})
      const content=JSON.stringify({version:1,events})
      const archiveFile=path.join(dir,archiveName)
      if(!fs.existsSync(archiveFile))fs.writeFileSync(archiveFile,content,{flag:'wx',mode:0o600})
      if(!s.archives.some(a=>a.name===archiveName))s.archives.push({name:archiveName,digest:archiveDigest(content),count:events.length,from:Date.now(),to:Date.now()})
      s.settings['legacy:'+name]=digest
    })
    result.push({name,characters:raw.length,unverified:true})
  }
  return result
}

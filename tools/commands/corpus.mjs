import fs from 'node:fs'
import path from 'node:path'
import {lifeStore} from '../lib/life-runtime.mjs'
import {corpusFor,styleContext} from '../lib/corpus-runtime.mjs'
const [cmd,arg,...rest]=process.argv.slice(2),store=lifeStore(),library=corpusFor(store)
const output=v=>console.log(JSON.stringify(v,null,2))
const option=(name,fallback)=>{const i=rest.indexOf('--'+name);return i<0?fallback:rest[i+1]}
try{
 if(cmd==='status')output(library.status())
 else if(cmd==='list')output(library.list({status:arg||'pending',offset:option('offset',0),limit:option('limit',20)}))
 else if(cmd==='import'){
   if(!arg)throw Error('需要 CSV 文件或目录')
   const files=fs.statSync(arg).isDirectory()?fs.readdirSync(arg).filter(n=>n.toLowerCase().endsWith('.csv')).sort().map(n=>path.join(arg,n)):[arg]
   if(!files.length||files.length>50)throw Error('目录需要 1–50 份 CSV')
   const results=[];for(const file of files)results.push(await library.importCSV(file))
   output({results,status:library.status()})
 }
 else if(cmd==='retrieve'){
   if(!arg||fs.statSync(arg).size>128000)throw Error('需要不超过128 KB的检索 JSON 文件')
   const plan=styleContext(store,JSON.parse(fs.readFileSync(arg,'utf8')));if(plan.library)await plan.library.recordSelection(plan)
   const {library:unused,...result}=plan;output(result)
 }
 else if(cmd==='export')output(library.export())
 else if(cmd==='split')output(library.split())
 else {console.log('corpus: status | import <CSV或目录> | list [pending|quarantined|approved|rejected] [--offset N --limit N] | retrieve <JSON> | export | split\n导入不会自动审核或写入记忆；批准、拒绝和撤销在设置页完成。');if(cmd)process.exitCode=2}
}catch(e){console.error(e.message);process.exitCode=2}

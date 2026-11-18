import fs from 'node:fs'
import path from 'node:path'
import {configPath} from '../lib/paths.mjs'
import {atomicWriteJson} from '../lib/life-persistence.mjs'
import {acquireProcessLock} from '../lib/process-lock.mjs'
import {pipelineConfig,PIPELINE_DEFAULTS} from '../local/pipeline-config.mjs'
const [action='show',key,value]=process.argv.slice(2)
try{
 if(action==='show')console.log(JSON.stringify(pipelineConfig(),null,2))
 else if(action==='set'){
  if(!Object.hasOwn(PIPELINE_DEFAULTS,key)||value===undefined)throw Error('用法：config set <pipeline字段> <JSON值>')
  const parsed=JSON.parse(value);fs.mkdirSync(path.dirname(configPath),{recursive:true});const release=await acquireProcessLock(configPath)
  try{let current={};try{current=JSON.parse(fs.readFileSync(configPath,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
   const next={...current,pipeline:{...current.pipeline,[key]:parsed}};pipelineConfig(next);atomicWriteJson(configPath,next);console.log('已保存 pipeline.'+key)
  }finally{await release()}
 }else throw Error('用法：config show | config set <pipeline字段> <JSON值>')
}catch(e){console.error(e.message);process.exitCode=2}

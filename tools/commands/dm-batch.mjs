import fs from 'node:fs'
import {execFile} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {NODE_EXE} from '../lib/nodebin.mjs'
import {config} from '../lib/config.mjs'
import {lifeStore} from '../lib/life-runtime.mjs'
import {parseMessages,createBatch,sendBatch,cancelBatch} from '../lib/dm-batch.mjs'
import {chatConfig} from '../lib/chat-config.mjs'
const args=new Map(),argv=process.argv.slice(2)
for(let i=0;i<argv.length;i++)if(argv[i].startsWith('--'))args.set(argv[i].slice(2),argv[i+1]&&!argv[i+1].startsWith('--')?argv[++i]:true)
const cfg=config(),store=lifeStore(),controller=new AbortController()
process.once('SIGTERM',()=>controller.abort());process.once('SIGINT',()=>controller.abort())
const run=(args,signal)=>new Promise(resolve=>execFile(NODE_EXE,[fileURLToPath(new URL('./dm.mjs',import.meta.url)),...args.slice(1)],{env:process.env,windowsHide:true,timeout:240000,signal},(err,out,stderr)=>resolve({ok:!err,out,err:stderr})))
try{
  if(args.has('status')){console.log(JSON.stringify(store.read().settings.dmBatches??[],null,2))}
  else if(args.has('cancel'))console.log(JSON.stringify(await cancelBatch(store,String(args.get('cancel'))),null,2))
  else{
    if(!args.has('dry')&&!args.has('go'))throw Error('必须 --dry 或 --go')
    if(args.has('file')===args.has('resume'))throw Error('使用 --file 正文.json 或 --resume 组ID 二选一')
    let batch
    if(args.has('file')){
      const input=JSON.parse(fs.readFileSync(String(args.get('file')),'utf8')),c=chatConfig(cfg.chat)
      const messages=parseMessages(input,c.multi?c.maxParts:1)
      if(args.has('dry'))console.log(JSON.stringify({messages,preview:true,note:'未创建草稿或发送；正式发送逐条重新预检'},null,2))
      else batch=await createBatch(store,messages,{config:cfg,taskId:typeof args.get('task')==='string'?args.get('task'):null})
    }else{
      batch=(store.read().settings.dmBatches??[]).find(x=>x.id===String(args.get('resume')))
      if(!batch)throw Error('发送组不存在')
      if(args.has('dry'))console.log(JSON.stringify(batch,null,2))
    }
    if(batch&&!args.has('dry')){
      console.log('发送组 '+batch.id+'；按配置冷却逐条发出，进度可用 --status 查看')
      console.log(JSON.stringify(await sendBatch(store,batch.id,{run,config:()=>config({fresh:true}),signal:controller.signal}),null,2))
    }
  }
}catch(e){console.error(e.message);process.exitCode=1}

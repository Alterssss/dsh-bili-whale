import fs from 'node:fs'
import path from 'node:path'
import {readMemory} from './legacy-memory-parser.mjs'
import {digest,assertScene,publicScene} from './memory-context.mjs'

export const LEGACY_NAMES=['whale-diary.md','whale-diary-private.md','whale-log.jsonl']
function readFile(home,name){
  if(!LEGACY_NAMES.includes(name))throw Error('未授权来源')
  const file=path.join(home,name),stat=fs.lstatSync(file)
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024)throw Error('来源不是普通文件或超过 16 MiB 上限')
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0))
  try{const opened=fs.fstatSync(fd);if(!opened.isFile()||opened.size>16*1024*1024)throw Error('来源变化');const bytes=fs.readFileSync(fd);new TextDecoder('utf-8',{fatal:true}).decode(bytes);return bytes}finally{fs.closeSync(fd)}
}
function allowed(bindings,scene){assertScene(scene);return LEGACY_NAMES.filter(name=>bindings[name]&&(!publicScene(scene)||bindings[name].visibility==='public'))}
export function legacyRecall(home,bindings,scene,query={}) {
  const names=allowed(bindings,scene),versions={},diagnostics=[]
  for(const name of names)try{versions[name]=digest(readFile(home,name))}catch(e){diagnostics.push({source:name,status:e.code==='ENOENT'?'missing':'unreadable',detail:e.message})}
  const filter={date:query.date,bv:query.bv,keyword:query.keyword},key=digest({scene,filter,versions,bindings})
  let offset=0
  if(query.cursor){let c;try{c=JSON.parse(Buffer.from(query.cursor,'base64url').toString('utf8'))}catch{throw Error('回溯游标无效')};if(c.key!==key)throw Error('来源、查询或权限变化，请从第一页重新回溯');offset=c.offset}
  const result=readMemory(home,{...filter,mode:'recall',includePrivate:!publicScene(scene),offset,allowedSources:Object.keys(versions)})
  for(const name of Object.keys(versions))if(digest(readFile(home,name))!==versions[name])throw Error('读取期间来源发生变化，请重新回溯')
  return {...result,scope:scene,diagnostics:[...diagnostics,...result.diagnostics],records:result.records.map(r=>({...r,authority:'legacy_unverified',sourceRef:{fileId:r.source,fileVersion:versions[r.source],byteRange:r.range,passageHash:digest(r.text),status:'exact'}})),cursor:result.nextOffset===null?null:Buffer.from(JSON.stringify({key,offset:result.nextOffset})).toString('base64url')}
}
export function legacySource(home,bindings,scene,ref){
  if(!allowed(bindings,scene).includes(ref?.fileId))return null
  let bytes;try{bytes=readFile(home,ref.fileId)}catch(e){return {status:'missing'}}
  const {start,end}=ref.byteRange??{}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end-start>16000||end>bytes.length)throw Error('来源范围无效')
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(start,end)),version=digest(bytes)
  if(digest(text)!==ref.passageHash)return {status:'superseded',fileVersion:version}
  return {status:version===ref.fileVersion?'exact':'drifted',text,fileVersion:version,authority:'legacy_unverified'}
}

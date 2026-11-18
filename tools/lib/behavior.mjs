import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
export const BEHAVIOR_ROOT=fileURLToPath(new URL('../../behavior/',import.meta.url))
export const BEHAVIOR_IDS=['common','private-reply','private-recommendation','public-comment','public-reply','browse','diary','formation','memory','stickers','tools']
export function loadBehavior(ids,{root=BEHAVIOR_ROOT}={}){
 return [...new Set(ids)].map(id=>{
  if(!BEHAVIOR_IDS.includes(id))throw Error('未知规范章节')
  const file=path.join(root,id+'.md')
  return {id,text:fs.readFileSync(file,'utf8'),path:file}
 })
}
export function behaviorSections(scene,role){
 const section=role==='browse-main'?'browse':({'private-reply':'private-reply','private-recommendation':'private-recommendation','public-comment':'public-comment','reply':'public-reply','public-recommendation':'public-comment'}[scene])
 if(!section)throw Error('未知规范场景')
 return ['common',section]
}

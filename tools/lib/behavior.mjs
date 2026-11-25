import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
export const BEHAVIOR_ROOT=fileURLToPath(new URL('../../behavior/',import.meta.url))
export const BEHAVIOR_IDS=['common','private-reply','private-recommendation','public-comment','public-reply','browse','diary','formation','memory','stickers','tools']

// stripTitle   : 去掉首行的 `# 标题`。拼进提示词时外面已经有 `［规范 <id>］` 标签，
//                标题再出现一遍就是重复；`behavior read` 这种给人看的输出不该用这个开关。
// stripComments: 去掉 HTML 注释。注释是写给读文件的人/工具看的，不该进提示词。
function tidy(text,{stripTitle,stripComments}) {
  let out=text
  if(stripComments)out=out.replace(/<!--[\s\S]*?-->/g,'')
  if(stripTitle)out=out.replace(/^\s*#[^\n]*(\n|$)/,'')
  return stripComments||stripTitle ? out.trim() : out
}

export function loadBehavior(ids,{root=BEHAVIOR_ROOT,stripTitle=false,stripComments=false}={}){
 return [...new Set(ids)].map(id=>{
  if(!BEHAVIOR_IDS.includes(id))throw Error('未知规范章节')
  const file=path.join(root,id+'.md')
  const raw=fs.readFileSync(file,'utf8')
  return {id,text:tidy(raw,{stripTitle,stripComments}),path:file}
 })
}
export function behaviorSections(scene,role){
 const section=role==='browse-main'?'browse':({'private-reply':'private-reply','private-recommendation':'private-recommendation','public-comment':'public-comment','reply':'public-reply','public-recommendation':'public-comment'}[scene])
 if(!section)throw Error('未知规范场景')
 return ['common',section]
}

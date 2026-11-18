import fs from 'node:fs'
const promptSpec=JSON.parse(fs.readFileSync(new URL('../prompts/expression-v1.json',import.meta.url),'utf8'))
import { fingerprint } from './life-store.mjs'
import crypto from 'node:crypto'
import {freezeDelivery} from './expression-delivery.mjs'
import {assertHard,hardPolicyPrompt} from './expression-hard.mjs'
import {prepareStyle,styleWarnings} from './corpus-runtime.mjs'
import {lifeConfig} from './life-config.mjs'
import {loadBehavior} from './behavior.mjs'
export {checkHard,hardMessage} from './expression-hard.mjs'
const scenes=new Set(['private-recommendation','public-comment','reply','private-reply'])
export function normalizeExpression(value) {
  // Preserve literal code, punctuation and emoticons; only repair transport artifacts.
  return String(value??'').replace(/\r\n/g,'\n').trim()
}
export function expressionPrompt(scene,mode='direct',policy=lifeConfig()) {
  if(!scenes.has(scene))throw Error('未知表达场景')
  if(!promptSpec.modes[mode])throw Error('未知草稿方式')
  return [scene==='public-comment'?loadBehavior(['public-comment'])[0].text:promptSpec.scenes[scene],...(scene==='public-comment'?[]:promptSpec.common),...(promptSpec.sceneHints?.[scene]??[]),
    policy.requireDraft?'本次 requireDraft=true：expression prepare→必要时revise一次→finalize；使用返回draftId --dry再--go。':'本次 requireDraft=false：可直接发送或使用草稿；先--dry再--go。',
    promptSpec.modes[mode],...((policy.hardMode??'enforce')!=='off'&&(policy.hardScenes??['public-comment']).includes(scene)?[hardPolicyPrompt(scene,policy)]:[])].join('\n')
}
export async function prepareExpression(store,input) {
  const scene=input.scene;if(!scenes.has(scene))throw Error('需要明确表达场景')
  if(input.channel!==undefined&&(input.channel!=='dynamic'||scene!=='public-comment'))throw Error('无效草稿通道')
  const text=normalizeExpression(input.text)
  if(!text||text.length>16000)throw Error('候选为空或超出存储上限')
  const style=prepareStyle(store,input)
  return store.tx(s=>{
    const sourceIds=input.sourceIds??[]
    if(!Array.isArray(sourceIds)||sourceIds.length>20)throw Error('来源列表无效')
    const refs=sourceIds.map(id=>s.events.find(e=>e.id===id));if(refs.some(e=>!e))throw Error('来源不存在，请先检索')
    const claims=input.claims??[]
    if(!Array.isArray(claims)||claims.length>20)throw Error('依据条目无效')
    for(const c of claims){const source=refs.find(r=>r.id===c.sourceId);if(!source||!c.quote||!source.text.includes(c.quote))throw Error('依据引用不在来源中')}
    if(s.drafts.filter(d=>d.status==='pending'||d.status==='editing').length>=100)throw Error('请先处理已有草稿')
    if(input.taskId&&!s.cognition?.traces.some(t=>t.taskId===input.taskId&&(t.scene===scene||t.sessionRole==='browse-main'&&t.scene==='public-recommendation'&&t.allowedExpressionScenes?.includes(scene))))throw Error('taskId 未准备本场景上下文')
    const d={taskId:input.taskId??null,policyRevision:s.settings.policyRevision??0,id:crypto.randomUUID(),at:store.now(),scene,text,original:text,target:String(input.target??''),thread:String(input.thread??''),parent:String(input.parent??''),share:input.share??null,video:String(input.video??''),referer:String(input.referer??''),sourceIds,claims,...style,edits:0,status:'editing'}
    if(input.channel)d.channel=input.channel
    if(d.share!==null&&typeof d.share!=='boolean')throw Error('share 必须是布尔值')
    if(!d.target)throw Error('需要草稿目标')
    s.drafts.push(d);return d
  })
}
export function editExpression(store,draftId,text) {return store.tx(s=>{
  const d=s.drafts.find(x=>x.id===draftId);if(!d||d.status!=='editing'||d.edits>=1)throw Error('草稿最多编辑一次；不合适请选择放弃')
  text=normalizeExpression(text);if(!text||text.length>16000)throw Error('修改内容无效')
  d.text=text;d.edits++;return d
})}
export function finalizeExpression(store,draftId,{discard=false}={}) {return store.tx(s=>{
  const d=s.drafts.find(x=>x.id===draftId);if(!d||d.status!=='editing')throw Error('草稿不存在或已结束')
  if(!discard){
    d.delivery=freezeDelivery(d,store.identity)
    const text=d.share===true?d.delivery.shareText??d.text:d.text
    d.hardCheck=assertHard(text,d.scene,store.policy)
  }
  d.status=discard?'discarded':'pending';d.hash=fingerprint(d.text)
  d.warnings=[]
  if(!discard)d.warnings.push(...styleWarnings(store,d))
  if(d.hardCheck)d.warnings.push(...d.hardCheck.warnings.map(w=>w.hint))
  if(/\*\*|&#\d+;|&(?:lt|gt|amp);/.test(d.text))d.warnings.push('检查是否包含意外格式；代码与引用可保留')
  if(/^@/.test(d.text)&&d.scene==='public-comment')d.warnings.push('确认公开提及是有意的，不要误用私人推荐')
  const recent=s.events.filter(e=>e.kind==='sent').slice(-20)
  if(recent.some(e=>e.hash===d.hash))d.warnings.push('近期发送过相同文本')
  return d
})}

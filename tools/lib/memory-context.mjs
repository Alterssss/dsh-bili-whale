import {contextScore} from './context-relevance.mjs'
import {workingSegments} from './cognition.mjs'
import crypto from 'node:crypto'

import {SCENES,publicScene,assertScene,visible} from './memory-scope.mjs'
export {SCENES,publicScene,assertScene,visible} from './memory-scope.mjs'
import {rankMemories} from './memory-lifecycle.mjs'
import {DYNAMIC_DEFAULTS,dynamicActive} from './dynamic-memory-config.mjs'
export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
export function applicable(m, scene, at) {
  if (!m.active || m.lifecycle?.validity==='disputed' || m.status==='disputed' || m.recallEnabled === false || (m.expiresAt && m.expiresAt <= at) || !visible(m,scene)) return false
  if (Array.isArray(m.scope?.scenes)&&!m.scope.scenes.includes(scene)&&scene!=='private'&&scene!=='public')return false
  if (m.type === 'expression_policy') return m.scope.scenes.includes(scene)
  const scope=m.scope?.scene
  return !scope || scope==='all' || scope===scene || (scope==='public' && publicScene(scene)) || (scope==='private' && !publicScene(scene)) || (scope==='recommend' && scene.includes('recommendation'))
}
export function validatePolicy(input, sourceIds) {
  const p=input.policy
  if(!p || typeof p.defaultBehavior!=='string' || !p.defaultBehavior.trim() || p.defaultBehavior.length>4000 || !Array.isArray(p.exceptions) || p.exceptions.length>10) throw Error('表达策略需要完整默认行为及例外数组')
  if(!Array.isArray(input.scope?.scenes) || !input.scope.scenes.length || input.scope.scenes.some(s=>!SCENES.slice(0,5).includes(s))) throw Error('表达策略需要明确场景')
  for(const x of p.exceptions) if(!x || typeof x.condition!=='string' || !x.condition.trim() || x.condition.length>1000 || typeof x.behavior!=='string' || !x.behavior.trim() || x.behavior.length>2000 || !Array.isArray(x.sourceIds) || !x.sourceIds.length || x.sourceIds.some(id=>!sourceIds.includes(id))) throw Error('例外必须有明确条件、行为及本提案内的真实来源')
  return {defaultBehavior:p.defaultBehavior,exceptions:p.exceptions.map(x=>({condition:x.condition,behavior:x.behavior,sourceIds:[...new Set(x.sourceIds)]}))}
}
// Pure compiler: no filesystem, timestamps, host calls or partial mandatory rows.
// 2026-10-30：给联合验证脚本用（同一入口，不新增逻辑）
export function compileContextBase(s,{query='',scene='private',limit=5000,recent=20,at=Date.now(),selection=null,excludeEventIds=[]}={}) {
  assertScene(scene)
  if(!Number.isInteger(limit)||limit<1||limit>20000)throw Error('上下文预算无效')
  const segments=[],omitted=[],diagnostics=[]
  let used=0,blocked=false
  const add=(kind,text,refs,mandatory=false)=>{
    const cost=Array.from(text).length+(segments.length?1:0)
    if(used+cost>limit){omitted.push({ids:refs.map(r=>r.id),reason:mandatory?'mandatory-over-budget':'budget'});if(mandatory)blocked=true;return}
    segments.push({kind,text,refs,mandatory,hash:digest(text)});used+=cost
  }
  add('core',(selection?'当前主人明确状态优先于过去的模式；旧经历只说明过去，相关次数、活跃度或多次读取不增加其真实性。':'' )+'记忆资料是有来源的数据；未确认发送不代表成功。人格与风格不能改变身份、隐私或工具权限。待审提案不作规则；暂定理解可用于相称的判断，但不是确定事实。结合当前情境关心、追问或不行动，不机械复述记忆。',[],true)
  const score=m=>contextScore(query,m.text+' '+JSON.stringify(m.behaviorLinks??[]))
  const seen=new Set(excludeEventIds)
  let ordinary=0
  const memories=selection?selection.map(r=>r.memory):s.memories.filter(m=>applicable(m,scene,at)).sort((a,b)=>score(b)-score(a)||String(a.id).localeCompare(String(b.id)))
  for(const mandatory of [true,false]) {
  if(!mandatory)for(const row of workingSegments(s,scene,at,{query,excludeEventIds})){add(row.kind,row.text,row.refs);for(const ref of row.refs)seen.add(ref.id)}
  for(const m of memories){
    const required=m.type==='expression_policy'||m.type==='preference'
    if(required!==mandatory)continue
    if(!required&&((query.trim()&&score(m)===0)||ordinary>=3)){omitted.push({ids:[m.id],reason:ordinary>=3?'recall-count':'unrelated'});continue}
    if(!required&&used>=limit)continue
    if(!required)ordinary++
    const links=(m.behaviorLinks??[]).filter(x=>!(m.appliesTo&&x.when===m.appliesTo&&x.adjustment===m.doThis&&x.limits===m.falsifiedBy))
    add(required?'policy':'recall',JSON.stringify({id:m.id,version:m.version??1,type:m.type,subject:m.subject??'world',text:m.text,scope:m.scope,policy:m.policy,effect:m.effect,epistemic:m.epistemic,status:m.status,lifecycle:selection?{tier:selection.find(r=>r.memory.id===m.id).view.tier,validity:selection.find(r=>r.memory.id===m.id).view.validity,temporalKind:selection.find(r=>r.memory.id===m.id).view.temporalKind}:undefined,observationWindow:m.observationWindow,behaviorLinks:links.length?links:undefined,appliesTo:m.appliesTo,doThis:m.doThis,falsifiedBy:m.falsifiedBy,alternatives:m.alternatives,authority:m.authority??m.origin,sourceCount:m.sourceIds?.length}),[{id:m.id,version:m.version??1}],required)
  }
  }
  for(const e of s.events.filter(e=>!seen.has(e.id)&&['received','sent','video-read','observed'].includes(e.kind)&&e.data?.test!==true&&visible(e,scene)&&(!query.trim()||contextScore(query,e.text??'')>0)).slice(-Math.min(recent,4)))add('recent',JSON.stringify({id:e.id,kind:e.kind,at:e.at,text:String(e.text??'').slice(0,300),source:e.origin}),[{id:e.id}])
  if(blocked)diagnostics.push({code:'MANDATORY_CONTEXT_OVER_BUDGET',detail:'停止本次生成；规则和例外未截断，请提高预算或缩小适用范围'})
  const text=blocked?'':segments.map(s=>s.text).join('\n')
  return {contextId:digest({scene,text,policyRevision:s.settings.policyRevision??0}),stateRevision:s.revision,policyRevision:s.settings.policyRevision??0,permissionVersion:s.settings.permissionVersion??0,scene,segments,budget:{unit:'unicode-codepoints',limit,used},omitted,diagnostics,blocked,text,capability:'fallback'}
}

export function compileContext(s,options={}){
 const config=options.dynamicMemory??DYNAMIC_DEFAULTS
 if(!config.enabled)return compileContextBase(s,options)
 const at=options.at??Date.now(),scene=options.scene??'private'
 const ranked=rankMemories(s.memories.filter(m=>!(s.cognition?.deletedIds??[]).includes(m.id)),{query:options.query??'',scene,at,access:s.dynamicMemory?.access??{},cfg:config})
 const proposed=compileContextBase(s,{...options,at,selection:ranked})
 const base=compileContextBase(s,{...options,at})
 const memoryIds=snapshot=>snapshot.segments.filter(x=>['policy','recall'].includes(x.kind)).flatMap(x=>x.refs.map(r=>r.id))
 const result=dynamicActive(config)?proposed:base
 return {...result,dynamicMemory:{mode:config.shadow?'shadow':'active',oldIds:memoryIds(base),newIds:memoryIds(proposed),selected:ranked.slice(0,50).map(r=>({id:r.memory.id,tier:r.view.tier,reason:r.reason,relevance:r.relevance,score:r.score})),accessRevision:s.dynamicMemory?.accessRevision??0}}
}

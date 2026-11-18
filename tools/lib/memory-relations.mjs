import crypto from 'node:crypto'
import {terms} from './memory-index.mjs'
import {visible} from './memory-scope.mjs'
import {dynamicActive} from './dynamic-memory-config.mjs'

export const RELATIONS=['related','support','contradict','supplement']
const MAX_TAGS=4096,DAY=86400000
const hash=x=>crypto.createHash('sha256').update(x).digest('hex')
const stop=new Set(['主人','今天','现在','这个','那个','一个','自己','可以','觉得','什么','已经','我们','你们','他们','the','and','this','that'])
// Small explicit synonym group; no causal inference such as tired => stayed up late.
export const relationTopics=x=>/疲惫|疲劳|好累|很累|太累|累了|不累/.test(String(x))?['topic:fatigue']:[]
const tokens=x=>[...terms(x).filter(t=>t.length>1&&!stop.has(t)),...relationTopics(x)]
const eligibleEvent=e=>e&&['received','video-read','observed'].includes(e.kind)&&e.origin!=='model'&&e.origin!=='formation'
export function relationEligible(m,e){
 if(!eligibleEvent(e)||!m.active||m.recallEnabled===false||['revoked','superseded','disputed'].includes(m.status))return false
 if(m.lifecycle?.recallControl&&m.lifecycle.recallControl!=='enabled')return false
 // Do not let a public memory's ranking or detail expose private activity.
 if(m.visibility==='public'&&!visible(e,'public'))return false
 if(m.visibility!=='public'&&!m.scope?.scenes?.some(s=>s.startsWith('private-'))&&m.scope?.scene==='public')return false
 return true
}
export function relationRoots(s,e){
 const byId=new Map(s.events.map(x=>[x.id,x])),seen=new Set(),roots=[]
 function walk(row){
  if(!row||seen.has(row.id))return
  seen.add(row.id)
  if(!eligibleEvent(row))return
  const parents=row.originEvidenceIds??[row.id]
  if(parents.length===1&&parents[0]===row.id){
   // Re-reading the same video is not a new independent experience.
   const key=row.kind==='video-read'&&row.target?'video:'+row.target:row.key||row.id
   roots.push({key:hash(key),eventId:row.id,at:row.at})
  }else for(const id of parents)walk(byId.get(id))
 }
 walk(e);return roots
}
export function relationView(m,at,halfLife){
 const tags=m.relevance?.version===(m.version??1)?m.relevance.tags:[]
 const counts=Object.fromEntries(RELATIONS.map(k=>[k,0]));let mass=0,last=null
 const days=new Set()
 for(const t of tags??[]){counts[t.relation]++;mass+=2**(-Math.max(0,at-t.at)/halfLife);last=Math.max(last??0,t.at);days.add(Math.floor((t.at+8*3600000)/DAY))}
 return {count:tags?.length??0,counts,mass,lastRelatedAt:m.relevance?.version===(m.version??1)&&Number.isFinite(m.relevance?.overflowLastAt)?Math.max(last??0,m.relevance.overflowLastAt):last,independentDays:days.size,saturated:!!m.relevance?.saturated}
}
export function addRelation(s,m,e,relation,{method='lexical',reason='词法关联，未判断是否支持原结论',roots=relationRoots(s,e)}={}){
 if(!RELATIONS.includes(relation)||!relationEligible(m,e))return 0
 if(!roots.length)return 0
 if(!m.relevance||m.relevance.version!==(m.version??1))m.relevance={schema:1,version:m.version??1,tags:[]}
 const ledger=m.relevance,existing=new Map(ledger.tags.map(t=>[t.key,t]));let changed=0
 for(const root of roots){
  const old=existing.get(root.key)
  if(old){
   // Semantic review may refine lexical related, never count the same source twice.
   if(method==='reviewed'&&old.method==='lexical'){Object.assign(old,{relation,method,reason:String(reason).slice(0,300)});changed++}
   continue
  }
  if(ledger.tags.length>=MAX_TAGS){ledger.saturated=true;ledger.overflowLastAt=Math.max(ledger.overflowLastAt??0,root.at);continue}
  const tag={...root,relation,method,reason:String(reason).slice(0,300)}
  ledger.tags.push(tag);existing.set(root.key,tag);changed++
 }
 return changed
}
export function observeRelations(s,e,cfg){
 if(!dynamicActive(cfg)||s.settings.paused||!eligibleEvent(e))return
 const eventTokens=new Set(tokens(String(e.text??'')+' '+String(e.data?.title??'')+' '+String(e.data?.tname??'')))
 if(!eventTokens.size)return
 let roots
 // Match all eligible memories, including cold ones; never only the injected subset.
 for(const m of s.memories){
  if(!relationEligible(m,e))continue
  const words=tokens(String(m.text??'')+' '+JSON.stringify(m.topics??[]))
  const hits=words.filter(t=>eventTokens.has(t))
  if(hits.some(t=>t.startsWith('topic:'))||hits.length>=2||(hits.length===1&&words.length<=3))addRelation(s,m,e,'related',{roots:roots??=relationRoots(s,e)})
 }
}
export function validateRelations(s){
 for(const m of s.memories){
  const r=m.relevance;if(!r)continue
  if(r.schema!==1||!Number.isInteger(r.version)||r.version<1||!Array.isArray(r.tags)||r.tags.length>MAX_TAGS)throw Error('记忆关联标签 schema 无效')
  const keys=new Set()
  for(const t of r.tags){if(!/^[a-f0-9]{64}$/.test(t.key)||keys.has(t.key)||!RELATIONS.includes(t.relation)||!['lexical','reviewed'].includes(t.method)||!Number.isFinite(t.at)||typeof t.eventId!=='string')throw Error('记忆关联标签无效');keys.add(t.key)}
 }
}
export function normalizeRelationProposals(s,j,input=[],{isolateInvalid=false,rejected=[]}={}){
 if(!Array.isArray(input)||input.length>16)throw Error('关联提案最多16条')
 const events=new Map(s.events.map(e=>[e.id,e])),memories=new Map(s.memories.map(m=>[m.id,m]))
 const rows=[],groups=new Map(),conflicts=new Set()
 const reject=(r,reason)=>rejected.push({key:typeof r?.key==='string'?r.key:null,stage:'extract-relation',code:'FORMATION_RELATION_INVALID',reason})
 for(const r of input){try{
  if(!r||typeof r!=='object')throw Error('关联提案必须是对象')
  const m=memories.get(r.memoryId),e=events.get(r.eventId),pair=r.memoryId+':'+r.eventId
  if(typeof r.key!=='string'||!r.key||r.key.length>100)throw Error('关联提案key无效')
  if(!m||j.memoryVersions[m.id]!==r.memoryVersion||(m.version??1)!==r.memoryVersion||!j.inputs.some(x=>x.id===r.eventId)||!relationEligible(m,e)||!RELATIONS.includes(r.relation))throw Error('关联提案越界、目标版本变化或来源无效')
  if(typeof r.quote!=='string'||!r.quote.trim()||r.quote.length>2000||!String(e.text??'').slice(0,2000).includes(r.quote))throw Error('关联提案需引用授权原话')
  const row={key:r.key,memoryId:m.id,memoryVersion:r.memoryVersion,eventId:e.id,relation:r.relation,quote:r.quote}
  const identity=JSON.stringify([row.memoryId,row.memoryVersion,row.eventId,row.relation,row.quote])
  const groupKeys=['key:'+r.key,'pair:'+pair,...relationRoots(s,e).map(root=>'root:'+m.id+':'+root.key)]
  const same=rows.find(x=>x.identity===identity)
  if(same&&isolateInvalid){
   // Preserve alternate keys for conflict detection even when collapsing duplicates.
   for(const k of groupKeys){const group=groups.get(k)??new Set();group.add(same);groups.set(k,group)}
   continue
  }
  const entry={row,identity};rows.push(entry)
  for(const k of groupKeys){const group=groups.get(k)??new Set();group.add(entry);groups.set(k,group)}
 }catch(e){if(!isolateInvalid)throw e;reject(r,e.message)}}
 for(const group of groups.values())if(group.size>1)for(const row of group)conflicts.add(row)
 if(conflicts.size&&!isolateInvalid)throw Error('关联提案key或来源对重复，同一独立来源不能重复分类')
 for(const entry of conflicts)reject(entry.row,'关联key或来源对冲突，本组不提交')
 return rows.filter(x=>!conflicts.has(x)).map(x=>x.row)
}
export function commitRelationProposals(s,j,decisions=[],cfg){
 const proposals=j.relations??[]
 if(!Array.isArray(decisions)||decisions.length!==proposals.length||new Set(decisions.map(d=>d.key)).size!==decisions.length)throw Error('关联审核必须完整覆盖提案')
 // Revalidate even when the feature was disabled; config generation checks stay authoritative.
 const checked=normalizeRelationProposals(s,j,proposals)
 let changed=0,contradicted=false
 for(const r of checked){
  const d=decisions.find(d=>d.key===r.key)
  if(!d||!['accept','reject'].includes(d.action)||typeof d.reason!=='string'||!d.reason.trim()||d.reason.length>1200)throw Error('关联审核无效')
  if(d.action==='reject'||!dynamicActive(cfg))continue
  const m=s.memories.find(m=>m.id===r.memoryId),e=s.events.find(e=>e.id===r.eventId)
  const updated=addRelation(s,m,e,r.relation,{method:'reviewed',reason:'独立审核通过：'+r.relation});changed+=updated
  if((updated||m.relevance?.saturated)&&r.relation==='contradict'){
   m.relevance.reviewNeeded=true
   m.counterEvidenceIds=[...new Set([...(m.counterEvidenceIds??[]),e.id])]
   // Relevance is not truth. Stop treating this claim as settled until revised.
   // Explicit owner rules are not revoked by an inferred contradiction.
   if(!['owner','owner_explicit'].includes(m.authority??m.origin)&&!['preference','expression_policy','commitment'].includes(m.type)){
    m.lifecycle??={schema:1,recallControl:'enabled'}
    m.lifecycle.validity='disputed';contradicted=true
   }
  }
 }
 return {changed,contradicted}
}

import crypto from 'node:crypto'
import {lifeConfig} from './life-config.mjs'
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value
const json=value=>JSON.stringify(stable(value))
const set=value=>Array.isArray(value)?[...new Set(value)].sort():null
const boundary=m=>json({visibility:m.visibility??'private',scene:m.scope?.scene??null,scenes:set(m.scope?.scenes),allowedExpressionScenes:set(m.allowedExpressionScenes),recall:m.recallEnabled!==false,control:m.lifecycle?.recallControl??'enabled',revoked:m.status==='revoked'})
// Capture before mutation: content/version/heat/validity are deliberately absent.
export function captureSessionBoundary(s){return {
 memories:s.memories.filter(m=>m.active).map(m=>({id:m.id,boundary:boundary(m)})),
 deleted:set(s.cognition?.deletedIds)??[],
 persona:json(s.memories.filter(m=>m.active&&m.type==='persona').map(m=>[m.id,m.text]).sort())
}}
export function sessionBoundaryChanged(before,s){
 if(json(before.deleted)!==json(set(s.cognition?.deletedIds)??[]))return true
 if(before.persona!==json(s.memories.filter(m=>m.active&&m.type==='persona').map(m=>[m.id,m.text]).sort()))return true
 const byId=new Map(s.memories.map(m=>[m.id,m])),replacements=new Map()
 for(const m of s.memories.filter(m=>m.active))for(const id of [m.baseId,...(m.baseVersions??[]).map(x=>x.id)].filter(Boolean))replacements.set(id,m)
 return before.memories.some(old=>{
   const next=replacements.get(old.id)??byId.get(old.id)
   // Automatic retention collection is not a permission revocation.
   return next ? old.boundary!==boundary(next) : false
 })
}
export function sessionBoundaryFingerprint(s,cfg,personaText=''){
 const c=lifeConfig(cfg.life)
 const policy=Object.fromEntries(['enabled','draftMode','requireDraft','hardMode','hardScenes','hardMaxChars','hardAtWarn','hardEmojiWarn','hardDisabledRules'].map(k=>[k,Array.isArray(c[k])?set(c[k]):c[k]]))
 return 'boundary-v1:'+crypto.createHash('sha256').update(json({account:String(cfg.self?.mid??''),owner:String(cfg.owner?.mid??''),epoch:s.settings.sessionBoundaryVersion??0,persona:cfg.persona??{},personaText,policy})).digest('hex')
}

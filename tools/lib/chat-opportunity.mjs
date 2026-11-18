import {chatConfig} from './chat-config.mjs'
import {hash} from './affect-engine.mjs'
const lastReply=(s,full)=>s.events.findLast(e=>e.kind==='sent'&&e.channel==='dm'&&String(e.target)===String(full.owner?.mid)&&e.data?.contentKind!=='image')
export function followupTurn(s,full){
  const owner=s.events.findLast(e=>e.kind==='received'&&(e.verifiedRole==='owner'||e.channel==='bili-dm'&&String(e.actor)===String(full.owner?.mid)))
  const reply=lastReply(s,full)
  if(owner?.channel!=='bili-dm'||owner.verifiedRole!=='owner'||String(owner.actor)!==String(full.owner?.mid)||owner.at!==s.affect.lastOwnerAt||
    !owner.text?.trim()||!reply?.text?.trim()||!reply.receipt||reply.data?.initiative||reply.data?.share||
    reply.seq<=owner.seq||reply.at<owner.at||reply.at-owner.at>=15*60000)return null
  return {owner,reply}
}
// One deterministic draw per contact, never a fresh dice roll every minute.
export function chatOpportunity(s,full,at){
  const c=chatConfig(full.chat),a=s.affect
  if(!a||(!c.followup&&!c.idle)||!a.lastOwnerAt)return null
  const last=lastReply(s,full)
  const anchor=Math.max(a.lastOwnerAt,last?.at??0)
  let kind
  if(c.followup&&last&&!last.data?.initiative&&last.at>=a.lastOwnerAt&&last.at-a.lastOwnerAt<15*60000&&at-last.at>=30000&&at-last.at<=5*60000&&followupTurn(s,full))kind='followup'
  else if(c.idle&&at-anchor>=c.idleHours*3600000)kind='idle'
  if(!kind)return null
  const key=kind+':'+a.lastOwnerAt // each incoming conversation may trigger once
  if((a.chatAttempts??[]).includes(key)||parseInt(hash(key).slice(0,8),16)/0x100000000>=c.chance)return null
  return {kind,key,ownerAt:a.lastOwnerAt,anchor}
}

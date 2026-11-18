import {preferenceMatches} from '../lib/feed-preferences.mjs'
import {config} from '../lib/config.mjs'
export const PIPELINE_DEFAULTS={windows:[3,7,30,365,730,1095],perKeywordPool:12,minPlay:0,minDm:0,minDuration:0,maxDuration:7200,multiPartThreshold:3,multiPartPerRound:1,deepReadMax:3,concurrency:2,relatedTakeMax:2,relatedMinPlay:0,relatedSources:2,timeoutMs:900000,maxMetadata:40,explorationMax:1}
const legacy={windows:'windows',perKeywordPool:'perKeywordPool',minPlay:'minPlay',minDm:'minDm',multiPartThreshold:'multiPartThreshold',multiPartPerRound:'multiPartPerRound',deepReadMax:'deepReadMax',relatedTakeMax:'relatedTakeMax',relatedMinPlay:'relatedMinPlay'}
export function pipelineConfig(input=config()){
 const migrated={};for(const [k,v]of Object.entries(legacy))if(input['bw_cfg_'+k]!==undefined)migrated[v]=input['bw_cfg_'+k]
 const p={...PIPELINE_DEFAULTS,...migrated,...input.pipeline}
 if(!Array.isArray(p.windows)||!p.windows.length||p.windows.length>8||p.windows.some((x,i)=>!Number.isInteger(x)||x<1||x>3650||(i&&x<=p.windows[i-1])))throw Error('pipeline.windows 必须是递增的天数数组（1–3650）')
 for(const [k,min,max] of [['perKeywordPool',1,50],['minPlay',0,1e9],['minDm',0,1e7],['minDuration',0,86400],['maxDuration',1,86400],['multiPartThreshold',1,1000],['multiPartPerRound',0,20],['concurrency',1,3],['relatedTakeMax',0,5],['relatedMinPlay',0,1e9],['relatedSources',0,5],['timeoutMs',1000,1800000],['maxMetadata',1,100],['explorationMax',0,3]])if(!Number.isInteger(p[k])||p[k]<min||p[k]>max)throw Error('pipeline.'+k+' 超出范围 '+min+'–'+max)
 if(p.minDuration>p.maxDuration)throw Error('时长下限不能大于上限')
 if(p.deepReadMax!=='all'&&(!Number.isInteger(p.deepReadMax)||p.deepReadMax<1||p.deepReadMax>20))throw Error('deepReadMax 必须为 1–20 或 all')
 return p
}
export function videoDuration(value){const p=String(value??'').split(':').map(Number);return p.every(Number.isFinite)?p.reduce((a,b)=>a*60+b,0):0}
export function ageDays(video,now=Date.now()){const n=Number(video.pubdate);return n>0?(now-n*1000)/86400000:Infinity}
export function eligibleVideo(x,p,now=Date.now()){
 const age=ageDays(x,now)
 return /^BV[0-9A-Za-z]{10}$/.test(x.bv??'')&&Number.isFinite(x.d)&&x.d>=p.minDuration&&x.d<=p.maxDuration&&x.play>=p.minPlay&&x.dm>=p.minDm&&age>=-1&&age<=p.windows.at(-1)
}
export function interestEvidence(video,preferences){
 const fields={title:String(video.t??''),description:String(video.description??''),tags:Array.isArray(video.tags)?video.tags.join(' '):String(video.tags??'')}
 return preferences.flatMap(preference=>{const matched=Object.entries(fields).filter(([,text])=>preferenceMatches(text,preference)).map(([field])=>field);return matched.length?[{preference,fields:matched}]:[]})
}
export function isInterest(video){return Array.isArray(video.interestMatches)&&video.interestMatches.length>0}
export function interestGroup(video){const matches=video.interestMatches;return matches?.includes(video.kw)?video.kw:matches?.[0]??video.kw??'其他'}
// Rotate across interests first. Freshness only orders candidates inside an interest.
export function fairOrder(items,keywords=[]){
 const groups=new Map();for(const x of items){const key=interestGroup(x);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(x)}
 const keys=[...new Set([...keywords.filter(k=>groups.has(k)),...groups.keys()])],out=[]
 while(keys.some(k=>groups.get(k).length))for(const key of keys){const next=groups.get(key).shift();if(next)out.push(next)}
 return out
}
export function chooseVideos(items,{n,per=2,config:p,random=Math.random,now=Date.now(),keywords=[],browsing={}}){
 const ranked=[...new Map(items.map(x=>[x.bv,x])).values()].filter(x=>eligibleVideo(x,p,now)).map(x=>({...x,_window:p.windows.findIndex(days=>ageDays(x,now)<=days),_random:random()}))
 ranked.sort((a,b)=>a._window-b._window||Math.floor((b._score??0)/4)-Math.floor((a._score??0)/4)||browsingRank(b,browsing)-browsingRank(a,browsing)||a._random-b._random)
 const interests=fairOrder(ranked.filter(isInterest),keywords),exploration=ranked.filter(x=>!isInterest(x))
 const selected=[],counts=new Map();let multi=0,explored=0
 for(const x of [...interests,...exploration]){
  if(selected.length>=n)break
  const interest=isInterest(x),key=interestGroup(x)
  if(interest&&(counts.get(key)??0)>=per)continue
  if(!interest&&(browsing.allowExploration===false||explored>=(p.explorationMax??1)))continue
  const isMulti=Number(x.parts??1)>p.multiPartThreshold;if(isMulti&&multi>=p.multiPartPerRound)continue
  if(interest)counts.set(key,(counts.get(key)??0)+1);else explored++
  if(isMulti)multi++
  const {_random,...row}=x;selected.push({...row,selectionReason:interest?'interest':'exploration'})
 }
 return selected
}

// Tie-break only inside the same freshness and quality tier; never bypass hard filters.
export function browsingRank(x,browsing={}){const d=Math.min(1200,Math.max(0,Number(x.d)||0));return browsing.duration==='short'?-d:browsing.duration==='long'?d:0}

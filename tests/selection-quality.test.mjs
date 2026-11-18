import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {pipelineConfig,chooseVideos,interestEvidence,isInterest} from '../tools/local/pipeline-config.mjs'
const root=fileURLToPath(new URL('../',import.meta.url)),interests=['明日方舟','猫咪','Live2D/模型','B站生态八卦','大肥鱼 拟人']
let seq=0
const video=(title,days=1,extra={})=>({bvid:'BV'+String(++seq).padStart(10,'0'),title,duration:'02:00',play:1000,danmaku:10,mid:333,author:'作者',pubdate:Math.floor(Date.now()/1000)-days*86400,...extra})
function fixture(t,data,{like=interests,pipeline={}}={}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-selection-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const dsh=path.join(home,'.dsh');fs.mkdirSync(dsh);fs.mkdirSync(path.join(home,'.bili-ai'))
 const configPath=path.join(home,'config.json'),dataPath=path.join(home,'selection.json'),requests=path.join(home,'requests');fs.writeFileSync(configPath,JSON.stringify({self:{mid:'111'},owner:{mid:'222'},preferences:{like,dislike:['标题党']},pipeline,timing:{enabled:true}}));fs.writeFileSync(dataPath,JSON.stringify(data));fs.writeFileSync(path.join(home,'.bili-ai/credentials.json'),JSON.stringify({sessdata:'fake',bili_jct:'fake'}))
 const env={...process.env,HOME:home,USERPROFILE:home,DSH_HOME:dsh,BILI_WHALE_CONFIG:configPath,DSH_NODE:process.execPath,BILI_NO_CACHE:'1',BILI_TRAFFIC_TEST:'1',NODE_TEST_CONTEXT:'child-v8',TEST_SELECTION_DATA:dataPath,TEST_REQUESTS:requests,NODE_OPTIONS:'--import='+pathToFileURL(path.join(root,'tests/helpers/selection-quality-fetch.mjs')).href}
 return {run:args=>spawnSync(process.execPath,[path.join(root,'tools/bili.mjs'),...args],{env,encoding:'utf8',timeout:30000}),requests:()=>fs.readFileSync(requests,'utf8').trim().split('\n').map(JSON.parse)}
}
const checked=r=>{assert.equal(r.status,0,r.stdout+r.stderr);return JSON.parse(r.stdout)}

test('repeated ambiguous search hits do not consume the unique metadata inspection slots',t=>{
 const f=fixture(t,{search:{'猫咪':[video('日常记录',1),video('快乐时光',2,{meta:{desc:'猫咪的午后'}})]}},{like:['猫咪'],pipeline:{explorationMax:0}})
 const data=checked(f.run(['feed','--n','6','--json']));assert.equal(data.diagnostics.interestSelected,1);assert.equal(data.diagnostics.metadataUsed,2);assert.equal(data.items[0].t,'快乐时光')
})
test('five interests receive first slots before any second slot or fresh high-score hot videos',()=>{
 const p=pipelineConfig({}),items=interests.flatMap((kw,i)=>[1,2].map(n=>({bv:'BV'+String(i*2+n).padStart(10,'0'),t:kw,kw,interestMatches:[kw],pubdate:Date.now()/1000-20*86400,d:120,play:1000,dm:1,parts:1})))
 items.push(...['热门','排行'].map((kw,i)=>({bv:'BV'+String(90+i).padStart(10,'0'),t:'无关新闻',kw,interestMatches:[],pubdate:Date.now()/1000,d:120,play:1e8,dm:1e6,parts:1,_score:10000})))
 const selected=chooseVideos(items,{n:6,per:2,config:p,keywords:interests,random:()=>0});assert.equal(selected.length,6);assert.equal(new Set(selected.slice(0,5).map(x=>x.interestMatches[0])).size,5);assert.ok(selected.every(isInterest))
})
test('one shared exploration cap permits honest shortfalls and can be disabled',()=>{
 const items=['猫咪','热门','排行','关注'].map((kw,i)=>({bv:'BV'+String(i+1).padStart(10,'0'),kw,interestMatches:i?[]:['猫咪'],pubdate:Date.now()/1000,d:120,play:1000,dm:10}))
 assert.equal(chooseVideos(items,{n:6,config:pipelineConfig({})}).length,2)
 assert.equal(chooseVideos(items,{n:6,config:pipelineConfig({pipeline:{explorationMax:0}})}).length,1)
 assert.throws(()=>pipelineConfig({pipeline:{explorationMax:4}}))
})
test('search provenance alone is not taste evidence; title, description and tags are explainable',()=>{
 assert.deepEqual(interestEvidence({t:'无关新闻',kw:'猫咪'},['猫咪']),[])
 assert.deepEqual(interestEvidence({t:'模型展示',description:'Live2D 模型',tags:['猫咪']},['Live2D/模型','猫咪']),[{preference:'Live2D/模型',fields:['description']},{preference:'猫咪',fields:['tags']}])
})
test('metadata budget is reserved across interests and wider windows before hot sources',t=>{
 const search=Object.fromEntries(interests.map((kw,i)=>[kw,Array.from({length:i?1:12},()=>video(kw.replace('/',' '),i?20:1))]));const f=fixture(t,{search,popular:[video('无关热门',0)],rank:[video('无关排行',0)]},{pipeline:{maxMetadata:5}})
 const data=checked(f.run(['discover','--n','6','--json']));assert.equal(data.items.length,5);assert.equal(data.diagnostics.interestSelected,5);assert.equal(new Set(data.items.map(x=>x.interestMatches[0])).size,5);assert.equal(data.shortfall,1);assert.equal(data.diagnostics.metadataUsed,5)
 assert.equal(f.requests().some(x=>/popular|ranking/.test(x.url)),false)
})
test('six real interest candidates exclude hotter unrelated results; feed stdout is strict JSON',t=>{
 const search=Object.fromEntries(interests.map(kw=>[kw,[video(kw.replace('/',' '),15),video(kw.replace('/',' ')+'片段',15)]])),f=fixture(t,{search,popular:Array.from({length:20},()=>video('无关热点',0,{play:9e7,danmaku:1e6})),rank:[video('无关新闻',0)]})
 const data=checked(f.run(['feed','--n','6','--json']));assert.equal(data.items.length,6);assert.equal(data.diagnostics.explorationSelected,0);assert.equal(new Set(data.items.map(x=>x.interestMatches[0])).size,5);assert.ok(data.items.every(x=>x.selectionReason==='interest'));assert.equal(f.requests().some(x=>/popular|ranking/.test(x.url)),false)
})
test('unrelated search hits do not masquerade as interest; round reports shortfall rather than filling with hot videos',t=>{
 const f=fixture(t,{search:{'猫咪':[video('汽车新闻')]},popular:[video('经济新闻')],rank:[video('社会热点')]},{like:['猫咪']})
 const data=checked(f.run(['round','--n','6','--dry','--json'])).selection;assert.equal(data.items.length,1);assert.equal(data.shortfall,5);assert.equal(data.diagnostics.interestSelected,0);assert.equal(data.diagnostics.explorationSelected,1);assert.ok(f.requests().every(x=>x.method==='GET'))
})
test('view-time dislikes and duration changes reject candidates without consuming other interests',t=>{
 const f=fixture(t,{search:{'猫咪':[video('猫咪好看',1,{meta:{title:'猫咪标题党'}}),video('猫咪合集',1,{duration:'99:00:00',meta:{duration:100},videos:8})],'明日方舟':[video('明日方舟实况',20)]}},{like:['猫咪','明日方舟']})
 const data=checked(f.run(['feed','--n','6','--json']));assert.equal(data.items.length,2);assert.ok(data.items.every(x=>!x.t.includes('标题党')));assert.ok(data.items.some(x=>x.parts===8&&x.d===100))
})
test('failed searches remain visible in diagnostics rather than being called empty interests',t=>{
 const f=fixture(t,{search:{},failKeyword:'猫咪'},{like:['猫咪'],pipeline:{explorationMax:0}});const data=checked(f.run(['feed','--json']));assert.equal(data.items.length,0);assert.ok(data.diagnostics.warnings.length);assert.ok(data.diagnostics.keywords[0].searches.every(x=>x.error))
})

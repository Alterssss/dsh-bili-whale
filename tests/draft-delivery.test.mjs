import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createLifeStore} from '../tools/lib/life-store.mjs'
import {prepareExpression,finalizeExpression} from '../tools/lib/expression.mjs'
import {commentFromDraft,dmFromDraft,shareText} from '../tools/lib/expression-delivery.mjs'
function setup(t){const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-draft2-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));return createLifeStore({dshHome:home,account:'1',owner:'2',ownerName:'Owner',config:{requireDraft:true,hardMode:'off'}})}
const cfg={owner:{mid:'2',name:'Owner'}}
async function prepare(store,extra={}){const d=await prepareExpression(store,{scene:'public-comment',target:'BV1234567890',thread:'1:123:top',text:'白猫回头 [笑哭]',...extra});await finalizeExpression(store,d.id);return d.id}
test('finalize precomputes share prefix and --draft supplies exact coordinates',async t=>{
 const store=setup(t),id=await prepare(store),args=new Map([['draft',id],['share',true]])
 commentFromDraft(store,args,cfg)
 assert.equal(args.get('message'),'@Owner 白猫回头 [笑哭]');assert.equal(args.get('oid'),'123');assert.equal(args.get('bvid'),'BV1234567890')
 const d=store.read().drafts[0];assert.equal(d.delivery.shareText,args.get('message'))
 assert.equal(store.check({channel:'comment',scene:'public-comment',target:'BV1234567890',thread:'1:123:top',parent:'',text:args.get('message'),auto:true,share:true,ownerName:'Owner',draftId:id}).allow,true)
})
test('prepared shared draft can be sent using only --draft as transport intent',async t=>{
 const store=setup(t),id=await prepare(store,{share:true}),args=new Map([['draft',id]])
 commentFromDraft(store,args,cfg);assert.equal(args.has('share'),true);assert.equal(args.has('auto'),true)
})
test('coordinate mismatch is actionable and never silently redirects a draft',async t=>{
 const store=setup(t),id=await prepare(store)
 for(const [key,value] of [['oid','999'],['bvid','BV0000000000'],['type','11'],['parent','888'],['message','changed']]){
  assert.throws(()=>commentFromDraft(store,new Map([['draft',id],[key,value]]),cfg),/不匹配/)
 }
})
test('owner rename invalidates frozen mention, with no fuzzy removal',async t=>{
 const store=setup(t),id=await prepare(store)
 assert.throws(()=>commentFromDraft(store,new Map([['draft',id],['share',true]]),{owner:{name:'Other'}}),/昵称或分享前缀/)
 assert.throws(()=>shareText('@OwnerOther 猫','Owner'),/其他 @/)
 assert.equal(shareText('@Owner 猫','Owner'),'@Owner 猫')
})
test('ordinary public mentions do not have to become owner shares',async t=>{
 const store=setup(t),id=await prepare(store,{text:'@Another 猫 [笑哭]'})
 const args=new Map([['draft',id]]);commentFromDraft(store,args,cfg)
 assert.equal(args.get('message'),'@Another 猫 [笑哭]');assert.equal(args.has('share'),false)
})
test('reply coordinates cannot be finalized with top-level scene',async t=>{
 const store=setup(t),d=await prepareExpression(store,{scene:'public-comment',target:'123',thread:'1:123:456',parent:'789',text:'answer'})
 await assert.rejects(finalizeExpression(store,d.id),/scene 与 parent/)
})
test('private recommendation binds owner and video and supplies MSG',async t=>{
 const store=setup(t),id=await prepare(store,{scene:'private-recommendation',target:'2',thread:'',text:'猫 https://www.bilibili.com/video/BV1234567890/'})
 const opt={draft:id};dmFromDraft(store,opt,cfg)
 assert.equal(opt.share,true);assert.equal(opt.target,'BV1234567890')
 assert.throws(()=>dmFromDraft(store,{draft:id},{owner:{mid:'3'}}),/主人 mid/)
})
test('v1 pending drafts remain usable with the deterministic share prefix',async t=>{
 const store=setup(t),id=await prepare(store)
 await store.tx(s=>{delete s.drafts[0].delivery})
 const args=new Map([['draft',id],['share',true]]);commentFromDraft(store,args,cfg)
 assert.equal(args.get('message'),'@Owner 白猫回头 [笑哭]')
})

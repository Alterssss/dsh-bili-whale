import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createLifeStore} from '../tools/lib/life-store.mjs'
import {prepareExpression,finalizeExpression} from '../tools/lib/expression.mjs'

test('image continuation is bound to the sent draft, image hash, target, scene and policy',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'whale-image-guard-'))
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
  const store=createLifeStore({dshHome:directory,account:'111',owner:'222',config:{requireDraft:true}})
  const draft=await prepareExpression(store,{scene:'private-recommendation',target:'222',text:'这是一条分享'})
  await finalizeExpression(store,draft.id)
  const hash='a'.repeat(64)
  const token=await store.reserve({channel:'dm',scene:'private-recommendation',target:'222',text:draft.text,
    auto:true,share:true,draftId:draft.id,dmImageHash:hash})
  await store.dispatch(token,async()=>{})
  await store.settle(token,{status:'sent',receipt:'text-receipt'})
  const image={channel:'dm',scene:'private-recommendation',target:'222',text:'[图片 sha256:'+hash+']',
    auto:true,share:false,dmImageHash:hash,dmAttachmentOf:token}
  assert.equal(store.check(image).allow,true)
  for(const change of [{target:'333'},{scene:'private-reply'},{auto:false},{share:true},{text:'新增的正文'},
    {dmImageHash:'b'.repeat(64)},{dmAttachmentOf:'unknown'},{taskId:'another-task'}]) {
    assert.equal(store.check({...image,...change}).allow,false,JSON.stringify(change))
  }
  await store.tx(state=>{state.settings.paused=true})
  assert.equal(store.check(image).allow,false)
  await store.tx(state=>{state.settings.paused=false;state.settings.policyRevision=(state.settings.policyRevision??0)+1})
  assert.equal(store.check(image).allow,false)
})

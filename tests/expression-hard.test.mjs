import test from 'node:test'
import assert from 'node:assert/strict'
import {checkHard,assertHard} from '../tools/lib/expression-hard.mjs'
test('word choice is free; length warns by default',()=>{
 assert.equal(checkHard('这意味着——不是开关而是目标','public-comment').ok,true)
 const r=checkHard('猫'.repeat(61),'public-comment');assert.equal(r.ok,true);assert.equal(r.warnings[0].code,'form:too-long')
 assert.equal(checkHard('🐱'.repeat(40),'public-comment').characters,40)
})
test('explicit length enforcement and scene overrides still apply',()=>{
 assert.throws(()=>assertHard('猫'.repeat(61),'public-comment',{hardMode:'enforce'}),/拒绝/)
 assert.equal(checkHard('猫'.repeat(100),'private-reply').applied,false)
 assert.equal(checkHard('猫'.repeat(100),'public-comment',{hardMode:'off'}).applied,false)
 assert.equal(checkHard('猫'.repeat(100),'private-reply',{hardMode:'enforce',hardScenes:['private-reply']}).ok,false)
})

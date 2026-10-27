import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { createSessionDelivery } from '../lib/session-delivery.js'

const visit = n => n && typeof n === 'object' ? [n, ...(n.children || []).flat(Infinity).flatMap(visit)] : []
function page(capabilities, response) {
  const draft = { dialogueMode: 'character', character: {name:'余小渔',style:'我刚修改的口吻'}, night:{windows:[{start:'20:00',end:'24:00',wakes:1}]} }
  let client, cursor=0
  const states=[draft], posts=[]
  const react={createElement:(type,props,...children)=>({type,props:props||{},children}),useEffect(){},useCallback:f=>f,useState(v){const i=cursor++;if(!(i in states))states[i]=v;return[states[i],x=>{states[i]=typeof x==='function'?x(states[i]):x}]}}
  vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'),{
    window:{__ModuleLoader__:{load({factory}){client=factory(()=>react)}}},
    fetch:async(url,opts)=>{
      assert.equal(url,'/dsh-bili/api/settings')
      if(!opts.body)return{ok:true,json:async()=>capabilities}
      const body=JSON.parse(opts.body);posts.push(body)
      return{ok:true,status:200,json:async()=>response ? response(body) : {ok:true,config:body.config}}
    },
  })
  const render=()=>{cursor=0;return client.BiliWhaleSection()}
  return{states,posts,render,async save(){return visit(render()).find(n=>n.type==='button'&&n.children.includes('保存')).props.onClick()}}
}

test('new settings page detects an old running backend without posting or losing edits',async()=>{
  const f=page({ok:true})
  assert.equal(await f.save(),false)
  assert.equal(f.posts.length,0)
  assert.equal(f.states[0].character.style,'我刚修改的口吻')
  assert.match(JSON.stringify(f.render()),/后台仍是旧版本/)
})

test('character fields reach settings API and success is shown only after confirmed save',async()=>{
  const f=page({supportedDialogueModes:['local','character']})
  assert.equal(await f.save(),true)
  assert.equal(f.posts[0].config.character.style,'我刚修改的口吻')
  assert.equal(JSON.parse(f.states[1]).character.style,'我刚修改的口吻')
  assert.match(JSON.stringify(f.render()),/已保存/)
  const bad=page({supportedDialogueModes:['character']},()=>({ok:false,error:'disk failed'}))
  assert.equal(await bad.save(),false)
  assert.equal(bad.states[0].character.style,'我刚修改的口吻')
  assert.match(JSON.stringify(bad.render()),/disk failed/)
})

test('maintenance mode prevents session creation and delivery during restart verification',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-maintenance-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  fs.writeFileSync(path.join(home,'whale-maintenance.json'),'{}')
  let calls=0
  const delivery=createSessionDelivery({dshHome:home,cwd:home,sessionId:'test',config:()=>({}),persona:()=>'',controller:{async create(){calls++},async prompt(){calls++}}})
  await assert.rejects(delivery.send({content:[]}),/自动投递已暂停/)
  assert.equal(calls,0)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { characterPrompt, characterOf, validateCharacter } from '../lib/dialogue-profile.js'
import { createSessionDelivery } from '../lib/session-delivery.js'
import { installCharacterRuntime } from '../lib/character-runtime.js'

const collect = async stream => { const out=[]; for await(const c of stream)out.push(c);return out }
const complete = text => [{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text},{type:'block-end',index:0,block:{type:'text',text}},{type:'usage',usage:{inputTokens:2,outputTokens:3}},{type:'finish',reason:{kind:'stop'}}]

test('local character replaces legacy identity without any external plugin files', async t => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-character-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  const cfg={dialogueMode:'character',personaOncePerSession:true,character:{name:'余小渔'}}
  const prompts=[]
  const delivery=createSessionDelivery({controller:{async create(){},async prompt(p){prompts.push(p)}},dshHome:home,cwd:home,sessionId:'fish',config:()=>cfg,persona:()=>characterPrompt(cfg)})
  for(let n=0;n<2;n++)await delivery.send({content:[{type:'text',text:'仅本地测试'}]})
  for(const p of prompts){assert.match(p.content[0].text,/唯一姓名：余小渔/);assert.doesNotMatch(p.content[0].text,/人设依据：|本肥鱼|［人格与表达］|［本次说话方式］/)}
  assert.equal(characterPrompt({}),null)
  assert.equal(characterOf(cfg).probability,0)
  assert.ok(validateCharacter({name:''}));assert.ok(validateCharacter({probability:2}))
  cfg.character.name=''
  await assert.rejects(delivery.send({content:[]}),/姓名不能为空/)
  assert.equal(prompts.length,2)
})

test('settings edit the fish own character and hide both legacy editors',()=>{
  let client,cursor=0
  const states=[{dialogueMode:'character',character:characterOf({})}]
  const react={createElement:(type,props,...children)=>({type,props:props||{},children}),useEffect(){},useCallback:fn=>fn,useState(initial){const i=cursor++;if(!(i in states))states[i]=initial;return[states[i],value=>{states[i]=typeof value==='function'?value(states[i]):value}]}}
  vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load({factory}){client=factory(()=>react)}}},fetch(){throw Error('No network')}})
  const visit=n=>n&&typeof n==='object'?[n,...(n.children||[]).flat(Infinity).flatMap(visit)]:[]
  const tree=client.BiliWhaleSection(),nodes=visit(tree)
  assert.doesNotMatch(JSON.stringify(tree),/人格来源：自然对话|她的人设（只属于她）|恢复默认人格/)
  assert.equal(nodes.filter(n=>['voice','persona'].includes(n.props?.f?.path?.[0])).length,0)
  const row=nodes.find(n=>n.props?.f?.path?.join('.')==='character.name');assert.ok(row)
  cursor=40
  const input=visit(row.type(row.props)).find(n=>n.type==='input')
  input.props.onChange({target:{value:'新名字'}})
  assert.equal(states[0].character.name,'新名字')
})

async function fixture(t, respond='我倒觉得可以先慢慢试。') {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'whale-runtime-')),handlers={},sections=[],disposers=[],calls=[]
  t.after(()=>{disposers.reverse().forEach(f=>f());fs.rmSync(cwd,{recursive:true,force:true})})
  const cfg={dialogueMode:'character',character:{name:'余小渔',planner:true,replyer:true}}
  const ctx={llm:{async *stream(o){calls.push(o);if(respond instanceof Error)throw respond;yield* complete(typeof respond === 'function' ? respond(o) : respond)}},systemPrompt:{section(s){sections.push(s);return()=>{}}},on(n,f){handlers[n]=f},effect(f){const d=f();if(typeof d==='function')disposers.push(d)}}
  const runtime=installCharacterRuntime(ctx,{config:()=>cfg,cwd})
  const user={id:'u',role:'user',source:{kind:'user'},content:[{type:'text',text:'你有什么想法？'}]}
  const agent={options:{provider:'test',model:'test'},session:{header:{id:'bili-whale',cwd},deriveMessages:()=>[user]}}
  const signal=new AbortController().signal
  const payload={agent,signal,turn:1,step:0,messages:[user]}
  const enter=()=>Promise.resolve({kind:'enter',messages:[user]})
  return {handlers,sections,calls,cfg,agent,signal,payload,enter,runtime,user}
}

test('independent planner and Replyer run once, use native sources and never recurse',async t=>{
  const f=await fixture(t)
  assert.match(f.sections[0].text({agent:f.agent}),/余小渔/)
  assert.equal(f.sections[0].text({agent:{session:{header:{cwd:'missing'}}}}),'')
  const admitted=await f.handlers['agent/pre-step'](f.payload,f.enter)
  assert.equal(admitted.messages.at(-1).source.kind,'dsh-bili-whale')
  await f.handlers['agent/pre-step'](f.payload,f.enter)
  assert.equal(f.calls.length,1)
  const original=complete('先说清楚，我建议先试试看。')
  const rendered=await collect(f.handlers['llm/stream']({signal:f.signal,provider:'test',model:'test'},async()=>original))
  assert.equal(rendered.find(c=>c.type==='text-delta').text,'我倒觉得可以先慢慢试。')
  assert.equal(f.calls.length,2)
  assert.equal(f.calls[1].tools,undefined)
  assert.notEqual(f.calls[1].signal,f.signal)
  assert.equal(rendered.find(c=>c.type==='usage').usage.inputTokens,4)
  assert.equal(rendered.at(-1).replayState,undefined)
  assert.equal(f.runtime.matches({...f.agent,session:{header:{...f.agent.session.header,origin:'parent'}}}),false)
  await collect(f.handlers['llm/stream']({signal:new AbortController().signal},async()=>original))
  assert.equal(f.calls.length,2)
  f.handlers['agent/turn-stopping']({signal:f.signal})
  await collect(f.handlers['llm/stream']({signal:f.signal},async()=>original));assert.equal(f.calls.length,2)
})

test('tool calls, exact results, failed generation and cancellation preserve execution boundaries',async t=>{
  const f=await fixture(t,new Error('offline'))
  await f.handlers['agent/pre-step'](f.payload,f.enter)
  const run=chunks=>collect(f.handlers['llm/stream']({signal:f.signal,provider:'test',model:'test'},async()=>chunks))
  for(const original of [[{type:'block-start',index:0,blockType:'tool-call'},{type:'tool-call-delta',input:'unchanged'}],complete('13项测试通过，未发送。'),complete('{"ok":true}'),complete('生成失败，未发送。')])assert.deepEqual(await run(original),original)
  const rejected=await f.handlers['agent/pre-step'](f.payload,async()=>({kind:'reject',reason:'host'}));assert.equal(rejected.kind,'reject')
  const controller=new AbortController();controller.abort()
  await assert.rejects(collect(f.handlers['llm/stream']({signal:f.signal},async function*(){controller.signal.throwIfAborted()})),{name:'AbortError'})
})


test('Replyer preserves task numbers and paths while conversation may omit irrelevant identifiers',async t=>{
  const f=await fixture(t,o=>o.messages.at(-1).content[0].text.replace('可用事实与回应方向：\n',''))
  f.cfg.character.planner=false
  f.user.content[0].text='帮我检查测试结果'
  await f.handlers['agent/pre-step'](f.payload,f.enter)
  const original=complete('13项测试通过，文件在 C:\\work\\test.json。未发送。')
  const result=await collect(f.handlers['llm/stream']({signal:f.signal,provider:'test',model:'test'},async()=>original))
  assert.equal(result.find(c=>c.type==='text-delta').text,original.find(c=>c.type==='text-delta').text)
  assert.equal(f.runtime.status.replies,1)
})

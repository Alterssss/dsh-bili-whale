import test from 'node:test'
import assert from 'node:assert/strict'
import {
  readVoice, isEmptyVoice, pickReplyStyle, normalizeExpressions,
  scoreExpression, sampleExpressions, buildVoiceBlock, buildLearnPrompt, DEFAULT_VOICE,
} from '../lib/voice.js'

test('readVoice 归一化：缺字段、脏数据都给安全默认值', () => {
  const v = readVoice({ voice: { personality: '  她是一条鱼  ', multipleStyles: ['a', '', 'b'], expressionTopK: 999 } })
  assert.equal(v.personality, '她是一条鱼')
  assert.deepEqual(v.multipleStyles, ['a', 'b'])
  assert.equal(v.expressionTopK, DEFAULT_VOICE.expressionTopK) // 越界回落
  assert.equal(v.styleMode, 'random')
  assert.equal(readVoice(undefined).styleMode, 'random')
})

test('初始人格非空，显式关闭可保留空设定', () => {
  assert.equal(isEmptyVoice(readVoice({})), false)
  assert.equal(isEmptyVoice(readVoice({ voice: { replyStyle: '短句' } })), false)
  assert.equal(isEmptyVoice(readVoice({ voice: { multipleStyles: ['x'] } })), false)
})

test('pickReplyStyle：random 不越界，first 取第一个，off 返回空', () => {
  const v = { multipleStyles: ['a', 'b', 'c'], styleMode: 'random', multipleProbability: 1 }
  assert.equal(pickReplyStyle(v, () => 0), 'a')
  assert.equal(pickReplyStyle(v, () => 0.999), 'c')
  assert.equal(pickReplyStyle({ ...v, styleMode: 'first' }, () => 0.9), 'a')
  assert.equal(pickReplyStyle({ ...v, styleMode: 'off' }), '')
  assert.equal(pickReplyStyle({ multipleStyles: [] }), '')
})

test('normalizeExpressions：去重、跳过脏条目、接受两种外层结构', () => {
  const r = normalizeExpressions([
    { situation: '夸奖', style: '厉害厉害' },
    { situation: '夸奖', style: '厉害厉害' },
    { situation: '', style: 'x' },
    { situation: 'y' },
    'not-an-object',
    { situation: '无语', style: '……', weight: 3 },
  ])
  assert.equal(r.items.length, 2)
  assert.equal(r.errors.length, 3) // 空 situation / 缺 style / 非对象
  assert.equal(r.items[1].weight, 3)
  assert.equal(normalizeExpressions({ expressions: [{ situation: 'a', style: 'b' }] }).items.length, 1)
  assert.equal(normalizeExpressions(null).items.length, 0)
})

test('scoreExpression：话题命中时权重更高', () => {
  const a = { situation: '被说菜时回嘴', style: '你行你上' }
  const b = { situation: '夸奖别人', style: '厉害' }
  assert.ok(scoreExpression(a, '你刚才是不是被说菜了') > scoreExpression(b, '你刚才是不是被说菜了'))
  assert.equal(scoreExpression(a, ''), 1) // 无话题只按权重
})

test('sampleExpressions：有话题挑相关的，无话题也能抽满且不重复', () => {
  const list = [
    { situation: '被说菜时回嘴', style: '你行你上' },
    { situation: '夸奖别人', style: '厉害' },
    { situation: '无语', style: '……' },
  ]
  const withTopic = sampleExpressions(list, { topic: '被说菜', k: 1 })
  assert.equal(withTopic.length, 1)
  assert.equal(withTopic[0].style, '你行你上')

  const noTopic = sampleExpressions(list, { k: 3, rand: () => 0.5 })
  assert.equal(noTopic.length, 3)
  assert.equal(new Set(noTopic.map((x) => x.style)).size, 3)
  assert.deepEqual(sampleExpressions(list, { k: 0 }), [])
})

test('buildVoiceBlock：空配置不出块，满配置含四层与口癖', () => {
  assert.equal(buildVoiceBlock(readVoice({voice:{enabled:false}}), { expressions: [] }), '')

  const voice = readVoice({ voice: {
    personality: '一条住在电脑里的鲸鱼',
    behaviorStyle: '不会硬找话题',
    replyStyle: '短句，不用呢哦呀',
    multipleStyles: ['只回两个字'],
    styleMode: 'first',
    expressionTopK: 2,
  } })
  const block = buildVoiceBlock(voice, {
    expressions: [{ situation: '被说菜', style: '你行你上' }, { situation: '夸奖', style: '厉害' }],
    rand: () => 0,
  })
  for (const needle of ['她是谁', '什么时候说', '怎么打字', '这一次的语气', '她的口癖', '你行你上']) {
    assert.ok(block.includes(needle), '缺少: ' + needle)
  }
})

test('只有口癖没有四层时也要出块（人设文本可以留空）', () => {
  const block = buildVoiceBlock(readVoice({}), { expressions: [{ situation: '无语', style: '……' }] })
  assert.ok(block.includes('她的口癖'))
})

test('buildLearnPrompt：带格式说明与语料截断', () => {
  const p = buildLearnPrompt('群里有人说：我嘞个豆', { maxChars: 50 })
  assert.ok(p.includes('当 "AAAAA" 时'))
  assert.ok(p.includes('我嘞个豆'))
  assert.ok(buildLearnPrompt('x'.repeat(100), { maxChars: 10 }).includes('x'.repeat(10)))
})
import { validateVoice } from '../lib/voice.js'

test('probability gates alternate style; default and off do not select', () => {
  const base = readVoice({voice:{multipleStyles:['a','b'],multipleProbability:0}})
  assert.equal(pickReplyStyle(base,()=>0),'')
  assert.equal(pickReplyStyle({...base,multipleProbability:0.5},()=>0.6),'')
  const rolls=[0.4,0.9]
  assert.equal(pickReplyStyle({...base,multipleProbability:0.5},()=>rolls.shift()),'b')
  assert.equal(pickReplyStyle({...base,multipleProbability:1,styleMode:'off'},()=>0),'')
})

test('stable block never consumes randomness and turn block scopes alternate style', () => {
  const voice=readVoice({voice:{personality:'稳定人格',behaviorStyle:'观察再说',replyStyle:'短句',multipleStyles:['正式'],multipleProbability:1}})
  const stable=buildVoiceBlock(voice,{phase:'stable',rand:()=>{throw Error('stable must not draw')}})
  assert.match(stable,/稳定人格/)
  assert.doesNotMatch(stable,/正式|这一次/)
  const turn=buildVoiceBlock(voice,{phase:'turn',rand:()=>0})
  assert.match(turn,/正式/)
  assert.doesNotMatch(turn,/稳定人格|观察再说/)
  assert.match(turn,/不延续到后续任务/)
  assert.match(buildVoiceBlock({...voice,multipleProbability:0},{phase:'turn'}),/恢复默认表达/)
  assert.equal(buildVoiceBlock(readVoice({voice:{enabled:false}}),{phase:'turn'}),'')
  assert.equal(buildVoiceBlock(readVoice({voice:{enabled:false}}),{phase:'stable'}),'')
  assert.equal(validateVoice({multipleProbability:0}), '')
  assert.ok(validateVoice({multipleProbability:NaN}))
})
import vm from 'node:vm'
import fs from 'node:fs'

test('settings UI edits multiline persona/styles and saves structured voice configuration', async () => {
  const state=[{persona:{name:'保留角色'},voice:{personality:'原人格',replyStyle:'短句',multipleStyles:[],multipleProbability:0,styleMode:'random',expressionTopK:6}}]
  let cursor=0,client,saved,saveCount=0
  const react={createElement:(type,props,...children)=>({type,props:props??{},children}),useEffect:()=>{},useCallback:f=>f,
    useState(initial){const i=cursor++;if(!(i in state))state[i]=initial;return [state[i],value=>{state[i]=typeof value==='function'?value(state[i]):value}]} }
  vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'),{
    window:{__ModuleLoader__:{load({factory}){client=factory(()=>react)}}},
    fetch:async(url,options)=>{
      assert.equal(url,'/dsh-bili/api/settings')
      if (!options.body) return {ok:true,json:async()=>({voiceDefaults:JSON.parse(JSON.stringify(DEFAULT_VOICE))})}
      saveCount++;saved=JSON.parse(options.body).config;return {ok:true,json:async()=>({ok:true,config:saved})}
    },
  })
  const walk=(node)=>node&&typeof node==='object'?[node,...node.children.flat(Infinity).flatMap(walk)]:[]
  const render=()=>{cursor=0;return client.BiliWhaleSection()}
  let tree=render()
  assert.ok(walk(tree).some(n=>n.type==='details'))
  assert.ok(walk(tree).some(n=>n.type==='button'&&n.children.includes('恢复默认人格')))
  assert.ok(!/maibot|mai-mai|麦麦/i.test(JSON.stringify(tree)))
  for(const [key,text] of [['personality','第一行\n第二行'],['multipleStyles','正式，保留逗号\n随意\n']]) {
    const row=walk(tree).find(n=>typeof n.type==='function'&&n.props.f?.path.join('.')==='voice.'+key)
    assert.ok(row,key)
    cursor=30
    const control=walk(row.type(row.props)).find(n=>n.type==='textarea')
    control.props.onChange({target:{value:text}})
    tree=render()
  }
  assert.equal(state[0].voice.personality,'第一行\n第二行')
  assert.deepEqual(Array.from(state[0].voice.multipleStyles),['正式，保留逗号','随意',''])
  const button=walk(tree).find(n=>n.type==='button'&&n.children.includes('保存'))
  await button.props.onClick()
  assert.equal(saved.voice.personality,'第一行\n第二行')
  assert.equal(saved.voice.multipleStyles[0],'正式，保留逗号')
  assert.equal(saved.voice.multipleProbability,0)
  await walk(render()).find(n=>n.type==='button'&&n.children.includes('恢复默认人格')).props.onClick()
  assert.equal(saveCount,1,'恢复默认不会立即保存')
  assert.equal(state[0].voice.replyStyle,DEFAULT_VOICE.replyStyle)
  assert.equal(state[0].persona.name,'保留角色')
  await walk(render()).find(n=>n.type==='button'&&n.children.includes('保存')).props.onClick()
  assert.equal(saveCount,2)
  assert.deepEqual(saved.voice,DEFAULT_VOICE)
  assert.equal(saved.persona.name,'保留角色')
  const enabledRow=walk(render()).find(n=>typeof n.type==='function'&&n.props.f?.path.join('.')==='voice.enabled')
  cursor=30
  walk(enabledRow.type(enabledRow.props)).find(n=>n.type==='input').props.onChange({target:{checked:false}})
  assert.equal(state[0].voice.enabled,false)
  await walk(render()).find(n=>n.type==='button'&&n.children.includes('保存')).props.onClick()
  assert.equal(saved.voice.enabled,false)
})

test('starter handles missing/legacy empty config and preserves custom or disabled settings', () => {
  assert.deepEqual(readVoice({}), DEFAULT_VOICE)
  assert.deepEqual(readVoice({voice:{personality:'',behaviorStyle:'',replyStyle:'',multipleStyles:[],multipleProbability:0}}), DEFAULT_VOICE)
  const custom=readVoice({voice:{personality:'我的旧人设',replyStyle:'很正式',multipleStyles:['旧语气'],multipleProbability:0}})
  assert.equal(custom.personality,'我的旧人设')
  assert.equal(custom.replyStyle,'很正式')
  assert.equal(custom.multipleProbability,0)
  assert.deepEqual(custom.multipleStyles,['旧语气'])
  const disabled=readVoice({voice:{...DEFAULT_VOICE,enabled:false}})
  assert.equal(buildVoiceBlock(disabled,{expressions:[{situation:'夸奖',style:'厉害'}]}),'')
  assert.equal(buildVoiceBlock(disabled,{phase:'turn'}),'')
  assert.ok(validateVoice({enabled:'false'}))
})

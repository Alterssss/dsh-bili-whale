import {styleOverlap} from './corpus.mjs'
import { expressionPrompt } from './expression.mjs'
import { fingerprint } from './life-store.mjs'
// Offline paired comparison. Observations are diagnostics, never an AI detector.
export function compareExpressions(input) {
  if(!input||typeof input.context!=='string'||!input.context.trim())throw Error('需要相同的事实与上文 context')
  const scene=input.scene??'public-comment'
  const candidates=['direct','cat-draft'].map(mode=>{
    const text=String(input.candidates?.[mode]??'')
    if(text.length>16000)throw Error('候选过长')
    return {mode,prompt:expressionPrompt(scene,mode),text,abstain:!text.trim(),characters:text.length,
      lines:text.split('\n').length,questions:(text.match(/[？?]/g)??[]).length,
      formatWarning:/\*\*|&#\d+;/.test(text),hash:fingerprint(text)}
  })
  if(input.variants&&(typeof input.variants!=='object'||Array.isArray(input.variants)||Object.keys(input.variants).length>6))throw Error('对照方案最多6个，需使用对象')
  const styleVariants=Object.entries(input.variants??{}).map(([name,value])=>{
    if(value===null||!['string','object'].includes(typeof value))throw Error('对照方案内容无效')
    const text=typeof value==='string'?value:String(value.text??'');if(text.length>16000)throw Error('对照文案过长')
    const refs=input.references??[];if(!Array.isArray(refs)||refs.length>5||refs.some(r=>typeof r.text!=='string'||r.text.length>1000))throw Error('对照参考列表无效')
    return {name,text,abstain:!text.trim(),characters:Array.from(text).length,copyWarnings:styleOverlap(text,refs),review:typeof value==='object'?value.review??null:null}
  })
  return {version:1,scene,styleVariants,contextHash:fingerprint(input.context),context:input.context,candidates,
    review:input.review??null,checklist:['事实、否定、条件与承诺是否保持','是否回应上文而非重复摘要','是否暴露私人信息','有无撑场面或重复内容','是否应当不发'],
    limitation:'长度与词频不是自然度评分。需要人工或宿主模型按同一材料评阅；本工具不会调用外部模型或发布。'}
}

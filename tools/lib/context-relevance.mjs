import {terms} from './memory-index.mjs'
import {relationTopics} from './memory-relations.mjs'
const noise=new Set(['主人','本喵','本鲸','喵','你','我','的','了','啊','这个','那个'])
export function contextTerms(value){return [...new Set([...terms(value),...relationTopics(value)])].filter(x=>!noise.has(x)).slice(0,200)}
// 2026-10-30：修「记忆永远召回不到」——
//   terms() 只给中文 bigram（"累 睡" → ["累","睡"]，而记忆正文 → ["人最","最近",…]）
//   → 单字 query 的 score 恒为 0 → 被当成「不相关」丢弃 ✗
//   实测：一条「主人最近几晚都在深夜…说累」的理解，query「累 睡」得 0 分，进不了上下文 ✓
//   这里补一条单字包含判断：单字 token 在正文里出现就算命中 ✓
//   （宁可多召回一点：后面还有 ordinary>=3 的上限和按分数排序兜着 ✓）
export function contextScore(query,text){
  const tokens=contextTerms(query),body=String(text??''),words=new Set(contextTerms(text))
  let score=tokens.filter(x=>words.has(x)).length
  for(const t of tokens)if(t.length===1&&body.includes(t))score++
  return score
}

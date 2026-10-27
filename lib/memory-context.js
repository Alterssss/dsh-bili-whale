import {memoryPrompt} from '../tools/lib/memory.mjs'

// Cache refreshed only at delivery, never read disk during synchronous assembly.
export function createMemoryContext(ctx,{dshHome,log=()=>{},now=Date.now}) {
  let sessionId, snapshot='', dispose, native=false
  try {
    const service=ctx.systemPrompt || ctx.get?.('systemPrompt')
    if(typeof service?.context==='function') {
      dispose=service.context({name:'bili-whale/local-memory',order:50,interpolate:false,text:context=>
        sessionId && context?.agent?.session?.id===sessionId ? snapshot : ''})
      native=true
    }
  } catch {log('本地记忆：原生 context 不可用，使用有界投递 fallback')}
  log(`本地记忆：${native?'native context（按会话隔离）':'bounded delivery fallback'}`)
  return {
    get mode(){return native?'native':'fallback'},
    refresh(id) {
      sessionId=id
      try {snapshot=memoryPrompt(dshHome,{now:now()})}
      catch {snapshot='【本地有界记忆不可用】不要将缺失历史视为没有发生；需要人工检查本地文件。'}
      return native?'本次本地有界记忆由 bili-whale/local-memory context 提供；不足时使用 bili.mjs memory recall。':snapshot
    },
    stop(){sessionId=undefined;snapshot='';try {if(typeof dispose==='function')dispose()} catch {log('本地记忆：context 清理失败；缓存已清空')}},
  }
}

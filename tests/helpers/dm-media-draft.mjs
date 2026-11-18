import {lifeStore} from '../../tools/lib/life-runtime.mjs'
import {prepareExpression,finalizeExpression} from '../../tools/lib/expression.mjs'

const store=lifeStore()
const draft=await prepareExpression(store,{
  scene:'private-recommendation',target:'222',text:'看看 BV1234567890',video:'BV1234567890',
})
await finalizeExpression(store,draft.id)
console.log(draft.id)

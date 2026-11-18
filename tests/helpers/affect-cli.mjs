import {config} from '../../tools/lib/config.mjs'
import {lifeStore} from '../../tools/lib/life-runtime.mjs'
import {prepareExpression,finalizeExpression} from '../../tools/lib/expression.mjs'
const cfg=config();let at=Date.now()-(cfg.chat?.idle?4:1)*3600000
const store=lifeStore(cfg,{now:()=>at})
await store.ingestOwnerMessage({channel:'bili-dm',actor:'222',messageId:'affect-fixture',text:'一起聊聊小猫喜欢纸箱的原因吧'})
at+=60000
const job=await store.claimAffectJob(),e=job.sources[0]
await store.commitAffectJob(job.id,job.lease,JSON.stringify({moodEffects:[],contextHints:[],topicEffects:[{action:'create',topicId:null,summary:'小猫喜欢纸箱',reasonToShare:'一起聊过的有趣问题',category:'shared-interest',confidence:0.95,sourceEventIds:[e.id],quotes:[{eventId:e.id,text:'小猫喜欢纸箱'}]}]}))
at=Date.now();await store.tx(s=>{s.affect.share.value=80;s.affect.share.updatedAt=at})
const plan=await store.claimAffectInitiative(cfg)
if(!plan)throw Error('fixture plan unavailable: '+JSON.stringify(store.affectPreview(cfg)))
const text='上次聊到小猫喜欢纸箱，我觉得它们窝在里面的样子很有趣。'
const draft=await prepareExpression(store,{scene:'private-reply',target:'222',text,share:false});await finalizeExpression(store,draft.id)
await store.readyAffectPlan(plan.id,draft.id,text,JSON.stringify({covered:true,quote:'小猫喜欢纸箱'}),cfg)
console.log(JSON.stringify({planId:plan.id,draftId:draft.id}))

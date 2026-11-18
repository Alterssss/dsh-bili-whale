import {styleContext} from '../lib/corpus-runtime.mjs'
import {checkHard,HARD_RULE_IDS} from '../lib/expression-hard.mjs'
import { compareExpressions } from '../lib/expression-eval.mjs'
import { NODE_EXE } from '../lib/nodebin.mjs'
import { DSH_HOME } from '../lib/paths.mjs'
import { migrateLegacy } from '../lib/life-migration.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { lifeStore } from '../lib/life-runtime.mjs'
import { config } from '../lib/config.mjs'
import { lifeConfig } from '../lib/life-config.mjs'
import {sessionAudit,cleanupSessions} from '../lib/session-maintenance.mjs'
import { expressionPrompt,prepareExpression,editExpression,finalizeExpression } from '../lib/expression.mjs'

const argv=process.argv.slice(2),[cmd,arg,...rest]=argv,store=lifeStore()
const json=value=>console.log(JSON.stringify(value,null,2))
const input=file=>{if(!file||fs.statSync(file).size>128000)throw Error('需要不超过 128 KB 的 JSON 文件');return JSON.parse(fs.readFileSync(file,'utf8'))}
try{
  if(cmd==='pause'||cmd==='resume')json(await store.pause(cmd==='pause'))
  else if(cmd==='session-audit')json(sessionAudit(DSH_HOME,config()))
  else if(cmd==='cleanup-sessions'){
    const args=[arg,...rest],i=args.indexOf('--keep');json(cleanupSessions(DSH_HOME,config(),{keep:i<0?3:Number(args[i+1]),apply:args.includes('--apply')}))
  }
  else if(cmd==='rules')json(HARD_RULE_IDS)
  else if(cmd==='check'){const i=input(arg),result=checkHard(i.text,i.scene,lifeConfig(config().life));json(result);if(!result.ok)process.exitCode=2}
  else if(cmd==='diary-status')json(store.diaryStatus())
  else if(cmd==='diary-render')json(await store.renderDiary())
  else if(cmd==='affect-status')json(store.affectStatus())
  else if(cmd==='affect-explain')json(store.affectExplain())
  else if(cmd==='affect-preview')json(store.affectPreview(config()))
  else if(cmd==='dynamic-status')json(store.dynamicStatus())
  else if(cmd==='memory-migrate')json(await store.dynamicMigrate({apply:arg==='--apply'}))
  else if(cmd==='memory-catalog-preview')json(store.reader(rest[0]??'public').catalog(arg?input(arg):{}))
  else if(cmd==='memory-catalog')console.log(JSON.stringify(await store.reader(rest[0]??'public').taskCatalog(input(arg))))
  else if(cmd==='memory-history-preview')json(store.reader(rest[0]??'public').history(arg?input(arg):{}))
  else if(cmd==='memory-history')console.log(JSON.stringify(await store.reader(rest[0]??'public').taskCatalog({...input(arg),history:true})))
  else if(cmd==='memory-fetch')console.log(JSON.stringify(await store.reader(rest[0]??'public').readMemory(input(arg))))
  else if(cmd==='memory-explain')json(store.reader(rest[0]??'public').explain(arg))
  else if(cmd==='learning-status')json(store.learningStatus())
  else if(cmd==='induce-submit')json(await store.submitFormation(arg,rest[0],input(rest[1])))
  else if(cmd==='induce-review')json(await store.commitFormation(arg,rest[0],input(rest[1])))
  else if(cmd==='decision')json(await store.recordDecision(input(arg)))
  else if(cmd==='traces')json(store.decisionTraces())
  else if(cmd==='maintain')json(await store.maintainCognition())
  else if(cmd==='status')json(store.status())
  else if(cmd==='context')console.log(store.context(arg??'',rest[0]??'private'))
  else if(cmd==='legacy-recall')json(store.legacyRecall(rest[0]??'public',arg?input(arg):{}))
  else if(cmd==='legacy-source')json(store.legacySource(rest[0]??'public',input(arg)))
  else if(cmd==='context-explain')json(store.contextSnapshot(arg??'',rest[0]??'private-reply'))
  else if(cmd==='recall')json(store.reader(rest[0]??'public').recall(arg??''))
  else if(cmd==='rebuild')json(store.rebuildIndex())
  else if(cmd==='replay-check')json(store.replayCheck())
  else if(cmd==='consolidate')json(await store.consolidate(input(arg)))
  else if(cmd==='explain')json(store.reader(rest[0]??'public').get(arg))
  else if(cmd==='source')json(store.reader(rest[0]??'public').sources([arg]))
  else if(cmd==='search')json(store.search(arg??'',{archives:rest.includes('--archives'),scene:rest.includes('--private')?'private':'public'}))
  else if(cmd==='propose')json(await store.propose(input(arg)))
  else if(cmd==='reflect')json(await store.record('reflection',{...input(arg),origin:'model'}))
  else if(cmd==='diary')json(await store.record('diary',{...input(arg),origin:'model'}))
  else if(cmd==='archive')json(await store.archive())
  else if(cmd==='migrate')json(await migrateLegacy(store,DSH_HOME,{dryRun:arg!=='--apply'}))
  else if(cmd==='export')json(store.export())
  else if(cmd==='close')json(await store.closeThread(arg,rest.join(' ')||'completed'))
  else if(cmd==='agenda-add')json(await store.agendaAdd([arg,...rest].join(' ')))
  else if(cmd==='agenda-done')json(await store.agendaDone(arg,rest.join(' ')))
  else if(cmd==='activity-end')json(await store.endActivity(arg))
  else if(cmd==='activity-read'){
    const [command,...args]=rest
    if(!['feed','debrief','comments','search'].includes(command))throw Error('自主活动只允许白名单只读工具')
    const lease=await store.consumeActivity(arg)
    const remaining=Math.max(1,lease.expiresAt-Date.now())
    const result=spawnSync(NODE_EXE,[path.join(path.dirname(fileURLToPath(import.meta.url)),'..','bili.mjs'),command,...args,...(command==='debrief'?['--no-frames']:[])],{encoding:'utf8',env:{...process.env,WHALE_ACTIVITY_DEADLINE:String(lease.expiresAt)},timeout:Math.min(remaining,120000),maxBuffer:2*1024*1024,windowsHide:true})
    process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');if(result.error)throw result.error;process.exitCode=result.status??1
  }
  else if(cmd==='references'){
    const e=store.sources([arg])[0];if(e.kind!=='video-read')throw Error('参考入口需要本轮视频素材事件，不能用私信或风格例子代替')
    const p=styleContext(store,{scene:'public-comment',sourceIds:[arg],video:e.target,intent:rest[0]??'reaction'});if(p.library)await p.library.recordSelection(p)
    const {library:unused,...result}=p;json(result)
  }
  else if(cmd==='expression-plan'||cmd==='plan'){
    const p=styleContext(store,{scene:arg,title:rest.join(' '),query:rest.join(' ')})
    console.log(expressionPrompt(arg,lifeConfig(config().life).draftMode,lifeConfig(config().life))+'\n'+p.prompt+'\n'+store.context(rest.join(' '),arg==='public-comment'||arg==='reply'?'public':'private'))
  }
  else if(cmd==='compare')json(compareExpressions(input(arg)))
  else if(cmd==='prepare')json(await prepareExpression(store,input(arg)))
  else if(cmd==='revise')json(await editExpression(store,arg,fs.readFileSync(rest[0],'utf8')))
  else if(cmd==='finalize'||cmd==='discard')json(await finalizeExpression(store,arg,{discard:cmd==='discard'}))
  else console.log('life: dynamic-status | memory-migrate [--apply] | memory-catalog-preview <json> [scene] | memory-history-preview <json> [scene] | memory-catalog <json-with-taskId> [scene] | memory-history <json> [scene] | memory-fetch <json> [scene] | memory-explain <id> [scene] | learning-status | traces | decision <json> | maintain | induce-submit <jobId> <token> <json> | induce-review <jobId> <token> <json> | context-explain [query] [scene] | recall <query> [scene] | source <id> [scene] | legacy-recall <query.json> [scene] | legacy-source <ref.json> [scene] | rebuild | replay-check | consolidate <json> | migrate [--dry-run|--apply] | status | references <视频来源事件ID> [intent] | rules | check <json> | migrate | compare <json> | context [query] [scene] | search <query> [--archives] | propose <json> | reflect <json> | diary <json> | archive | export | close <thread> [reason] | agenda-add <text> | agenda-done <id> <result> | activity-read <lease> <feed|debrief|comments|search> [args] | activity-end <lease> | expression-plan <scene> | prepare <json> | revise <id> <text-file> | finalize <id> | discard <id>\n提案接受、撤销、线程恢复、不确定发送核查在设置页完成。')
}catch(e){console.error(e.message);process.exitCode=2}

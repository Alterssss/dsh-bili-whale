import {loadBehavior,BEHAVIOR_IDS} from '../lib/behavior.mjs'
try{
 const [action='list',id]=process.argv.slice(2)
 if(action==='read')console.log(loadBehavior([id])[0].text)
 else if(action==='list')console.log(JSON.stringify({sections:BEHAVIOR_IDS}))
 else if(action==='reload')console.log(JSON.stringify({status:'每次任务都会重新读取规范，无需重载'}))
 else throw Error('用法：behavior list | read <章节> | reload')
}catch(e){console.error(e.message);process.exitCode=1}

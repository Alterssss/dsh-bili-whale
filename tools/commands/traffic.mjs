import { HOME } from '../lib/paths.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { trafficGuard, riskSettings } from '../lib/traffic.mjs'
const [command='status', ...args] = process.argv.slice(2)
const value = flag => args[args.indexOf(flag)+1]
try {
  const guard=trafficGuard()
  if(command==='status') {
    const s=guard.status()
    console.log(JSON.stringify({settings:riskSettings(),pausedUntil:s.until??null,reason:s.reason??null,manualAccounts:Object.keys(s.manual??{}).length,accounts:s.accounts??{},pending:Object.entries(s.operations??{}).filter(([,v])=>['unknown','pending'].includes(v.status)).map(([id,v])=>({id,...v})),last:s.last??null},null,2))
  } else if(command==='resume' && args.includes('--go')) {
    const c=JSON.parse(fs.readFileSync(path.join(HOME,'.bili-ai/credentials.json'),'utf8'))
    await guard.resume({cookie:`SESSDATA=${c.sessdata}`})
    console.log('已解除当前账号的人工处理暂停；平台等待时间和发送记录仍保留。')
  } else if(command==='resolve' && args.includes('--go') && args.includes('--id') && args.includes('--outcome')) {
    await guard.resolve(value('--id'),value('--outcome'))
    console.log('已记录人工核查结果。')
  } else { console.error('用法：traffic status | resume --go（人工处理登录/验证码后）| resolve --id ID --outcome confirmed|not-sent --go（回读核查后）');process.exitCode=2 }
} catch(e) {console.error(e.message);process.exitCode=1}

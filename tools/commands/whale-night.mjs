// Shared planning engine: absolute timestamps and persistent per-window history.
import fs from 'node:fs'
import path from 'node:path'
import { dshPath } from '../lib/paths.mjs'
import { readNightConfig } from '../lib/night-config.mjs'
import { makePlan, completePlan, dayOf } from '../lib/night-plan.mjs'
import { requestNightTrigger, readNightTrigger } from '../../lib/night-trigger.js'
import { readSchedulerHealth } from '../../lib/scheduler-health.js'
import { deliveryStatus } from '../../lib/delivery-state.js'
import { config } from '../lib/config.mjs'
import { lifeStore } from '../lib/life-runtime.mjs'
const STATE = dshPath('whale-night.json')
const load = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return {} } }
const save = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n') }
const [cmd, ...args] = process.argv.slice(2)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
if (cmd === 'trigger') {
  try{
    if(args.length!==1||!['--dry','--go'].includes(args[0]))throw Error('用法: night trigger --dry 或 night trigger --go；必须明确选择')
    const result=await requestNightTrigger(dshPath(),{dry:args[0]==='--dry',getSnapshot:()=>{
      const cfg=config();return {night:readNightConfig(),state:load(),paused:cfg.life?.paused||lifeStore(cfg).read().settings.paused}
    }})
    console.log(JSON.stringify(result,null,2))
  }catch(e){console.error(e.message);process.exitCode=2}
} else if (cmd === 'plan') {
  const p = makePlan(readNightConfig(), load())
  save(STATE, p)
  console.log(JSON.stringify(p, null, 2))
} else if (cmd === 'mark') {
  save(dshPath('whale-wake'), { date: dayOf(), at: new Date().toISOString(), by: 'task' })
  console.log('已留唤醒标记')
} else if (cmd === 'status') {
  console.log(JSON.stringify({ config: readNightConfig(), state: load(), scheduler:readSchedulerHealth(dshPath()),trigger:readNightTrigger(dshPath()),delivery:deliveryStatus(dshPath()) }, null, 2))
} else if (cmd === 'clock') {
  if (args.includes('--test')) {
    await sleep(Math.max(0, Number(args[args.indexOf('--test') + 1] ?? 5)) * 1000)
    console.log('WHALE_WAKE (test; 不修改正式计划)')
  } else {
    const p = makePlan(readNightConfig(), load())
    save(STATE, p)
    if (p.action === 'done') console.log('WHALE_DONE ' + p.reason)
    else {
      while (Date.now() < p.atMs) {
        await sleep(Math.min(60000, p.atMs - Date.now()))
        const current = load()
        if (current.fired || current.atMs !== p.atMs || current.action !== p.action) {
          console.log('WHALE_DONE 计划已由宿主处理或更新'); process.exit(0)
        }
      }
      if (Date.now() >= p.endsAt) console.log('WHALE_DONE 窗口已结束，不补发过期唤醒')
      else {
        save(STATE, completePlan(p))
        console.log(p.action === 'skip' ? 'WHALE_SKIP ' + p.reason : 'WHALE_WAKE at=' + p.atText)
      }
    }
  }
} else { console.error('用法: night plan | clock [--test 秒] | mark | status | trigger --dry/--go'); process.exitCode = 2 }

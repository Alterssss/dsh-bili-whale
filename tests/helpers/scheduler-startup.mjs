import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'

const mode = process.argv[2]
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-startup-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = home
process.env.DSH_NODE = process.execPath
process.env.BILI_WHALE_CONFIG = path.join(home, 'bili-whale.config.json')
fs.writeFileSync(process.env.BILI_WHALE_CONFIG, JSON.stringify({
  self:{mid:'111'}, owner:{mid:'222'}, listen:{dm:false,comment:false},
  night:{windows:[]}, life:{learningEnabled:false,autonomy:false,affect:{enabled:false}},
}))
globalThis.fetch = async () => { throw Error('Unexpected network request in startup test') }
const nativeInterval = globalThis.setInterval
const nativeClearInterval = globalThis.clearInterval
const intervals = new Map()
const bootTimers = new Map()
const nativeTimeout = globalThis.setTimeout
const nativeClearTimeout = globalThis.clearTimeout
let registrations = 0
globalThis.setInterval = (...args) => {
  if (mode === 'registration-failure' && ++registrations === 2) throw Error('fixture timer registration failed')
  const handle = {}
  intervals.set(handle, {callback:args[0], ms:args[1]})
  return handle
}
globalThis.clearInterval = handle => {
  intervals.delete(handle)
}
globalThis.setTimeout = (callback, ms, ...args) => {
  if (![8000, 15000, 25000].includes(ms)) return nativeTimeout(callback, ms, ...args)
  const handle = {}
  bootTimers.set(handle, {callback, ms})
  return handle
}
globalThis.clearTimeout = handle => {
  if (!bootTimers.delete(handle)) nativeClearTimeout(handle)
}
const routes = new Map()
const disposers = []
const context = {
  sessionController:{prompt:async()=>{throw Error('Unexpected host prompt')}},
  webServer:{register(route){routes.set(route.path,route.handler);return ()=>routes.delete(route.path)}},
  get(name){return name === 'connection' ? {requestRejection:req=>req.headers.authorization === 'fixture' ? false : 401} : undefined},
  effect(fn){disposers.push(fn())},
}
Object.defineProperty(context, 'workspaceController', {
  get(){throw Error('workspaceController is unavailable')},
})
const healthPath = path.join(home, 'whale-scheduler.json')
const readHealth = () => JSON.parse(fs.readFileSync(healthPath,'utf8'))
try {
  const {default:plugin} = await import('../../lib/index.js')
  if (mode === 'config-failure') {
    const {startScheduler} = await import('../../lib/scheduler.js')
    fs.writeFileSync(process.env.BILI_WHALE_CONFIG, '{')
    assert.throws(()=>startScheduler(context,{dshHome:home,cwd:home}),/JSON|property|Expected/i)
    assert.equal(readHealth().status,'startup-failed')
    assert.equal(intervals.size,0)
  } else {
    assert.ok(Array.isArray(plugin.inject) && plugin.inject.includes('sessionController'))
    plugin.apply(context)
    assert.ok(routes.has('/dsh-bili/api/settings'))
    if (mode === 'registration-failure') {
      assert.equal(readHealth().status,'startup-failed')
      assert.match(readHealth().lastError.message,/fixture timer registration failed/)
      assert.equal(intervals.size,0,'Partially registered timers must be removed')
    } else {
      const initial = readHealth()
      assert.equal(initial.status,'waiting')
      assert.ok(initial.timersRegisteredAt)
      assert.ok(initial.recent.some(item=>item.reason==='service-unavailable'))
      assert.equal(intervals.size,5)
      const statusRoute = routes.get('/dsh-bili/api/status')
      async function status(auth) {
        let payload
        const response = {writeHead(code){this.statusCode=code},end(text){payload=text?JSON.parse(text):undefined}}
        await statusRoute({method:'GET',headers:{host:'localhost',authorization:auth}},response)
        return {status:response.statusCode,payload}
      }
      assert.equal((await status()).status,401)
      async function waitForTick(after) {
        for (let i=0;i<200;i++) {
          const snapshot = readHealth()
          if (snapshot.lastTickAt > after && !snapshot.activeRun && fs.existsSync(path.join(home,'whale-night.json'))) return snapshot
          await delay(10)
        }
        assert.fail('scheduler tick did not complete')
      }
      const bootTimer = [...bootTimers.values()].find(timer=>timer.ms===8000)
      assert.ok(bootTimer)
      await delay(10)
      bootTimer.callback()
      const boot = await waitForTick(initial.startedAt)
      assert.ok(fs.existsSync(path.join(home,'whale-night.json')))
      const tick = [...intervals.values()].filter(timer=>timer.ms===60000).at(-1)
      assert.ok(tick)
      await delay(10)
      tick.callback()
      await waitForTick(boot.lastTickAt)
      const report = await status('fixture')
      assert.equal(report.status,200)
      for (const key of ['scheduler','delivery','affectWorker','diary','diaryWorker','socialWorker','formation']) {
        assert.ok(report.payload[key], key+' status is missing')
      }
      assert.equal(report.payload.formation.mode,'direct-json')
      for (const dispose of disposers.splice(0)) dispose?.()
      assert.equal(intervals.size,0)
      assert.equal(bootTimers.size,0)
      assert.equal(routes.size,0)
    }
  }
  console.log('PASS '+mode)
} finally {
  for (const dispose of disposers) dispose?.()
  globalThis.setInterval = nativeInterval
  globalThis.clearInterval = nativeClearInterval
  globalThis.setTimeout = nativeTimeout
  globalThis.clearTimeout = nativeClearTimeout
  fs.rmSync(home,{recursive:true,force:true})
}

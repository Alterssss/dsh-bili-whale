import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('actual whale scheduler in push mode creates no periodic DM poller and ignores untriggered dmTick', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-push-scheduler-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const values = { DSH_HOME: dir, USERPROFILE: dir, BILI_WHALE_CONFIG: path.join(dir, 'bili-whale.config.json'), DSH_NODE: process.execPath }
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  Object.assign(process.env, values)
  t.after(() => { for (const key of Object.keys(values)) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key] })
  fs.writeFileSync(values.BILI_WHALE_CONFIG, JSON.stringify({ listen: { dm: true, dmTransport: 'push' }, self: { mid: '123456789' }, owner: { mid: '987654321' } }))
  const saved = { setInterval, setTimeout, clearInterval, clearTimeout }; const intervals = []
  globalThis.setInterval = (_fn, ms) => { const handle = { ms }; intervals.push(handle); return handle }
  globalThis.setTimeout = (_fn, ms) => ({ ms })
  globalThis.clearInterval = () => {}; globalThis.clearTimeout = () => {}
  t.after(() => Object.assign(globalThis, saved))
  const { startScheduler } = await import('../lib/scheduler.js')
  let prompts = 0
  const scheduler = startScheduler({ sessionController: { create: async () => ({}), prompt: async () => prompts++ } },
    { dshHome: dir, cwd: dir, biliMjs: new URL('../tools/bili.mjs', import.meta.url).pathname })
  try {
    await scheduler.dmTick()
    assert.equal(intervals.filter(timer => timer.ms === 20000).length, 0)
    assert.equal(prompts, 0)
  } finally { await scheduler.stop() }
})

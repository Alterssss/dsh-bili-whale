import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDmPushController } from '../lib/dm-push-controller.js'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function fixture(t, drain, more = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-push-controller-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const config = { self: { mid: '123456789' }, owner: { mid: '987654321' }, listen: { dm: true, dmTransport: 'push' } }
  let callbacks; let starts = 0; let stops = 0
  const controller = createDmPushController({ dshHome: dir, getConfig: () => config, credentialsFile: '/fixture/credentials', drain, debounceMs: 5,
    createReceiver(options) { callbacks = options; return { start() { starts++; options.onReady() }, async stop() { stops++ } } }, ...more })
  t.after(() => controller.stop())
  return { controller, config, callbacks: () => callbacks, starts: () => starts, stops: () => stops }
}
test('idle connection performs one recovery sync and never periodically fetches the inbox', async t => {
  let reads = 0; const f = fixture(t, async () => { reads++; return { ok: true } })
  await f.controller.sync(); await pause(25); assert.equal(reads, 1)
  await pause(60); assert.equal(reads, 1)
  f.callbacks().onNotify(); f.callbacks().onNotify(); f.callbacks().onNotify()
  await pause(25); assert.equal(reads, 2)
})
test('notification arriving during a drain is preserved and queued messages finish without another push', async t => {
  let reads = 0; let release
  const f = fixture(t, async () => {
    reads++
    if (reads === 1) await new Promise(resolve => { release = resolve })
    return { ok: true, pending: reads === 2 }
  })
  await f.controller.sync(); await pause(20); f.callbacks().onNotify(); release()
  await pause(50); assert.equal(reads, 3)
})
test('failed delivery uses bounded retry delay rather than a tight loop', async t => {
  let reads = 0; const f = fixture(t, async () => { reads++; return { ok: false, retryable: true } }, { retryDeadlineMs: 30 })
  await f.controller.sync(); await pause(60)
  assert.equal(reads, 1)
  assert.equal(f.controller.status().deliveryError, 'delivery-retry-pending')
})
test('invalid push configuration never falls back to polling, and disabling closes the receiver', async t => {
  let reads = 0; const f = fixture(t, async () => { reads++; return { ok: true } })
  await f.controller.sync(); await pause(20)
  f.config.listen.dm = false; await f.controller.sync(); assert.equal(f.stops(), 1)
  const before = reads; f.callbacks().onNotify(); await pause(25); assert.equal(reads, before)
  const bad = fixture(t, async () => { reads++; }, { createReceiver: () => { throw Error('fixture') } })
  await bad.controller.sync(); await pause(25); assert.equal(bad.controller.status().phase, 'blocked'); assert.equal(reads, before)
})

test('refreshing credentials replaces the connection and ignores callbacks from the old receiver', async t => {
  let reads = 0; const f = fixture(t, async () => { reads++; return { ok: true } })
  await f.controller.sync(); await pause(20); const old = f.callbacks()
  await f.controller.sync(true); await pause(20)
  assert.equal(f.starts(), 2); assert.equal(f.stops(), 1)
  const before = reads
  old.onNotify(); old.onStatus({ phase: 'stale-receiver' })
  await pause(20)
  assert.equal(reads, before); assert.notEqual(f.controller.status().phase, 'stale-receiver')
})

test('changing the owner while consuming does not schedule an old-owner retry', async t => {
  let reads = 0, release
  const f = fixture(t, async () => {
    if (++reads === 1) return new Promise(resolve => { release = resolve })
    return { ok: true }
  })
  await f.controller.sync(); await pause(20)
  f.config.owner.mid = '555555555'; await f.controller.sync()
  release({ ok: false, retryable: true }); await pause(30)
  assert.equal(reads, 2)
  assert.notEqual(f.controller.status().deliveryError, 'delivery-retry-pending')
})

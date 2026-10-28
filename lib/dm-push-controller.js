import fs from 'node:fs'
import path from 'node:path'
import { createDmPushReceiver } from './dm-push-receiver.js'

// Notifications own this queue. There is no idle inbox polling timer: a pull
// happens on a push hint, connection recovery, or a bounded retry of that work.
export function createDmPushController({ dshHome, getConfig, credentialsFile, drain, log = () => {},
  createReceiver = createDmPushReceiver, debounceMs = 300, retryDeadlineMs = 120000 } = {}) {
  let receiver = null, key = null, stopped = false, timer = null, busy = false, pending = false
  let deadline = 0, reason = '', errors = 0, pendingDelay = debounceMs, chain = Promise.resolve(), generation = 0
  const status = { transport: 'push', phase: 'idle', pollingEnabled: false, drains: 0, failures: 0 }
  const file = path.join(dshHome, 'whale-dm-push.json')
  function publish(update = {}) {
    Object.assign(status, update, { at: new Date().toISOString() })
    try {
      fs.mkdirSync(dshHome, { recursive: true })
      const tmp = file + '.' + process.pid + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(status, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file)
    } catch { log('[bili-whale] 无法保存私信推送状态') }
  }
  function enqueue(trigger, delay = debounceMs, fresh = true) {
    if (stopped || !receiver) return
    if (fresh || !pending) { reason = trigger; pendingDelay = delay }
    else pendingDelay = Math.min(pendingDelay, delay)
    pending = true
    if (fresh) deadline = Date.now() + retryDeadlineMs
    if (busy) return
    if (timer && !fresh) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(consume, pendingDelay)
  }
  async function consume() {
    timer = null
    if (stopped || !receiver || busy || !pending) return
    if (reason === 'delivery-retry' && Date.now() > deadline) {
      pending = false; publish({ deliveryError: 'delivery-retry-deadline' }); return
    }
    busy = true; pending = false
    const activeGeneration = generation
    publish({ drains: status.drains + 1, lastDrainReason: reason, lastDrainAt: new Date().toISOString(), consuming: true })
    try {
      const result = await drain()
      if (stopped || activeGeneration !== generation) return
      if (result?.ok) {
        errors = 0
        publish({ deliveryError: null })
        if (result.pending) enqueue('queued-message')
      } else if (result?.retryable && Date.now() < deadline) {
        errors++
        enqueue('delivery-retry', Math.min(30000, 1000 * 2 ** Math.min(errors, 5)), false)
        publish({ failures: status.failures + 1, deliveryError: 'delivery-retry-pending' })
      } else if (result && !result.ok) publish({ deliveryError: result.reason || 'delivery-needs-attention' })
    } catch {
      publish({ failures: status.failures + 1, deliveryError: 'delivery-needs-attention' })
    } finally {
      busy = false; publish({ consuming: false })
      if (pending && !timer && !stopped && receiver) timer = setTimeout(consume, pendingDelay)
    }
  }
  function sync(force = false) {
    const operation = chain.then(async () => {
      if (stopped) return
      const cfg = getConfig(), listen = cfg.listen ?? {}
      const enabled = listen.dm === true && listen.dmTransport === 'push'
      const next = enabled ? JSON.stringify([cfg.self?.mid, cfg.owner?.mid]) : null
      if (!force && next === key) return
      const receiverGeneration = ++generation
      key = next; if (timer !== null) clearTimeout(timer); timer = null; pending = false
      const previous = receiver; receiver = null; await previous?.stop()
      if (!enabled) { if (previous) publish({ phase: 'disabled', connected: false, subscribed: false }); return }
      try {
        if (stopped) return
        receiver = createReceiver({ credentialsFile, selfMid: String(cfg.self?.mid ?? ''), ownerMid: String(cfg.owner?.mid ?? ''),
          onNotify: () => { if (!stopped && receiverGeneration === generation) enqueue('push-notification') },
          onReady: () => { if (!stopped && receiverGeneration === generation) enqueue('connection-sync') },
          onStatus: value => { if (!stopped && receiverGeneration === generation) publish(value) },
        })
        receiver.start()
      } catch {
        publish({ phase: 'blocked', connected: false, subscribed: false, error: 'push-start-failed' })
        log('[bili-whale] 私信推送启动失败；未回退到轮询，请检查 whale-dm-push.json')
      }
    })
    chain = operation.catch(() => {}); return operation
  }
  return {
    sync,
    status: () => ({ ...status }),
    async stop() {
      stopped = true; generation++; if (timer !== null) clearTimeout(timer); timer = null; pending = false
      await chain
      const previous = receiver; receiver = null; await previous?.stop()
      if (key !== null) publish({ phase: 'stopped', connected: false, subscribed: false })
    },
  }
}

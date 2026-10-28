import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import NativeWebSocket from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { getProxyForUrl } from 'proxy-from-env'
import { PATH, numberField, bytesField, message, encodeFrame, decodeFrame, decodeNotify } from './dm-push-protocol.js'

export function createDmPushReceiver(options) { return new DmPushReceiver(options) }

export class DmPushReceiver {
  constructor({ credentialsFile, selfMid, ownerMid, onNotify = () => {}, onReady = () => {}, onStatus = () => {},
    WebSocket = NativeWebSocket, proxy = getProxyForUrl('https://broadcast.chat.bilibili.com:7826/sub'), heartbeatMs = 20000, handshakeMs = 12000,
    retryBaseMs = 1000, retryMaxMs = 60000, random = Math.random, loadCookie } = {}) {
    if (!/^[1-9]\d{0,19}$/.test(selfMid) || !/^[1-9]\d{0,19}$/.test(ownerMid) || selfMid === ownerMid) throw Error('Distinct pet and owner identities are required')
    if (proxy && !['http:', 'https:'].includes(new URL(proxy).protocol)) throw Error('Only HTTP(S) WebSocket proxies are supported')
    Object.assign(this, { credentialsFile, selfMid, ownerMid, onNotify, onReady, onStatus, WebSocket, proxy,
      heartbeatMs, handshakeMs, retryBaseMs, retryMaxMs, random })
    this.loadCookie = loadCookie ?? (() => {
      const c = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'))
      if (!c.sessdata) throw Error('Missing pet login')
      return `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct ?? ''}; buvid3=${c.buvid3 ?? ''}; DedeUserID=${selfMid}`
    })
    this.status = { transport: 'websocket', connected: false, authenticated: false, subscribed: false,
      notifications: 0, ownerNotifications: 0, heartbeats: 0, reconnects: 0, phase: 'idle' }
    this.guid = randomUUID(); this.seen = new Set(); this.stopped = true; this.failures = 0; this.generation = 0
  }
  publish(update) {
    Object.assign(this.status, update, { at: new Date().toISOString() })
    try { this.onStatus({ ...this.status }) } catch {}
  }
  start() { if (!this.stopped) return; this.stopped = false; this.connect() }
  connect() {
    if (this.stopped || this.status.phase === 'blocked') return
    const generation = ++this.generation
    this.sequence = 1; this.missed = 0
    this.publish({ phase: 'connecting', connected: false, authenticated: false, subscribed: false, error: null })
    let cookie
    try { cookie = this.loadCookie() } catch { this.publish({ phase: 'blocked', error: 'credential-unavailable' }); return }
    let ws
    try {
      ws = new this.WebSocket('wss://broadcast.chat.bilibili.com:7826/sub', 'proto', {
        headers: { Cookie: cookie, Origin: 'https://message.bilibili.com', 'User-Agent': 'Mozilla/5.0' },
        ...(this.proxy ? { agent: new HttpsProxyAgent(this.proxy) } : {}),
        handshakeTimeout: this.handshakeMs, maxPayload: 1024 * 1024,
      })
    } catch { this.retry('connect-failed'); return }
    this.ws = ws
    const current = () => !this.stopped && this.generation === generation
    this.handshakeTimer = setTimeout(() => { if (current()) this.disconnect('handshake-timeout') }, this.handshakeMs)
    ws.on('open', () => {
      if (!current()) return
      this.publish({ connected: true, phase: 'authenticating' })
      try { this.authSequence = this.send(PATH.auth, 'AuthReq', bytesField(1, this.guid)) } catch { this.disconnect('auth-send-failed') }
    })
    ws.on('message', data => { if (current()) this.receive(data) })
    ws.on('unexpected-response', (_request, response) => {
      response.resume()
      if (!current()) return
      if ([401, 403].includes(response.statusCode)) this.block('http-auth-' + response.statusCode)
      else this.disconnect('http-status-' + response.statusCode)
    })
    ws.on('error', error => {
      if (current()) this.publish({ error: /^[A-Z_0-9-]{1,64}$/.test(error.code ?? '') ? error.code : 'socket-error' })
    })
    ws.on('close', () => {
      if (!current()) return
      this.clearConnectionTimers()
      this.publish({ connected: false, authenticated: false, subscribed: false })
      if (this.status.phase !== 'blocked') this.retry(this.status.error || 'connection-closed')
    })
  }
  send(target, type, body) {
    const sequence = ++this.sequence
    this.ws.send(encodeFrame(sequence, target, type, body))
    return String(sequence)
  }
  receive(data) {
    try {
      const frame = decodeFrame(data)
      if (frame.status !== 0) return this.block('server-status-' + frame.status)
      if (frame.isAck) this.send(PATH.ack, 'MessageAckReq', message(numberField(1, frame.messageId), bytesField(2, frame.ackOrigin), bytesField(3, frame.target), numberField(4, frame.msgType)))
      if (frame.target === PATH.auth && frame.sequence === this.authSequence && !this.status.authenticated) {
        this.publish({ authenticated: true, phase: 'subscribing' })
        this.subscribeSequence = this.send(PATH.subscribe, 'TargetPath', bytesField(1, PATH.notify))
      } else if (frame.target === PATH.subscribe && frame.sequence === this.subscribeSequence && this.status.authenticated && !this.status.subscribed) {
        clearTimeout(this.handshakeTimer)
        this.publish({ subscribed: true, phase: 'ready', error: null })
        this.heartbeatTimer = setInterval(() => {
          if (++this.missed > 3) return this.disconnect('heartbeat-timeout')
          try { this.send(PATH.heartbeat, 'HeartbeatResp') } catch { this.disconnect('heartbeat-send-failed') }
        }, this.heartbeatMs)
        try { this.onReady() } catch {}
      } else if (frame.target === PATH.heartbeat) {
        this.missed = 0; this.failures = 0; this.publish({ heartbeats: this.status.heartbeats + 1 })
      } else if (frame.target === PATH.notify || frame.type.endsWith('.NotifyRsp')) {
        if (!this.status.subscribed) return
        const hint = decodeNotify(frame.body)
        if (hint.uid !== '0' && hint.uid !== this.selfMid) return this.block('recipient-mismatch')
        if (hint.command === 2) return this.block('server-kick-out')
        if (hint.command !== 1) return
        const key = frame.messageId !== '0' ? 'frame:' + frame.messageId
          : hint.messageKey !== '0' ? 'message:' + hint.messageKey : hint.sequence !== '0' ? 'sequence:' + hint.sequence : null
        if (key && this.seen.has(key)) return
        if (key) { this.seen.add(key); if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value) }
        const related = hint.talkers.length === 0 || hint.talkers.includes(this.ownerMid)
        this.publish({ notifications: this.status.notifications + 1,
          ownerNotifications: this.status.ownerNotifications + Number(related), lastNotificationAt: new Date().toISOString() })
        if (related) try { this.onNotify({ frameId: frame.messageId, sequence: hint.sequence, ownerRelated: true }) } catch {}
      }
    } catch { this.disconnect('invalid-protocol-frame') }
  }
  clearConnectionTimers() { clearTimeout(this.handshakeTimer); clearInterval(this.heartbeatTimer) }
  block(reason) {
    this.clearConnectionTimers(); clearTimeout(this.retryTimer)
    this.publish({ phase: 'blocked', error: reason, connected: false, authenticated: false, subscribed: false })
    this.ws?.terminate()
  }
  disconnect(reason) { this.publish({ error: reason }); this.ws?.terminate() }
  retry(reason) {
    if (this.stopped || this.retryTimer || this.status.phase === 'blocked') return
    const base = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(this.failures++, 10))
    const delay = Math.min(this.retryMaxMs, Math.round(base * (1 + this.random() * 0.2)))
    this.publish({ phase: 'reconnecting', error: reason, reconnects: this.status.reconnects + 1, retryInMs: delay })
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect() }, delay)
  }
  async stop() {
    if (this.stopped) return
    this.stopped = true; this.generation++; this.clearConnectionTimers(); clearTimeout(this.retryTimer); this.retryTimer = null
    const ws = this.ws
    if (ws && ws.readyState !== 3) await new Promise(resolve => {
      const timer = setTimeout(() => { ws.terminate(); resolve() }, 1000)
      ws.once('close', () => { clearTimeout(timer); resolve() }); ws.close()
    })
    this.publish({ phase: 'stopped', connected: false, authenticated: false, subscribed: false })
  }
}

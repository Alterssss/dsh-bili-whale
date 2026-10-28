import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { DmPushReceiver } from '../lib/dm-push-receiver.js'
import { PATH, decodeFrame, decodeNotify, numberField, bytesField, message } from '../lib/dm-push-protocol.js'

// Public, generic acknowledgement frames captured from Bilibili's current
// official web SDK. They contain no account, authentication or message content.
const authAck = Buffer.from('0a02100212252f62696c6962696c692e62726f6164636173742e76312e42726f6164636173742f417574681a340a32747970652e676f6f676c65617069732e636f6d2f62696c6962696c692e62726f6164636173742e76312e4175746852657370', 'hex')
const subAck = Buffer.from('0a021003122a2f62696c6962696c692e62726f6164636173742e76312e42726f6164636173742f5375627363726962651a2b0a29747970652e676f6f676c65617069732e636f6d2f676f6f676c652e70726f746f6275662e456d707479', 'hex')
class Socket extends EventEmitter {
  static instances = []
  constructor(_url, _protocol, options) { super(); this.options = options; this.readyState = 1; this.sent = []; Socket.instances.push(this) }
  send(data) { this.sent.push(decodeFrame(data)) }
  terminate() { this.readyState = 3; this.emit('close') }
  close() { this.terminate() }
}
function fixture(t, extra = {}) {
  const notifications = []; let ready = 0
  const receiver = new DmPushReceiver({ selfMid: '123456789', ownerMid: '987654321', WebSocket: Socket,
    proxy: '', loadCookie: () => 'test-fixture', retryBaseMs: 5, retryMaxMs: 10, random: () => 0,
    onNotify: event => notifications.push(event), onReady: () => ready++, ...extra })
  receiver.start(); const ws = Socket.instances.at(-1); ws.emit('open')
  t.after(() => receiver.stop())
  return { receiver, ws, notifications, ready: () => ready }
}
function notifyFrame({ uid = '123456789', sender = '987654321', key = '999999999999999999', id = '9007199254740999' } = {}) {
  const instant = message(numberField(1, sender), numberField(3, uid), bytesField(6, 'must-not-be-decoded'), numberField(11, key))
  const notify = message(numberField(1, uid), numberField(2, 1), bytesField(3, bytesField(2, instant)))
  return message(bytesField(1, message(numberField(1, id), numberField(3, 1))), bytesField(2, PATH.notify), bytesField(3, message(bytesField(1, 'type.googleapis.com/bilibili.broadcast.message.im.NotifyRsp'), bytesField(2, notify))))
}
test('real web acknowledgement frames drive authentication then subscription', async t => {
  const f = fixture(t)
  assert.equal(f.receiver.status.subscribed, false)
  f.ws.emit('message', authAck); assert.equal(f.ws.sent.at(-1).target, PATH.subscribe)
  f.ws.emit('message', subAck); assert.equal(f.ready(), 1); assert.equal(f.receiver.status.phase, 'ready')
})
test('only owner hints trigger consumption; duplicate packets are acknowledged but not redelivered', t => {
  const f = fixture(t); f.ws.emit('message', authAck); f.ws.emit('message', subAck)
  const bytes = notifyFrame(); f.ws.emit('message', bytes); f.ws.emit('message', bytes)
  assert.equal(f.notifications.length, 1)
  assert.equal(f.ws.sent.filter(frame => frame.target === PATH.ack).length, 2)
  assert.ok(!JSON.stringify(f.notifications).includes('must-not-be-decoded'))
  f.ws.emit('message', notifyFrame({ sender: '888', id: '999' })); assert.equal(f.notifications.length, 1)
})
test('notification identity mismatch blocks the stream rather than delivering another account', t => {
  const f = fixture(t); f.ws.emit('message', authAck); f.ws.emit('message', subAck)
  f.ws.emit('message', notifyFrame({ uid: '123' })); assert.equal(f.receiver.status.phase, 'blocked'); assert.equal(f.notifications.length, 0)
})
test('disconnect reconnects with bounded backoff and stop prevents all later connections', async t => {
  const f = fixture(t); const before = Socket.instances.length; f.ws.terminate()
  await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(Socket.instances.length > before)
  await f.receiver.stop(); const stoppedAt = Socket.instances.length
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(Socket.instances.length, stoppedAt)
})
test('protobuf notification IDs keep 64-bit precision and malformed frames are rejected', () => {
  const decoded = decodeFrame(notifyFrame()); assert.equal(decoded.messageId, '9007199254740999')
  const hint = decodeNotify(decoded.body); assert.equal(hint.messageKey, '999999999999999999')
  assert.throws(() => decodeFrame(Buffer.from([0x1a, 0x7f, 0x01])), /Truncated/)
})

test('an authentication rejection blocks reconnects instead of retrying invalid credentials', async t => {
  const f = fixture(t); const before = Socket.instances.length
  f.ws.emit('message', message(bytesField(1, bytesField(4, numberField(1, 401))), bytesField(2, PATH.auth)))
  assert.equal(f.receiver.status.phase, 'blocked')
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(Socket.instances.length, before)
})

test('missing heartbeat replies close the old socket and reconnect', async t => {
  const f = fixture(t, { heartbeatMs: 5 }); const before = Socket.instances.length
  f.ws.emit('message', authAck); f.ws.emit('message', subAck)
  await new Promise(resolve => setTimeout(resolve, 45))
  assert.equal(f.ws.readyState, 3); assert.ok(Socket.instances.length > before)
})

test('default proxy selection honors NO_PROXY for the broadcast host', async t => {
  const keys = ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy']
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  t.after(() => { for (const key of keys) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key] })
  process.env.HTTPS_PROXY = process.env.https_proxy = 'http://127.0.0.1:12345'
  process.env.NO_PROXY = process.env.no_proxy = '.bilibili.com'
  const f = fixture(t, { proxy: undefined })
  assert.equal(f.ws.options.agent, undefined)
})

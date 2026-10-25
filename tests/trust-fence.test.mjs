import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

globalThis.setInterval = () => ({})
globalThis.setTimeout = () => ({})
globalThis.clearInterval = () => {}
globalThis.clearTimeout = () => {}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-trust-'))
const dshHome = path.join(home, '.dsh')
fs.mkdirSync(dshHome, { recursive: true })
process.env.USERPROFILE = home
process.env.HOME = home
process.env.DSH_HOME = dshHome
process.env.DSH_NODE = process.execPath
process.env.BILI_WHALE_CONFIG = path.join(dshHome, 'bili-whale.config.json')

const { default: plugin } = await import('../lib/index.js')

function mount(connection) {
  const routes = new Map()
  const ctx = {
    get: (name) => (name === 'connection' ? connection : undefined),
    webServer: { register: (r) => { routes.set(r.path, r.handler); return () => {} } },
    effect: () => {},
  }
  plugin.apply(ctx)
  return routes
}

function request(routes, name, { host, method = 'GET', body = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = method
    req.headers = { host }
    const res = {
      statusCode: 200,
      writeHead(code) { this.statusCode = code },
      end(text) { resolve({ status: this.statusCode, data: text ? JSON.parse(text) : null }) },
    }
    routes.get('/dsh-bili/api/' + name)(req, res).catch(reject)
  })
}

test.after(() => fs.rmSync(home, { recursive: true, force: true }))

test('loopback is trusted without consulting the connection service', async () => {
  const routes = mount({ isTrusted: () => false, requestRejection: () => undefined })
  assert.equal((await request(routes, 'settings', { host: '127.0.0.1:3080' })).status, 200)
})

test('LAN bind address accepted when DSH trust fence accepts it', async () => {
  const seen = []
  const routes = mount({
    isTrusted: (req) => (seen.push(req.headers.host), req.headers.host === '192.168.0.101:3080'),
    requestRejection: () => undefined,
  })
  const r = await request(routes, 'settings', { host: '192.168.0.101:3080' })
  assert.equal(r.status, 200)
  assert.deepEqual(seen, ['192.168.0.101:3080'])
})

test('untrusted host is rejected with 403', async () => {
  const routes = mount({ isTrusted: () => false, requestRejection: () => undefined })
  const r = await request(routes, 'settings', { host: 'evil.example:3080' })
  assert.equal(r.status, 403)
  assert.match(r.data.error, /不受信任/)
})

test('trusted host still requires authentication', async () => {
  const routes = mount({ isTrusted: () => true, requestRejection: () => 401 })
  assert.equal((await request(routes, 'settings', { host: '192.168.0.101:3080' })).status, 401)
})

test('connection service missing stays fail-closed', async () => {
  const routes = mount(undefined)
  assert.equal((await request(routes, 'settings', { host: '192.168.0.101:3080' })).status, 403)
  assert.equal((await request(routes, 'settings', { host: '127.0.0.1:3080' })).status, 503)
})

test('write routes apply the same trust rule', async () => {
  const trusted = mount({ isTrusted: (req) => req.headers.host === '192.168.0.101:3080', requestRejection: () => undefined })
  assert.equal((await request(trusted, 'settings', { host: '192.168.0.101:3080', method: 'POST', body: { sessionRotateDays: 3 } })).status, 200)

  const untrusted = mount({ isTrusted: () => false, requestRejection: () => undefined })
  assert.equal((await request(untrusted, 'settings', { host: 'evil.example:3080', method: 'POST', body: { sessionRotateDays: 3 } })).status, 403)
})

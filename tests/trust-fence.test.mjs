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
  assert.ok(Array.isArray(plugin.inject), 'DSH host requires an array of injected service names')
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

test('plugin declares the supported host dependencies without requiring a workspace service', () => {
  assert.deepEqual(plugin.inject, ['sessionController', 'webServer', 'connection'])
  const routes = mount({ requestRejection: () => 401 })
  assert.ok(routes.has('/dsh-bili/api/settings'))
  assert.ok(routes.has('/dsh-bili/api/life'))
})

test('corpus administration uses the same trust and authentication fence',async()=>{
 for(const action of ['list','review','revoke','export']){
  assert.equal((await request(mount({isTrusted:()=>false,requestRejection:()=>undefined}),'corpus',{host:'evil.example',method:'POST',body:{action}})).status,403)
  assert.equal((await request(mount({isTrusted:()=>true,requestRejection:()=>401}),'corpus',{host:'127.0.0.1',method:'POST',body:{action}})).status,401)
 }
})
test('corpus UI can inspect and revoke a bundled reference',async()=>{
 const routes=mount({isTrusted:()=>true,requestRejection:()=>undefined})
 const call=body=>request(routes,'corpus',{host:'127.0.0.1',method:'POST',body})
 const list=await call({action:'list',status:'approved',limit:1});assert.equal(list.status,200);const before=list.data.state.approved
 const id=list.data.result.items[0].id
 const revoked=await call({action:'revoke',id});assert.equal(revoked.status,200);assert.equal(revoked.data.state.approved,before-1)
 const invalid=await call({action:'review',id,review:{action:'approve',topic:'animals',intent:'observation'}});assert.equal(invalid.status,500)
})
test('trusted corpus review promotes a staged item without writing life memories',async()=>{
 const {lifeStore}=await import('../tools/lib/life-runtime.mjs'),{corpusFor}=await import('../tools/lib/corpus-runtime.mjs')
 const life=lifeStore(),corpus=corpusFor(life),before=life.status().memories.length
 const file=path.join(home,'corpus-ui.csv');fs.writeFileSync(file,'text,level,bvid,videoTitle,mid,ctime\n猫耳朵朝另一个方向转了,主评论,BVfixture,猫的日常,test,1\n')
 await corpus.importCSV(file);const item=corpus.list().items[0]
 const routes=mount({isTrusted:()=>true,requestRejection:()=>undefined})
 const approved=await request(routes,'corpus',{host:'127.0.0.1',method:'POST',body:{action:'review',id:item.id,review:{action:'approve',topic:'animals',intent:'observation',note:'仅作写法参考'}}})
 assert.equal(approved.status,200);assert.equal(approved.data.result.status,'approved');assert.equal(approved.data.result.review.identityVerified,false)
 assert.equal(life.status().memories.length,before)
})

test('life administration rejects untrusted and unauthenticated requests',async()=>{
  for(const action of ['accept','revoke','pause','resolve','export','owner-note']){
    assert.equal((await request(mount({isTrusted:()=>false,requestRejection:()=>undefined}),'life',{host:'evil.example',method:'POST',body:{action}})).status,403)
    assert.equal((await request(mount({isTrusted:()=>true,requestRejection:()=>401}),'life',{host:'127.0.0.1',method:'POST',body:{action}})).status,401)
  }
})
test('trusted life UI completes evidence, approve, revoke, export cycle',async()=>{
  fs.writeFileSync(process.env.BILI_WHALE_CONFIG,JSON.stringify({self:{mid:'111'},owner:{mid:'222'}}))
  const routes=mount({isTrusted:()=>true,requestRejection:()=>undefined})
  const call=body=>request(routes,'life',{host:'127.0.0.1',method:'POST',body})
  const note=await call({action:'owner-note',text:'less cats'});assert.equal(note.status,200)
  const proposal=await call({action:'propose',proposal:{type:'preference',text:'less cats',sourceIds:[note.data.result.id],effect:'exclude',scope:{scene:'recommend',field:'keyword',value:'cats'}}})
  const accepted=await call({action:'accept',id:proposal.data.result.id});assert.equal(accepted.status,200)
  const memory=accepted.data.state.memories.at(-1)
  const revoked=await call({action:'revoke',id:memory.id});assert.equal(revoked.data.state.memories.at(-1).active,false)
  const exported=await call({action:'export'});assert.ok(Array.isArray(exported.data.result.archiveContents))
  const invalid=await call({action:'resolve',id:'unknown',status:'not-sent'});assert.equal(invalid.status,500)
})

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

test('QR routes enforce trust, host authentication and POST before running login', async () => {
  for (const name of ['start', 'poll', 'cancel']) {
    const route = 'auth/qr/' + name
    assert.equal((await request(mount({ isTrusted: () => false, requestRejection: () => undefined }), route,
      { host: 'evil.example', method: 'POST' })).status, 403)
    assert.equal((await request(mount({ isTrusted: () => true, requestRejection: () => 401 }), route,
      { host: '127.0.0.1', method: 'POST' })).status, 401)
    assert.equal((await request(mount(undefined), route,
      { host: '127.0.0.1', method: 'POST' })).status, 503)
    assert.equal((await request(mount({ requestRejection: () => undefined }), route,
      { host: '127.0.0.1' })).status, 405)
  }
  const routes = mount({ isTrusted: () => true, requestRejection: () => undefined })
  assert.equal((await request(routes, 'auth/qr/cancel', { host: '192.168.0.101', method: 'POST' })).status, 200)
  const invalid = await request(routes, 'auth/qr/poll', { host: '192.168.0.101', method: 'POST', body: { id: 'stale' } })
  assert.equal(invalid.status, 400)
  assert.match(invalid.data.error, /失效/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { QrAuth, verifyAccount } from '../lib/auth.js'
import { createCredentialStore, parseManualCookie, protectCredentials } from '../lib/credentials.js'
import { execFileSync } from 'node:child_process'

const cookies = { sessdata: 'fixture-session-not-real', bili_jct: 'a'.repeat(32), buvid3: '' }
const json = (data, headers = {}) => new Response(JSON.stringify({ code: 0, data }), { headers })
const generated = () => json({ url: 'https://passport.bilibili.com/scan?key=fixture', qrcode_key: 'fixture-key' })
const success = () => {
  const headers = new Headers()
  headers.append('set-cookie', `SESSDATA=${cookies.sessdata}; HttpOnly`)
  headers.append('set-cookie', `bili_jct=${cookies.bili_jct}; HttpOnly`)
  return json({ code: 0, url: 'https://example.invalid/secret', refresh_token: 'private-refresh' }, headers)
}
function fixture(t, responses) {
  let now = 0
  const calls = [], saved = []
  const auth = new QrAuth({
    fetch: async (url, options) => { calls.push({ url: String(url), at: now, options }); const next = responses.shift(); return typeof next === 'function' ? next() : next },
    now: () => now,
    render: async () => 'data:image/png;base64,fixture',
    save: async (value, options) => { options.check(); saved.push(value); return { mid: '111', name: 'fixture' } },
  })
  t.after(() => auth.dispose())
  return { auth, calls, saved, advance: (ms = 2000) => { now += ms } }
}
test('QR waiting/scanned/success states are bounded, throttled and sanitized', async t => {
  const f = fixture(t, [generated(), json({ code: 86101 }), json({ code: 86090 }), success()])
  const qr = await f.auth.start()
  assert.match(qr.image, /^data:image\/png/)
  assert.equal(qr.key, undefined)
  f.advance(); assert.equal((await f.auth.poll(qr.id)).status, 'waiting')
  assert.equal((await f.auth.poll(qr.id)).status, 'waiting')
  assert.equal(f.calls.length, 2)
  f.advance(); assert.equal((await f.auth.poll(qr.id)).status, 'scanned')
  f.advance(); const result = await f.auth.poll(qr.id)
  assert.equal(result.status, 'success')
  assert.equal(f.saved.length, 1)
  assert.deepEqual(f.saved[0], cookies)
  assert.doesNotMatch(JSON.stringify(result), /fixture-session|aaaa|private-refresh|example.invalid|fixture-key/)
  assert.equal((await f.auth.poll(qr.id)).status, 'success')
  assert.equal(f.saved.length, 1)
})
test('expired and cancelled QR cannot save, and replacing a challenge invalidates the old ID', async t => {
  const f = fixture(t, [generated(), generated()])
  const first = await f.auth.start()
  f.advance(180001)
  assert.equal((await f.auth.poll(first.id)).status, 'expired')
  const next = await f.auth.start()
  await assert.rejects(f.auth.poll(first.id), /失效/)
  f.auth.cancel(next.id)
  assert.equal((await f.auth.poll(next.id)).status, 'cancelled')
  assert.equal(f.saved.length, 0)
})
test('cancel ignores an in-flight success and never writes credentials', async t => {
  let resolve
  const f = fixture(t, [generated(), () => new Promise(r => { resolve = r })])
  const qr = await f.auth.start(); f.advance()
  const pending = f.auth.poll(qr.id)
  f.auth.cancel(qr.id)
  resolve(success())
  assert.equal((await pending).status, 'cancelled')
  assert.equal(f.saved.length, 0)
})
test('unknown status, missing cookies, foreign QR and network errors never leak upstream', async t => {
  for (const response of [json({ code: 999, message: cookies.sessdata }), json({ code: 0 })]) {
    const f = fixture(t, [generated(), response]); const qr = await f.auth.start(); f.advance()
    const result = await f.auth.poll(qr.id)
    assert.equal(result.status, 'error'); assert.equal(f.saved.length, 0)
    assert.doesNotMatch(JSON.stringify(result), /fixture-session/)
  }
  const foreign = fixture(t, [json({ url: 'https://evil.invalid', qrcode_key: 'k' })])
  await assert.rejects(foreign.auth.start(), /二维码/)
  const network = fixture(t, [() => { throw Error(cookies.sessdata) }])
  await assert.rejects(network.auth.start(), e => !e.message.includes(cookies.sessdata))
})
test('concurrent polls share one request', async t => {
  let resolve
  const f = fixture(t, [generated(), () => new Promise(r => { resolve = r })])
  const qr = await f.auth.start(); f.advance()
  const a = f.auth.poll(qr.id), b = f.auth.poll(qr.id)
  resolve(json({ code: 86101 }))
  assert.deepEqual(await a, await b); assert.equal(f.calls.length, 2)
})
test('nav verification requires a logged-in numeric account and redacts its name', async () => {
  const ok = await verifyAccount(cookies, { fetch: async () => json({ isLogin: true, mid: 111, uname: cookies.sessdata }) })
  assert.equal(ok.mid, '111'); assert.doesNotMatch(ok.name, /fixture-session/)
  for (const data of [{ isLogin: false, mid: 111 }, { isLogin: true, mid: 0 }])
    await assert.rejects(verifyAccount(cookies, { fetch: async () => json(data) }), /验证/)
})
function storeFixture(t, verify) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-auth-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'credentials.json'), pending = path.join(dir, 'pending-replies.json')
  fs.writeFileSync(file, JSON.stringify(cookies))
  const store = createCredentialStore({ file, pending, verify, protect: () => {} })
  return { file, pending, store }
}
test('failed verification and cancelled save preserve old credentials', async t => {
  const f = storeFixture(t, async () => { throw Error('登录验证失败') })
  await assert.rejects(f.store.save({ ...cookies, sessdata: 'new-valid-fixture-session' }), /验证/)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), cookies)
  const next = createCredentialStore({ file: f.file, pending: f.pending, verify: async () => ({ mid: '111', name: 'ok' }), protect: () => {} })
  await assert.rejects(next.save(cookies, { check() { throw Error('cancelled') } }), /cancelled/)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), cookies)
})
test('pending drafts block cross-account or unverifiable-account replacement but permit same account', async t => {
  const next = { ...cookies, sessdata: 'new-valid-fixture-session' }
  let oldMid = '111'
  const f = storeFixture(t, async c => ({ mid: c.sessdata === cookies.sessdata ? oldMid : '222', name: 'ok' }))
  fs.writeFileSync(f.pending, JSON.stringify({ items: [{ id: 'old' }] }))
  await assert.rejects(f.store.save(next), /待审/)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), cookies)
  oldMid = '222'
  await f.store.save(next)
  assert.equal(JSON.parse(fs.readFileSync(f.file)).sessdata, next.sessdata)
})
test('atomic persistence failure leaves the original file and removes temporary credentials', async t => {
  const f = storeFixture(t, async () => ({ mid: '111', name: 'ok' }))
  const broken = createCredentialStore({ file: f.file, pending: f.pending, verify: async () => ({ mid: '111', name: 'ok' }), protect() { throw Error('permissions failed') } })
  await assert.rejects(broken.save({ ...cookies, sessdata: 'new-valid-fixture-session' }), /保存/)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), cookies)
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['credentials.json'])
})
test('manual import accepts existing paste formats without weakening required fields', () => {
  assert.deepEqual(parseManualCookie({ sessdata: `SESSDATA=${cookies.sessdata}; bili_jct=${cookies.bili_jct}`, bili_jct: cookies.bili_jct }), cookies)
  assert.throws(() => parseManualCookie({ sessdata: 'short', bili_jct: 'bad' }), /凭据/)
})

test('late generation after disposal is rejected and clears challenge secrets', async t => {
  let resolve
  const f = fixture(t, [() => new Promise(r => { resolve = r })])
  const started = f.auth.start()
  f.auth.dispose(); resolve(generated())
  await assert.rejects(started)
  assert.equal(f.auth.current.key, undefined)
  assert.equal(f.auth.current.image, undefined)
  assert.equal(f.saved.length, 0)
})

test('unverifiable old account and drafts changing during verification preserve credentials', async t => {
  const next = { ...cookies, sessdata: 'new-valid-fixture-session' }
  const f = storeFixture(t, async c => {
    if (c.sessdata === cookies.sessdata) throw Error('expired old session')
    return { mid: '222', name: 'ok' }
  })
  fs.writeFileSync(f.pending, JSON.stringify({ items: [{ id: 'old' }] }))
  await assert.rejects(f.store.save(next), /待审/)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), cookies)
  const changed = createCredentialStore({ file: f.file, pending: f.pending, protect() {}, verify: async c => {
    if (c.sessdata === cookies.sessdata) fs.writeFileSync(f.pending, JSON.stringify({ items: [{ id: 'new' }] }))
    return { mid: '111', name: 'ok' }
  } })
  await assert.rejects(changed.save(next), /已变化/)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), cookies)
})

test('real credential persistence restricts the empty temporary file before writing', async t => {
  const f = storeFixture(t, async () => ({ mid: '111', name: 'ok' }))
  const store = createCredentialStore({ file: f.file, pending: f.pending, verify: async () => ({ mid: '111', name: 'ok' }), protect(file) {
    assert.equal(fs.statSync(file).size, 0)
    protectCredentials(file)
  } })
  await store.save(cookies)
  if (process.platform === 'win32') {
    const script = '$ErrorActionPreference = "Stop"; $acl = [System.IO.File]::GetAccessControl($env:WHALE_TEST_ACL_FILE); [pscustomobject]@{ protected = $acl.AreAccessRulesProtected; sids = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }); current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } | ConvertTo-Json -Compress'
    const acl = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, WHALE_TEST_ACL_FILE: f.file } }))
    assert.equal(acl.protected, true)
    assert.deepEqual(acl.sids, [acl.current])
  } else assert.equal(fs.statSync(f.file).mode & 0o777, 0o600)
})

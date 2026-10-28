import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run } from '../tools/commands/video-danmaku.mjs'

const base = ['--bvid', 'BV1234567890', '--at', '5.123', '--msg', '好看']
function fixture(overrides = {}) {
  const calls = [], logs = []
  const deps = {
    credentials: { sessdata: 'secret-session', bili_jct: 'secret-csrf' },
    getConfig: () => ({ self: { mid: 123 } }),
    apiGet: async url => url.includes('/nav') ? { code: 0, data: { isLogin: true, mid: 123 } } : { code: 0, data: { pages: [{ cid: 456, duration: 60 }, { cid: 789, duration: 20 }] } },
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ code: 0, data: { dmid_str: '999' } }) } },
    gate: x => { calls.push({ gate: x }); return true }, record: x => calls.push({ record: x }),
    log: x => logs.push(x), error: x => logs.push(x), ...overrides,
  }
  return { deps, calls, logs }
}
test('dry validates metadata and never writes or consumes quota', async () => {
  const f = fixture(); assert.equal(await run([...base, '--dry'], f.deps), 0); assert.equal(f.calls.length, 0)
  assert.match(f.logs.join(' '), /第一分 P1/)
})
test('go sends P1 CID, milliseconds and CSRF once, accounts and reports verification limit', async () => {
  const f = fixture(); assert.equal(await run([...base, '--go', '--auto'], f.deps), 0)
  assert.deepEqual(f.calls[0].gate, { type: 'danmaku', target: 'video:BV1234567890', auto: true })
  assert.equal(f.calls[1].url, 'https://api.bilibili.com/x/v2/dm/post')
  const form = new URLSearchParams(f.calls[1].options.body)
  for (const [k, v] of Object.entries({ type: '1', oid: '456', bvid: 'BV1234567890', progress: '5123', msg: '好看', csrf: 'secret-csrf', mode: '1' })) assert.equal(form.get(k), v)
  assert.equal(f.calls[2].record.target, 'video:BV1234567890')
  assert.match(f.logs.join(' '), /未回读确认/); assert.doesNotMatch(f.logs.join(' '), /secret-/)
})
test('invalid arguments cannot write', async () => {
  for (const argv of [[...base], [...base, '--dry', '--go'], [...base, '--at', '4', '--go'], ['--bvid','BV1234567890','--at','-1','--msg','x','--go']]) {
    const f = fixture(); assert.equal(await run(argv, f.deps), 2); assert.equal(f.calls.length, 0)
  }
})
test('wrong identity, out-of-range time and quota denial cannot send', async () => {
  for (const f of [fixture({ getConfig: () => ({self:{mid: 999}}) }), fixture({ apiGet: async url => url.includes('/nav') ? {code:0,data:{isLogin:true,mid:123}} : {code:0,data:{pages:[{cid:456,duration:5}]}} }), fixture({gate: () => false})]) {
    assert.equal(await run([...base, '--go'], f.deps), 1); assert.equal(f.calls.filter(x => x.url).length, 0)
  }
})
test('rejected or uncertain send is nonzero and not recorded; secrets stay hidden', async () => {
  for (const fetch of [async () => ({ok:true,json:async()=>({code:-111})}), async () => ({ok:false,status:503}), async () => { throw Error('secret-session') }]) {
    const f = fixture({ fetch }); assert.equal(await run([...base,'--go'], f.deps), 1); assert.equal(f.calls.filter(x => x.record).length, 0); assert.doesNotMatch(f.logs.join(' '), /secret-/)
  }
})

import fs from 'node:fs'
import assert from 'node:assert/strict'
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input))
  assert.equal(url.hostname, 'api.bilibili.com')
  fs.appendFileSync(process.env.TEST_REQUESTS, (options.method ?? 'GET') + '\n')
  let result
  if (url.pathname === '/x/polymer/web-dynamic/v1/detail') {
    result = { code: 0, data: { item: { modules: { module_dynamic: { major: { opus: { pics: [{url:'https://example.com/image',width:10,height:20}] } } } } } } }
  } else if (url.pathname === '/x/dynamic/feed/edit/dyn') {
    assert.equal(url.searchParams.get('csrf'), 'fixture-csrf-secret')
    assert.equal(options.method, 'POST')
    if (process.env.TEST_EDIT_RESULT === 'transport') throw Error(url.href)
    assert.equal(options.headers['content-type'], 'application/json')
    const body = JSON.parse(options.body)
    assert.equal(body.csrf, undefined)
    assert.equal(body.dyn_id_str, '123')
    assert.equal(body.dyn_req.content.contents[0].raw_text, 'test edit')
    assert.equal(body.dyn_req.pics.length, 1)
    if (process.env.TEST_EDIT_RESULT === 'invalid') return new Response('not-json')
    result = { code: process.env.TEST_EDIT_RESULT === 'reject' ? -111 : 0, message: 'fixture-csrf-secret' }
  } else throw Error('Unexpected fixture endpoint')
  return new Response(JSON.stringify(result), {headers:{'content-type':'application/json'}})
}

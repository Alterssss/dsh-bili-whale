import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLifeStore } from '../tools/lib/life-store.mjs'

function setup(t) {
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-state-contract-'))
  t.after(() => fs.rmSync(dshHome, { recursive: true, force: true }))
  const store = createLifeStore({ dshHome, account: '1', owner: '2' })
  return { store, projectionFile: store.file }
}

test('an older or altered projection never overrides the authoritative checkpoint', async t => {
  const { store, projectionFile } = setup(t)
  const recorded = await store.record('observed', { text: 'committed evidence' })
  const committed = store.read()
  const projection = JSON.parse(fs.readFileSync(projectionFile, 'utf8'))
  projection.revision = committed.revision - 1
  projection.events.find(event => event.id === recorded.id).text = 'stale projection text'
  fs.writeFileSync(projectionFile, JSON.stringify(projection))

  assert.equal(store.read().events.find(event => event.id === recorded.id).text, 'committed evidence')
  await store.tx(() => {})
  const repaired = JSON.parse(fs.readFileSync(projectionFile, 'utf8'))
  assert.equal(repaired.revision, committed.revision)
  assert.equal(repaired.events.find(event => event.id === recorded.id).text, 'committed evidence')
})

test('a projection ahead of the checkpoint blocks reads and further writes', async t => {
  const { store, projectionFile } = setup(t)
  await store.record('observed', { text: 'committed evidence' })
  const committed = store.read()
  const projection = JSON.parse(fs.readFileSync(projectionFile, 'utf8'))
  projection.revision = committed.revision + 1
  fs.writeFileSync(projectionFile, JSON.stringify(projection))

  assert.throws(() => store.read(), /投影超前于检查点/)
  await assert.rejects(store.record('observed', { text: 'must not commit' }), /投影超前于检查点/)
  assert.equal(store.checkpointStatus().revision, committed.revision)
})

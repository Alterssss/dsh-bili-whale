import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const helper=fileURLToPath(new URL('./helpers/local-date.mjs',import.meta.url))
for(const zone of ['Asia/Shanghai','UTC','America/New_York'])test('calendar keys and cross-midnight windows in '+zone,()=>{
  const r=spawnSync(process.execPath,[helper],{env:{...process.env,TZ:zone},encoding:'utf8',timeout:10000})
  assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr)
})

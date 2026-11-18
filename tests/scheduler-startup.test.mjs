import test from 'node:test'
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'

const execute = promisify(execFile)
for (const mode of ['unavailable-service','registration-failure','config-failure']) {
  test('plugin startup handles '+mode, {timeout:15000}, async () => {
    const result = await execute(process.execPath, [
      fileURLToPath(new URL('./helpers/scheduler-startup.mjs',import.meta.url)), mode,
    ], {timeout:12000,windowsHide:true})
    assert.match(result.stdout,new RegExp('PASS '+mode))
  })
}

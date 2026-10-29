import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath, pathToFileURL} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url))
for (const mode of ['preview','success','reject','invalid','transport']) {
  test(`dynamic edit credential handling: ${mode}`, t => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-edit-'))
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
    fs.mkdirSync(path.join(dir,'.bili-ai'))
    fs.writeFileSync(path.join(dir,'.bili-ai','credentials.json'),JSON.stringify({sessdata:'fixture-session-secret',bili_jct:'fixture-csrf-secret'}))
    const textFile=path.join(dir,'text.txt'), log=path.join(dir,'requests.txt')
    fs.writeFileSync(textFile,'test edit')
    const env={...process.env,USERPROFILE:dir,HOME:dir,DSH_HOME:path.join(dir,'.dsh'),TEST_REQUESTS:log,TEST_EDIT_RESULT:mode,NODE_OPTIONS:'--import='+pathToFileURL(path.join(root,'tests/helpers/edit-dynamic-fetch.mjs')).href}
    delete env.BILI_TRAFFIC_TEST
    const r=spawnSync(process.execPath,[path.join(root,'tools/commands/edit-dynamic.mjs'),'123',textFile,...(mode==='preview'?[]:['--go'])],{env,encoding:'utf8',timeout:20000})
    assert.equal(r.status,['preview','success'].includes(mode)?0:1,r.stdout+r.stderr)
    assert.doesNotMatch(r.stdout+r.stderr,/fixture-csrf-secret|fixture-session-secret/)
    assert.deepEqual(fs.readFileSync(log,'utf8').trim().split('\n'),mode==='preview'?['GET']:['GET','POST'])
    if(mode==='invalid')assert.match(r.stderr,/结果不确定/)
    if(mode==='reject')assert.match(r.stderr,/编辑失败/)
  })
}

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {cleanupSessions,sessionAudit} from '../tools/lib/session-maintenance.mjs'
import {updateDelivery} from '../lib/delivery-state.js'

test('cleanup previews then archives stale pointers while retaining active and uncertain sessions',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-clean-'));t.after(()=>fs.rmSync(home,{force:true,recursive:true}))
 const cfg={self:{mid:'1'},owner:{mid:'2'}}
 for(let i=0;i<7;i++){const n='whale-session-'+String(i).padStart(24,'0')+'.json';fs.writeFileSync(path.join(home,n),JSON.stringify({id:'session-'+i,startedAt:i+1,deliveredAt:i+1,sessionRole:i===0?'private-main':i===1?'browse-main':'public-task',...(i===2?{pendingRequest:'p'}:{})}))}
 updateDelivery(home,'unknown',{attempt:'a',sessionId:'session-3',status:'unconfirmed',startedAt:1,updatedAt:1})
 const preview=cleanupSessions(home,cfg,{keep:1});assert.equal(preview.dryRun,true);assert.equal(preview.selected.length,2);assert.equal(preview.protected.length,4)
 assert.equal(fs.readdirSync(home).filter(n=>n.startsWith('whale-session-')).length,7)
 const done=cleanupSessions(home,cfg,{keep:1,apply:true});assert.equal(done.hostSessionsRemoved,0);assert.equal(fs.readdirSync(done.archive).length,2)
 assert.equal(sessionAudit(home,cfg).records.length,5);assert.throws(()=>cleanupSessions(home,cfg,{keep:NaN}),/keep/)
})

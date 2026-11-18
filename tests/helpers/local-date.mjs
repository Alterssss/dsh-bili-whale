import assert from 'node:assert/strict'
import {localDay} from '../../tools/lib/local-date.mjs'
import {makePlan,completePlan,historyOf,dayOf} from '../../tools/lib/night-plan.mjs'
const at=new Date('2026-10-28T05:10:00').getTime()
assert.equal(localDay(at),'2026-10-28');assert.equal(dayOf(at),'2026-10-28')
if(process.env.TZ==='Asia/Shanghai')assert.equal(new Date(at).toISOString().slice(0,10),'2026-10-27')
const morning={windows:[{start:'00:00',end:'08:00',wakes:3}],skipChance:0,minGapMin:10}
const p=makePlan(morning,{},at,()=>0)
assert.equal(p.date,'2026-10-28');assert.equal(p.windowKey,'2026-10-28|00:00–08:00')
assert.match(p.atText,/^2026-10-28 05:10/)
const used=completePlan(p,at)
assert.equal(used.usedCount[p.windowKey],1)
assert.equal(makePlan(morning,used,at+11*60000,()=>0).date,'2026-10-28')
const night={windows:[{start:'23:00',end:'06:00',wakes:2}],skipChance:0,minGapMin:10}
const before=new Date('2026-10-27T23:50:00').getTime(),after=new Date('2026-10-28T00:20:00').getTime()
const planned=makePlan(night,{},before,()=>.25)
assert.equal(makePlan(night,planned,after).atMs,planned.atMs,'midnight must not reroll a pending plan')
const completed=completePlan(planned,after)
assert.equal(completed.date,'2026-10-28');assert.equal(completed.windowKey,'2026-10-27|23:00–06:00')
assert.equal(completed.usedCount[planned.windowKey],1)
const reset=historyOf(completed,after)
assert.deepEqual(reset.usedCount,completed.usedCount)
const next=makePlan(night,reset,after+11*60000,()=>0)
assert.equal(next.windowKey,completed.windowKey)
if(process.env.TZ==='America/New_York'){
  const dst=new Date('2026-11-01T01:30:00-04:00').getTime()
  const plan=makePlan(night,{},dst,()=>0)
  assert.equal(plan.windowKey,'2026-10-31|23:00–06:00');assert.ok(plan.endsAt>dst)
}
assert.throws(()=>localDay('invalid'),/无效/)

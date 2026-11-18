import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const statuses = new Set(['dispatching', 'unconfirmed', 'accepted', 'failed'])
export function readDeliveries(dshHome) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dshHome, 'whale-delivery.json'), 'utf8'))
    if (data.schema !== 1 || !Array.isArray(data.records) || data.records.some(r =>
      typeof r.requestId!=='string'||!r.requestId||typeof r.attempt!=='string'||!r.attempt||
      typeof r.sessionId!=='string'||!r.sessionId||!Number.isFinite(r.startedAt)||!Number.isFinite(r.updatedAt)||!statuses.has(r.status))||
      new Set(data.records.map(r=>r.requestId)).size!==data.records.length) throw Error('invalid schema')
    return data.records
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw Error('投递账本无法读取，请检查 whale-delivery.json；不要删除未确认记录后重发')
  }
}

export function updateDelivery(dshHome, requestId, update) {
  const records = readDeliveries(dshHome)
  const index = records.findIndex(r => r.requestId === requestId)
  const next = {...(records[index] ?? {}), ...update, requestId}
  if (index < 0) records.push(next)
  else records[index] = next
  // Uncertain requests and unacknowledged DMs never expire as a side effect
  // of pruning diagnostic history. Stop before dispatch if that set is full.
  const protectedRecord = r => r.retained || ['dispatching', 'unconfirmed'].includes(r.status)
  const ordinary = records.filter(r => !protectedRecord(r)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 256)
  const kept = records.filter(protectedRecord).concat(ordinary)
  if (kept.length > 768) throw Error('未确认投递记录过多，请核查宿主会话；本轮不再投递')
  fs.mkdirSync(dshHome, {recursive: true})
  const file = path.join(dshHome, 'whale-delivery.json'), tmp = file + '.' + crypto.randomUUID() + '.tmp'
  try { fs.writeFileSync(tmp, JSON.stringify({schema: 1, records: kept}), {mode: 0o600}); fs.renameSync(tmp, file) }
  finally { fs.rmSync(tmp, {force: true}) }
  return next
}

export function deliveryStatus(dshHome) {
  const records = readDeliveries(dshHome)
  const wakes = records.filter(r => r.channel === 'wake').sort((a, b) => b.startedAt - a.startedAt)
  let consecutiveFailures = 0
  for (const r of wakes) {
    if (!['failed', 'unconfirmed', 'dispatching'].includes(r.status)) break
    consecutiveFailures++
  }
  return {lastWake: wakes[0] ?? null, consecutiveFailures, alertClaimed:wakes.slice(0,consecutiveFailures).some(r=>r.noticeClaimedAt),
    unconfirmed: records.filter(r => ['dispatching', 'unconfirmed'].includes(r.status)).length}
}

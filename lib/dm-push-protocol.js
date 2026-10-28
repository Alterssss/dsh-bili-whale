// Original minimal protobuf adapter for Bilibili's current web message-notify
// protocol. Source field definitions: official message-notify.js, 2026-10-28.
export const PATH = {
  auth: '/bilibili.broadcast.v1.Broadcast/Auth',
  subscribe: '/bilibili.broadcast.v1.Broadcast/Subscribe',
  heartbeat: '/bilibili.broadcast.v1.Broadcast/Heartbeat',
  ack: '/bilibili.broadcast.v1.Broadcast/MessageAck',
  notify: '/bilibili.broadcast.message.im.Notify/WatchNotify',
}

export function varint(value) {
  let n = BigInt.asUintN(64, BigInt(value)); const bytes = []
  do { const low = Number(n & 127n); n >>= 7n; bytes.push(low | (n ? 128 : 0)) } while (n)
  return Buffer.from(bytes)
}
export const numberField = (id, value) => Buffer.concat([varint(id << 3), varint(value)])
export const bytesField = (id, value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  return Buffer.concat([varint((id << 3) | 2), varint(bytes.length), bytes])
}
export const message = (...fields) => Buffer.concat(fields)

export function fields(input) {
  const buffer = Buffer.from(input); const result = new Map(); let offset = 0
  function readInt() {
    let n = 0n
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= buffer.length) throw Error('Truncated protobuf varint')
      const byte = buffer[offset++]; n |= BigInt(byte & 127) << shift
      if (!(byte & 128)) return n
    }
    throw Error('Oversized protobuf varint')
  }
  while (offset < buffer.length) {
    const tag = Number(readInt()); const id = tag >>> 3; const wire = tag & 7
    if (!id) throw Error('Invalid protobuf field')
    let value
    if (wire === 0) value = readInt()
    else if (wire === 2) {
      const length = Number(readInt())
      if (!Number.isSafeInteger(length) || length < 0 || offset + length > buffer.length) throw Error('Truncated protobuf field')
      value = buffer.subarray(offset, offset + length); offset += length
    } else if (wire === 1 || wire === 5) {
      const length = wire === 1 ? 8 : 4
      if (offset + length > buffer.length) throw Error('Truncated fixed protobuf field')
      value = buffer.subarray(offset, offset + length); offset += length
    } else throw Error('Unsupported protobuf wire type')
    if (!result.has(id)) result.set(id, [])
    result.get(id).push(value)
  }
  return result
}
const first = (map, id) => map.get(id)?.[0]
const integer = (map, id) => String(first(map, id) ?? 0n)
const text = (map, id) => Buffer.isBuffer(first(map, id)) ? first(map, id).toString('utf8') : ''
const child = (map, id) => fields(first(map, id) ?? Buffer.alloc(0))

export function encodeFrame(sequence, target, type, body = Buffer.alloc(0)) {
  const any = message(bytesField(1, 'type.googleapis.com/bilibili.broadcast.v1.' + type), ...(body.length ? [bytesField(2, body)] : []))
  return message(bytesField(1, numberField(2, sequence)), bytesField(2, target), bytesField(3, any))
}
export function decodeFrame(bytes) {
  const frame = fields(bytes); const options = child(frame, 1); const status = child(options, 4); const any = child(frame, 3)
  return { target: text(frame, 2), sequence: integer(options, 2), messageId: integer(options, 1),
    isAck: first(options, 3) === 1n, ackOrigin: text(options, 5), msgType: integer(options, 7),
    status: Number(BigInt.asIntN(32, first(status, 1) ?? 0n)),
    type: text(any, 1), body: first(any, 2) ?? Buffer.alloc(0) }
}
export function decodeNotify(bytes) {
  const notify = fields(bytes); const payload = child(notify, 3); const instant = child(payload, 2); const info = child(payload, 3)
  const talkers = new Set()
  for (const uid of [integer(info, 2), integer(instant, 1), integer(instant, 3)]) if (uid !== '0') talkers.add(uid)
  for (const command of payload.get(4) ?? []) {
    const options = fields(command)
    for (const kind of [2, 4]) {
      const session = child(child(options, kind), 1); const privateId = child(session, 1)
      const uid = integer(privateId, 1); if (uid !== '0') talkers.add(uid)
    }
  }
  return { uid: integer(notify, 1), command: Number(integer(notify, 2)), talkers: [...talkers],
    // Content field 6 is intentionally never decoded or logged here.
    sequence: integer(payload, 1), messageKey: integer(instant, 11) }
}

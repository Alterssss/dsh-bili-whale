import fs from 'node:fs'
import zlib from 'node:zlib'

// 3×5 点阵数字：不依赖字体、不依赖 libfreetype 的极简 FFmpeg 也能用。
const glyphs = {
  '0':[7,5,5,5,7], '1':[2,6,2,2,7], '2':[7,1,7,4,7],
  '3':[7,1,7,1,7], '4':[5,5,7,1,1], '5':[7,4,7,1,7],
  '6':[7,4,7,5,7], '7':[7,1,1,1,1], '8':[7,5,7,5,7],
  '9':[7,5,7,1,7], ':':[0,2,0,2,0],
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()
const crc32 = (buf) => {
  let c = -1
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
const chunk = (type, data) => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4, 8), data])), 0)
  return Buffer.concat([head, data, crc])
}
const encodePng = (width, height, rgba) => {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// 写一个带半透明黑底 + 白字黑描边的时间码 PNG。
// 为什么要这么大：63×21 叠在 720P 缩略图上只剩 32×11，看九宫格时根本认不出格号。
export function writeTimecode(file, stamp, digits = 5, { scale = 5, pad = 6 } = {}) {
  const cell = 4 * scale
  const width = digits * cell + pad * 2
  const height = 7 * scale + pad * 2
  const rgba = Buffer.alloc(width * height * 4, 0)
  const set = (x, y, [r, g, b, a]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const i = (y * width + x) * 4
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a
  }
  // 底：半透明黑，保证白字在任何画面上都能读
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) set(x, y, [0, 0, 0, 150])

  const inside = (char, gx, gy) => {
    const rows = glyphs[char]
    if (!rows) return false
    const row = rows[Math.floor(gy / scale)]
    if (row === undefined) return false
    const col = Math.floor(gx / scale)
    if (col < 0 || col > 2) return false
    return (row & (4 >> col)) !== 0
  }
  const chars = [...stamp]
  for (let y = 0; y < height - pad * 2; y++) {
    for (let x = 0; x < width - pad * 2; x++) {
      const index = Math.floor(x / cell)
      const char = chars[index]
      if (!char) continue
      const gx = x - index * cell
      const gy = y
      const on = inside(char, gx, gy)
      const near = !on && (inside(char, gx - 1, gy) || inside(char, gx + 1, gy) || inside(char, gx, gy - 1) || inside(char, gx, gy + 1))
      if (on) set(x + pad, y + pad, [255, 255, 255, 255])
      else if (near) set(x + pad, y + pad, [0, 0, 0, 235])
    }
  }
  fs.writeFileSync(file, encodePng(width, height, rgba))
}

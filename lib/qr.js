/**
 * lib/qr.js —— 把一段文本画成二维码 PNG（**零运行时依赖**）
 * ============================================================================
 * 为什么不用 npm 的 `qrcode` 包（2026-11-06，对应 issue #64）：
 *   v0.4.6 默认导入了 npm 的 `qrcode` 包。`qrcode@1.5.4` 是 **CJS** 包，
 *   而插件是被宿主（DSH）以「插件」身份加载的 ESM 模块 —— 在 DSH 0.2.1-rc.5 上，
 *   宿主对「裸 CJS 依赖」的解析会把模块 stub 成空对象 `{}`，
 *   于是 `QRCode.toDataURL` 是 undefined → 抛出 → 上层统一报「二维码生成失败」。
 *   用户侧看到的就是「扫码登录永远是生成失败」，而 Cookie 手填一切正常。
 *
 *   即使宿主哪天修好了这个解析，把「能不能登录」押在宿主的模块解析策略上，
 *   本身就是脆的：插件对外的承诺是「零安装、零守护进程、零框架」，
 *   那么它也不该把一张二维码的实现外包给运行时去解析。
 *
 * 做法：vendor 一个 MIT 的 QR 编码实现（vendor/qrcode/，Kazuhiko Arase 原作），
 *   自己写 PNG 编码（zlib 是 Node 内置）。整条链路上没有任何 `import 'xxx'`，
 *   也没有任何 `require('xxx')` —— 宿主怎么解析模块都影响不到它。
 */
import qrcode from '../vendor/qrcode/qrcode.mjs'
import { deflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

function crc32(buf) {
  const table = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xFFFFFFFF
  for (const b of buf) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const sum = Buffer.alloc(4)
  sum.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, sum])
}

/**
 * 把文本编码成 8 位灰度 PNG。
 * @param {string} text 要编码的内容
 * @param {{ scale?: number, margin?: number, ec?: 'L'|'M'|'Q'|'H' }} [options]
 * @returns {{ png: Buffer, size: number, modules: number }}
 */
export function qrPng(text, options) {
  const opt = options || {}
  const margin = opt.margin === undefined ? 2 : opt.margin
  const ec = opt.ec || 'M'
  const q = qrcode(0, ec)
  q.addData(String(text), 'Byte')
  q.make()
  const modules = q.getModuleCount()
  const inner = modules + margin * 2
  // 模块必须落在整数像素上才锐利；width 只作为"目标边长"，
  // 尺寸差的那几像素用白边补齐（二维码四周本来就是静区，补白无害）。
  const scale = opt.scale === undefined
    ? Math.max(1, Math.floor((opt.width || 0) / inner) || 6)
    : opt.scale
  const drawn = inner * scale
  const size = opt.width && opt.width > drawn ? opt.width : drawn
  const offset = Math.floor((size - drawn) / 2)
  const raw = Buffer.alloc((size + 1) * size, 0xFF)
  for (let y = 0; y < size; y += 1) raw[y * (size + 1)] = 0
  for (let mr = 0; mr < modules; mr += 1) {
    for (let mc = 0; mc < modules; mc += 1) {
      if (q.isDark(mr, mc) === false) continue
      const y0 = offset + (margin + mr) * scale
      const x0 = offset + (margin + mc) * scale
      for (let dy = 0; dy < scale; dy += 1) {
        const row = (y0 + dy) * (size + 1) + 1
        raw.fill(0x00, row + x0, row + x0 + scale)
      }
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  const png = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  return { png, size, modules }
}

/**
 * 把文本编码成 `data:image/png;base64,...`（可直接塞进 <img src>）。
 * 形状与 npm `qrcode` 的 `toDataURL(text, { width, margin })` 一致，便于替换。
 */
export function qrDataUrl(text, options) {
  const { png } = qrPng(text, options)
  return 'data:image/png;base64,' + png.toString('base64')
}

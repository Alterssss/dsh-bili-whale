import { qrDataUrl } from '../lib/qr.js'

try {
  const url = new URL(process.argv[2])
  if (!['https://passport.bilibili.com', 'https://account.bilibili.com'].includes(url.origin) || url.username || url.password) {
    throw Error('invalid login URL')
  }
  console.log(qrDataUrl(url.href, {width:220, margin:2}))
} catch {
  console.error('二维码绘制失败')
  process.exitCode = 1
}

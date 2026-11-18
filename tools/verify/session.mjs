import { HOME } from '../lib/paths.mjs'
import { guardedFetch as fetch } from '../lib/traffic.mjs'
// 先确认"这串 cookie 是哪个号"——任何写操作之前都该跑一次。
import fs from 'node:fs'
import path from 'node:path'

const credPath = path.join((HOME), '.bili-ai', 'credentials.json')
if (!fs.existsSync(credPath)) {
  console.error(`缺少凭据文件: ${credPath}`)
  console.error('内容应为 {"sessdata":"…","bili_jct":"…","buvid3":"…"}（见 README「凭据」一节）')
  process.exit(3)
}
const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'))
// 2026-10-21：buvid3 改为可选（缺了不该拦住任何事 ✗）
const missing = ['sessdata', 'bili_jct'].filter((k) => !cred[k] || String(cred[k]).trim() === '')
if (missing.length) {
  console.error(`凭据文件里这些项是空的: ${missing.join(', ')}`)
  process.exit(3)
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', {
  headers: {
    'user-agent': UA,
    referer: 'https://www.bilibili.com/',
    cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`,
  },
})).json()
if (nav.code !== 0) {
  console.error(`登录态无效: code=${nav.code} ${nav.message}（cookie 过期或抄错，重新复制一次）`)
  process.exit(4)
}
console.log('凭据有效 ✓')
console.log(`  账号      : ${nav.data.uname}`)
console.log(`  mid       : ${nav.data.mid}`)
console.log(`  手机绑定  : ${nav.data.mobile_verified ? '是（发评论/动态需要）' : '否 ← 会被拒'}`)
console.log(`  硬币      : ${nav.data.money}   等级: ${nav.data.level_info?.current_level ?? '-'}`)
console.log(`  凭据文件  : ${credPath}`)
console.log('\n⚠️ 确认这就是你要用来操作的那个号；若显示的是主号，请换成小号再继续。')

import { HOME } from '../lib/paths.mjs'
import { guardedFetch as fetch } from '../lib/traffic.mjs'
// 按 mid 查昵称（WBI 签名）。用法: node whois.mjs <mid> [mid...]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const cred = JSON.parse(fs.readFileSync(path.join((HOME), '.bili-ai', 'credentials.json'), 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
const H = { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie }
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))
const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: H })).json()
const raw = keyOf(nav.data?.wbi_img?.img_url ?? '') + keyOf(nav.data?.wbi_img?.sub_url ?? '')
const mixin = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)
const clean = (v) => String(v).replace(/[!'()*]/g, '')
for (const mid of process.argv.slice(2)) {
  const wts = Math.round(Date.now() / 1000)
  const q = Object.keys({ mid, wts }).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(k === 'wts' ? wts : mid))}`).join('&')
  const d = await (await fetch(`https://api.bilibili.com/x/space/wbi/acc/info?${q}&w_rid=${crypto.createHash('md5').update(q + mixin).digest('hex')}`, { headers: H })).json()
  if (d.code !== 0) { console.log(`mid ${mid}: code=${d.code} ${d.message}`); continue }
  console.log(`mid ${mid}  →  昵称「${d.data.name}」  签名: ${String(d.data.sign ?? '').slice(0, 60)}`)
}

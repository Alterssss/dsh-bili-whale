import { HOME } from '../lib/paths.mjs'
import { guardedFetch as fetch } from '../lib/traffic.mjs'
// 搜索 B 站视频（WBI 签名 + cookie）。用法: node search.mjs <关键词> [页码]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const kw = process.argv[2]
const page = Number(process.argv[3] ?? 1)
if (!kw) { console.error('用法: node search.mjs <关键词> [页码]'); process.exit(2) }
// 2026-10-22 修（Codex 实测 #1）：页码不合法要显式报错 ✗
//   以前 --ps 2 这种会被解析成 NaN → 请求 -400 → 但退出码还是 0 ✗
if (!Number.isInteger(page) || page < 1) { console.error('页码必须是正整数：' + JSON.stringify(process.argv[3])); process.exit(2) }

const cred = JSON.parse(fs.readFileSync(path.join((HOME), '.bili-ai', 'credentials.json'), 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
const H = { 'user-agent': UA, referer: 'https://search.bilibili.com/', cookie }
const jget = async (u) => (await fetch(u, { headers: H })).json()

// WBI 签名（各脚本里重复了一份，保持一致；要改就一起改）
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))
const nav = await jget('https://api.bilibili.com/x/web-interface/nav')
const raw = keyOf(nav.data?.wbi_img?.img_url ?? '') + keyOf(nav.data?.wbi_img?.sub_url ?? '')
const mixin = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)
const clean = (v) => String(v).replace(/[!'()*]/g, '')
function wbi(params) {
  const wts = Math.round(Date.now() / 1000)
  const q = Object.keys({ ...params, wts }).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(k === 'wts' ? wts : params[k]))}`).join('&')
  return `${q}&w_rid=${crypto.createHash('md5').update(q + mixin).digest('hex')}`
}

const qs = wbi({ search_type: 'video', keyword: kw, page })
const d = await jget(`https://api.bilibili.com/x/web-interface/wbi/search/type?${qs}`)
const list = d.data?.result ?? d.data?.results ?? []
console.log(`搜索「${kw}」 page=${page}  code=${d.code} ${d.message ?? ''}  结果数=${list.length}`)
if (d.code !== 0 || !list.length) {
  console.log(`data 的字段: ${Object.keys(d.data ?? {}).join(', ') || '(空)'}`)
  if (!list.length) console.log(JSON.stringify(d).slice(0, 400))
  // 2026-10-22 修（Codex 实测 #1）：接口失败必须非 0 ✗
  //   只有「接口成功但确实没结果」才算正常结束 ✓
  //   （上层自动化拿到 0 就当成功，失败也 0 会被误报 ✗）
  if (d.code !== 0) { console.error(`✗ 搜索接口失败 code=${d.code} ${d.message ?? ''}`); process.exit(4) }
  console.log('（接口正常，但没有搜到结果）')
  process.exit(0)
}
for (const [i, r] of list.entries()) {
  const title = String(r.title ?? '').replace(/<[^>]+>/g, '')
  console.log(`\n[${i + 1}] ${title}`)
  console.log(`    BV=${r.bvid}  UP=${r.author}  播放=${r.play}  弹幕=${r.video_review}  时长=${r.duration}  日期=${new Date((r.pubdate ?? 0) * 1000).toLocaleDateString('zh-CN')}`)
  if (r.description) console.log(`    简介: ${String(r.description).replace(/<[^>]+>/g, '').slice(0, 120)}`)
  if (r.tag) console.log(`    标签: ${String(r.tag).replace(/<[^>]+>/g, '').slice(0, 100)}`)
}

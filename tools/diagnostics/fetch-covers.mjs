import { HOME } from '../lib/paths.mjs'
import { guardedFetch as fetch } from '../lib/traffic.mjs'
// 抓取若干视频的元信息 + 封面（供 agent 看图），封面存到 covers/<BV>.jpg
//   node fetch-covers.mjs BV1xxx BV2yyy ...
import fs from 'node:fs'
import path from 'node:path'
const cred = JSON.parse(fs.readFileSync(path.join((HOME), '.bili-ai', 'credentials.json'), 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const H = { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}` }
const outDir = path.join(process.argv[1], '..', '..', 'covers')
fs.mkdirSync(outDir, { recursive: true })

for (const bv of process.argv.slice(2)) {
  try {
    const d = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, { headers: H })).json()
    if (d.code !== 0) { console.log(`${bv}: code=${d.code} ${d.message}`); continue }
    const v = d.data
    const cover = path.join(outDir, `${bv}.jpg`)
    const img = await fetch(v.pic, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' } })
    fs.writeFileSync(cover, Buffer.from(await img.arrayBuffer()))
    console.log(`\n===== ${bv} =====`)
    console.log(`标题: ${v.title}`)
    console.log(`UP: ${v.owner?.name} (mid ${v.owner?.mid})   播放=${v.stat?.view} 点赞=${v.stat?.like} 弹幕=${v.stat?.danmaku} 回复=${v.stat?.reply}`)
    console.log(`分区: ${v.tname}   时长=${v.duration}s   发布=${new Date(v.pubdate * 1000).toLocaleString('zh-CN')}`)
    console.log(`封面: ${cover}  (${(fs.statSync(cover).size / 1024).toFixed(0)} KiB)`)
    console.log(`简介: ${String(v.desc ?? '').slice(0, 400)}`)
  } catch (e) {
    console.log(`${bv}: 失败 ${e.message}`)
  }
}

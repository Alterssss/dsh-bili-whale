// diary-lines.mjs —— LOCAL：把本轮结果拼成日记表格行（复制粘贴用）
// 2026-10-29：日记别每轮手写脚本拼。
//
// 数据来源两份（都是自动落盘的）：
//   discover-logs/<最新>.json   标题 / 播放 / 弹幕 / 发布时间 / 来源窗口
//   batch-logs/<最新>.log       UP / 时长 / 抽帧失败
// 用法：node tools/local/diary-lines.mjs [--at "2026-10-29 22:10"]
import fs from 'node:fs'
import path from 'node:path'
import { dshPath } from '../lib/paths.mjs'
import { VideoItem } from './video-entry.mjs'

const DL = dshPath('whale-work', 'discover-logs')
const BL = dshPath('whale-work', 'batch-logs')

const argv = process.argv.slice(2)
const atIdx = argv.indexOf('--at')
const at = atIdx >= 0 ? argv[atIdx + 1] : new Date().toISOString().slice(0, 16).replace('T', ' ')

const newest = (dir, ext) => {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => path.join(dir, f))
  if (!files.length) return null
  return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
}

const discFile = newest(DL, '.json')
if (!discFile) { console.error('找不到 discover 日志'); process.exit(2) }
const disc = JSON.parse(fs.readFileSync(discFile, 'utf8'))
const items = disc.items ?? []

// 从 debrief 日志里补 UP / 时长 / 抽帧失败
const meta = {}
let frameFail = new Set()
const qualityMap = new Map()   // bv → { quality, missing }
const batchFile = newest(BL, '.log')
if (batchFile) {
  const L = fs.readFileSync(batchFile, 'utf8').split(/\r?\n/)
  let cur = ''
  for (const l of L) {
    const m = l.match(/##########\s*(BV\w+)/)
    if (m) { cur = m[1]; meta[cur] = meta[cur] ?? {}; continue }
    const u = l.match(/^UP: (.+?)\s+时长: (.+?)(?:\s+分区|$)/)
    if (u && cur) { meta[cur].up = u[1]; meta[cur].dur = u[2] }
    // 只认「这一条视频失败」的那一行（-- 抽帧失败…），不能匹配日志末尾的
    //   「# 结果：… 抽帧失败 0 条」汇总行 —— 否则 cur 还是最后一条 BV，会被误标成抽帧失败
    if (/^-- 抽帧失败/.test(l) && cur) frameFail.add(cur)
    const pr = l.match(/-- 探针 质量=(\w) 缺=(.+)$/)
    if (pr && cur) qualityMap.set(cur, { quality: pr[1], missing: pr[2] === '无' ? '' : pr[2] })
  }
}

// 2026-10-30：直接用 VideoItem 的 toRow —— 时长 / UP / 来源都从对象取，
// 不再依赖 debrief 日志里那行元信息（走分段直取时那边没有时长）
const toRow = (raw) => {
  const v = new VideoItem(raw)
  if (frameFail.has(v.bv)) v.frameOk = false
  const pr = qualityMap.get(v.bv)
  const memo = []
  if (v.frameOk === false) memo.push('抽帧失败')
  if (pr && pr.quality !== 'A') memo.push(`评级${pr.quality}（缺${pr.missing}）`)
  return v.toRow(at, memo.join('；'))
}

console.log('| 时间 | BV | 标题 | 播放/弹幕/发布/时长 | UP + 来源 | 备注 |')
console.log('|---|---|---|---|---|---|')
for (const r of items) console.log(toRow(r))
if (!items.length) console.log('（本轮没有条目）')

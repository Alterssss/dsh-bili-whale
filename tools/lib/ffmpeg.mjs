// ffmpeg 定位（2026-10-17 加，为开源打包做准备）
//
// 为什么要有这个文件：旧代码把 ffmpeg 路径写死在 bili-watch.mjs 里（作者本机剪映自带那份）。
// 别人机器上没有剪映、或者版本号不同 → 抽帧直接报错 ✗
//
// 查找顺序（找到即用）：
//   ① 环境变量 FFMPEG         —— 用户明确指定，优先级最高
//   ② PATH 里的 ffmpeg(.exe)  —— 用户 `winget install ffmpeg` / `scoop install ffmpeg` 后就是这样
//   ③ <仓库>/bin/ffmpeg(.exe) —— 发布时随包放的静态构建（⚠️ 只放 LGPL 变体，附 LICENSE）
//   ④ ~/.dsh/bili-whale/bin/  —— 用户自己丢进来的那份
//   ⑤ 本机常见位置（剪映自带）—— ⚠️ 仅"本机便利"，剪映那份**不可再分发**（第三方发行版）
//
// 用 @ffmpegPath() 取路径（可能 null）；@requireFfmpeg() 取路径并在缺时抛友好错误。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { dshPath } from './paths.mjs'


const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const HOME = process.env.USERPROFILE || process.env.HOME || '.'

const exists = (f) => {
  if (!f) return false
  try { return fs.statSync(f).isFile() } catch { return false }
}

function onPath() {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue
    const f = path.join(d, EXE)
    if (exists(f)) return f
  }
  return null
}

// 本机便利：剪映自带的 ffmpeg（版本号在路径里，要扫目录）
function jianyingCopies() {
  if (process.platform !== 'win32') return []
  const base = path.join(process.env.LOCALAPPDATA || '', 'JianyingPro', 'Apps')
  try {
    return fs.readdirSync(base)
      .map((v) => path.join(base, v, 'ffmpeg.exe'))
      .filter(exists)
  } catch { return [] }
}

export function ffmpegPath() {
  const cands = [
    process.env.FFMPEG,
    onPath(),
    path.join(ROOT, 'bin', EXE),
    dshPath('bili-whale', 'bin', EXE),
    ...jianyingCopies(),
  ]
  return cands.find(exists) ?? null
}

export function requireFfmpeg() {
  const p = ffmpegPath()
  if (p) return p
  throw new Error([
    '找不到 ffmpeg（抽帧/看画面需要它）。任选一种解决：',
    '  ① 装一个：winget install ffmpeg   （或 scoop install ffmpeg / brew install ffmpeg）',
    '  ② 用环境变量指定：set FFMPEG=D:\\path\\to\\ffmpeg.exe',
    `  ③ 把它放到 ${path.join(ROOT, 'bin', EXE)} 或 ${dshPath('bili-whale', 'bin', EXE)}`,
  ].join('\n'))
}

// 给人/给 agent 看的"依赖体检"结果
export function ffmpegInfo() {
  const p = ffmpegPath()
  if (!p) return { ok: false, path: null, version: null }
  try {
    const out = execFileSync(p, ['-hide_banner', '-version'], { encoding: 'utf8' })
    return { ok: true, path: p, version: (out.split('\n')[0] || '').trim() }
  } catch (e) {
    return { ok: false, path: p, version: null, error: String(e.message).slice(0, 120) }
  }
}

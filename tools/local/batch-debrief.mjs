// batch-debrief.mjs —— 稳一点的批量深读：自带重试、空输出检测、日志走 node 写
// 用法：
//   node batch-debrief.mjs BV1xxx BV1yyy ...            （默认 10 条一批）
//   node batch-debrief.mjs --from bvs.txt [--no-frames] [--size 5]
//
// 为什么要有它：2026-10-23、10-28 三次批量深读被 Windows 杀掉（0xC0000142 DLL 初始化失败），
//   原因是一次 PowerShell 循环里连续 spawn 几十个子进程 + Out-File 反复开文件句柄。
//   这个脚本：每个子进程独立管道、日志用 fs 写、失败重试一次、连续两条空就停手报错。
// 它**不改上游任何文件**，只调用 `node bili.mjs debrief`，放在 tools/local/ 里。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dshPath, configPath } from '../lib/paths.mjs'
import { probeText } from './text-probe.mjs'   // ← LOCAL：字幕/评论/弹幕三类探针

const here = path.dirname(fileURLToPath(import.meta.url))       // tools/local
const TOOLS = path.resolve(here, '..')                          // tools
const LOGDIR = dshPath('whale-work', 'batch-logs')
const MIN_BYTES = 200
const SEG_FRAMES = process.argv.includes('--seg-frames')   // 用新的分段下载抽帧
// 2026-10-30："字幕/评论/弹幕能不能并行读" —— 不能改上游 debrief 内部，
//   但可以同时跑两条视频，效果一样：两套请求并行发出。默认 2 条。
const READ_CONC = Number(process.env.READ_CONC ?? 2)

// 2026-10-30 的计时开关：bili-whale.config.json 里 timing.enabled
//   默认 true；关掉就改成 false，届时不再输出 TIMING 行
const TIMING_ON = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    return j?.timing?.enabled === true // 仓库默认关，本地配置里写 true 才输出
  } catch { return true }
})()

const argv = process.argv.slice(2)
const extra = argv.filter((a) => a.startsWith('--') && !['--from', '--size'].includes(a))
const sizeArg = argv.indexOf('--size')
const batchSize = sizeArg >= 0 ? Number(argv[sizeArg + 1] || 10) : 999
const fromIdx = argv.indexOf('--from')
let bvs = argv.filter((a, i) => /^BV/i.test(a) && !String(argv[i - 1]).startsWith('--'))
if (fromIdx >= 0) {
  const file = argv[fromIdx + 1]
  bvs = bvs.concat(fs.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
}

if (!bvs.length) { console.error('用法：node batch-debrief.mjs <BV...> 或 --from <文件>'); process.exit(2) }

fs.mkdirSync(LOGDIR, { recursive: true })
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')
const LOG = path.join(LOGDIR, `debrief-${stamp}.log`)
const write = (s) => fs.appendFileSync(LOG, s + '\n')

// 2026-10-29（方案 C）：抽完帧就把原片删掉，别在盘上堆 —— 之前堆到 7.3 GB
//   只删这次跑成功的那些；失败的不删，方便排查
const SHOTS = dshPath('shots', 'video')
function cleanupMp4(bv) {
  let freed = 0
  try {
    for (const f of fs.readdirSync(SHOTS)) {
      if (!f.startsWith(bv) || !f.endsWith('.mp4')) continue
      const p = path.join(SHOTS, f)
      const size = fs.statSync(p).size
      fs.rmSync(p, { force: true })
      freed += size
      write(`-- 已删原片 ${f}（${(size / 1024 / 1024).toFixed(1)} MB）`)
    }
  } catch {}
  return freed
}

write(`# 批次 ${stamp} · ${bvs.length} 条 · 额外参数 ${extra.join(' ') || '无'}`)

const ok = []
const failed = []
const frameFailures = []
let emptyStreak = 0

// 并发池（默认 2 条同时读）
const runOne = async (i, bv) => {
  if (emptyStreak >= 2) {
    write('!! 连续两条空输出 → 停手（机器可能扛不住了）')
    console.error(`连续两条空输出，停在 ${bv} 之前`)
    return
  }
  write(`\n########## ${bv}   (${i + 1}/${bvs.length})`)

  // 2026-10-30：字幕/评论/弹幕各 30s 超时，失败返回空；缺哪样就降评级
  const tStart = Date.now()
  let probe = null
  try {
    probe = await probeText(bv)
    write(`-- 探针 质量=${probe.quality} 缺=${probe.missing.join('/') || '无'}`)
    if (probe.quality !== 'A') console.log(`  评级 ${probe.quality}（缺 ${probe.missing.join('、')}）`)
    if (probe.missing.length >= 3) {
      write('-- 三类全空，跳过文字深读（只取画面帧）')
    }
  } catch (e) { write('-- 探针失败（忽略）：' + String(e.message).slice(0, 80)) }

  let okThis = false
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let r
    if (SEG_FRAMES) {
      const dT0 = Date.now()
      r = spawnSync(process.execPath, ['bili.mjs', 'debrief', bv, '--no-frames', ...extra.filter((a) => a !== '--no-frames')], {
        cwd: TOOLS, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15 * 60 * 1000,
      })
      var textMs = Date.now() - dT0
      const segT0 = Date.now()
      const seg = spawnSync(process.execPath, [path.join(TOOLS, 'local/segment-watch.mjs'), bv, '3x3'], {
        encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60 * 1000,
      })
      var frameMs = Date.now() - segT0
      if (seg.status === 0) {
        write(String(seg.stdout || ''))
      } else if (seg.status === 7) {
        frameFailures.push(bv)
        write('-- 抽帧失败（文字部分已完成，本条目没有画面帧）')
        console.log('⚠ 抽帧失败：' + bv + '（日记里会写明）')
      } else {
        console.log('⚠ 新下载方法失效，请进行排查 —— 这条回退上游整片下载')
        write('-- 分段下载失败，回退上游：' + String(seg.stderr || '').slice(0, 200))
        r = spawnSync(process.execPath, ['bili.mjs', 'debrief', bv, ...extra.filter((a) => a !== '--no-frames')], {
          cwd: TOOLS, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15 * 60 * 1000,
        })
      }
    } else {
      const dT0 = Date.now()
      r = spawnSync(process.execPath, ['bili.mjs', 'debrief', bv, ...extra], {
        cwd: TOOLS, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15 * 60 * 1000,
      })
      var textMs = Date.now() - dT0
    }
    const out = (r.stdout || '') + (r.stderr || '')
    write(out)
    if (out.length >= MIN_BYTES && !/Cannot find module|ERR_|不可用/.test(out.slice(0, 200))) { okThis = true; break }
    write(`-- 第 ${attempt} 次没成（${out.length} 字节，status=${r.status}）`)
    if (attempt === 1) await new Promise((r2) => setTimeout(r2, 2000))
  }

  if (TIMING_ON) {
    const ms = probe?.ms ?? { sub: 0, cmt: 0, dm: 0 }
    write(`TIMING bv=${bv} subs=${ms.sub ?? 0} cmt=${ms.cmt ?? 0} dm=${ms.dm ?? 0} text=${typeof textMs === 'number' ? textMs : 0} frames=${typeof frameMs === 'number' ? frameMs : 0} total=${Date.now() - tStart}`)
  }

  if (okThis) {
    const freed = cleanupMp4(bv)
    if (freed) console.log(`  清理原片，省 ${(freed / 1024 / 1024).toFixed(0)} MB`)
    ok.push(bv); emptyStreak = 0
  } else { failed.push(bv); emptyStreak += 1 }
}

for (let k = 0; k < bvs.length; k += READ_CONC) {
  const batch = bvs.slice(k, k + READ_CONC).map((bv, j) => [k + j, bv])
  await Promise.all(batch.map(([i, bv]) => runOne(i, bv)))
  if (k + READ_CONC < bvs.length) write(`-- 已跑 ${k + READ_CONC} 条，继续`)
}

write(`\n# 结果：成功 ${ok.length} 条 · 失败 ${failed.length} 条 · 抽帧失败 ${frameFailures.length} 条`)
write(`# 成功：${ok.join(' ')}`)
if (failed.length) write(`# 失败：${failed.join(' ')}`)
if (frameFailures.length) write(`# 抽帧失败（文字成功、无画面帧）：${frameFailures.join(' ')}`)
console.log(JSON.stringify({ log: LOG, ok, failed, frameFailures }, null, 2))
process.exit(failed.length ? 1 : 0)

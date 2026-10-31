// round.mjs —— LOCAL：一键跑一轮「找片 → 深读 → 采标签」
// 为什么要有（2026-10-29）：discover 和 batch-debrief 之前要手动串两条命令。
// 2026-10-29：**默认走新路径**（discover）；只有新路径凑不够 N 条时，
//   才兜底走老路径（feed），并且要明确报「新路径不足，请排查」。
//
// 用法：
//   node tools/local/round.mjs                 # 默认 10 条，用日记偏好词
//   node tools/local/round.mjs --n 6           # 要 6 条
//   node tools/local/round.mjs --kw 新番 --kw 家常菜
//   node tools/local/round.mjs --no-frames     # 只读文字，不抽帧（快、省流量）
//   node tools/local/round.mjs --dry           # 只找片列清单，不深读
//
// ── 流水线概览（一条命令按顺序跑完五个阶段）────────────────────────
//   ① 找片     按兴趣词与时间窗搜索，配额随机取并加热搜保底，凑够 N 条
//              对应 discover.mjs（filter.mjs 做统一筛选，video-entry.mjs 承载每条数据）
//   ② 深读     并发读取字幕、评论、弹幕与画面帧，产出可读的结构化素材
//              对应 batch-debrief.mjs（内部调 debrief 取字幕/热评/弹幕，调 segment-watch 抽帧，
//              text-probe 先用三类探针判定内容是否完整）
//   ③ 采标签   把已读视频的标签计入统计，供之后反选更有效的兴趣词
//              对应 collect-tags-round.mjs + tagstore.mjs（两级标签库，按月清理低频词）
//   ④ 相关补采  从相关推荐里补收高播放视频的标签与分区，只取前几条
//              对应 related-collect.mjs + region-store.mjs（有播放量门槛与条数上限）
//   ⑤ 输出     打印耗时、超时、总览、收信草稿与「下一步该做什么」的提示
//              对应 out/{report,overview,stats,final}.mjs（hooks 订阅，可增删）
//
//   这条流水线只做「读」和「统计」：找片、深读、采标签、补采、打印下一步提示。发送动作（评论 / 分享 / 私信）不在本命令内执行 —— 上游的 feed、debrief 同样如此，由唤醒流程或调用方另行决定。
//   与原流程的差别：原来是 feed 出选题 → 手动一条条 debrief → 人肉挑几条深读；
//   这里把找片、深读、采标签、补采、输出串成一条命令，找片多了时间窗梯次/配额随机/热搜保底/
//   合集限流，深读改成并发 + 探针预判，抽帧改成只下需要的片段，最后统一出表。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { configPath } from '../lib/paths.mjs'
// 2026-10-31：耗时/落点/超时这类"本地诊断输出"共用这个开关。
//   仓库默认关（别人跑起来干净），本地配置写 "timing": { "enabled": true } 才开。
const TIMING_ON = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    return j?.timing?.enabled === true
  } catch { return false }
})()
// 输出块已拆到 out/：各文件自注册 round:done，round.mjs 只负责流程。
import { hooks } from './hooks.mjs'
import './out/report.mjs'
import './out/overview.mjs'
import './out/stats.mjs'
import './out/final.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
// 本轮开始时刻（2026-10-31）：out/report.mjs 的超时表按这个时间往后筛，
//   不再用固定的 20 分钟窗口 —— 一轮跑超过 20 分钟时，前半段的超时会整段漏掉。
const startAt = new Date()
const argv = process.argv.slice(2)

const nIdx = argv.indexOf('--n')
const N = nIdx >= 0 ? argv[nIdx + 1] : '10'
const kws = argv.reduce((a, v, i) => (v === '--kw' && argv[i + 1] ? a.concat(argv[i + 1]) : a), [])
const NO_FRAMES = argv.includes('--no-frames')
const DRY = argv.includes('--dry')

const discoverArgs = ['discover.mjs', '--n', N, '--json']
for (const k of kws) discoverArgs.push('--kw', k)

// 落点：这一轮醒来的时刻（2026-10-29：确定后立刻在对话里发）
const pad2 = (n) => String(n).padStart(2, '0')
const now = new Date()
const LANDING = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
// 2026-10-31：落点不输出到对话，只有本地开着耗时开关时才打印 —— 跟耗时共用 timing.enabled
if (TIMING_ON) console.log(`落点 ${LANDING}（${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}）`)
// 本命令只读：找片、深读、统计、打印下一步提示。发送动作不在本命令内执行（上游 feed/debrief 同样如此），由调用方另行决定。
//   落点只打印出来给自己看，要发就自己发 —— node bili.mjs dm --msg "…"
if (TIMING_ON) {
    const dm = spawnSync(process.execPath, ['bili.mjs', 'dm', '--msg', `落点 ${LANDING}，这轮开始找片`], {
      cwd: path.resolve(here, '../..', 'tools'), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
    })
    if (dm.status !== 0) console.log('  （落点私信没发出去：' + String(dm.stderr || '').slice(0, 80) + '）')
    else console.log('  （落点私信已发）')
  }

console.log(`[1/2] 找片：${N} 条${kws.length ? '，关键词 ' + kws.join('/') : '，用日记偏好词'}`)
const d = spawnSync(process.execPath, [path.join(here, 'discover.mjs'), ...discoverArgs.slice(1)], {
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
})
if (d.status !== 0) { console.error('找片失败：' + String(d.stderr || '').slice(0, 300)); process.exit(1) }

let res = null
try { res = JSON.parse(String(d.stdout).trim()) } catch { console.error('找片输出不是 JSON：' + String(d.stdout).slice(0, 200)); process.exit(1) }
let items = res.items ?? []
let usedFallback = false

// ── 兜底：新路径凑不够 N 条 → 明确报出来，再退回老路径（feed）──
if (items.length < Number(N)) {
  console.warn(`\n⚠ 新路径只找到 ${items.length} 条，还差 ${Number(N) - items.length} 条 —— 新路径搜索失败/不足，请排查`)
  console.warn('   原因可能是：时间窗内没有够格的片、关键词太窄、或搜索接口被风控')
  console.warn('   → 已启用兜底机制：改走老路径（feed）选题；下面标「兜底」的条目就是它补的')
  const fb = spawnSync(process.execPath, ['bili.mjs', 'feed', '--n', String(N)], {
    cwd: path.resolve(here, '../..', 'tools'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60 * 1000,
  })
  const bvsFn = String(fb.stdout || '').matchAll(/\bBV[0-9A-Za-z]{10}\b/g)
  const have = new Set(items.map((r) => r.bv))
  const extra = []
  for (const m of bvsFn) {
    if (extra.length >= Number(N) - items.length) break
    if (have.has(m[0])) continue
    extra.push({ bv: m[0], title: '(老路径兜底)', play: 0, dm: 0, pubdate: '', window: '兜底', kw: 'feed' })
  }
  if (extra.length) {
    console.warn(`   老路径补了 ${extra.length} 条（来源标「兜底」）`)
    items = items.concat(extra)
    usedFallback = true
  } else {
    console.warn('   老路径也没补到，见下面的错误')
  }
}
if (!items.length) { console.error('新路径和老路径都没找到片'); process.exit(1) }

// 本轮参数头（2026-10-29：每次输出都带上这些）
console.log('[本轮参数]')
console.log(`  N              ${res.n ?? N}`)
console.log(`  兴趣词(${(res.keywords ?? []).length})       ${(res.keywords ?? []).join(' · ') || '(来自日记)'}`)
console.log(`  每词配额        ${res.quota ?? '-'}`)
console.log(`  minHotCount    ${res.minHotCount ?? '-'}（实际热搜 ${res.hotActual ?? '-'} 条）`)
console.log(`  搜索侧时间      ${(res.windows ?? []).join(' → ')} 天`)
console.log(`  筛选侧时间      ${(res.filterWindows ?? []).join(' → ')} 天`)
console.log(`  凑不到条数      ${res.shortfall ?? 0}`)
console.log('')

if (res.warnings?.length) {
  console.log('⚠ 需要处理的警告：')
  for (const w of res.warnings) console.log('   · ' + w)
  console.log('')
}

for (const t of res.trace ?? []) {
  if (t.kw) console.log(`  ${t.kw}: 候选 ${t.候选} → 取 ${t.取}（配额 ${t.配额 ?? '-'}）`)
console.log(`  ${t.来源}: ${Object.entries(t).filter(([k]) => k !== '来源').map(([k, v]) => `${k} ${v}`).join(' · ')}`)
}
items.forEach((r, i) => {
  const src = r.window === '热搜' ? `热搜·${r.kw}` : `${r.window}天·${r.kw}`
  console.log(`${String(i + 1).padStart(2)}. ${r.bv}  ${String(r.play).padStart(9)} 播放  ${r.pubdate}  【${src}】  ${String(r.title).slice(0, 40)}`)
})

if (DRY) { console.log('\n（--dry：只找片，不深读）'); process.exit(0) }

// 2026-10-31：深读条数 = min(bw_cfg_deepReadMax, 找片筛出数)，不再无条件全读。
//   原来"全部深读"意味着 9 条十条全跑，一轮十几分钟；现在按配置封顶。
try {
  const { cv } = await import('file:///' + path.join(here, 'bw-config.mjs').replace(/\\/g, '/'))
  const capRaw = cv('deepReadMax') ?? 3
  const isAll = String(capRaw).toLowerCase() === 'all'
  const cap = isAll ? items.length : Number(capRaw)
  if (!isAll && items.length > cap) {
    console.log(`  深读上限 ${cap} 条（筛出 ${items.length} 条，超出部分不读）`)
    items = items.slice(0, cap)
  }
} catch {}

const bvs = items.map((r) => r.bv)
const batchArgs = [path.join(here, 'batch-debrief.mjs'), ...bvs, '--size', '5']
if (NO_FRAMES) batchArgs.push('--no-frames')
else batchArgs.push('--seg-frames')   // 默认分段下载抽帧（省 95% 流量），失败自动回退上游

console.log(`\n[2/2] 深读 ${bvs.length} 条${NO_FRAMES ? '（不抽帧）' : '（含抽帧）'}…`)
const b = spawnSync(process.execPath, batchArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60 * 60 * 1000 })
let out = null
try { out = JSON.parse(String(b.stdout).trim()) } catch {}
if (out) {
  console.log(`成功 ${out.ok.length} 条 · 失败 ${out.failed.length} 条`)
  console.log(`日志：${out.log}`)
  if (out.failed.length) console.log('失败：' + out.failed.join(' '))
  // 修 a（2026-10-31）：把抽帧失败回填到条目上。
  //   问题：out/final.mjs 的「抽帧失败 N 条」是数 items.filter(r => r.frameOk === false)，
  //        但 items 来自 discover 的 JSON，frameOk 一律是 null，所以恒为 0。
  //   做法：batch-debrief 的 JSON 里已经带着 frameFailures（文字读成功、只是没拿到画面帧的 BV），
  //        按 BV 把这批条目标成 frameOk = false；成功抽到帧的不动（仍是 null = 未知）。
  const frameFailed = new Set(out.frameFailures ?? [])
  for (const it of items) if (frameFailed.has(it.bv)) it.frameOk = false
} else {
  console.log(String(b.stdout || b.stderr || '').slice(-600))
}

// ── [3/3] 采标签（2026-10-29：读过的都进两级标签库）────────
if (!argv.includes('--no-tags') && items.length) {
  console.log(`\n[3/3] 采标签 ${items.length} 条…`)
  const kwCount = new Set(items.map((r) => r.kw)).size || kws.length || 4
  const c = spawnSync(process.execPath, [
    path.join(here, 'collect-tags-round.mjs'), ...items.map((r) => r.bv),
    '--src', 'round', '--kwcount', String(kwCount),
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60 * 1000 })
  console.log(String(c.stdout || '').trim().split(/\r?\n/).slice(-4).join('\n'))

  // 本轮标签统计：这批视频里每个标签出现几次，从多到少（2026-10-29）
  try {
    const { readRoundTags } = await import('file:///' + path.join(here, 'tagstore.mjs').replace(/\\/g, '/'))
    const rows = readRoundTags(items.map((r) => r.bv))
    if (rows.length) {
      console.log('\n[本轮标签统计]')
      for (const r of rows) console.log(`  ${String(r.count).padStart(2)}×  ${r.tag}`)
    }
  } catch (e) { console.log('（标签统计失败：' + String(e.message).slice(0, 60) + '）') }
  if (c.status !== 0) console.log('（采标签有失败，不影响这轮读片结果）')
}

// ── [4/4] 收尾：日记行 + 评论扫描 + 表态扫描（2026-10-29）──
if (!argv.includes('--dry')) {
  console.log('\n[本轮日记行]（复制进 whale-diary.md 的「看过」表）')
  const dl = spawnSync(process.execPath, [path.join(here, 'diary-lines.mjs'), '--at', `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${LANDING}`], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60 * 1000,
  })
  console.log(String(dl.stdout || '').trim().split(/\r?\n/).slice(1).join('\n'))

  console.log('\n[评论扫描]')
  const cd = spawnSync(process.execPath, ['bili.mjs', 'comment-digest', '--hours', '24'], {
    cwd: path.resolve(here, '../..', 'tools'), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5 * 60 * 1000,
  })
  console.log(String(cd.stdout || '').trim().split(/\r?\n/).slice(-3).join('\n') || String(cd.stderr || '').slice(0, 120))

  console.log('\n[表态扫描]')
  const qr = spawnSync(process.execPath, ['bili.mjs', 'quota', 'react', '--auto', '--hours', '48'], {
    cwd: path.resolve(here, '../..', 'tools'), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5 * 60 * 1000,
  })
  console.log(String(qr.stdout || '').trim().split(/\r?\n/).slice(0, 3).join('\n') || String(qr.stderr || '').slice(0, 120))
}

// 输出块拆到 tools/local/out/：各文件订阅 round:done 自注册，这里按流程触发一次。
// payload 里多带两个字段，给输出块用（都是本轮才知道的值，所以只能从流程里传）：
//   logPath —— 本轮 batch-debrief 的日志路径（修 b：out/report.mjs 的耗时表优先读它，
//              不再去 batch-logs 里猜「最新那个 .log」，并发/上一轮的日志会串）；
//   startAt —— 本轮开始时间（修 c：超时表按它往后筛，不再硬编码 20 分钟窗口）。
await hooks.run('round:done', { items, N, LANDING, TIMING_ON, here, res, logPath: out?.log, startAt: startAt.toISOString() })

process.exit(out && out.failed.length ? 1 : 0)

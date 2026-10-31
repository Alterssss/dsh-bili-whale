// out/report.mjs —— LOCAL：本轮耗时表 + 本轮超时表（round:done 订阅者，order 10）
import fs from 'node:fs'
import path from 'node:path'
import { dshPath } from '../../lib/paths.mjs'
import { hooks } from '../hooks.mjs'

/**
 * 本轮超时窗口的起点（2026-10-31 修 c）：
 *   以前这里是固定的「最近 20 分钟」，单轮跑超过 20 分钟时，前半段的超时会整段漏掉。
 *   现在按「本轮开始时间」算：round 把 startAt 放进 payload 传过来。
 *   取不到时（单独跑 report）退两级：先看本轮日志文件名里的批次时间戳，最后才退到当天 0 点。
 * 注意 batch-debrief 的日志名是 UTC 时间戳（debrief-YYYYMMDDHHmmss），所以按 UTC 解析。
 */
function sinceOf(startAt, logFile) {
  const t = startAt ? new Date(startAt) : null
  if (t && !Number.isNaN(t.getTime())) return t
  const m = path.basename(String(logFile ?? '')).match(/debrief-(\d{14})/)
  if (m) {
    const iso = m[1].replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6Z')
    const d = new Date(iso)
    if (!Number.isNaN(d.getTime())) return d
  }
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

hooks.on('round:done', async ({ items, here, logPath, startAt }) => {
  console.log('')

  // 本轮耗时表（开关在 bili-whale.config.json 的 timing.enabled）
  // 修 b（2026-10-31）：优先用本轮 batch-debrief 返回的日志路径（round 通过 payload 传进来）。
  //   以前固定读 batch-logs 里「最新」的那个 .log —— 并发跑或者上一轮刚结束时都会读串，
  //   表里就混进别人的/上一轮的耗时。只有取不到（单独跑 report）才回退到「最新文件」。
  let logFile = ''
  if (logPath && fs.existsSync(logPath)) logFile = logPath
  else {
    try {
      const dir = dshPath('whale-work', 'batch-logs')
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).map((f) => path.join(dir, f))
      logFile = files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? ''
    } catch (e) { console.log('（耗时统计读不到：' + String(e.message).slice(0, 60) + '）') }
  }

  if (logFile) {
    try {
      const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('TIMING '))
      if (lines.length) {
        console.log('\n[本轮耗时] 单位秒')
        // 2026-10-30：加 分P / 总时长 / 标题，方便一眼看出是哪种片子
        const info = new Map(items.map((r) => [r.bv, r]))
        const toSec = (v) => { const a=String(v??'').split(':').map(Number); if(a.some(n=>!Number.isFinite(n))) return 0; return a.reduce((x,n)=>x*60+n,0) }
        const fmtMin = (sec) => { const m = Math.round(Number(sec) / 60); return m >= 60 ? `${Math.floor(m / 60)}小时${m % 60}分` : `${m}分` }
        console.log('  BV              分P  总时长    标题                          字幕  评论  弹幕  深读  抽帧  合计')
        let sum = { subs: 0, cmt: 0, dm: 0, text: 0, frames: 0, total: 0 }
        for (const l of lines) {
          const g = Object.fromEntries([...l.matchAll(/(?:^|\s)(subs|cmt|dm|text|frames|total)=(\d+)/g)].map((m) => [m[1], Number(m[2])]))
          g.bv = (l.match(/bv=(\S+)/) || [])[1] ?? '-'
          const s = (n) => (n / 1000).toFixed(1).padStart(5)
          const it = info.get(g.bv) ?? {}
          const parts = Number(it.parts ?? 1)
          const totalSec = (Number(it.durSec ?? 0) || toSec(it.dur)) * parts
          const title = String(it.title ?? '').slice(0, 24)
          console.log(`  ${g.bv}  ${String(parts).padStart(3)}P  ${fmtMin(totalSec).padEnd(8)} ${title.padEnd(26)} ${s(g.subs)} ${s(g.cmt)} ${s(g.dm)} ${s(g.text)} ${s(g.frames)} ${s(g.total)}`)
          for (const k of Object.keys(sum)) sum[k] += g[k] ?? 0
        }
        const s = (n) => (n / 1000).toFixed(1)
        console.log(`  合计（并发跑，各项相加会大于实际墙钟）`)
        console.log(`  字幕 ${s(sum.subs)}s · 评论 ${s(sum.cmt)}s · 弹幕 ${s(sum.dm)}s · 文字 ${s(sum.text)}s · 抽帧 ${s(sum.frames)}s`)
      }
    } catch (e) { console.log('（耗时统计读不到：' + String(e.message).slice(0, 60) + '）') }
  }

  // 超时单独一块，一行一条（窗口见上面的 sinceOf）
  try {
    const tl = await import('file:///' + path.join(here, 'timeout-log.mjs').replace(/\\/g, '/'))
    const rows = tl.readTimeouts(sinceOf(startAt, logFile).toISOString())
    if (rows.length) {
      console.log('\n[本轮超时]')
      for (const x of rows) {
        const parts = x.parts > 1 ? `${x.parts}P/${x.durMin}分` : `单集/${x.durMin}分`
        console.log(`  ${x.bv} · ${x.title.slice(0, 26)} · ${parts} · ${x.stage} 超时 ${x.timeoutSec}s`)
      }
    } else {
      console.log('\n[本轮超时] 无')
    }
  } catch (e) { console.log('（超时统计读不到：' + String(e.message).slice(0, 50) + '）') }
}, 10)

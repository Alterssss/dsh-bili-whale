import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { guardedFetch } from '../lib/traffic.mjs'
import { apiGet } from '../lib/bili-api.mjs'
import { credentialsPath } from '../lib/paths.mjs'
import { config } from '../lib/config.mjs'
import { gate, record } from '../lib/quota-gate.mjs'

const usage = '用法: video-danmaku --bvid <BV号> --at <秒> --msg <内容> --dry|--go [--auto]'
function parse(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (!['--bvid', '--at', '--msg', '--dry', '--go', '--auto'].includes(key) || key in opts) throw Error(usage)
    if (['--dry', '--go', '--auto'].includes(key)) opts[key] = true
    else {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw Error(usage)
      opts[key] = value
    }
  }
  if (!/^BV[0-9A-Za-z]{10}$/.test(opts['--bvid'] ?? '') || !/^(?:\d+)(?:\.\d{1,3})?$/.test(opts['--at'] ?? '') || !opts['--msg']?.trim() || [...opts['--msg']].length >= 100 || Boolean(opts['--dry']) === Boolean(opts['--go'])) throw Error(usage)
  const ms = Math.round(Number(opts['--at']) * 1000)
  if (!Number.isSafeInteger(ms)) throw Error('播放时间无效')
  return { bvid: opts['--bvid'], ms, msg: opts['--msg'], dry: !!opts['--dry'], auto: !!opts['--auto'] }
}

// Dependencies can be substituted by tests; the CLI always uses the real guarded transport.
export async function run(argv, deps = {}) {
  let options
  try { options = parse(argv) } catch (e) { (deps.error ?? console.error)(e.message); return 2 }
  const { bvid, ms, msg, dry, auto } = options
  const log = deps.log ?? console.log
  try {
    let cred
    try { cred = deps.credentials ?? JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) } catch { throw Error('无法读取凭据') }
    if (!cred.sessdata || !cred.bili_jct) throw Error('凭据不完整')
    const expected = String((deps.getConfig ?? config)().self?.mid ?? '')
    if (!/^[1-9]\d*$/.test(expected)) throw Error('配置中缺少有效的 self.mid')
    const headers = { 'user-agent': 'Mozilla/5.0', referer: `https://www.bilibili.com/video/${bvid}`, origin: 'https://www.bilibili.com', cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3 ?? ''}` }
    const get = deps.apiGet ?? apiGet
    const nav = await get('https://api.bilibili.com/x/web-interface/nav', headers, { noCache: true })
    if (nav?.code !== 0 || nav.data?.isLogin !== true || String(nav.data.mid) !== expected) throw Error('登录账号与配置 self.mid 不一致或未登录')
    const view = await get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, headers, { noCache: true })
    if (view?.code !== 0 || !view.data) throw Error('获取视频信息失败')
    const first = view.data.pages?.[0]
    const cid = first?.cid ?? view.data.cid
    const duration = first?.duration ?? view.data.duration
    if (!Number.isSafeInteger(Number(cid)) || Number(cid) <= 0 || !Number.isFinite(Number(duration)) || Number(duration) <= 0 || ms >= Number(duration) * 1000) throw Error('视频第一分信息或播放时间无效')
    log(`账号 mid=${expected}；视频 ${bvid}，第一分 P1，cid=${cid}，位置 ${ms} 毫秒；弹幕：${msg}`)
    if (dry) { log('[dry] 未发送'); return 0 }
    const target = `video:${bvid}`
    if (!(deps.gate ?? gate)({ type: 'danmaku', target, auto })) throw Error('限额闸拒绝发送')
    const form = new URLSearchParams({ type: '1', oid: String(cid), bvid, msg, progress: String(ms), color: '16777215', fontsize: '25', pool: '0', mode: '1', csrf: String(cred.bili_jct) })
    const response = await (deps.fetch ?? guardedFetch)('https://api.bilibili.com/x/v2/dm/post', { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() })
    if (!response.ok) throw Error(`发送接口 HTTP ${response.status}；发送结果可能未知，请先检查再决定是否重试`)
    let result
    try { result = await response.json() } catch { throw Error('发送接口响应无效；发送结果可能未知，请先检查再决定是否重试') }
    if (result?.code !== 0) throw Error(`发送接口拒绝 code=${String(result?.code ?? 'unknown')}`)
    ;(deps.record ?? record)({ type: 'danmaku', target, note: msg, auto })
    log(`发送接口已接受${result.data?.dmid_str ? `，dmid=${result.data.dmid_str}` : ''}；未回读确认，展示或审核状态未知。`)
    return 0
  } catch (e) {
    // Do not log raw transport errors: they can include URLs, headers or secrets.
    const known = /^(无法读取凭据|凭据不完整|配置中缺少有效的 self\.mid|登录账号与配置 self\.mid 不一致或未登录|获取视频信息失败|视频第一分信息或播放时间无效|限额闸拒绝发送|发送接口 HTTP \d+；发送结果可能未知，请先检查再决定是否重试|发送接口响应无效；发送结果可能未知，请先检查再决定是否重试|发送接口拒绝 code=-?\d+)$/.test(e.message)
    ;(deps.error ?? console.error)(`操作失败：${known ? e.message : '请求或处理失败；若已发送，请先检查再决定是否重试'}`)
    return 1
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await run(process.argv.slice(2))

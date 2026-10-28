import fs from 'node:fs'
import { guardedFetch as fetch } from '../lib/traffic.mjs'
import { credentialsPath } from '../lib/paths.mjs'
import { config } from '../lib/config.mjs'

const args = process.argv.slice(2)
const modes = args.filter(x => ['--dry', '--go', '--check'].includes(x))
const target = args[0]
if (args.length !== 2 || modes.length !== 1 || args[1] !== modes[0] || !/^[1-9]\d*$/.test(target)) {
  console.error('用法: node bili.mjs follow <mid> --dry|--go|--check')
  process.exit(2)
}
try {
  let cred
  try { cred = JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) } catch { throw Error('无法读取凭据') }
  if (!cred.sessdata || !cred.bili_jct) throw Error('凭据不完整')
  const expected = String(config().self?.mid ?? '')
  if (!/^[1-9]\d*$/.test(expected)) throw Error('配置中缺少有效的 self.mid，无法核对账号')
  const headers = { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com', cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3 ?? ''}` }
  async function call(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } })
    if (!response.ok) throw Error(`接口 HTTP ${response.status}`)
    const result = await response.json()
    if (result.code !== 0) throw Error(`接口拒绝请求 code=${String(result.code)}`)
    return result.data
  }
  const nav = await call('https://api.bilibili.com/x/web-interface/nav')
  if (nav?.isLogin !== true || String(nav.mid) !== expected) throw Error('登录账号与配置 self.mid 不一致或未登录')
  if (target === expected) throw Error('不能关注自己')
  console.log(`账号 mid=${expected}；目标 mid=${target}`)
  async function check() { const data = await call(`https://api.bilibili.com/x/relation?fid=${target}`); if (![0, 2, 6, 128].includes(data?.attribute)) throw Error('关注关系响应无效'); if (data.attribute === 128) throw Error('目标处于黑名单，不能关注'); return data.attribute === 2 || data.attribute === 6 }
  const before = await check()
  console.log(`当前状态：${before ? '已关注' : '未关注'}`)
  if (modes[0] === '--check') process.exit(0)
  if (before) { console.log('已经关注，无需写入'); process.exit(0) }
  if (modes[0] === '--dry') { console.log('[dry] 将关注，未写入'); process.exit(0) }
  const body = new URLSearchParams({ fid: target, act: '1', re_src: '11', csrf: String(cred.bili_jct) })
  await call('https://api.bilibili.com/x/relation/modify', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() })
  if (!await check()) throw Error('接口返回成功，但回读未确认关注；请先检查再决定是否重试')
  console.log('已关注，回读确认')
} catch (error) {
  const known = /^(无法读取凭据|凭据不完整|配置中缺少有效的 self\.mid，无法核对账号|登录账号与配置 self\.mid 不一致或未登录|不能关注自己|目标处于黑名单，不能关注|点赞状态响应无效|关注关系响应无效|接口 HTTP \d+|接口拒绝请求 code=-?\d+|接口返回成功，但回读未确认(?:点赞|关注)；请先检查再决定是否重试)$/.test(error.message)
  console.error(`操作失败：${known ? error.message : '请求或处理失败；如已提交，请先检查状态再决定是否重试'}`)
  process.exit(1)
}

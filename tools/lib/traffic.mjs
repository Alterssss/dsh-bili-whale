import { resolveHome } from './home.mjs'
import {diagnose} from './diagnostics.mjs'
import { activityFetch } from './activity.mjs'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { configPath } from './paths.mjs'

export const RISK_DEFAULTS = { minGapMs: 1500, readHourly: 600, readDaily: 3000, writeHourly: 12, writeDaily: 30, writeGapSec: 120, dmGapSec: 60 }
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
export function riskSettings() {
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')).risk ?? {} } catch(e) { if(e.code!=='ENOENT'){diagnose('traffic-config-read',e);throw new TrafficError('请求保护配置无法读取，已停止网络请求')} }
  const result = { ...RISK_DEFAULTS }
  for (const key of Object.keys(result)) {
    const n = Number(cfg[key])
    // 2026-10-23 改：dmGapSec 允许 0（主人要求「私信冷却不要」✗）
    //   其他预算类仍然是 >0 才生效 ✓（0 会被当成没填 ✓ 防手滑关掉闸门）
    // 2026-10-29 测试期（主人要求）：三个冷却键都允许显式 0
    //   原来是 n>0 才生效 ✗ → 写 0 会被当成"没填"，回落到默认 120 秒
    const GAP_KEYS = new Set(['dmGapSec', 'writeGapSec', 'minGapMs'])
    if (Number.isFinite(n) && (n > 0 || GAP_KEYS.has(key))) result[key] = Math.max(0, Math.floor(n))
  }
  // 2026-10-29 测试期：minGapMs 也允许 0（原先是 Math.max(500, ...)）
  //   正式使用时应改回 Math.max(500, ...)
  result.minGapMs = Math.max(0, Number(result.minGapMs) || 0)
  // 2026-10-29 测试期（主人要求）：writeGapSec 允许 0，不再强制最低 30 秒
  //   原先是 Math.max(30, ...) ✗ → 带图评论要 上传(1写)+评论(1写) 两次冷却，测不动
  //   正式使用时应改回 Math.max(30, ...)
  result.writeGapSec = Math.max(0, Number(result.writeGapSec) || 0)
  // 2026-10-23 改（主人要求）：私信冷却先不要 ✗
//   原来是 Math.max(30, ...) → 最低 30 秒，改不了 0 ✗
//   现在允许 0 = 不冷却（私信本来就一天只锁一个收信人 + 条数不限 ✓）
result.dmGapSec = Math.max(0, Number(result.dmGapSec) || 0)
  return result
}
const isBili = u => u.hostname === 'bilibili.com' || u.hostname.endsWith('.bilibili.com')
export class TrafficError extends Error { constructor(message) { super(message); this.name = 'TrafficError'; this.code = 'BILI_TRAFFIC_PAUSED' } }

// One state and lock per local plugin data directory, shared by CLI children and
// the Electron host. The lock covers reservation/update only, never network I/O.
export function createTrafficGuard({ directory, transport = (...a) => globalThis.fetch(...a), settings = riskSettings, now = Date.now, sleep = delay } = {}) {
  const stateFile = path.join(directory, 'traffic-state.json'), lockFile = stateFile + '.lock'
  function read() {
    try { const s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (!s || typeof s !== 'object'||Array.isArray(s)||['until','nextAt','lastDispatch'].some(k=>s[k]!==undefined&&!Number.isFinite(s[k]))) throw Error('invalid state'); return s }
    catch (e) { if (e.code === 'ENOENT') return {}; throw new TrafficError('请求保护状态损坏，请检查 traffic-state.json；已停止网络请求') }
  }
  async function locked(fn) {
    fs.mkdirSync(directory, { recursive: true })
    const deadline = Date.now() + 10000
    let fd
    while (fd === undefined) {
      try { fd = fs.openSync(lockFile, 'wx'); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })) }
      catch (e) {
        if (e.code !== 'EEXIST') { if(fd!==undefined){try{fs.closeSync(fd);fs.unlinkSync(lockFile)}catch(cleanup){diagnose('traffic-lock-cleanup',cleanup)}}throw e }
        try {
          const age = Date.now() - fs.statSync(lockFile).mtimeMs
          let pid
          try { pid = JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid } catch(e) { if(e.code!=='ENOENT')diagnose('traffic-lock-metadata',e) }
          let dead = false
          if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0) } catch (x) { dead = x.code === 'ESRCH' } }
          if (dead || (!pid && age > 10000)) { fs.unlinkSync(lockFile); continue }
        } catch(e) { if(e.code!=='ENOENT'){diagnose('traffic-lock-inspect',e);throw new TrafficError('请求保护锁无法检查，已停止网络请求')} }
        if (Date.now() >= deadline) throw new TrafficError('请求保护锁繁忙，本次停止；请稍后再试')
        await delay(25)
      }
    }
    try {
      const s = read(), result = fn(s)
      const temp = stateFile + '.' + process.pid + '.tmp'
      try { fs.writeFileSync(temp, JSON.stringify(s)); fs.renameSync(temp, stateFile) }
      finally { fs.rmSync(temp, { force: true }) }
      return result
    } finally { fs.closeSync(fd); fs.unlinkSync(lockFile) }
  }
  function blocked(s, account) {
    if (s.manual?.[account]) throw new TrafficError('账号需要人工处理登录或验证码；处理后运行 traffic resume --go')
    if (Number(s.until ?? 0) > now()) throw new TrafficError(`请求已暂停，${new Date(s.until).toISOString()} 后再试（${s.reason ?? '平台限制'}）`)
    let legacy = {}
    try { legacy=JSON.parse(fs.readFileSync(path.join(directory,'api-ban.json'),'utf8'));if(!legacy||typeof legacy!=='object'||Array.isArray(legacy)||legacy.until!==undefined&&!Number.isFinite(Number(legacy.until)))throw Error('invalid ban') } catch(e) { if(e.code!=='ENOENT'){diagnose('traffic-ban-read',e);throw new TrafficError('历史风控状态无法读取，已停止网络请求')} }
    if (Number(legacy.until??0)>now()) throw new TrafficError('已有接口风控等待尚未结束，请等待恢复')
  }
  function identity(headers) {
    const cookie = new Headers(headers).get('cookie') ?? ''
    return digest(((cookie.match(/(?:^|;)\s*SESSDATA=([^;]*)/i) ?? [])[1] ?? cookie) || 'anonymous')
  }
  async function fingerprint(url, body) {
    const ignored = /^(csrf|csrf_token|wts|w_rid|rnd|timestamp|msg\[timestamp\]|msg\[dev_id\])$/
    const raw = body instanceof URLSearchParams ? body.toString() : typeof body === 'string' ? body : null
    if (body instanceof FormData) {
      const parts=[]
      for (const [key,value] of body) if (!ignored.test(key)) parts.push([key,typeof value==='string'?value:digest(Buffer.from(await value.arrayBuffer()))])
      return digest(url.origin+url.pathname+JSON.stringify(parts.sort(([a],[b])=>a.localeCompare(b))))
    }
    if (raw === null) return digest(url.pathname + ':' + String(body))
    let value
    try { value = JSON.stringify(JSON.parse(raw), (k, v) => ignored.test(k) ? undefined : v) }
    catch { value = new URLSearchParams([...new URLSearchParams(raw)].filter(([k]) => !ignored.test(k)).sort(([a],[b]) => a.localeCompare(b))).toString() }
    return digest(url.origin + url.pathname + ':' + value)
  }
  async function guarded(input, options = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (!isBili(url)) return transport(input, options)
    const headers = options.headers ?? input.headers ?? {}, account = identity(headers)
    const method = String(options.method ?? input.method ?? 'GET').toUpperCase()
    const writing = !['GET','HEAD','OPTIONS'].includes(method)
    const body = options.body ?? (writing && input instanceof Request ? await input.clone().text() : undefined)
    const operation = writing ? await fingerprint(url, body) : null
    const id = operation ? account.slice(0,16) + ':' + operation : null
    const cfg = settings()
    let timestamp = now()
    const waitDeadline=timestamp+Math.min(180000,Math.max(0,Number(options.waitWriteMs)||0))
    const requestToken = crypto.randomUUID()
    let reservation
    for (;;) {
    timestamp=now()
    try { reservation = await locked(s => {
      blocked(s, account)
      s.accounts ??= {}; s.operations ??= {}
      const a = s.accounts[account] ??= {}
      const date = new Date(timestamp).toLocaleDateString('sv-SE')
      if (a.date !== date) Object.assign(a, { date, readDay: 0, writeDay: 0 })
      if (!a.hourAt || timestamp - a.hourAt >= 3600000) Object.assign(a, { hourAt: timestamp, readHour: 0, writeHour: 0 })
      for (const [key, item] of Object.entries(s.operations)) if (item.status !== 'unknown' && item.status !== 'pending' && timestamp - item.at > 86400000) delete s.operations[key]
      if (writing) {
        if (s.operations[id]) throw new TrafficError(`相同操作已提交或结果待核查，禁止重复发送；操作 ID：${id}`)
        if (Object.keys(s.operations).length >= 2000) throw new TrafficError('发送记录已满，请先核查未确认操作')
        const gap = (url.pathname.endsWith('/send_msg') ? cfg.dmGapSec : cfg.writeGapSec) * 1000
        if (a.lastWrite && timestamp - a.lastWrite < gap && !url.pathname.endsWith('/reply/del')) throw Object.assign(new TrafficError('写操作冷却中，请稍后再发送'), { cooldownMs: a.lastWrite + gap - timestamp })
        if ((a.writeHour ?? 0) >= cfg.writeHourly || (a.writeDay ?? 0) >= cfg.writeDaily) throw new TrafficError('已达到本地写操作预算，本次不发送')
      } else if ((a.readHour ?? 0) >= cfg.readHourly || (a.readDay ?? 0) >= cfg.readDaily) throw new TrafficError('已达到本地读取预算，请等待预算窗口恢复')
      const slot = Math.max(timestamp, Number(s.nextAt ?? 0))
      if (slot - timestamp > 30000) throw new TrafficError('请求队列已满，本次停止')
      s.nextAt = slot + cfg.minGapMs
      if (writing) { a.writeHour=(a.writeHour??0)+1; a.writeDay=(a.writeDay??0)+1; a.lastWrite=timestamp; s.operations[id]={at:timestamp,status:'pending',endpoint:url.pathname} }
      else { a.readHour=(a.readHour??0)+1; a.readDay=(a.readDay??0)+1 }
      return { slot }
    })
      break
    } catch(e) {
      if(!e.cooldownMs || now()+e.cooldownMs>waitDeadline || !options.waitWriteMs) throw e
      await sleep(e.cooldownMs)
      options.signal?.throwIfAborted()
    }
    }
    let dispatched = false
    const startedAt=now(), timing={}
    let phase='queue'
    try {
      await sleep(Math.max(0, reservation.slot-now()))
      options.signal?.throwIfAborted()
      for (;;) {
        const wait = await locked(s => {
          blocked(s, account)
          if (s.active && Number(s.active.until)>now()) {
            let dead=false
            try { process.kill(s.active.pid,0) } catch(e) {dead=e.code==='ESRCH'}
            if(!dead) return 100
          }
          const remaining = Math.max(0, Number(s.lastDispatch ?? 0)+cfg.minGapMs-now())
          if (!remaining) { s.lastDispatch=now();s.active={token:requestToken,pid:process.pid,until:now()+35000} }
          return remaining
        })
        if (!wait) break
        await sleep(wait)
        options.signal?.throwIfAborted()
      }
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
      const {dispatch:lifeDispatch,waitWriteMs,...transportOptions}=options
      phase='transport';timing.queuedMs=now()-startedAt
      const invoke=()=>{dispatched=true;return transport(input,{...transportOptions,signal})}
      const response = await (lifeDispatch?lifeDispatch(invoke):invoke())
      timing.transportMs=now()-startedAt-timing.queuedMs
      phase='response-body'
      let payload, bodyError
      if ((response.headers?.get('content-type') ?? '').includes('json')) {
        try { payload = await response.clone().json() } catch(e) { bodyError=String(e.code??e.name??'error').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,60);diagnose('traffic-response-json',e) }
      }
      timing.bodyMs=now()-startedAt-timing.queuedMs-timing.transportMs
      phase='state-commit'
      const code = Number(payload?.code)
      const risk = [412,429].includes(response.status) || [-412,-352,-799,-509,-10403].includes(code)
      const session = (new Headers(headers).get('cookie')?.match(/(?:^|;)\s*SESSDATA=([^;]+)/i) ?? [])[1]
      const authenticated = !!session && !['undefined','null'].includes(session)
      const manual = [12015,-105].includes(code) || (authenticated && (code === -101 || response.status === 401))
      const retry = response.headers?.get('retry-after')
      const retryMs = retry ? (/^\d+(\.\d+)?$/.test(retry) ? Number(retry)*1000 : Math.max(0, Date.parse(retry)-now())) : 0
      await locked(s => {
        if (s.active?.token===requestToken) delete s.active
        if (risk) {
          s.streak = Math.min(8, Number(s.streak ?? 0)+1)
          s.until = Math.max(Number(s.until??0),now()+Math.max(Number.isFinite(retryMs)?retryMs:0,Math.min(1800000,300000*2**(s.streak-1))))
          s.reason = `HTTP ${response.status} / code ${Number.isFinite(code)?code:'unknown'}`
          s.riskEndpoint = url.pathname
        } else if (code === 0 && s.riskEndpoint === url.pathname && now() >= Number(s.until??0)) s.streak = 0
        if (manual) { s.manual ??= {}; s.manual[account] = {at:now(),code:Number.isFinite(code)?code:response.status} }
        if (id) {
          if (response.ok && code === 0) s.operations[id].status = 'confirmed'
          else if (payload && Number.isFinite(code) && code !== 0) delete s.operations[id]
          else s.operations[id].status = 'unknown'
        }
        s.last = { at: now(), endpoint: url.pathname, method, http: response.status, code: Number.isFinite(code)?code:null, phase:bodyError?'response-body-error':'complete',...(bodyError?{errorCode:bodyError}:{}),elapsedMs:now()-startedAt,...timing }
      })
      return response
    } catch (e) {
      await locked(s => { s.last={at:now(),endpoint:url.pathname,method,phase,elapsedMs:now()-startedAt,...timing,errorCode:String(e.code??e.name??'error').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,60)}; if(s.active?.token===requestToken)delete s.active; if (id) { if (!dispatched) delete s.operations[id]; else if (s.operations[id]) s.operations[id].status='unknown' } })
      if (dispatched && writing) throw new TrafficError(`发送结果不确定，已禁止自动重发。请回读核查；操作 ID：${id}`)
      throw e
    }
  }
  const inflight = new Map()
  return {
    fetch: (input, options={}) => {
      const url=new URL(typeof input==='string'||input instanceof URL ? input : input.url)
      if (!isBili(url) || String(options.method??input.method??'GET').toUpperCase()!=='GET' || options.signal) return guarded(input,options)
      const key=identity(options.headers??input.headers??{})+':'+url.href
      if(!inflight.has(key)) inflight.set(key,guarded(input,options).finally(()=>inflight.delete(key)))
      return inflight.get(key).then(r=>r.clone())
    },
    status: () => read(),
    pauseReason: headers => { try { blocked(read(),identity(headers));return null } catch(e) {return e.message} },
    resume: headers => locked(s => { if (s.manual) delete s.manual[identity(headers)] }),
    resolve: (id, outcome) => locked(s => { if (!s.operations?.[id]) throw new TrafficError('找不到操作 ID'); if (outcome === 'not-sent') delete s.operations[id]; else if (outcome === 'confirmed') s.operations[id].status='confirmed'; else throw new TrafficError('outcome 必须是 confirmed 或 not-sent') }),
  }
}
let singleton
export function trafficGuard() { return singleton ??= createTrafficGuard({ directory: path.join(resolveHome(), '.bili-ai') }) }
export function guardedFetch(...args) {
  args[1]=activityFetch(args[0],args[1])
  // Legacy fixture suites replace fetch and opt out explicitly. Production
  // BILI_NO_CACHE does NOT disable traffic protection.
  if (process.env.BILI_TRAFFIC_TEST === '1' && process.env.NODE_TEST_CONTEXT) {const {dispatch,...options}=args[1]??{};const invoke=()=>globalThis.fetch(args[0],options);return dispatch?dispatch(invoke):invoke()}
  return trafficGuard().fetch(...args)
}

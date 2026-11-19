import {withoutRetiredListening,LISTEN_DEFAULTS} from '../tools/lib/config.mjs'
import {CHAT_DEFAULTS,chatConfig} from '../tools/lib/chat-config.mjs'
import {diagnose} from '../tools/lib/diagnostics.mjs'
import {corpusFor} from '../tools/lib/corpus-runtime.mjs'
import { migrateLegacy } from '../tools/lib/life-migration.mjs'
import { LIFE_DEFAULTS, lifeConfig } from '../tools/lib/life-config.mjs'
import { windowIssues } from '../tools/lib/night-plan.mjs'
import { lifeStore } from '../tools/lib/life-runtime.mjs'
import { AuthError, createCredentialStore, parseManualCookie } from './credentials.js'
import { QrAuth, verifyAccount } from './auth.js'
import { guardedFetch as fetch, RISK_DEFAULTS } from '../tools/lib/traffic.mjs'
/**
 * dsh-bili-whale —— 宿主侧插件（设置壳）
 *
 * 职责只有三件：
 *   1. 设置页：DSH 客户端 section「设置 → 养鱼」（lib/client.js）
 *   2. 配置读写：GET/POST /dsh-bili/api/settings → 读写 ~/.dsh/bili-whale.config.json
 *      （与 bilibili-tools 里的 lib/config.mjs 共用同一份文件 —— 不搞两套配置）
 *   3. 依赖体检：GET /dsh-bili/api/deps → 跑 `node <tools>/bili.mjs deps --json`
 *      （这就是"装完之后让 agent/用户自己确认依赖能不能用"）
 *
 * 凭据（cookie）**单独写**到 ~/.bili-ai/credentials.json，且**永远不回显**。
 *
 * 所有路由都过一遍 connection.requestRejection 的信任栅栏：DSH 的 Web 端口是回环地址，
 * 但浏览器里任何一个网页都能向回环发请求 —— 不加栅栏等于把配置与账号凭据开放给任意页面。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startScheduler } from './scheduler.js'
import { deliveryStatus } from './delivery-state.js'
import { readSchedulerHealth } from './scheduler-health.js'
import { resolveWorkDir } from './work-dir.js'
import { resolveNodeRuntime, nodeEnv } from './node-runtime.js'
import { HOME, DSH_HOME, configPath, credentialsPath } from '../tools/lib/paths.mjs'

/** 生物钟状态：{ ok, reason, at } —— 设置页/体检用它回答「时钟是不是活的」 */
let SCHED_STATUS = { ok: false, reason: "未初始化", at: null }



/**
 * execFile 的安全包装：NODE_EXE 解析失败时不让 execFile(null, …) 抛 TypeError，
 * 而是把原因通过回调交给调用方（设置页就能显示真因，而不是一个空 stdout）。
 */
function execNode(args, options, cb) {
  if (!NODE_EXE) {
    const msg = globalThis.__biliWhaleNodeError || '未找到可用的 node 运行时'
    cb?.(new Error(msg), '', msg)
    return null
  }
  return execFile(NODE_EXE, args, { ...options, env: { ...nodeEnv(DSH_HOME), ...options?.env } }, cb)
}


// 2026-10-19：真 node 路径（Electron 的 process.execPath 是 Harness.exe ✗ 跑不了 node 脚本）
const NODE_EXE = (() => {
  const dshHome = DSH_HOME
  try {
    return resolveNodeRuntime(dshHome)
  } catch (e) {
    // 不静默回退：process.execPath 在桌面端是 Electron 主程序，跑不了脚本。
    // 这里只记录，具体失败由各调用点按自身语义报出（设置页体检会显示原因）。
    globalThis.__biliWhaleNodeError = String(e?.message ?? e)
    return null
  }
})()

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CFG_FILE = configPath
const CRED_FILE = credentialsPath
// 2026-10-21 修 Issue #6：她的会话工作目录必须是**专用小目录**，不能用用户主目录 ✗
//   原因：DSH 的 Windows 沙箱会把会话 cwd 当"工作区"，主目录当工作区会让权限/完整性标签
//   影响到主目录下的其它程序（实测有人 DSH / VS Code 起不来）✗
//   放在 ~/.dsh/whale-work 里，范围最小，也不会碰任何别的东西 ✓
const WORK_DIR = path.join(DSH_HOME, 'whale-work')


/** 默认配置（与 lib/config.mjs 的中性默认对齐；这里多一个 toolsPath） */
const DEFAULTS = {
  chat: CHAT_DEFAULTS,
  life: LIFE_DEFAULTS,
  sessionRotateDays: 0,
  personaOncePerSession: true,
  risk: RISK_DEFAULTS,
  owner: { mid: '', name: '' },
  night: {
    windows: [{ start: '20:00', end: '24:00', wakes: 1 }],
    skipChance: 0.3,
    minGapMin: 10, maxVideos: 5,
  },
  preferences: {
    like: ['DSH/AI 工具与插件', '鬼畜与怀旧向剪辑', '猫咪', 'Live2D/模型', 'B站生态八卦'],
    dislike: ['带货', '擦边', '标题党', '纯搬运'],
    keywords: [],
  },
  quota: { shareDaily: 3 },
  diary: { push: true, enabled: true },   // 2026-10-20：写日记不可关；只留"要不要推送"一个开关
  // ④ 2026-10-18：补上 persona / self（和 tools/lib/config.mjs 对齐 ✓ 否则设置页首次打开是空的 ✗）
  persona: { name: '', ownerTitle: '主人', selfClaim: '我' },
  self: { mid: '', name: '' },
  notify: { type: 'none', url: '', template: 'text', cmd: '' },
  listen: { ...LISTEN_DEFAULTS },
  share: { aiCommentGuard: false, aiThreshold: 30, enabled: true, via: 'dm', minScore: 13, silentAfterDays: 3, },
  toolsPath: '',
}

const clone = (o) => JSON.parse(JSON.stringify(o))
const merge = (base, over) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] ?? {}, v) : v
  }
  return out
}

/** 工具链里 bili.mjs 的位置：① 设置里的 toolsPath ② 插件自带的 tools/ ③ 开发目录 */
function resolveBiliMjs() {
  const cfg = readConfig()
  // 2026-10-18：去掉"作者机器"回退 ✗（换机器就是静默失效）→ 只有两个候选：设置里的 toolsPath / 插件自带 tools/ ✓
  return cfg.toolsPath || path.join(HERE, '..', 'tools', 'bili.mjs')
}

function readConfig() {
  let user = {}
  try { user = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));if(!user||Array.isArray(user)||typeof user!=='object')throw Error('config schema') } catch(e) { if(e.code!=='ENOENT'){diagnose('settings-config-read',e);throw Error('配置文件损坏或不可读取，未使用默认值覆盖')} }
  return withoutRetiredListening({ ...merge(DEFAULTS, user), __hasUserFile: Object.keys(user).length > 0 })
}

function writeConfig(next) {
  next=withoutRetiredListening(next)
  fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true })
  const temp=CFG_FILE+'.'+process.pid+'.tmp'
  try{fs.writeFileSync(temp,JSON.stringify(next,null,2)+'\n',{mode:0o600});fs.renameSync(temp,CFG_FILE)}finally{fs.rmSync(temp,{force:true})}
}

/** 只回"能不能用"，不回显任何凭据内容 */
function credState() {
  try {
    const c = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'))
    return { present: true, hasSess: !!c.sessdata, hasJct: !!c.bili_jct, hasBuvid: !!c.buvid3 }
  } catch { return { present: false, hasSess: false, hasJct: false, hasBuvid: false } }
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export default {
  name: 'dsh-bili-whale',
  // ⚠️ 2026-10-18 踩的坑：这里以前**写了两个 inject 键** ✗ —— 对象字面量后者覆盖前者 →
  //   `sessionController` 没被注入 → 生物钟每 60 秒静默 `return`（不报错、也不干活 ✗）
  // 当前 DSH 使用数组式依赖声明；工作区服务在调用处检测，缺失时退回 cwd。
  inject: ['sessionController', 'webServer', 'connection'],
  apply(ctx) {

/** 回环快速通道：Host 是 127.0.0.1/localhost/[::1] 时直接算可信。
 *  非回环不能在这里一刀切 —— DSH 允许 `--host <局域网地址>` 部署，
 *  合法浏览器访问时 Host 必然非回环。完整信任判定见 isTrustedReq。 */
function isLoopbackReq(req) {
  const host = String(req.headers?.host ?? '').toLowerCase()
  const h = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
}

/** 信任判定沿用 DSH 的 Host/Origin 栅栏：回环、监听绑定地址、trustedHosts 都放行；
 *  连接服务不可用时退回"仅回环"（fail-closed）。放行 Host 不等于放行请求 ——
 *  后面的 requestRejection 仍会校验登录态（未认证返回 401）。 */
function isTrustedReq(req) {
  if (isLoopbackReq(req)) return true
  try {
    const conn = ctx.get('connection') || ctx.connection
    if (conn && typeof conn.isTrusted === 'function') return conn.isTrusted(req) === true
  } catch(e) { if(e.code!=='ENOENT')diagnose('host-optional-operation',e) }
  return false
}

    // P1-1（Kimi 评审 #8）：这条路以前是 fail-open —— connection 缺失/抛错就**放行** ✗
    // 安全组件的默认值必须是"关"：栅栏不可用 → 拒绝（写操作尤其），只对静态页面留一条活路。
    function rejected(req, res, { strict = true } = {}) {
      if (isTrustedReq(req) === false) {
        json(res, 403, { ok: false, error: '不受信任的访问来源' })
        return true
      }
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (!conn || typeof conn.requestRejection !== 'function') {
          if (!rejected.warned) {
            rejected.warned = true
            console.warn('[bili-whale] 信任栅栏不可用：connection 服务缺失 → 按 fail-closed 处理')
          }
          if (strict) { json(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问（fail-closed）' }); return true }
          return false
        }
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch (e) {
        if (strict) { json(res, 503, { ok: false, error: '信任栅栏异常，拒绝访问（fail-closed）' }); return true }
        return false
      }
    }

    const disposers = []
    function route(kind, pathname, handler) {
      disposers.push(ctx.webServer.register({
        kind,
        path: pathname,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          try { await handler(req, res) } catch (err) {
            try { json(res, 500, { ok: false, error: String(err?.message ?? err) }) } catch(e) { if(e.code!=='ENOENT')diagnose('host-optional-operation',e) }
          }
        },
      }))
    }

    // 旧的独立设置页已下线（2026-10-18）：DSH 的信任栅栏不认插件路径，这个页面在浏览器里永远 403 ✗
    // 设置页唯一的入口是「设置 → 养鱼」（lib/client.js）。旧的 lib/settings.html 已删除（2026-10-22）✓
    // 需要本地直开时：把该文件拷到桌面双击（它的 API 调用会被栅栏拒，只作静态预览 ✓）

    // 写设置：浅合并，但**只接受已知的顶层字段** ✓（2026-10-18 加白名单，兑现这句注释 ✗ 原来是什么都收）
    // P0-2（Kimi 评审 #2）：读和写**合成一个 handler**（原来同一路径注册两次，
    //   宿主若是"首个匹配即终止"，后注册的 POST 永远收不到请求 ✗）
    route('exact', '/dsh-bili/api/settings', async (req, res) => {
      if (req.method === 'GET') { json(res, 200, { ok: true, config: readConfig(), credentials: credState(), configPath: CFG_FILE }); return }
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = JSON.parse(await readBody(req) || '{}')
      const cur = readConfig()
      delete cur.__hasUserFile
      // ⚠️ 2026-10-18 修的 bug：客户端发的是**配置本身**，这里却只认 `body.config` ✗
      //   → merge(cur, {}) = 什么都没改 → "保存成功"但值没变（主人实测就是这个 ✗）
      //   现在两种都收：{ config: {...} } 或直接 {...}
      const incoming = (body && typeof body.config === 'object' && body.config) || body || {}
      // 顶层白名单：只合并认识的键（防止被塞任意字段 ✓）
      // 2026-10-21 修（审查 #4）：原来白名单漏了 diary ✗ → 设置页「推送日记摘要」存不进去
      const KNOWN = new Set(['persona', 'preferences', 'notify', 'aliases', 'owner', 'self', 'quota', 'share', 'listen', 'diary', 'night', 'toolsPath', 'home', 'risk', 'sessionRotateDays', 'personaOncePerSession', 'life', 'chat'])
      const filtered = {}
      for (const [k, v] of Object.entries(incoming)) if (KNOWN.has(k)) filtered[k] = v
      const next = merge(cur, filtered)
      const rotateDays = Number(next.sessionRotateDays)
      if (!Number.isFinite(rotateDays) || rotateDays < 0 || rotateDays > 365 || typeof next.personaOncePerSession !== 'boolean') {
        json(res, 400, { ok: false, error: '会话轮换天数须为 0–365；人设去重须为布尔值' }); return
      }
      next.sessionRotateDays = rotateDays
      // 基本的范围校验（别让设置页把东西写成负数/离谱值）
      const n = next.night
      if (!Array.isArray(n.windows) || !n.windows.length) { json(res, 400, { ok: false, error: '至少要有一个作息窗口' }); return }
      // 写盘前复用计划器的时间校验：坏窗口要让用户知道是哪一个、哪个字段，而不是整页静默失效。
      // 说明：白天允许先保存一坏一好（历史配置也常这样），调度器会跳过坏的继续排好的。
      const windowProblems = windowIssues({ windows: n.windows })
      if (windowProblems.length && n.windows.every(w => !w || typeof w !== 'object' || !String(w.start ?? '').trim() || !String(w.end ?? '').trim())) {
        json(res, 400, { ok: false, error: windowProblems[0].message, windowIndex: windowProblems[0].index, field: windowProblems[0].field, problems: windowProblems }); return
      }
      n.maxWakesPerDay = Math.min(12, Math.max(0, Number(n.maxWakesPerDay ?? 0) || 0))   // 12 = 与 whale-night 的上限一致 ✓
      n.skipChance = Math.min(0.95, Math.max(0, Number(n.skipChance) || 0))
      n.minGapMin = Number.isFinite(Number(n.minGapMin)) ? Math.max(1, Number(n.minGapMin)) : 10
      n.maxVideos = Math.min(20, Math.max(1, Number(n.maxVideos) || 5))
      // P0-3（Kimi 评审 #3）：Number(0) || 3 === 3 → 用户取消勾选"分享"会被强行改回 3 ✗
      const sd = Number(next.quota.shareDaily)
      next.quota.shareDaily = Number.isFinite(sd) ? Math.min(20, Math.max(0, sd)) : 3
      next.life = lifeConfig(next.life)
      next.chat = chatConfig(next.chat)
      if(cur.self?.mid&&cur.owner?.mid&&(['enabled','learningEnabled','paused'].some(k=>lifeConfig(cur.life)[k]!==next.life[k])||['enabled','shadow'].some(k=>lifeConfig(cur.life).dynamicMemory[k]!==next.life.dynamicMemory[k])))await lifeStore(cur).invalidateFormation()
      writeConfig(next)
      // 改完立刻生效 ✓（主人 2026-10-18 要求）：清掉旧计划，让生物钟按新配置重算
      const schedulingChanged = ['windows', 'skipChance', 'maxVideos', 'minGapMin'].some(key => JSON.stringify(cur.night?.[key]) !== JSON.stringify(next.night?.[key]))
      let reloadWarning=null
      try { sched?.invalidate(schedulingChanged) } catch(e) { diagnose('settings-scheduler-reload',e);reloadWarning='设置已保存，但调度器重载失败，请查看诊断' }
      json(res, 200, { ok: true, config: next, warn: reloadWarning??(next.quota.shareDaily > 3 ? '分享条数 >3：看起来会像刷量，平台可能限流/封号' : null) })
    })

    route('exact', '/dsh-bili/api/life', async (req, res) => {
      if (!isTrustedReq(req)) { json(res,403,{ok:false,error:'不受信任的访问来源'}); return }
      const store=lifeStore(readConfig())
      if(req.method==='GET'){json(res,200,{ok:true,state:{...store.status(),affectWorker:sched?.affectStatus()??{status:'unavailable'},socialWorker:sched?.socialStatus()??{status:'unavailable'},formationWorker:sched?.formationStatus()??{status:'unavailable',reason:'调度器未启动'}}});return}
      if(req.method!=='POST'){json(res,405,{ok:false});return}
      const b=JSON.parse(await readBody(req)||'{}')
      let result
      switch(b.action){
        case 'dynamic-status': result=store.dynamicStatus();break
        case 'memory-catalog': result=store.memoryCatalog(b.options??{});break
        case 'memory-history': result=store.memoryHistory(b.options??{});break
        case 'memory-explain': result=store.memoryExplain(String(b.id),'local-management');break
        case 'memory-retention': result=await store.memoryRetention(String(b.id),b);break
        case 'memory-migrate': result=await store.dynamicMigrate({apply:b.apply===true});break
        case 'learning-status': result={...store.learningStatus(),worker:sched?.formationStatus()??{status:'unavailable',reason:'调度器未启动'}};break
        case 'traces': result=store.decisionTraces();break
        case 'maintain': result=await store.maintainCognition();break
        case 'bind-channel': result=await store.bindChannel(b);break
        case 'accept': case 'reject': result=await store.review(String(b.id),b.action,{expectedRevision:b.expectedRevision});break
        case 'revoke': result=await store.revoke(String(b.id));break
        case 'bind-legacy': result=await store.bindLegacy(String(b.name),b.visibility??'private');break
        case 'suppress': result=await store.suppress(String(b.id),b.value!==false);break
        case 'rebuild-index': result=store.rebuildIndex();break
        case 'replay-check': result=store.replayCheck();break
        case 'context-explain': result=store.contextSnapshot(String(b.query??''),b.scene??'private-reply');break
        case 'pause': result=await store.pause(b.value===true);break
        case 'archive': result=await store.archive();break
        case 'export': result=store.export();break
        case 'migrate': result=await migrateLegacy(store,DSH_HOME,{dryRun:b.apply!==true});break
        case 'sources': result=store.sources(b.ids);break
        case 'search': result=store.search(String(b.query??''),{archives:true});break
        case 'close': result=await store.closeThread(String(b.thread),String(b.reason??'owner'));break
        case 'reopen': result=await store.reopenThread(String(b.thread),String(b.eventId),{approved:true});break
        case 'resolve':
          if(b.confirmed!==true)throw Error('请先回读平台确认发送结果')
          result=await store.settle(String(b.id),{status:b.status,receipt:b.receipt,verified:true});break
        case 'owner-note':
          result=await store.record('observed',{text:String(b.text??''),origin:'owner',actor:String(readConfig().owner?.mid??'')});break
        case 'propose': result=await store.propose(b.proposal);break
        default: throw Error('未知的长期管理操作')
      }
      json(res,200,{ok:true,result,state:store.status()})
    })

    route('exact','/dsh-bili/api/corpus',async(req,res)=>{
      if(!isTrustedReq(req)){json(res,403,{ok:false,error:'不受信任的访问来源'});return}
      const corpus=corpusFor(lifeStore(readConfig()))
      if(req.method==='GET'){json(res,200,{ok:true,state:corpus.status()});return}
      if(req.method!=='POST'){json(res,405,{ok:false});return}
      const b=JSON.parse(await readBody(req)||'{}');let result
      switch(b.action){
        case 'list':result=corpus.list(b);break
        case 'review':result=await corpus.review(String(b.id),b.review);break
        case 'revoke':result=await corpus.revoke(String(b.id));break
        case 'export':result=corpus.export();break
        case 'split':result=corpus.split();break
        default:throw Error('未知语料管理操作')
      }
      json(res,200,{ok:true,result,state:corpus.status()})
    })

    // Both login paths verify first and share one serialized, atomic credential writer.
    const credentialStore = createCredentialStore({
      file: CRED_FILE,
      pending: path.join(HOME, '.bili-ai', 'pending-replies.json'),
      verify: verifyAccount,
    })
    const saveLogin = async (credentials, options) => {
      const account = await credentialStore.save(credentials, options)
      try {
        const current = readConfig()
        delete current.__hasUserFile
        writeConfig({ ...current, self: account })
      } catch {
        // Credentials are already committed. Report success plus the secondary metadata warning.
        return { ...account, warn: '登录态已保存，但账号显示信息未更新；请重新读取或检查配置权限。' }
      }
      return account
    }
    const qrAuth = new QrAuth({ save: saveLogin })
    ctx.effect(() => () => qrAuth.dispose())
    const authRoute = (name, action) => route('exact', '/dsh-bili/api/auth/qr/' + name, async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      try {
        const body = JSON.parse(await readBody(req) || '{}')
        const result = await action(body)
        json(res, 200, { ok: true, ...result })
      } catch (error) {
        json(res, error instanceof AuthError ? 400 : 503, {
          ok: false, error: error instanceof AuthError ? error.message : '登录操作失败，请稍后重试。',
        })
      }
    })
    authRoute('start', () => qrAuth.start())
    authRoute('poll', body => qrAuth.poll(String(body.id ?? '')))
    authRoute('cancel', body => qrAuth.cancel(String(body.id ?? '')))

    // Keep the original manual endpoint and paste formats as a fallback.
    route('exact', '/dsh-bili/api/cookie', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      try {
        const body = JSON.parse(await readBody(req) || '{}')
        const credentials = parseManualCookie(body)
        qrAuth.cancel()
        const account = await saveLogin(credentials)
        json(res, 200, { ok: true, self: { mid: account.mid, name: account.name },
          detail: '已登录：' + account.name + '（mid ' + account.mid + '）', warn: account.warn ?? null })
      } catch (error) {
        json(res, 400, { ok: false, error: error instanceof AuthError ? error.message : '登录未保存，请检查输入后重试。' })
      }
    })

    // ── 她专属的人设（2026-10-21 主人要的）：只影响她，不影响别的会话 ✓ ──────────
    //   存在 ~/.bili-ai/persona.md → 换机器时连 .bili-ai 一起拷就带着走 ✓
    const PERSONA_FILE = path.join(HOME, '.bili-ai', 'persona.md')
    route('exact', '/dsh-bili/api/persona', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method === 'GET') {
        let text = ''
        try { text = fs.readFileSync(PERSONA_FILE, 'utf8') } catch(e) { if(e.code!=='ENOENT')diagnose('host-optional-operation',e) }
        let updatedAt = null
        try { updatedAt = fs.statSync(PERSONA_FILE).mtime.toISOString() } catch(e) { if(e.code!=='ENOENT')diagnose('host-optional-operation',e) }
        json(res, 200, { ok: true, text, bytes: Buffer.byteLength(text, 'utf8'), updatedAt })
        return
      }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const b = JSON.parse(await readBody(req) || '{}')
      const text = String(b.text ?? '')
      if (text.length > 20000) { json(res, 400, { ok: false, error: '太长（上限 20000 字），人设不用写论文 ✗' }); return }
      try {
        fs.mkdirSync(path.dirname(PERSONA_FILE), { recursive: true })
        fs.writeFileSync(PERSONA_FILE, text, 'utf8')
        try { fs.chmodSync(PERSONA_FILE, 0o600) } catch(e) { if(e.code!=='ENOENT')diagnose('host-optional-operation',e) }
      } catch (e) { json(res, 500, { ok: false, error: '写入失败：' + String(e?.message ?? e).slice(0, 120) }); return }
      const bytes = Buffer.byteLength(text, 'utf8')
      json(res, 200, {
        ok: true,
        bytes,
        detail: text.trim()
          ? '✓ 已注入（' + bytes + ' 字节）—— 从下一次唤醒开始生效 ✓'
          : '✓ 已清空 —— 她回到只有「设置里的人设」那几行 ✓',
      })
    })

    // 依赖体检：跑 bili.mjs deps --json
    route('exact', '/dsh-bili/api/deps', async (req, res) => {
      const cfg = readConfig()
      // 工具位置（2026-10-18 收敛为两个候选 ✗ 去掉"作者机器"路径）：
      //   ① 设置里的 toolsPath  ② <插件根>/tools/bili.mjs（发布版自带 ✓）
      const tools = cfg.toolsPath || path.join(HERE, "..", "tools", "bili.mjs")
      if (!fs.existsSync(tools)) {
        json(res, 200, { ok: false, error: `找不到 bili.mjs：${tools}（在设置里填「工具目录」）`, items: [], scheduler: SCHED_STATUS })
        return
      }
      execNode([tools, 'deps', '--json'], { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
        try {
          const parsed = JSON.parse(String(stdout || '{}'))
          // 2026-10-19：顺手把"她自己是谁"从 cookie 体检里抠出来写回配置 ✓
          //   以前 self.mid / self.name 只有默认值、没人写 → 设置页永远空 ✗
          let selfNow = null
          try {
            const ck = (parsed.items ?? []).find((it) => it.name === 'B站 cookie')
            const m = String(ck?.detail ?? '').match(/已登录：(.+?)（mid (\d+)）/)
            if (m) {
              selfNow = { name: m[1], mid: m[2] }
              const cur = readConfig()
              if (String(cur.self?.mid ?? '') !== selfNow.mid || String(cur.self?.name ?? '') !== selfNow.name) writeConfig({ ...cur, self: selfNow })
            }
          } catch(e) { if(e.code!=='ENOENT')diagnose('host-optional-operation',e) }
          // 2026-10-20：把"跑没跑过启动测试"一起返回 —— 设置页用它决定要不要显示首次安装横幅
          let selftestPassed = false
          try {
            selftestPassed = fs.existsSync(path.join(HOME, ".bili-ai", "selftest-passed.json"))
          } catch(e) { if(e.code!=='ENOENT')diagnose('host-optional-operation',e) }
          json(res, 200, { ok: !!parsed.ok, items: parsed.items ?? [], node: parsed.node, self: selfNow, selftestPassed, scheduler: SCHED_STATUS })
        } catch {
          json(res, 200, { ok: false, error: String(stderr || err?.message || 'deps 跑失败').slice(0, 300), items: [] })
        }
      })
    })

    // ── 待审回复（2026-10-18 主人选 B 档：**发前审核**）──────────────────────────
    //   她的回复先进 pending-replies.json → 主人在「设置 → 养鱼 → 待审核」里点发才发 ✓
    const PENDING = path.join(HOME, '.bili-ai', 'pending-replies.json')
    route('exact', '/dsh-bili/api/pending', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      let items = []
      try { items = JSON.parse(fs.readFileSync(PENDING, 'utf8')).items ?? [] } catch(e) { if(e.code!=='ENOENT')diagnose('host-optional-operation',e) }
      json(res, 200, { ok: true, items })
    })
    route('exact', '/dsh-bili/api/pending/reject', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const b = JSON.parse(await readBody(req) || '{}')
      const id = String(b.id ?? '')
      if (!id) { json(res, 400, { ok: false, error: '需要 id' }); return }
      execNode([resolveBiliMjs(), 'reply-draft', 'drop', id], { timeout: 20000, windowsHide: true }, (err, stdout) => {
        // 否掉也是一种反馈 → 记事件流（她下次能学到"这种不要" ✓）
        // ⚠️ 只有真的删掉了才记 ✗ —— 以前连点几次会重复记三条（2026-10-18 修 ✓）
        if (!err) {
          try {
            fs.appendFileSync(path.join(DSH_HOME, 'whale-log.jsonl'),
              JSON.stringify({ at: new Date().toISOString(), kind: 'reply-rejected', target: null, note: `主人否掉了草稿 ${id}${b.reason ? '：' + String(b.reason).slice(0, 80) : ''}` }) + '\n')
          } catch(e) { if(e.code!=='ENOENT')diagnose('host-optional-operation',e) }
        }
        json(res, 200, { ok: !err, out: String(stdout ?? '').slice(0, 300) })
      })
    })
    route('exact', '/dsh-bili/api/pending/approve', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const b = JSON.parse(await readBody(req) || '{}')
      const id = String(b.id ?? '')
      if (!id) { json(res, 400, { ok: false, error: '需要 id' }); return }
      const bili = resolveBiliMjs()
      // 2026-10-21 修（审查 P1-2）：下面回调里用了 cfg.listen，但本作用域【没有 cfg】✗
      //   → ReferenceError，而草稿已被 take 掉 → 静默丢失 ✗
      let cfgNow = {}
      cfgNow = readConfig()
      // ① 从队列取出（取不到 = 已经发过/删过 ✓）
      execNode([bili, 'reply-draft', 'take', id], { timeout: 20000, windowsHide: true }, (err, stdout) => {
        let item = null
        try { item = JSON.parse(String(stdout ?? '')) } catch(e) { if(e.code!=='ENOENT')diagnose('host-optional-operation',e) }
        if (!item) { json(res, 400, { ok: false, error: '队列里没有这条（可能已经发过）' }); return }
        // ② 真发（--auto → 自动报备 ✓；--once-per-person → 判重 ✓）
        const args = ['comment', '--oid', item.oid, '--root', item.root, '--parent', item.parent,
          '--message', item.message, '--auto', ...(cfgNow.listen?.oncePerPerson !== false ? ['--once-per-person'] : []), '--go']
        if (item.bvid) args.push('--bvid', item.bvid)
        execNode([bili, ...args], { timeout: 360000, windowsHide: true }, (e2, out2, err2) => {
          const text = String(out2 ?? '')
          const ok = !e2 && /code=0/.test(text)
          const rpid = (text.match(/rpid=(\d+)/) ?? [])[1] ?? null
          try {
            fs.appendFileSync(path.join(DSH_HOME, 'whale-log.jsonl'),
              JSON.stringify({ at: new Date().toISOString(), kind: ok ? 'reply-sent' : 'reply-failed', target: item.who || item.parent, note: `${ok ? '主人批准并发出' : '发送失败'} · ${String(item.message).slice(0, 60)}` }) + '\n')
          } catch(e) { if(e.code!=='ENOENT')diagnose('host-optional-operation',e) }
          // 2026-10-21：发送失败 → 草稿放回队列，别悄悄丢掉 ✗
          if (!ok) {
            try {
              const back = ['reply-draft', 'add', '--oid', item.oid, '--message', item.message]
              if (item.bvid) back.push('--bvid', item.bvid)
              if (item.root) back.push('--root', item.root)
              if (item.parent) back.push('--parent', item.parent)
              if (item.who) back.push('--who', item.who)
              if (item.src) back.push('--src', item.src)
              execNode([bili, ...back], { timeout: 20000, windowsHide: true }, () => {})
              console.error('[pending/approve] 发送失败，草稿已放回队列：' + id)
            } catch (e) { console.error('[pending/approve] 放回草稿也失败：' + e.message) }
          }
          json(res, 200, { ok, rpid, out: text.slice(-600), err: String(err2 ?? '').slice(0, 400) })
        })
      })
    })

    // 「发条测试」：真的跑一次 notify.mjs --test，把结果原样返回（配错了当场能看见 ✓）
    // 2026-10-18 主人要求：必须有这个按钮，不然配错了不知道 ✗
    route('exact', '/dsh-bili/api/notify-test', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const cfg = readConfig()
      const tools = cfg.toolsPath || path.join(HERE, "..", "tools", "bili.mjs")
      const notifyMjs = path.join(path.dirname(tools), 'commands', 'notify.mjs')
      if (!fs.existsSync(notifyMjs)) { json(res, 200, { ok: false, error: `找不到 notify.mjs：${notifyMjs}` }); return }
      execNode([notifyMjs, '--test'], { timeout: 330_000, windowsHide: true }, (err, stdout, stderr) => {
        json(res, 200, {
          ok: !err,
          out: String(stdout ?? '').slice(0, 800),
          err: String(stderr ?? '').slice(0, 800),
          type: cfg.notify?.type ?? 'none',
        })
      })
    })

    // 状态（只读）：今天分享了几条 / 今天的作息计划 / 判重账本里记了几个人
    route('exact', '/dsh-bili/api/status', async (req, res) => {
      const localHome = HOME
      const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
      const quota = readJson(path.join(localHome, '.bili-ai', 'quota.json')) ?? { log: [] }
      const today = new Date().toLocaleDateString('sv-SE')
      const todays = (quota.log ?? []).filter((x) => new Date(x.at).toLocaleDateString('sv-SE') === today)
      const night = readJson(path.join(DSH_HOME, 'whale-night.json'))
      const replied = readJson(path.join(localHome, '.bili-ai', 'replied.json'))
      json(res, 200, {
        ok: true, today, timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
        shares: todays.filter((x) => x.share).length,
        sharesMax: readConfig().quota?.shareDaily ?? 3,
        commentsToday: todays.length,
        repliedPeople: Object.keys(replied?.byUid ?? {}).length,
        delivery: deliveryStatus(DSH_HOME),
        scheduler: readSchedulerHealth(DSH_HOME),
        affect: lifeStore(readConfig()).affectStatus(),
        affectWorker: sched?.affectStatus()??{status:'unavailable'},
        diary: lifeStore(readConfig()).diaryStatus(),
        diaryWorker: sched?.diaryStatus()??{status:'unavailable'},
        socialWorker: sched?.socialStatus()??{status:'unavailable'},
        formation: sched?.formationStatus()??{status:'unavailable'},
        plan: night ? { date: night.date, action: night.action, atText: night.atText ?? null, wakes: Number(night.wakes ?? 0), windows: night.usedWindows ?? [] } : null,
      })
    })

    // ── 自主生物钟（2026-10-18）：插件自己 tick，到点自己叫醒她（不靠对话框 ✓）────────
    let sched = null
    // 2026-10-21 修（Issue #8-3）：时钟起不来时以前只 console.warn ✗
    //   用户在设置页看不出「它永远不会醒」→ 现在把状态记下来，/deps 带出去 ✓
    try {
      sched = startScheduler(ctx, {
        dshHome: DSH_HOME,
        biliMjs: resolveBiliMjs(),
        cwd: resolveWorkDir(readConfig().home, WORK_DIR),
        sessionId: 'bili-whale',
        log: (m) => { try { console.log(m) } catch(e) { if(e.code!=='ENOENT')diagnose('host-optional-operation',e) } },
      })
      SCHED_STATUS = { ok: true, reason: '定时器已注册（每 60 秒）；实际运行情况见调度诊断 lastTickAt', at: new Date().toISOString() }
    } catch (e) {
      SCHED_STATUS = { ok: false, reason: String(e?.message ?? e).slice(0, 300), at: new Date().toISOString() }
      try { console.warn('[bili-whale] 生物钟启动失败：' + e.message) } catch(e) { if(e.code!=='ENOENT')diagnose('host-optional-operation',e) }
    }

    ctx.effect(() => () => {
      try { sched?.stop() } catch(e) { if(e.code!=='ENOENT')diagnose('host-optional-operation',e) }
      for (const d of disposers) { try { d() } catch(e) { if(e.code!=='ENOENT')diagnose('host-optional-operation',e) } }
    })

    try {
      console.log(`[bili-whale] 设置页已挂载：/dsh-bili/ · 配置 ${CFG_FILE}`)
    } catch(e) { if(e.code!=='ENOENT')diagnose('host-optional-operation',e) }
  },
}

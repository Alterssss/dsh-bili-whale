import { guardedFetch as fetch, trafficGuard } from '../lib/traffic.mjs'
import { dshPath } from '../lib/paths.mjs'
// 依赖体检（2026-10-17 加）：装完之后让 agent 自己跑一次，确认"能不能用"
//
// 用法：
//   node deps.mjs            人读版（每项 ✓/✗ + 怎么修）
//   node deps.mjs --json     机器读版（agent 判断用）
//
// 退出码：0 = 全可用；3 = 有缺的（缺的那项会写明补救办法）
import fs from 'node:fs'
import path from 'node:path'
import { ffmpegInfo } from '../lib/ffmpeg.mjs'
import { apiState } from '../lib/bili-api.mjs'
import { config } from '../lib/config.mjs'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const cred = path.join(HOME, '.bili-ai', 'credentials.json')
const asJson = process.argv.includes('--json')

const items = []

// ① 凭据（cookie）：**真去请求一次 nav** —— 只查"字段齐不齐"是不够的（cookie 会过期 ✗）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
let credOk = false, credNote = ''
try {
  const c = JSON.parse(fs.readFileSync(cred, 'utf8'))
  const miss = ['sessdata', 'bili_jct'].filter((k) => !c[k] || !String(c[k]).trim())
  if (miss.length) { credNote = `缺字段：${miss.join(', ')}` }
  else {
    const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct}; buvid3=${c.buvid3}` },
    })).json()
    credOk = nav.code === 0 && !!nav.data?.isLogin
    credNote = credOk
      ? `已登录：${nav.data.uname}（mid ${nav.data.mid}）`
      : `cookie 无效：code=${nav.code} ${nav.message ?? ''} —— 重新复制一次（选"长期/记住我"）`
  }
} catch (e) { credNote = e.code === 'BILI_TRAFFIC_PAUSED' ? e.message : `无法验证凭据：${e.message}` }
items.push({
  name: 'B站 cookie',
  ok: credOk,
  detail: credNote,
  fix: '请求保护暂停时等待恢复；只有明确登录失效时才重新填写凭据。体检无需在每次写操作前重复执行。',
})

// ② ffmpeg（抽帧看画面）
const ff = ffmpegInfo()
items.push({
  name: 'ffmpeg（抽帧看画面）',
  ok: ff.ok,
  detail: ff.ok ? `${ff.version}\n  路径：${ff.path}` : (ff.path ? `找到了但跑不起来：${ff.version ?? ff.error}` : '没找到'),
  fix: '① winget install ffmpeg  ② 或设环境变量 FFMPEG=路径  ③ 或放进 <仓库>/bin/ 或 ~/.dsh/bili-whale/bin/',
})

// ③ Node 版本（要 18+ 才有稳定 fetch）
const major = Number(process.versions.node.split('.')[0])
items.push({
  name: 'Node.js',
  ok: major >= 18,
  detail: `v${process.versions.node}`,
  fix: '升级到 Node 18 或更高（fetch / Blob 之类要用）',
})

// ④ 可写的家目录（放 cookie/配额/日记）
let dirOk = false
try {
  const d = path.join(HOME, '.bili-ai')
  fs.mkdirSync(d, { recursive: true })
  const probe = path.join(d, '.write-probe')
  fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe)
  dirOk = true
} catch {}
// 2026-10-21 加（Issue #8-3）：没有 node 运行时 → 生物钟/监听/直播间全部停用，
//   但以前体检不报这一项 ✗ 表面全绿、其实永远不会醒 ✗
try {
  const { NODE_EXE, isRealNode } = await import('../lib/nodebin.mjs')
  const real = isRealNode()
  items.push({
    name: 'node 运行时',
    ok: real,
    detail: real ? NODE_EXE : ('这个不是 node：' + NODE_EXE + '（会静默返回空输出）'),
    fix: '设置环境变量 DSH_NODE 指向 node 可执行文件的绝对路径，然后重启 DSH',
  })
} catch (e) {
  items.push({ name: 'node 运行时', ok: false, detail: '检查失败：' + String(e?.message ?? e).slice(0, 80), fix: '设置 DSH_NODE' })
}

items.push({ name: '数据目录可写', ok: dirOk, detail: path.join(HOME, '.bili-ai'), fix: '检查该目录权限' })
// 2026-10-22：把「接口缓存 / 熔断」现状也列出来 ——
//   被 412 限流时最想知道的就是「还要等多久」和「缓存里还有多少能撑」
try {
  const st = apiState()
  items.push({
    name: 'B站 限流',
    ok: !st.banned,
    detail: st.banned
      ? `熔断中，约 ${st.banMinutesLeft} 分钟后恢复（原因 ${st.banWhy ?? '-'}）；缓存里 ${st.cacheEntries} 条可撑`
      : `正常 · 元信息缓存 ${st.cacheEntries} 条`,
    fix: '等它自己恢复（5→10→20→30 分钟退避）；期间只读缓存，别手动狂点',
  })
} catch {}

// 2026-10-22 加：把「生物钟」也报出来 —— 主人很早以前提过，一直没做 ✗
//   以前 deps 只看 cookie / ffmpeg / node ✗ → 调度器死了她看不出来 ✗
//   → 「体检全绿，但今晚根本不会醒」是最难发现的失败 ✓
//   ⚠️ deps.mjs 是独立进程，读不到插件内存里的 SCHED_STATUS
//   → 只能从【配置 + 状态文件】推断 ✓
try {
  // 2026-10-23 修（issue #27，@Schumchanvi 报的）：自定义 DSH_HOME 时这里读错目录 ✗
  //   以前写死 path.join(HOME, '.dsh', ...) ✗ → 体检误报「配置里没有任何作息窗口」✗
  const cfgPath = process.env.BILI_WHALE_CONFIG || dshPath('bili-whale.config.json')
  const statePath = dshPath('whale-night.json')
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  const night = cfg.night ?? {}
  const windows = Array.isArray(night.windows) ? night.windows : []
  const maxW = Number(night.maxWakesPerDay ?? 1) || 1
  if (!windows.length) {
    items.push({ name: '生物钟', ok: false, detail: '配置里没有任何作息窗口 → 永远不醒 ✗', fix: '设置页「作息」加一个窗口（例如 20:00–24:00，醒 1 次）' })
  } else {
    let st = null
    try { st = JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch {}
    const now = Date.now()
    const woke = Number(st?.wakes ?? 0)
    const atMs = Number(st?.atMs ?? 0)
    const action = String(st?.action ?? '')
    let ok = true, detail = '', fix = ''
    if (!st) {
      ok = false
      detail = '还没有计划文件（调度器可能刚起、或根本没起来）✗'
      fix = '等一分钟再看；还是这样就看设置页「依赖体检」里调度器那行的原因'
    } else if (action === 'wake' && atMs) {
      const mins = Math.round((atMs - now) / 60000)
      // Today's wake count does not establish that this particular plan ran.
      if (st.fired === true || st.woke === true) {
        detail = `每 60 秒 tick · 今天已醒 ${woke}/${maxW} 次 · 计划 ${st.atText ?? ''} 已执行 ✓`
      } else if (atMs < now - 15 * 60000) {
        ok = false
        detail = `计划 ${st.atText ?? ''} 已经过去 ${Math.abs(mins)} 分钟还没执行 → 调度器可能没在跑 ✗`
        fix = '重启 DSH；起来后看设置页「依赖体检」里调度器那行'
      } else {
        detail = `每 60 秒 tick · 下次 ${st.atText ?? new Date(atMs).toLocaleString('zh-CN')}${mins > 0 ? `（${mins} 分钟后）` : '（马上）'} · 今日已醒 ${woke}/${maxW}`
      }
    } else if (action === 'done') {
      detail = `今日已醒 ${woke}/${maxW} · 今晚不会再醒（${st.reason ?? '窗口已用完'}）`
    } else if (action === 'skip') {
      detail = `这趟是「不看」· 今日已醒 ${woke}/${maxW}（${st.window ?? ''}）`
    } else {
      detail = `状态 ${action || '(空)'} · 今日已醒 ${woke}/${maxW}`
    }
    items.push({ name: '生物钟', ok, detail, fix })
  }
} catch (e) {
  items.push({ name: '生物钟', ok: false, detail: '检查失败：' + String(e?.message ?? e).slice(0, 80), fix: '看设置页「养鱼」里生物钟那行；或 node bili.mjs night plan' })
}

try {
  const state = trafficGuard().status()
  const manual=Object.keys(state.manual??{}).length
  let currentPause
  try { const c=JSON.parse(fs.readFileSync(cred,'utf8'));currentPause=trafficGuard().pauseReason({cookie:`SESSDATA=${c.sessdata}`}) } catch {}
  const pending=Object.values(state.operations??{}).filter(x=>['pending','unknown'].includes(x.status)).length
  const paused=Number(state.until??0)>Date.now()
  items.push({name:'全局请求保护',ok:!currentPause&&!pending,detail:`${currentPause??'当前账号可请求'}；${manual} 个会话凭据曾需人工处理，${pending} 条发送结果待核查`,fix:'运行 node tools/bili.mjs traffic status 查看。人工核查前不要重发或解除暂停。'})
} catch(e) {items.push({name:'全局请求保护',ok:false,detail:e.message,fix:'检查请求保护状态文件，不要删除状态来绕过限制'})}
if (config().listen?.dm && config().listen?.dmTransport === 'push') {
  try {
    const state = JSON.parse(fs.readFileSync(dshPath('whale-dm-push.json'), 'utf8'))
    const fresh = Date.now() - new Date(state.at).getTime() < 90000
    const ok = fresh && state.phase === 'ready' && state.subscribed === true && state.pollingEnabled === false
    items.push({ name: '私信实时推送', ok,
      detail: ok ? `已订阅 · 周期查收关闭 · 通知 ${state.ownerNotifications ?? 0} · 事件取信 ${state.drains ?? 0}` : `状态 ${state.phase ?? 'unknown'}${state.error ? ' · ' + state.error : ''}${fresh ? '' : ' · 状态已过期'}`,
      fix: '检查宠物推送连接；失败不会自动回退到分钟轮询。' })
  } catch {
    items.push({ name: '私信实时推送', ok: false, detail: '推送状态不可读', fix: '检查 whale-dm-push.json 和宠物 Host 日志。' })
  }
}
const bad = items.filter((i) => !i.ok)

if (asJson) {
  console.log(JSON.stringify({ ok: bad.length === 0, node: process.versions.node, items }, null, 2))
} else {
  console.log('== 依赖体检 ==')
  for (const i of items) {
    console.log(`${i.ok ? '✓' : '✗'} ${i.name}  ${i.detail ? '— ' + i.detail : ''}`)
    if (!i.ok) console.log(`    修：${i.fix}`)
  }
  console.log(bad.length ? `\n✗ ${bad.length} 项不可用 —— 先用上面的"修"处理，再重跑一次。` : '\n✓ 全部可用')
}
process.exit(bad.length ? 3 : 0)

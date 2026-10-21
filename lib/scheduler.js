/**
 * 自主生物钟（2026-10-18 加，主人要求）——
 *
 * 为什么要有它：以前"醒来"要靠**有人在对话框里挂 clock** ✗ —— 那不是"她活在过日子"，
 * 是"你戳一下她动一下" ✗。主人明确要求：**计划要她自己执行，改配置要立刻生效** ✓。
 *
 * 做法（不需要任何外部 CLI）：
 *   · 插件宿主**常驻在 DSH 里** → 自己每 60 秒 tick 一次 ✓
 *   · tick 里跑 `bili.mjs night plan` 算出今天下一次醒来的时刻（结果写在 whale-night.json）
 *   · 到点了 → 用 **`ctx.sessionController.prompt({ sessionId, mode:'queue', content:[…] })`**
 *     往她自己的专用会话里塞一个"你醒了"的回合 ✓ → agent 真的醒来干活 ✓
 *   · 醒来后立刻标记 `woke` → 下一次 tick 自动排下一趟（多窗口 × 多次 ✓）
 *   · 设置页一保存 → 调 `invalidate()` 清掉旧计划 → 下一次 tick 按新配置重算 ✓（改完立刻生效 ✓）
 *
 * 为什么用"她自己的会话"：`sessionId` 固定（默认 bili-whale）→ 跨天保留她的上下文，
 *   而不是每天开一个新会话、每天忘光 ✗。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
// 收件箱读取复用工具链的实现（避免在插件里再抄一份 B站 接口 ✓）
import { pullFeed, makeHeaders } from '../tools/lib/msgfeed.mjs'

const TICK_MS = 60_000
const LISTEN_STATE = 'whale-listen.json'

/** 叫醒她时塞进去的那段话（她醒来第一眼看到的就是它） */
function wakePrompt(st) {
  return [
    `【生物钟】你醒了 —— ${st.atText ?? ''}${st.window ? `（窗口 ${st.window}${st.withinWindow ? ' · ' + st.withinWindow : ''}）` : ''}。`,
    '',
    '按 AGENTS.md 的「看的那晚」流程走一遍（不要等我说话，直接做）：',
    '1) `node bili.mjs deps` —— 体检红着就报备我、只做读、别对外发',
    '2) 读两本日记（`~/.dsh/whale-diary.md` + `whale-diary-private.md`）',
    '3) `feed` 选题（≤5 条）→ 对这 5 条跑 `debrief --no-frames`',
    '4) 挑 2–3 条深读（完整 `debrief`，含抽帧）',
    '5) 按「标尺」打分排序，只对第一名考虑分享；**先看 share.via**：',
    '   · via=dm：**不发公开评论** ✗ → dm --msg "<分享内容> 视频：https://www.bilibili.com/video/<BV>/ " **--share --target BV…** --go ✓',
    '     ⚠️ 必须带 --share：与评论区 @ 共用同一本额度账（≤3/天 · 同一视频 7 天一次）；不带就只是推送 ✗',
    '     ⚠️ 必须带视频链接：链接里的 BV 就是「同一视频」的判重依据 ✓',
    '   · via=comment：comment --share --auto --reason … --score … --rank 1（原功能 ✓）',
    '6) 写两本日记（散文体 + 表格 ✓ 私人那本写「偏好校准」）',
    // ⭐ 2026-10-18 主人定：每轮流程**最后**扫一遍"有没有没回的评论" → 有就**一起**推给我 ✓
    '7) ⭐ `comment-digest --hours 24` —— **每轮最后都要扫**：有没回的评论就**一起**推给我（不是一条条报 ✗）',
    '   回不回、怎么回：主人 / 其他人 → 见「倾听」的分两侧规则 ✓',
    '7.5) ⭐ `quota react --auto --hours 48` —— 扫一遍主人有没有表态（**点赞也算** ✓ 能看到是哪条评论 ✓）',
    '     → 有就记一次反馈，并**写进私人日记「偏好校准」**（哪条视频 / 他什么反应 / 我下次往哪偏）',
    '8) 用 `node bili.mjs notify` 推给我：**「给他的信」里最想对我说的那一段原文** + 一句摘要',
    '   （2026-10-18 主人定：推**日记内容**，不只是流水账 ✓ 它读设置页「消息推送」的配置）',
    '9) 收工：记 `diary log`，别再自己加戏 ✓',
  ].join('\n')
}

export function startScheduler(ctx, opts) {
  const {
    dshHome,
    biliMjs,          // 指向 tools/bili.mjs（绝对路径）
    cwd,              // 她那个会话的工作目录
    sessionId = 'bili-whale',
    log = () => {},
  } = opts

  const STATE = path.join(dshHome, 'whale-night.json')
  const CFG_FILE_REF = path.join(dshHome, 'bili-whale.config.json')     // 监听循环每次重读（改配置立刻生效 ✓）
  const CRED_REF = path.join(dshHome, '..', '.bili-ai', 'credentials.json')
  const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return null } }
  const writeState = (o) => {
    try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(o, null, 2) + '\n') } catch {}
  }
  const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() }
  const today = () => new Date().toLocaleDateString('sv-SE')

  // ⚠️ 2026-10-18 大坑：插件跑在 DSH 的 **Electron** 里，`process.execPath` = DeepSeek Harness.exe ✗
  //   用主程序跑脚本时，B站 的 `gethistory` 返回**空数组**（nav 之类却正常 ✗）→ 直播间永远"听不见" ✗
  //   实测对照：真 node.exe 5 秒命中；主程序 25 秒 0 行 ✗
  //   → 必须找到 **真正的 node.exe**（DSH 自带的运行时）✓
  function findNode() {
    const cands = [
      process.env.DSH_NODE,
      path.join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
      path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    ]
    for (const c of cands) { try { if (c && fs.existsSync(c)) return c } catch {} }
    return process.execPath   // 兜底
  }
  const NODE_EXE = findNode()
  const NODE_ENV = { ...process.env }   // 真 node 不需要 ELECTRON_RUN_AS_NODE ✓

  const runBili = (args) => new Promise((resolve) => {
    execFile(NODE_EXE, [biliMjs, ...args], { timeout: 120_000, windowsHide: true, env: NODE_ENV }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout ?? ''), err: String(stderr ?? '') })
    })
  })

  let sessionReady = false
  async function ensureSession() {
    if (sessionReady) return
    try {
      await ctx.sessionController.create({ sessionId, cwd })
    } catch {
      /* create 失败就忽略（常见为同名会话已抛错）✓ —— 已存在的会话沿用建它时的 cwd，home 配置不会迁移到它 */
      log(`[bili-whale] 会话 ${sessionId} create 失败（常见为已存在），沿用其原工作目录（config.home 若已改，对它不生效）`)
    }
    sessionReady = true
  }

  let waking = false
  async function tick() {
    if (waking) return
    if (!ctx.sessionController) return           // 服务还没就绪 → 下一 tick 再来
    const st = readState()
    const t = today()

    // ①-0 掷到「不看」→ **也要叫醒她**（2026-10-18 主人定：醒或不醒都要写日记 ✓）
    //    以前这个分支只是被重算掉 ✗ → 那一趟等于什么都没发生、日记也没有 ✗
    if (st && st.date === t && st.action === 'skip' && !st.fired) {
      waking = true
      try {
        await ensureSession()
        await ctx.sessionController.prompt(
          {
            requestId: `bili-whale-skip-${Date.now()}`,
            sessionId,
            mode: 'queue',
            content: [{
              type: 'text',
              text: [
                personaLine(),
                `【今晚不看】${st.reason ?? ''}（窗口 ${st.window ?? '?'}）`,
                '',
                '按 AGENTS.md 的「不看的那晚」做（不要等我说话，直接做）：',
                '1) **两本日记都要写**，而且必须写清"为什么不想看"（累/没吃饱/心情不好/就是不想… 不许只写"跳过"两个字 ✗）',
                '2) `node bili.mjs diary log night-skip --note "…理由…"`',
                '3) `comment-digest` 扫一眼有没有没回的评论',
                '4) 推给我：**日记里最想对我说的那一段** + 今天谁找过你 ✓',
              ].join('\n'),
            }],
          },
          new AbortController().signal,
        )
        writeState({ ...st, fired: true })
        log(`[bili-whale] 今晚不看 → 已叫醒她写日记 · ${st.reason ?? ''}`)
      } catch (e) {
        log(`[bili-whale] 不看那晚叫醒失败：${String(e.message).slice(0, 120)}`)
      } finally {
        waking = false
      }
      return
    }

    // ① 该重算的情形：没计划 / 跨天 / 上次已醒 / 上次已结束 / 只有计数没计划（invalidate 之后 ✓）
    if (!st || st.date !== t || st.woke === true || st.done === true || st.action === 'skip' || !st.action) {
      if (st && st.date === t && st.action === 'done') return   // 今天的次数用完了，别反复算
      const r = await runBili(['night', 'plan'])
      if (!r.ok) log(`[bili-whale] plan 失败：${(r.err || r.out).slice(0, 160)}`)
      return
    }

    if (st.action === 'wake' && !st.fired && nowMin() >= Number(st.at)) {
      waking = true
      try {
        await ensureSession()
        await ctx.sessionController.prompt(
          {
            requestId: `bili-whale-${Date.now()}`,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: wakePrompt(st) }],
          },
          new AbortController().signal,
        )
        writeState({ ...st, fired: true, woke: true, wakes: Number(st.wakes ?? 0) + 1, wokeAt: new Date().toISOString() })
        log(`[bili-whale] 生物钟叫醒 · ${st.atText ?? ''}${st.window ? '（' + st.window + '）' : ''} · 第 ${Number(st.wakes ?? 0) + 1} 次`)
      } catch (e) {
        log(`[bili-whale] 叫醒失败：${String(e.message).slice(0, 160)}（下一 tick 重试）`)
      } finally {
        waking = false
      }
    }
  }

  // ── 全天监听（2026-10-18 加）：插件自己轮询收件箱，有人找她就叫醒她 ────────────────
  // 为什么放这里：`listen.allDay` 只控制"守多久" ✓，但**没人启动 listener** ✗ —— 跟生物钟当初的病一样。
  // 现在插件每 listen.commentIntervalSec 秒看一眼「回复我的 / @我的」；有新东西就 prompt 她一次。
  const LSTATE = path.join(dshHome, LISTEN_STATE)
  const readL = () => { try { return JSON.parse(fs.readFileSync(LSTATE, 'utf8')) } catch { return null } }
  const writeL = (o) => { try { fs.mkdirSync(path.dirname(LSTATE), { recursive: true }); fs.writeFileSync(LSTATE, JSON.stringify(o, null, 2) + '\n') } catch {} }
  const inWindow = (cfg) => {
    const wins = Array.isArray(cfg?.night?.windows) ? cfg.night.windows : []
    const d = new Date(); const m = d.getHours() * 60 + d.getMinutes()
    return wins.some((w) => {
      const [sh, sm] = String(w.start ?? '').split(':').map(Number)
      const [eh, em] = String(w.end ?? '').split(':').map(Number)
      const s = (sh === 24 ? 1440 : sh * 60) + (sm || 0)
      const e = (eh === 24 ? 1440 : eh * 60) + (em || 0)
      return m >= s && m < e
    })
  }

  let listening = false
  let lastListenAt = 0
  // 直播间监听（2026-10-18 加）：插件替主人管着 `danmaku await` ✓
  let liveProc = null
  let liveRetryAt = 0
  let liveWaking = false
  let liveStopping = false   // 主动停（关开关）→ 退出回调不要当成"异常退出" ✗
  let liveRoomNow = ''       // 当前在听的房间号（用于检测"主人换了房间" ✓）
    // ── 私信监听（2026-10-19）──────────────────────────────────────
    //   只认主人那一个会话 ✓ 系统通知/陌生人一律忽略 ✗
    //   你不说话 = 没有新私信 = 不叫醒 = 零 token ✓（主人设计的低风险互动 ✓）
    let dmBusy = false
    let lastDmAt = 0
    // ── 身份注入（2026-10-19）────────────────────────────────────
    //   设置页「她是谁」那三个字段以前只是存着，没有任何代码读 ✗
    //   现在每次叫醒她，把这段塞到提示最前面 → 她真的按配置称呼自己/主人 ✓
    const personaLine = () => {
      let cfg = {}
      try { cfg = JSON.parse(fs.readFileSync(CFG_FILE_REF, "utf8")) } catch {}
      const p = cfg.persona ?? {}
      const bits = []
      if (p.name) bits.push(`你是「${p.name}」`)
      if (p.ownerTitle) bits.push(`称用户「${p.ownerTitle}」`)
      if (p.selfClaim) bits.push(`自称「${p.selfClaim}」`)
      return bits.length ? `［身份］${bits.join("，")}。（以此为准，别用别的称呼 ✓）` : ""
    }

    async function dmTick() {
      if (dmBusy) return
      let cfg
      try { cfg = JSON.parse(fs.readFileSync(CFG_FILE_REF, "utf8")) } catch { cfg = {} }
      const L = cfg.listen ?? {}
      if (!L.dm) return
      if (Date.now() - lastDmAt < 5_000) return   // 2026-10-19：原来 60s 和定时器叠成双层节流 → 最坏 2 分钟 ✗ 改成 5s
      lastDmAt = Date.now()
      dmBusy = true
      try {
        const r = await runBili(["dm-await", "--once", "--json"])
        const line = String(r.out ?? "").trim().split("\n").pop() ?? ""
        let j = null
        try { j = JSON.parse(line) } catch { j = null }
        if (!j?.hit) return
        await ensureSession()
        await ctx.sessionController.prompt({
          requestId: `bili-whale-dm-${Date.now()}`,
          sessionId,
          mode: "queue",
          content: [{
            type: "text",
            text: [
              personaLine(),
              `【主人私信】${j.name}（mid ${j.mid}）刚给你发私信：`,
              "",
              String(j.text ?? "").slice(0, 500),
              "",
              "按 AGENTS.md「专属通道」做：",
              "1) 这是主人 → **直接回，不用审核** ✓（node bili.mjs dm --msg \"…\" --go）",
              "2) 回短一点、像聊天（私信不是评论区 ✗ 一两句就够）",
              "3) 回完写进日记「偏好校准」✓（主人的话算反馈 ✓）",
            ].join("\n"),
          }],
        }, new AbortController().signal)   // 2026-10-19 修：prompt 的第二个参数是 signal ✗ 漏传会 TypeError
      } catch (e) {
        try { fs.appendFileSync(path.join(os.homedir(), ".bili-ai", "dm-tick-err.log"), new Date().toISOString() + " " + (e?.stack ?? e) + "\n") } catch {}
      }
      finally { dmBusy = false }
    }

  async function listenTick() {
    if (listening) return
    let cfg
    try { cfg = JSON.parse(fs.readFileSync(CFG_FILE_REF, 'utf8')) } catch { cfg = {} }
    const L = cfg.listen ?? {}
    if (L.comment === false) return                              // 评论区监听关掉了 ✓
    // 下限 60 秒（2026-10-18 测试期曾临时放宽到 2 秒 ✓ 已还原 ✓ —— B站 接口经不起每 2 秒锤 ✗）
    const interval = Math.max(60, Number(L.commentIntervalSec ?? 300)) * 1000
    if (Date.now() - lastListenAt < interval) return
    lastListenAt = Date.now()
    // 「全天」关掉时：只在她醒着的窗口里听（省 token / 更自然 ✓）
    if (!L.allDay && !inWindow(cfg)) return
    listening = true
    try {
      const cred = JSON.parse(fs.readFileSync(CRED_REF, 'utf8'))
      const H = makeHeaders(cred)
      const since = Number(readL()?.lastSeen ?? 0)
      const items = []
      items.push(...(await pullFeed('reply', { headers: H, pages: 1 })).items)
      if (String(L.scope ?? 'both') !== 'reply') {
        try { items.push(...(await pullFeed('at', { headers: H, pages: 1 })).items) } catch {}
      }
      // 第一次跑：只把"现在"当基线，不把历史回复全倒一遍 ✓
      if (!since) { writeL({ lastSeen: Math.floor(Date.now() / 1000) }); listening = false; return }
      const fresh = items.filter((x) => Number(x.t) > since && (!L.onlyOwner || String(x.mid) === String(cfg.owner?.mid ?? '')))
      if (!fresh.length) { listening = false; return }
      fresh.sort((a, b) => a.t - b.t)
      const who = fresh.map((x) => `${x.who}（${x.kind === 'at' ? '@' : '回复'}）`).join('、')
      await ensureSession()
      await ctx.sessionController.prompt(
        {
          requestId: `bili-whale-listen-${Date.now()}`,
          sessionId,
          mode: 'queue',
          content: [{
            type: 'text',
            text: [
              personaLine(),
              `【有人找你】${fresh.length} 条新消息：${who}。`,
              '',
              '按 AGENTS.md 的「倾听」做（不要等我说话，直接做）：',
              '1) `node bili.mjs comment-digest --hours 24` —— 把积压的**一起看**（合并策略 ✓ 不可关）',
              '2) 只回「一两句能答清的提问 + 轻互动」，一条收住；吵架/要隐私/长篇追问/代表主人承诺 → 不回 ✗',
              '3) ⭐ **分两侧**（2026-10-18 主人定）：',
              // mid 动态读配置 ✓（别把 uid 写死进代码 ✗ 开源版会带出去 ✗）
              `   · 对方是**主人**（mid ${cfg.owner?.mid ?? '（未配置）'}）→ **直接回** ✓：`,
              '     `comment --oid … --root … --parent … --message "…" --auto --once-per-person（仅当开关=开 ✓） --dry` → `--go` → `thread` 复核 ✓',
              '   · 对方是**其他人** → ⚠️ **不要直接发**，先写草稿给我审 ✓：',
              '     `node bili.mjs reply-draft add --oid … --bvid … --root … --parent … --who 对方昵称 --src "他说的话" --message "你的回复"`',
              '     （add 会自动把草稿推到我微信 ✓）→ 然后 `node bili.mjs notify "有 N 条回复待你审核"` ✓',
              '4) 主人回了「发」→ 你再跑 comment --go；回「不发」→ `reply-draft drop <id>` ✓',
              '5) 别贪多：这一批处理完就停 ✓（**只有设置页「同一个人最多只回一条」= 开时**才加 --once-per-person ✓；关掉就别加 ✗）',
            ].join('\n'),
          }],
        },
        new AbortController().signal,
      )
      writeL({ lastSeen: Math.max(...fresh.map((x) => Number(x.t))) })
      log(`[bili-whale] 监听命中 ${fresh.length} 条（${who}）→ 已叫醒`)
    } catch (e) {
      log(`[bili-whale] 监听失败：${String(e.message).slice(0, 140)}`)
    } finally {
      listening = false
    }
  }

  // ── 直播间监听：起一个 `danmaku await` 子进程；它命中就退出（自带契约）→ 叫醒她 → 再挂上 ──
  // 为什么放独立循环：tick() 会在"今天 done"时提前 return ✗，直播间不能跟着停 ✓
  async function liveTick() {
    // ⚠️ 2026-10-18 主人定：直播间是**独立开关** —— 点开就开始、关掉就停（不受作息影响 ✓）
    if (ctx.sessionController) {
      let cur = {}
      try { cur = JSON.parse(fs.readFileSync(CFG_FILE_REF, 'utf8')) } catch {}
      if (!cur.listen?.live && liveProc !== null) {           // 开关被关掉 → 立刻停子进程 ✓
        liveStopping = true
        try { liveProc.kill() } catch {}
        liveProc = null
        liveRetryAt = 0
        log('[bili-whale] 直播间监听已停（开关关掉了 ✓）')
        return
      }
      // 2026-10-18 加：**换了房间号** → 也要立刻换线（以前只认开关 ✗ 换房间还在听老房间 ✗）
      const wantRoom = String(cur.listen?.liveRoom ?? '').trim()
      if (liveProc !== null && wantRoom && liveRoomNow && wantRoom !== liveRoomNow) {
        liveStopping = true
        try { liveProc.kill() } catch {}
        liveProc = null
        liveRetryAt = 0
        log(`[bili-whale] 直播间换房间：${liveRoomNow} → ${wantRoom}（立刻重挂 ✓）`)
        liveRoomNow = ''
        return
      }
    }
    if (liveProc !== null || liveWaking || liveRetryAt > Date.now()) return
    if (!ctx.sessionController) return
    let cfg = {}
    try { cfg = JSON.parse(fs.readFileSync(CFG_FILE_REF, 'utf8')) } catch {}
    const L = cfg.listen ?? {}
    const room = String(L.liveRoom ?? '').trim()
    if (!L.live || !room) return

    // ⚠️ `danmaku-await.mjs` 是独立脚本（不走 bili.mjs 的 danmaku 子命令 ✗ —— 那是 pre/send/live ✓）
    const awaitScript = path.join(path.dirname(biliMjs), 'commands', 'danmaku-await.mjs')
    const args = [awaitScript, '--room', room]
    if (String(L.liveScope ?? 'owner') === 'owner' && cfg.owner?.mid) args.push('--operator-uid', String(cfg.owner.mid))
    liveProc = execFile(NODE_EXE, args, {   // ⚠️ 必须真 node（主程序会让 gethistory 返回空 ✗）
      // ⚠️ 千万不要写 `timeout: 0` ✗ —— 实测它会把子进程立刻 SIGTERM 掉（探针验过 ✓）；
      //   直播间监听本来就是长驻的，**不设 timeout** 才对 ✓
      windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: NODE_ENV,
      cwd: path.dirname(biliMjs),   // 脚本按相对路径找 lib/，必须给 cwd ✓
    }, (err, stdout, stderr) => {
      liveProc = null
      if (liveStopping) { liveStopping = false; return }   // 那是我们主动停的 ✓ 不算异常 ✗
      const out = String(stdout ?? '')
      // ⚠️ 2026-10-18 修真 bug：`danmaku-await` 命中时打印的是 **AWAIT_HIT** ✗
      //   我原来等的是 DANMAKU_HIT ✗ → 听见了也认不出 → 一直"退出/重挂"
      if (/AWAIT_HIT|DANMAKU_HIT/.test(out)) {
        liveWaking = true
        const lines = out.split('\n').map((s) => s.trim()).filter((s) => /AWAIT_HIT|DANMAKU_HIT|@/.test(s)).slice(-3).join(' / ').slice(0, 300)
        ;(async () => {
          try {
            await ensureSession()
            await ctx.sessionController.prompt({
              requestId: `bili-whale-live-${Date.now()}`,
              sessionId,
              mode: 'queue',
              content: [{
                type: 'text',
                text: [
                  personaLine(),
                  `【直播间有人叫你】${lines || '（看输出）'}`,
                  '',
                  '按 AGENTS.md「倾听 · 直播间」做（不要等我说话，直接做）：',
                  '1) 看是谁、说了什么；范围按主人设置（只回主人 / 只回 @她的）✓',
                  '2) 回一句就收住（弹幕不是评论区，别长篇 ✗）；吵架/要隐私/不认识的 → 不回 ✗',
                  '   发弹幕：`node bili.mjs danmaku send --msg "…" --reply-mid <对方mid> --reply-name <对方昵称>` → `--dry` → `--go` ✓（**不用审核 ✓ 也不用报备 ✗ 2026-10-18 主人定**）',
                ].join('\n'),
              }],
            }, new AbortController().signal)
            log(`[bili-whale] 直播间命中 → 已叫醒 · ${lines.slice(0, 80)}`)
          } catch (e) {
            log(`[bili-whale] 直播间叫醒失败：${String(e.message).slice(0, 120)}`)
          } finally {
            liveWaking = false
            // 2026-10-18 主人定：**监听到就回（实时）** ✓ —— 回复完 2 秒就重新挂上 ✗ 不再冷却 2 分钟
            liveRetryAt = Date.now() + 2_000
          }
        })()
      } else {
        // 退出但没命中 → 把"怎么退的"记全（2026-10-18：以前只记一句话，排不动 ✗）
        // 退避 12 秒（2026-10-18 改：原来 60 秒，外部误杀一次要等一分钟以上才回来 ✗）
        const tail = String(out ?? '').trim().split('\n').slice(-2).join(' | ').slice(-200)
        const why = [
          err ? `code=${err.code ?? '?'} signal=${err.signal ?? '?'}` : 'code=0',
          String(stderr ?? '').trim().slice(0, 150),
          tail,
        ].filter(Boolean).join(' · ')
        log(`[bili-whale] 直播间监听退出：${why}（12 秒后重挂）`)
        liveRetryAt = Date.now() + 12_000
      }
    })
    liveRoomNow = room   // 记下"现在听的是哪个房间" → 主人换房间时靠它检测 ✓
    log(`[bili-whale] 直播间监听已挂上（房间 ${room} · ${String(L.liveScope ?? 'owner') === 'owner' ? '只回主人' : '只回@她的'}）✓`)
  }

  const timer = setInterval(() => { tick().catch(() => {}) }, TICK_MS)
  setTimeout(() => { tick().catch(() => {}) }, 8000)          // 启动 8 秒后先跑一次
  // 30 秒看一眼"到点没"（2026-10-18 测试期曾改 2.5 秒 ✓ 已还原 ✓），真正间隔由配置定 ✓
  const timer2 = setInterval(() => { listenTick().catch(() => {}) }, 30_000)
  setTimeout(() => { listenTick().catch(() => {}) }, 15_000)
  const timerDm = setInterval(() => { dmTick().catch(() => {}) }, 20_000)   // 2026-10-19: 60s -> 20s, 私信要像聊天; 每次只是一个 get_sessions 请求 很轻
  setTimeout(() => { dmTick().catch(() => {}) }, 25_000)
  const timer3 = setInterval(() => { liveTick().catch(() => {}) }, 60_000)     // 直播间：挂了就一直跑，断了自动重挂 ✓
  setTimeout(() => { liveTick().catch(() => {}) }, 20_000)
  log(`[bili-whale] 自主生物钟已启动（每 ${TICK_MS / 1000}s tick · 会话 ${sessionId}）；监听 + 直播间监看都挂上了 ✓`)

  return {
    /** 设置页一保存就调它：清掉旧计划，下一次 tick 按新配置重算 ✓ */
    invalidate() {
      // ⚠️ 2026-10-18 修：以前直接删状态文件 → 把「今天已醒几次」也抹了 ✗
      //   现在只清**计划**，保留 `{ date, wakes }` ✓（tick 里 `!st.action` 会触发重算 ✓）
      try {
        const old = readState()
        if (old && old.date === today()) writeState({ date: old.date, wakes: Number(old.wakes ?? 0) })
        else fs.rmSync(STATE, { force: true })
      } catch {}
      lastListenAt = 0            // 监听间隔也立刻重读 ✓（改完全天/间隔马上生效）
      writeL({})                  // 重置基线 → 下次按"现在"重新算，不会把旧的倒出来 ✓
      tick().catch(() => {})
      listenTick().catch(() => {})
      dmTick().catch(() => {})
      // ⭐ 直播间是**单独开关**：保存设置就立刻生效（点开就跑 ✓ 关掉就停 ✓），不等下一轮定时器
      liveTick().catch(() => {})
    },
    stop() { clearInterval(timer); clearInterval(timer2); clearInterval(timer3); try { liveProc?.kill() } catch {} },
    tick,
    listenTick,
    liveTick,
  }
}

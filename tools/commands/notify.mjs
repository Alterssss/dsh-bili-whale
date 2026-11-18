import { guardedFetch as fetch } from '../lib/traffic.mjs'
import { dshPath } from '../lib/paths.mjs'
// 通知分发器 —— 她看完一轮，把摘要送到哪。
//
// 2026-10-18 主人重定：方式只有四种（不推送 / 桌面通知 / Webhook / 自定义命令）。
//   · Webhook **按域名自动适配**飞书/钉钉/企业微信/QQ机器人/WorkBuddy 的报文格式
//     （它们各自的 JSON 结构不一样 ✗，让用户去记格式不现实 ✓）
//   · 自定义命令：`cmd` = 可执行文件、`args` = 参数数组，消息自动作为**最后一个参数**传入 ✓
//     （`$MSG` 占位已于 2026-10-18 弃用 ✗ —— 走 shell 有命令注入风险，来源是陌生评论/弹幕）
//   · 兼容旧配置：stdout / file 仍然可用（不删，免得老配置炸 ✗）
//
// 用法：
//   node notify.mjs "消息正文" [--title 标题] [--dry]   （--dry = 只算报文，不真发）
//   node notify.mjs --test                              （发一条测试消息；设置页「发条测试」用它）
//
// 配置（~/.dsh/bili-whale.config.json 的 notify 段）：
//   { "type": "none|desktop|webhook|command", "url": "", "template": "text|markdown", "cmd": "" }
import { spawnSync } from 'node:child_process'
import { execFileSync } from '../lib/capture.mjs'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { config } from '../lib/config.mjs'
import { NODE_EXE } from '../lib/nodebin.mjs'   // 2026-10-21：别用 process.execPath（Electron 里它是主程序 ✗）

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry')
const TEST = argv.includes('--test')
const ti = argv.indexOf('--title')
const title = ti >= 0 ? (argv[ti + 1] ?? '通知') : '通知'

let text
if (argv[0]==='--public-diary') {
  if(argv.length!==2)process.exit(2)
  const {lifeStore}=await import('../lib/life-runtime.mjs')
  text=await lifeStore().claimDiaryPush(argv[1])
  if(!text)process.exit(20)
} else if (TEST) {
  text = `这是一条测试消息 ✓\n如果你看到它，说明「消息推送」配好了。\n（${new Date().toLocaleString('zh-CN', { hour12: false })}）`
} else {
  // 第一个不以 -- 开头、且不是 --title 的值的参数
  const skip = new Set()
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--title') { skip.add(i); skip.add(i + 1) }
    if (argv[i] === '--dry' || argv[i] === '--test') skip.add(i)
  }
  text = argv.find((a, i) => !skip.has(i) && !a.startsWith('--'))
}
if (!text) { console.error('用法: node notify.mjs "消息正文" [--title 标题] | --test'); process.exit(2) }

const n = config().notify ?? { type: 'none' }
const type = String(n.type ?? 'none')
const payload = { title, text, at: new Date().toISOString() }

/** 按域名猜服务，生成它认的报文（飞书 / 钉钉 / 企微 / WorkBuddy / 通用）。 */
function buildWebhookBody(url, tpl) {
  const md = tpl === 'markdown'
  const line = `${title}\n${text}`
  const u = String(url)
  if (u.includes('open.feishu.cn') || u.includes('larksuite.com')) {
    return md
      ? { msg_type: 'post', content: { post: { zh_cn: { title, content: [[{ tag: 'text', text: line }]] } } } }
      : { msg_type: 'text', content: { text: line } }
  }
  if (u.includes('oapi.dingtalk.com')) {
    return md
      ? { msgtype: 'markdown', markdown: { title, text: line } }
      : { msgtype: 'text', text: { content: line } }
  }
  if (u.includes('qyapi.weixin.qq.com')) {
    return md ? { msgtype: 'markdown', markdown: { content: line } } : { msgtype: 'text', text: { content: line } }
  }
  if (u.includes('workbuddy')) return { title, text: line, format: md ? 'markdown' : 'text' }
  // 通用兜底（含 QQ 机器人常见的 { content } 约定）
  return { title, text: line, content: line, format: md ? 'markdown' : 'text' }
}

async function sendWebhook(url, tpl) {
  const body = buildWebhookBody(url, tpl)
  if (DRY) { console.log('[dry] webhook 报文：\n' + JSON.stringify(body, null, 2)); return }
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const raw = await r.text().catch(() => '')
  if (!r.ok) throw new Error(`webhook HTTP ${r.status} ${raw.slice(0, 160)}`)
  console.log(`webhook ${r.status} ✓ ${raw.slice(0, 120)}`)
}

function sendDesktop() {
  if (DRY) { console.log('[dry] 桌面通知：' + String(text).slice(0, 60)); return }
  if (process.platform !== 'win32') { console.log(`[通知] ${title}\n${text}`); return }
  const ps = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null',
    '"<toast><visual><binding template=""ToastGeneric""><text></text><text></text></binding></visual></toast>" | Out-File -Encoding utf8 $env:DW_XML',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$xml.LoadXml([IO.File]::ReadAllText($env:DW_XML))',
    '$node = $xml.GetElementsByTagName("text")',
    '$node.Item(0).AppendChild($xml.CreateTextNode($env:DW_TITLE)) | Out-Null',
    '$node.Item(1).AppendChild($xml.CreateTextNode($env:DW_TEXT)) | Out-Null',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("DeepSeek Harness").Show([Windows.UI.Notifications.ToastNotification]::new($xml))',
    'Remove-Item $env:DW_XML -Force -ErrorAction SilentlyContinue',
  ].join('\n')
  const script = path.join(os.tmpdir(), `dw-toast-${Date.now()}.ps1`)
  const xml = path.join(os.tmpdir(), `dw-toast-${Date.now()}.xml`)
  fs.writeFileSync(script, ps, 'utf8')
  try { execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
    env: { ...process.env, DW_TITLE: String(title), DW_TEXT: String(text), DW_XML: xml },
    encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'],
  })
  } finally {
    fs.rmSync(script, { force: true }); fs.rmSync(xml, { force: true })
  }
  console.log('桌面通知已发送 ✓')
}

function sendCommand(cmd) {
  const c = String(cmd ?? '')
  if (!c.trim()) throw new Error('config.notify.cmd 没配')
  // 2026-10-18 加保险：命令不存在（换电脑/插件被删/路径变了）→ 别静默失败 ✗，
  //   退回桌面通知 ✓ 并说明一句 ✓ —— 开源模板里最容易踩的就是"写死的绝对路径" ✗
  try {
    const looksPath = /[\\/]/.test(c) && !c.includes('$MSG')
    if (looksPath && !fs.existsSync(c)) {
      console.log(`⚠️ 推送命令不存在：${c}`)
      console.log('   → 自动退回「桌面通知」✓（去设置里改「消息推送」即可）')
      return sendDesktop()
    }
  } catch {}
  if (DRY) { console.log('[dry] 命令：' + c + '  (消息作为最后一个参数)'); return }
  if (c.includes('$MSG')) {
    // 2026-10-18 弃用（KIMI 评审指出）✗：$MSG 要走 shell，而 cmd.exe **不认 \" 转义** →
    //   消息里一个英文双引号就能破开引号边界，等于**遥控执行命令** ✗（消息来源是陌生评论/弹幕）
    //   要拼命令请用下面 cmd + args 那条路 ✓（execFileSync，不走 shell ✓）
    throw new Error('$MSG 已弃用（有命令注入风险）：请把 cmd 填成可执行文件、把参数放 args，消息会自动作为最后一个参数传入 ✓')
  } else {
    // 2026-10-18 加：支持 cmd + args（推荐用法 ✓）—— 消息作为**最后一个参数**传进去，
    // 不走 shell → 中文/emoji/引号都不会被 cmd.exe 弄坏 ✓（比如 dsh-wechat-send）
    const argv = Array.isArray(n.args) ? n.args.map(String) : []
    execFileSync(c, [...argv, String(text)], {
      stdio: 'inherit', timeout: 60000,
      env: { ...process.env, WHALE_NOTIFY_TEXT: String(text), WHALE_NOTIFY_TITLE: String(title) },
    })
  }
  console.log('命令已执行 ✓')
}

try {
  if (type === 'none') {
    console.log(DRY ? '[dry] 方式=none（不推送）→ 什么也不做 ✓' : '（方式=none：不推送）')
  } else if (type === 'desktop') {
    sendDesktop()
  } else if (type === 'webhook') {
    if (!n.url) throw new Error('config.notify.url 没配')
    await sendWebhook(n.url, n.template)
  } else if (type === 'command') {
    // 2026-10-18：命令不存在（换电脑/插件被删/写死路径失效）→ 直接改用桌面通知 ✓ 别静默失败 ✗
    const c = String(n.cmd ?? '')
    const isPath = /[\\/]/.test(c) && !c.includes('$MSG')
    if (isPath && !fs.existsSync(c)) {
      console.log(`⚠️ 推送命令不存在：${c}`)
      console.log('   → 已自动改用「桌面通知」✓（去设置里改「消息推送」即可）')
      sendDesktop()
    } else {
      sendCommand(n.cmd)
    }
  } else if (type === 'dm') {
    // 2026-10-19 加：B站私信（专属通道）—— 调 commands/dm.mjs 的发送逻辑
    //   私信自带三道闸（只发主人 / 必须互相关注 / 一天只锁定一个收信人）；失败只提示，不抛 ✗
    // 2026-10-19：DSH 的 Windows 沙箱禁止捕获子进程输出（管道 → EPERM）——
    //   用文件句柄重定向拿输出（不走管道），再原样转贴到 stdout/stderr。
    // 2026-10-21 修（审查 P1-1）：原来这里写死 --go，且没有 DRY 判断 ✗
    //   → notify "…" --dry 在 type=dm 时会【真的发出私信】✗
    // 注意：这里在模块顶层，不能用 return ✗ → 用 exit(0)（预演到此为止 ✓）
    if (DRY) { console.log('[dry] B站私信（不发送）：' + String(text).slice(0, 80)); process.exit(0) }
    const dmPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dm.mjs')
    const outF = path.join(os.tmpdir(), `whale-dm-out-${process.pid}-${Date.now()}.txt`)
    const errF = path.join(os.tmpdir(), `whale-dm-err-${process.pid}-${Date.now()}.txt`)
    const fdO = fs.openSync(outF, 'w'); const fdE = fs.openSync(errF, 'w')
    let r
    try {
      r = spawnSync(NODE_EXE, [dmPath, '--msg', ' '+String(text), '--go'], { stdio: ['ignore', fdO, fdE], timeout: 300000 })
    } finally {
      try { fs.closeSync(fdO) } catch {}
      try { fs.closeSync(fdE) } catch {}
    }
    if (fs.existsSync(outF)) process.stdout.write(fs.readFileSync(outF, 'utf8'))
    if (r?.status !== 0) console.error((fs.existsSync(errF) ? fs.readFileSync(errF, 'utf8') : '').trim() || '（私信发送失败）')
    fs.rmSync(outF, { force: true }); fs.rmSync(errF, { force: true })
    if (r?.error || r?.status !== 0) throw new Error('私信推送失败，未确认送达')
  } else if (type === 'stdout') {
    console.log(`[通知] ${title}\n${text}`)
  } else if (type === 'file') {
    // 2026-10-23 修（issue #27）：日志也要跟 DSH_HOME 走 ✓
    const p = n.path ?? dshPath('whale-notify.log')
    if (DRY) { console.log(`[dry] 通知文件：${p}（不写入）`); process.exit(0) }
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, JSON.stringify(payload) + '\n')
    console.log(`已写入通知文件：${p}`)
  } else {
    throw new Error(`未知的推送方式：${type}`)
  }
} catch (e) {
  console.error(`通知失败（${type}）：${e.message}`)
  console.error(`原文：${title} / ${String(text).slice(0, 200)}`)
  process.exit(1)
}

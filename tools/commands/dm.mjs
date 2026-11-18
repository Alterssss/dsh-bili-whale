import { HOME } from '../lib/paths.mjs'
import {dmFromDraft} from '../lib/expression-delivery.mjs'
import {lifeConfig} from '../lib/life-config.mjs'
import { guardSend,lifeStore } from '../lib/life-runtime.mjs'
import { uploadPic, dmContent } from '../lib/upload-pic.mjs'
import { guardedFetch as fetch } from '../lib/traffic.mjs'
// 私信（专属通道）—— 2026-10-18 主人定：**三条写死在代码里**
//   ① **一天只锁定 1 个收信人**（防刷量；对同一个人发多少条不限 ✓）
//   ② 只发给配置里的 owner.mid（同一个用户，别处发不出去）
//   ④ **带 --share 时占「分享 3 条/天」的额度**（与评论区 @ 共用同一本账 ✓；不带则只是推送，不占额度）
//   ③ 必须互关（relation.attribute === 6），否则拒发
//
// 为什么写死：私信是 B站 风控最凶的接口（判营销/骚扰），而我们要的只是
// "把一条分享私密地送到主人手里"，不是群发工具 ✗ 所以能力越窄越安全 ✓
//
// 用法:
//   node dm.mjs --msg "…" --dry
//   node dm.mjs --msg "…" --go
//   node dm.mjs --status            （看今天额度 + 互关状态）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../lib/config.mjs'
import { validateShare } from '../lib/share-policy.mjs'
import { gate, record } from '../lib/quota-gate.mjs'
import {exactJson} from '../lib/json-exact.mjs'

// 稳定的设备 ID：只生成一次，之后永远复用 ✓
//   · 存在 ~/.bili-ai/dev_id（0600）
//   · 写坏了/删了会自动重建（重建等于"换了台设备"，但只发生一次 ✓）
function stableDevId() {
  const file = path.join(HOME, '.bili-ai', 'dev_id')
  try {
    const v = fs.readFileSync(file, 'utf8').trim()
    if (/^WEB-[0-9A-F-]{20,}$/i.test(v)) return v
  } catch {}
  const v = 'WEB-' + crypto.randomUUID().toUpperCase()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, v + '\n')
    try { fs.chmodSync(file, 0o600) } catch {}
  } catch (e) { throw new Error('无法保存私信设备 ID，已停止发送：' + e.message) }
  return v
}


const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
    else { opt[argv[i].slice(2)] = v; i += 1 }
  }
}
if(opt.draft){try{dmFromDraft(lifeStore(),opt,config())}catch(e){console.error(e.message);process.exit(2)}}
if(opt['affect-plan']!==undefined&&typeof opt['affect-plan']!=='string'){console.error('心情分享计划ID无效');process.exit(2)}
const AFFECT_PLAN=typeof opt['affect-plan']==='string'?opt['affect-plan']:''
if(AFFECT_PLAN&&(!opt.draft||opt.share)){console.error('心情分享必须使用独立计划草稿');process.exit(2)}
const SHARE = !!opt.share       // ④ 分享型：占「分享 3 条/天」额度（与评论区 @ 共用 ✓）
// 分享型的 target 用正文里的 BV 号（"同一视频 7 天一次"才判得准 ✓）；没有就退回 dm:<mid>
const BV = (String(opt.msg ?? "").match(/BV[0-9A-Za-z]{10}/) ?? [])[0] ?? "";
// ⚠️ SHARE_TARGET 移到 ONLY_TO 定义之后（2026-10-19 修：原先在模块顶层引用 ONLY_TO，触发 TDZ
//    ReferenceError: Cannot access 'ONLY_TO' before initialization → dm.mjs 整个跑不起来，
//    notify 的私信后端也跟着挂 ✗）
const DRY = !!opt.dry
const GO = !!opt.go
const STATUS = !!opt.status
const MSG = String(opt.msg ?? '').trim()
// 2026-10-29（取自 PR #45 / DDDMUC）：--pic <路径> 附带一张图（msg_type=2）
//   dry 阶段只校验路径存在，不上传 ✓（上传本身是写操作）
const PIC = String(opt.pic ?? '').trim()
if (SHARE && !STATUS) {
  try { validateShare(config(), opt) } catch (e) { console.error(e.message); process.exit(2) }
}
const CRED = path.join(HOME, '.bili-ai', 'credentials.json')
const QUOTA = path.join(HOME, '.bili-ai', 'dm-quota.json')
// 2026-10-21：用共用凭据层（trim + 缺字段检查 + 错误码翻译）
//   以前这里直接 JSON.parse 就用：bili_jct 空着也照发 → B站回裸的 code=-111，
//   用户看到"体检全绿 / 能查互关"却发不出去，完全不知道该改什么 ✗
const { loadCred, missingForWrite, explainCode, looksLikeJct } = await import('../lib/cred.mjs')
const cred = loadCred()
const miss = missingForWrite(cred)
if (miss.length) {
  console.error('✗ 凭据不完整，没法发私信：')
  for (const m of miss) console.error('   · 缺 ' + m)
  console.error('  → 设置页把 SESSDATA 和 bili_jct 【两个都】重新粘贴一次并保存 ✓')
  process.exit(2)
}
// 只检查"有没有"不够 —— 截断/粘错的 bili_jct 一样会让 B 站回 -111 ✗
if (!looksLikeJct(cred.bili_jct)) {
  console.error('⚠️ bili_jct 格式不像（长度 ' + String(cred.bili_jct).length + '，B站 目前是 32 位十六进制）')
  console.error('   发送大概率会被拒（code=-111 CSRF 校验失败）—— 建议回设置页重新粘贴一次')
  console.error('   （只读接口不受影响，所以"依赖体检全绿"不代表能发东西 ✗）')
  console.error('')
}
const cfg = config()
const OWNER = String(cfg.owner?.mid ?? '').trim()
const OWNER_NAME = String(cfg.owner?.name ?? '主人')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const H = {
  'user-agent': UA,
  referer: 'https://www.bilibili.com/',
  cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`,
}
const jget = async (u) => (await fetch(u, { headers: H })).json()
const loadQ = () => { try { return JSON.parse(fs.readFileSync(QUOTA, 'utf8')) } catch { return {} } }
const saveQ = (o) => { fs.mkdirSync(path.dirname(QUOTA), { recursive: true }); fs.writeFileSync(QUOTA, JSON.stringify(o, null, 2) + '\n') }
const today = () => new Date().toLocaleDateString('sv-SE')

// ── 写死的三条 ───────────────────────────────────────────────────────
const ONE_TARGET_PER_DAY = true  // ① 一天只锁定 1 个收信人（条数不限 ✓）
const ONLY_TO = OWNER            // ② 只发给主人
const REQUIRE_MUTUAL = true      // ③ 必须互关
// 分享型的 target：优先正文里的 BV（"同一视频 7 天一次"才判得准 ✓），否则退回 dm:<mid>
const targetBV = BV || (String(opt.target ?? "").match(/^(?:BV:)?(BV[0-9A-Za-z]{10})$/) ?? [])[1]
if (SHARE && !STATUS && !targetBV) { console.error("分享需要正文或 --target 中的有效 BV 号"); process.exit(2) }
const SHARE_TARGET = AFFECT_PLAN ? 'affect:'+AFFECT_PLAN : targetBV ? "BV:" + targetBV : "dm:" + ONLY_TO

async function me() {
  const nav = await jget('https://api.bilibili.com/x/web-interface/nav')
  if (!nav.data?.isLogin) { console.error('✗ 未登录（cookie 失效 ✗）'); process.exit(3) }
  return { mid: String(nav.data.mid), uname: nav.data.uname }
}

async function relation(toMid) {
  const j = await jget(`https://api.bilibili.com/x/relation?fid=${toMid}`)
  if (j.code !== 0) return { ok: false, attribute: -1, why: `关系接口 code=${j.code}` }
  return { ok: true, attribute: Number(j.data?.attribute ?? -1), beAttribute: j.data?.be_relation?.attribute == null ? null : Number(j.data.be_relation.attribute) }
}

function relationLines(rel, meInfo) {
  if (!rel.ok) return [rel.why + '，无法确认关注方向，请稍后重试']
  const outgoing = [2, 6].includes(rel.attribute)
  const incoming = rel.attribute === 6 || (rel.beAttribute != null ? [2, 6].includes(rel.beAttribute) : null)
  const lines = [
    `她 → 主人：${outgoing ? '已关注' : '未关注'}`,
    `主人 → 她：${incoming === null ? '未知（请在主人账号确认）' : incoming ? '已关注' : '未关注'}`,
  ]
  if (!outgoing) lines.push(`请登录她的账号，在 https://space.bilibili.com/${ONLY_TO} 手动关注主人。`)
  if (incoming !== true) lines.push(`请登录主人账号，在 https://space.bilibili.com/${meInfo.mid} 确认并手动关注她。`)
  if (rel.attribute === 128 || rel.beAttribute === 128) lines.push('存在拉黑关系，请先检查双方黑名单。')
  return lines
}

async function send(toMid, text, dispatch, pic) {
  const body = new URLSearchParams()
  body.set('msg[sender_uid]', meInfo.mid)
  body.set('msg[receiver_id]', String(toMid))
  body.set('msg[receiver_type]', '1')
  // 2026-10-29（取自 PR #45 / DDDMUC）：带图时 msg_type=2
  body.set('msg[msg_type]', pic ? '2' : '1')
  body.set('msg[msg_status]', '0')
  body.set('msg[timestamp]', String(Math.floor(Date.now() / 1000)))
  // 2026-10-22 修（她自己发现的，很准）：
  //   以前每发一条私信就随机一个新 dev_id ✗ → 风控看到的是
  //   「同一个人在不同设备之间高频切换」→ 小号私信容易被封控 ✗
  //   真浏览器里这个值是【固定的】✓ 所以这里也生成一次、存起来、永久复用。
  //   位置：~/.bili-ai/dev_id（和凭据放一起，换机器时跟着拷 ✓）
  body.set('msg[dev_id]', stableDevId())
  body.set('msg[content]', pic ? dmContent(pic) : JSON.stringify({ content: text }))
  body.set('csrf', String(cred.bili_jct))
  const r = await fetch('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
    method: 'POST',
    waitWriteMs: 180000,
    dispatch,
    headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const j = await exactJson(r).catch(() => ({}))
  return { http: r.status, code: j.code, message: j.message, data: j.data }
}

if (STATUS) {
  const q = loadQ()
  const lockedToday = q.date === today() ? String(q.mid ?? '') : ''
  const rel = await relation(ONLY_TO)
  const meInfo = await me()
  console.log(`账号: ${meInfo.uname}（mid ${meInfo.mid}）`)
  console.log(`专属对象: ${OWNER_NAME}（mid ${ONLY_TO || '未配置'}）`)
  console.log(`今天锁定给: ${lockedToday || '（还没发过）'}${lockedToday && lockedToday !== ONLY_TO ? '  ⚠️ 和当前配置不一致 ✗' : ''}`)
  console.log(`今日已发: ${q.date === today() ? Number(q.count ?? 0) : 0} 条（**条数不限** ✓ 只限收信人 ✓）`)
  console.log(`互关状态: attribute=${rel.attribute} ${rel.attribute === 6 ? '（✓ 互关，可以发）' : '（✗ 不是互关，发不出去）'}`)
  for (const line of relationLines(rel, meInfo)) console.log(line)
  if (!rel.ok) process.exit(3)
  process.exit(0)
}

if (!MSG && !PIC) { console.error('用法: node dm.mjs --msg "…" [--pic 图片路径] --dry|--go；仅发图片可用 --pic 图片路径'); process.exit(2) }

// ── 闸门（写死，不接受参数覆盖）──────────────────────────────────────
if (!OWNER) { console.error('✗ 配置里 owner.mid 为空 —— 私信只发给主人，没配就不发'); process.exit(2) }
if (MSG.length > 300) { console.error(`✗ 私信太长（${MSG.length} > 300 字），退化成刷屏了 ✗`); process.exit(2) }

const meInfo = await me()
if (String(meInfo.mid) === ONLY_TO) {
  // 2026-10-23 修（issue #22）：只报「不能给自己发私信」没有出路 ✗
  console.error('✗ 不能给自己发私信（owner.mid 就是 cookie 这个号）');
  console.error('  私信通道需要【第二个 B 站号】：设 owner.mid 为另一个号，且双方手动互关');
  console.error('  只有一个号时：分享方式选「评论区 @」，推送选桌面通知 / Webhook / 自定义命令 ✓');
  process.exit(2)
}

const rel = await relation(ONLY_TO)
if (!rel.ok) { console.error(`✗ ${rel.why}`); process.exit(3) }
if (REQUIRE_MUTUAL && rel.attribute !== 6) {
  console.error(`✗ 未互关（attribute=${rel.attribute}）—— 私信通道要求双方互相关注 ✓`)
  for (const line of relationLines(rel, meInfo)) console.error(line)
  process.exit(4)
}

const q = loadQ()
const used = q.date === today() ? Number(q.count ?? 0) : 0
// ① 一天只锁定 1 个收信人（条数不限 ✓）：如果今天已经发给过别人 → 拒
if (ONE_TARGET_PER_DAY && q.date === today() && q.mid && String(q.mid) !== ONLY_TO) {
  console.error(`✗ 今天已经锁定给 mid ${q.mid} 了 —— 一天只能锁定 1 个收信人（防刷量 ✗）`)
  process.exit(4)
}

console.log(`[dm] ${meInfo.uname} → ${OWNER_NAME}（mid ${ONLY_TO}）`)
console.log(`  正文 ${MSG.length} 字：${MSG.slice(0, 80)}${MSG.length > 80 ? '…' : ''}`)
console.log(`  互关 ✓  ·  今天第 ${used + 1} 条（条数不限 ✓ 锁定给 ${OWNER_NAME} ✓）`)

if (!GO && !DRY) { console.error('✗ 必须给 --dry 或 --go'); process.exit(2) }

// ④ 分享型先过闸（日上限 / 同一视频 7 天一次 / 评分卡 …由 quota 统一管 ✓）
if (AFFECT_PLAN) {lifeStore().validateAffectPlanRequest(AFFECT_PLAN,String(opt.draft),MSG,cfg)}
if (SHARE || AFFECT_PLAN) {
  const ok = gate({ type: 'dm', target: SHARE_TARGET, auto: true, share: true })
  if (!ok) { console.error('✗ 分享额度不允许（见上面的 [限额闸] 输出）'); process.exit(4) }
}
let imageHash
if (PIC) {
  try {
    const stat = fs.statSync(PIC)
    if (!stat.isFile() || !stat.size) throw Error('图片必须是非空文件')
    imageHash = crypto.createHash('sha256').update(fs.readFileSync(PIC)).digest('hex')
  } catch (error) { console.error('--pic 无法读取：' + error.message); process.exit(2) }
}
const imageText = imageHash ? '[图片 sha256:' + imageHash + ']' : ''
const request = {
  channel:'dm',scene:SHARE?'private-recommendation':'private-reply',target:String(ONLY_TO),
  text:MSG || imageText,auto:SHARE||!!AFFECT_PLAN||!!opt.auto,share:SHARE||!!AFFECT_PLAN,
  video:SHARE_TARGET,draftId:opt.draft,affectPlanId:AFFECT_PLAN||undefined,
  socialJobId:opt['social-job'],
  ...(PIC ? {dmImageHash:imageHash,dmImageOnly:!MSG} : {}),
}
// Preview validation before uploads or creating any pending-send reservation.
await guardSend(request,{dry:true})
if (DRY) {
  if (PIC) console.log(MSG ? '  [dry] 将分别发送文字和图片，各有独立回执；仅计一次分享额度' : '  [dry] 将仅发送图片')
  console.log('  [dry] 预检通过，未上传或发送；正式发送会重新检查额度')
  process.exit(0)
}
let activeGuard
let textReceipt = ''
async function releasePrepared() {
  if (!activeGuard) return
  const pending = activeGuard.store.read().pending[activeGuard.token]
  if (pending?.phase === 'prepared') await activeGuard.store.settle(activeGuard.token,{status:'not-sent',verified:true})
}
async function deliver(guard, text, pic) {
  const result = await send(ONLY_TO,text,invoke=>guard.store.dispatch(guard.token,invoke),pic)
  if (result.http >= 200 && result.http < 300 && result.code === 0) {
    const receipt = result.data?.msg_key ?? result.data?.msg_seqno
    if (receipt == null || !String(receipt)) throw Error('平台接受但未返回消息回执，保留未知发送占位')
    await guard.store.settle(guard.token,{status:'sent',receipt:String(receipt)})
    const quota = loadQ()
    saveQ({date:today(),count:(quota.date===today()?Number(quota.count??0):0)+1,mid:ONLY_TO,at:new Date().toISOString()})
    return String(receipt)
  }
  if (Number.isFinite(result.code) && result.code !== 0) await guard.store.settle(guard.token,{status:'rejected'})
  throw Error('发送失败：HTTP '+result.http+' '+explainCode(result.code))
}
try {
  activeGuard = await guardSend(request)
  let picData = null
  if (PIC) {
    console.log('  正在上传图片；发送将遵守配置的写入冷却')
    picData = await uploadPic(PIC,cred.bili_jct,H)
    if (picData._sha256 !== imageHash) throw Error('预检后图片文件发生变化，请重新预检')
  }
  if (MSG) {
    textReceipt = await deliver(activeGuard,MSG,null)
    console.log('  ✓ 文字已确认，回执 '+textReceipt)
    if (SHARE || AFFECT_PLAN) record({type:'dm',target:SHARE_TARGET,note:MSG.slice(0,40),auto:true,share:true})
    if (PIC) {
      const parent = activeGuard.store.read().events.find(event=>event.kind==='sent'&&event.operationId===activeGuard.token)
      activeGuard = await guardSend({
        channel:'dm',scene:request.scene,target:request.target,text:imageText,
        auto:request.auto,share:false,video:SHARE_TARGET,taskId:parent?.taskId,
        dmImageHash:imageHash,dmAttachmentOf:activeGuard.token,
      })
    }
  }
  if (PIC) {
    console.log('  正在发送图片，可能需要等待配置的私信冷却')
    const receipt = await deliver(activeGuard,'',picData)
    console.log('  ✓ 图片已确认，回执 '+receipt)
  }
  console.log('  ✓ 已发送'+(MSG&&PIC?'文字和图片':'')+'；账本按各自回执记录')
} catch (error) {
  await releasePrepared()
  if (textReceipt) console.error('文字已发送，图片未确认；不要重发正文。明确失败后可用 --pic 单独重试；结果未知时先核查回执。')
  console.error('  ✗ '+error.message)
  process.exitCode = 1
}

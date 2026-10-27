import { exactJson } from './json-exact.mjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { guardedFetch as fetch } from './traffic.mjs'
import { apiGet, signWbi } from './bili-api.mjs'

// ── 2026-10-27 修：主人私信分享的视频被整条丢弃 ────────────────────────────────
// 症状：主人 15:11 和 15:18 各分享了一条视频（msg_type=7 分享卡片），她一条都没收到 ——
//   因为下面 readHistory 的过滤只放行 type===1（纯文本）。她连"主人发过东西"都不知道，
//   还硬着头皮回答了紧跟着的「总结一下」，把宾语猜成了"今天"。连着错三轮。
//
// 现在：① type=7 放行；② 卡片还原成一行可读摘要（标题 + UP）；
//      ③ 卡片里没有 BV 号，拿标题 + UP 去搜索反查一个，查不到就明说"未解析"，
//         绝不把卡片原始 JSON 当成人话丢给她。
const SHARE_TYPE = 7
const SHARE_CACHE = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.bili-ai', 'dm-share-cache.json')
const SHARE_CACHE_MAX = 300
const SHARE_RESOLVE_LIMIT = 3   // 单批最多反查几条，别让分享卡片把一轮请求预算吃掉
const BV_RE = /^BV[0-9A-Za-z]{10}$/

/** 分享卡片（msg_type=7）的 content → 结构化摘要；解析不出来返回 null。 */
export function parseShareCard(content) {
  try {
    const j = JSON.parse(String(content ?? ''))
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null
    // 标题语义不可靠（同为卡片时 title / headline 谁有内容用谁）
    const title = String(j.title ?? j.headline ?? '').replace(/\s+/g, ' ').trim()
    if (!title) return null
    const raw = String(content)
    const found = (raw.match(/BV[0-9A-Za-z]{10}/) ?? [])[0] ?? null
    return {
      cardId: String(j.id ?? '').trim(),
      title,
      author: String(j.author ?? '').trim(),
      authorId: String(j.author_id ?? '').trim(),
      source: Number.isFinite(Number(j.source)) ? Number(j.source) : null,
      bvid: found && BV_RE.test(found) ? found : null,
    }
  } catch { return null }
}

/** 把分享卡片写成一行她看得懂的话。 */
export function shareText(share) {
  if (!share) return '[分享] （卡片内容无法解析）'
  const who = share.author ? `（UP：${share.author}）` : ''
  return `[分享] ${share.title}${who} · ${share.bvid ?? 'BV 未解析，需按标题反查'}`
}

function readShareCache() {
  try {
    const x = JSON.parse(fs.readFileSync(SHARE_CACHE, 'utf8'))
    return x && typeof x === 'object' && !Array.isArray(x) ? x : {}
  } catch { return {} }
}

function writeShareCache(store) {
  try {
    const keys = Object.keys(store)
    if (keys.length > SHARE_CACHE_MAX) {
      keys.sort((a, b) => Number(store[a]?.at ?? 0) - Number(store[b]?.at ?? 0))
      for (const k of keys.slice(0, keys.length - SHARE_CACHE_MAX)) delete store[k]
    }
    fs.mkdirSync(path.dirname(SHARE_CACHE), { recursive: true })
    fs.writeFileSync(SHARE_CACHE, JSON.stringify(store))
  } catch {}
}

const stripTags = (s) => String(s ?? '').replace(/<[^>]+>/g, '')
// 搜索框受不了 emoji / 零宽字符，标题里这些要清掉，否则搜不出来
const cleanKeyword = (s) => stripTags(s)
  .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F\u200D]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()
const squash = (s) => stripTags(s).replace(/\s+/g, '').trim()

/**
 * 分享卡片没有 BV 号，只能拿标题+UP 去 wbi 搜索里认人。
 * 认领顺序：UP 的 mid 对得上且标题一致 → 只有一条 mid 命中 → 标题完全一致 → 认不出就返回 null。
 * 认错比认不出更糟（她会给主人总结错视频），所以宁可返回 null。
 */
export async function resolveShareBv(share, headers, cache = readShareCache()) {
  if (!share) return null
  if (share.bvid) return share.bvid
  const key = share.cardId || `${share.title}|${share.authorId}`
  if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key]?.bvid ?? null

  const keyword = cleanKeyword(share.title).slice(0, 60)
  if (!keyword) { cache[key] = { at: Date.now(), bvid: null }; return null }

  const nav = await apiGet('https://api.bilibili.com/x/web-interface/nav', headers)
  if (nav.code !== 0 || !nav.data?.wbi_img) throw new Error('分享卡片反查失败：WBI 签名密钥不可用')
  const query = signWbi({ search_type: 'video', keyword, page: 1 }, nav.data.wbi_img)
  const response = await fetch(`https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`, { headers })
  const body = await exactJson(response)
  const list = body?.data?.result ?? body?.data?.results ?? []
  if (!Array.isArray(list) || !list.length) { cache[key] = { at: Date.now(), bvid: null }; return null }

  const target = squash(share.title)
  const byMid = share.authorId ? list.filter((r) => String(r.mid ?? '') === share.authorId) : []
  const pick =
    byMid.find((r) => squash(r.title) === target) ??
    (byMid.length === 1 ? byMid[0] : null) ??
    list.find((r) => squash(r.title) === target) ??
    null
  const bvid = pick && BV_RE.test(String(pick.bvid ?? '')) ? String(pick.bvid) : null
  cache[key] = { at: Date.now(), bvid }
  return bvid
}

export function normalizeMessage(row) {
  const ts=Number(row.timestamp),sender=String(row.sender_uid??'')
  if(!Number.isFinite(ts)||ts<0||!sender)throw Error('私信历史消息缺少有效时间或发送者')
  const type=Number(row.msg_type ?? 1)
  let withdrawn=null
  if(type===5){try{const v=JSON.parse(String(row.content));withdrawn=String(v?.msg_key ?? v?.msg_key_str ?? v)}catch{withdrawn=String(row.content??'')}}
  const share=type===SHARE_TYPE?parseShareCard(row.content):null
  let text=String(row.content??'')
  if(type===SHARE_TYPE)text=shareText(share)
  else try {const j=JSON.parse(text);text=String(j.content??j.text??text)} catch {}
  const seq=String(row.msg_seqno??'')
  const key=String(row.msg_key??(seq||crypto.createHash('sha256').update(JSON.stringify([ts,sender,row.content])).digest('hex')))
  return {ts,sender,text,key,type,withdrawn,seq:/^\d+$/.test(seq)?seq:null,share}
}

export async function readHistory(owner,headers,state,{baseline=false}={}) {
  const nav=await apiGet('https://api.bilibili.com/x/web-interface/nav',headers)
  if(nav.code!==0||!nav.data?.wbi_img)throw Error('私信历史签名密钥不可用，保留游标')
  const seen=new Set(),all=[]
  let cursor='0'
  const boundary=Number(state.lastSeen??0),known=new Set(state.lastKeys??(state.lastKey?[state.lastKey]:[]))
  for(let page=0;page<10;page++) {
    const query=signWbi({talker_id:owner,session_type:1,size:30,begin_seqno:cursor},nav.data.wbi_img)
    const response=await fetch('https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?'+query,{headers})
    const body=await exactJson(response)
    if(!response.ok||body.code!==0||!Array.isArray(body.data?.messages))throw Error('私信历史读取失败，保留游标（code='+body.code+'）')
    const rows=body.data.messages.map(normalizeMessage)
    for(const row of rows)if(!seen.has(row.key)){seen.add(row.key);all.push(row)}
    // First run deliberately considers only the newest page; no unbounded historical replay.
    const more=body.data.has_more
    if(baseline||state.lastSeen===undefined||rows.some(r=>r.ts<boundary)||more===0||more==='0'||more===false||(!rows.length&&more===undefined)|| (more===undefined&&rows.length<30))break
    const seqs=rows.filter(r=>r.seq).map(r=>BigInt(r.seq))
    if(!seqs.length)throw Error('私信历史分页缺少序号，保留游标')
    const next=seqs.reduce((a,b)=>a<b?a:b).toString()
    if(next===cursor||(cursor!=='0'&&BigInt(next)>=BigInt(cursor)))throw Error('私信历史分页未前进，保留游标')
    if(page===9)throw Error('私信积压超过单次 10 页，未推进游标；请人工检查')
    cursor=next
  }
  all.sort((a,b)=>a.ts-b.ts||(a.seq&&b.seq?(BigInt(a.seq)<BigInt(b.seq)?-1:BigInt(a.seq)>BigInt(b.seq)?1:0):a.key.localeCompare(b.key)))
  const withdrawn=new Set(all.filter(r=>r.type===5).map(r=>r.withdrawn))
  // type=1 纯文本 + type=7 分享卡片才算"聊天"；撤回/图片/系统通知一律不进聊天流
  const chat=type=>type===1||type===SHARE_TYPE
  const messages=all.filter(r=>chat(r.type)&&!withdrawn.has(r.key)&&r.sender===owner&&(r.ts>boundary||(r.ts===boundary&&!known.has(r.key))))

  // 分享卡片没有 BV，投递前尽量把它认出来（认不出也照常投递，只是标注"未解析"）
  if(messages.some(m=>m.share)) {
    const cache=readShareCache()
    let budget=SHARE_RESOLVE_LIMIT,used=false
    for(const m of messages) {
      if(!m.share)continue
      if(m.share.bvid){m.text=shareText(m.share);continue}
      if(budget<=0)break
      budget-=1
      try {
        const bvid=await resolveShareBv(m.share,headers,cache)
        if(bvid)m.share.bvid=bvid
        m.text=shareText(m.share)
        used=true
      } catch { /* 反查失败不影响"主人发过东西"这件事被投递 */ }
    }
    if(used)writeShareCache(cache)
  }
  return {all,messages}
}

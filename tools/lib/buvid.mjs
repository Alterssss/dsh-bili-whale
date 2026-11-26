import fs from 'node:fs'
import path from 'node:path'
import { HOME } from './paths.mjs'
import { guardedFetch as fetch } from './traffic.mjs'

// buvid3 缺失会让空间动态这类接口直接 412（风控），而它跟登录态无关：
// 匿名就能拿到。这里做三件事：
//   ① 凭据里有就用凭据的
//   ② 没有就读本地缓存 ~/.bili-ai/buvid.json
//   ③ 都没有就向 /x/frontend/finger/spi 取一个并缓存
// 不写回 credentials.json（那是用户手填的文件，不动它）。
const cacheFile = () => path.join(HOME, '.bili-ai', 'buvid.json')

function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'))
    return j && typeof j.buvid3 === 'string' && j.buvid3 ? j.buvid3 : ''
  } catch { return '' }
}

function writeCache(buvid3, buvid4) {
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true })
    fs.writeFileSync(cacheFile(), JSON.stringify({ buvid3, buvid4: buvid4 ?? '', at: new Date().toISOString() }, null, 2) + '\n')
  } catch { /* 缓存写不进去不影响本次请求 */ }
}

export async function fetchBuvid({ timeoutMs = 15000, refresh = false } = {}) {
  if (!refresh) {
    const cached = readCache()
    if (cached) return cached
  }
  const response = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw Error('取 buvid 失败，HTTP ' + response.status)
  const j = await response.json()
  const buvid3 = String(j?.data?.b_3 ?? '')
  if (j?.code !== 0 || !buvid3) throw Error('取 buvid 失败：code=' + (j?.code ?? '?') + ' ' + (j?.message ?? ''))
  writeCache(buvid3, j?.data?.b_4)
  return buvid3
}

// 优先用凭据里的；没有就自动取一个（并缓存）。取不到返回空串，让调用方决定要不要继续。
export async function ensureBuvid(fromCredential, options = {}) {
  const given = String(fromCredential ?? '').trim()
  if (given) return given
  try { return await fetchBuvid(options) } catch { return '' }
}

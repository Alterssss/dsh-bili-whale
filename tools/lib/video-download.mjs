import fs from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { guardedFetch as fetch } from './traffic.mjs'

export async function downloadVideo(source, file, {headers, fetch:transport=fetch, timeoutMs=60000}={}) {
  const candidates = [...new Set([source.url, ...(source.backup_url ?? [])].filter(Boolean))]
  const expected = Number(source.size) || 0
  let attempts = 0
  for (const url of candidates) {
    fs.rmSync(file, {force:true})
    for (let retry=0; retry<3; retry++) {
      attempts++
      const have = fs.existsSync(file) ? fs.statSync(file).size : 0
      let response
      try {
        response = await transport(url, {
          headers:{...headers, range:'bytes=' + have + '-'},
          signal:AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok || !response.body) throw Error('下载响应无效')
        let total = expected
        if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
          if (!range || Number(range[1]) !== have || Number(range[2]) < have ||
              Number(range[2]) >= Number(range[3]) || (expected && Number(range[3]) !== expected)) {
            throw Error('续传范围不一致')
          }
          total = Number(range[3])
        } else if (response.status !== 200) throw Error('不支持的下载响应')
        else if (!total) total = Number(response.headers.get('content-length')) || 0
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file, {flags:response.status===206 && have>0?'a':'w'}))
        const size = fs.statSync(file).size
        if (size > 0 && (!total || size === total)) return {size, attempts}
        if (total && size > total) fs.rmSync(file, {force:true})
      } catch {
        // A partial stream can be resumed only after the next response validates its range.
      } finally {
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
      }
    }
  }
  fs.rmSync(file, {force:true})
  throw Error('视频下载失败，已尝试 ' + candidates.length + ' 个接口提供的地址；未获得完整文件')
}

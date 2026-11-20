// 一轮活动的文字小结（给主人看的清单，确定性生成，不依赖模型）
// 输入：事件数组（life store events），输出：一段可直接 notify 的文本，或 null（没有可说的）
const BV = /BV[0-9A-Za-z]{10}/

function firstLine(text, max = 42) {
  const line = String(text ?? '').replace(/\r/g, '').split('\n').map((x) => x.trim()).find((x) => x && !/^\[P\d]/.test(x) && !/^\d{2}:\d{2}/.test(x)) ?? ''
  const clean = line.replace(/^\[[^\]]*]\s*/, '')
  return clean.length > max ? clean.slice(0, max) + '…' : clean
}

export function buildRoundSummary(events = [], { title = '', limit = 8 } = {}) {
  const seen = new Map()
  const comments = []
  for (const e of events) {
    if (!e) continue
    if (e.kind === 'video-read') {
      const bv = String(e.target ?? '').match(BV)?.[0]
      if (!bv || seen.has(bv)) continue
      seen.set(bv, firstLine(e.text))
    } else if (e.kind === 'sent' && e.channel === 'comment') {
      const text = String(e.text ?? '').trim()
      if (text) comments.push(text.length > 60 ? text.slice(0, 60) + '…' : text)
    }
  }
  const videos = [...seen.entries()].slice(0, limit)
  if (!videos.length && !comments.length) return null
  const lines = []
  if (title) lines.push(title)
  if (videos.length) {
    lines.push(`看了 ${videos.length} 条：`)
    for (const [bv, name] of videos) {
      lines.push(`· ${name || '（无标题）'}`)
      lines.push(`  https://www.bilibili.com/video/${bv}`)
    }
  }
  if (comments.length) {
    lines.push(`说了 ${comments.length} 句：`)
    for (const c of comments.slice(0, 4)) lines.push(`· ${c}`)
  }
  return lines.join('\n')
}

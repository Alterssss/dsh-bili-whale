// video-entry.mjs —— LOCAL：一条视频一个对象，字段跟着条目走
// 2026-10-30：不要零散变量，把要用的字段都装进对象里，后面写日记直接从对象取。
export class VideoItem {
  constructor(o = {}) {
    this.bv = String(o.bv ?? '')
    this.title = String(o.title ?? '').replace(/<[^>]+>/g, '')
    this.play = Number(o.play ?? 0)
    this.dm = Number(o.dm ?? 0)
    this.durSec = toSeconds(o.dur)
    this.up = String(o.up ?? '')
    this.pubdate = String(o.pubdate ?? '')
    this.region = String(o.region ?? '')   // 分区名（来自搜索结果的 typename）
    this.kw = String(o.kw ?? '')
    this.window = o.window ?? null        // 数字（天）或 '热搜'
    this.src = o.src ?? '搜索'
    this.frameOk = o.frameOk ?? null      // true/false/null(未知)
    this.picked = o.picked ?? true
  }

  static fromSearch(r, meta = {}) {
    return new VideoItem({ ...r, ...meta })
  }

  /** 来源标签，例如 "3天·新番" / "热搜·排行" */
  get srcLabel() {
    if (this.window === '热搜') return `热搜·${this.kw}`
    return `${this.window}天·${this.kw}`
  }

  /** 复制一份并打上来源标签（搜索词 + 窗口天数） */
  withPool(kw, days) {
    const c = new VideoItem(this.toJSON())
    c.kw = kw
    c.window = days
    return c
  }

  get dur() { return fmtDur(this.durSec) }
  get playText() { return this.play >= 10000 ? `${(this.play / 10000).toFixed(1)} 万` : String(this.play) }

  /** 日记表格的一行（六列：时间 / BV / 标题 / 播放·弹幕·发布·时长 / UP + 来源 / 备注） */
  toRow(at, note = '') {
    const up = this.up || '?'
    const dur = this.dur || '-'
    const memo = note || (this.frameOk === false ? '抽帧失败' : '')
    return `| ${at} | ${this.bv} | ${this.title.replace(/\|/g, '/').slice(0, 46)} | 播放 ${this.playText} · 弹幕 ${this.dm} · ${this.pubdate} · ${dur} | ${up}。〔${this.srcLabel}〕 | ${memo} |`
  }

  toJSON() {
    return {
      bv: this.bv, title: this.title, play: this.play, dm: this.dm,
      dur: this.dur, up: this.up, pubdate: this.pubdate, region: this.region,
      parts: this.parts, totalPlay: this.totalPlay,
      kw: this.kw, window: this.window, src: this.src, frameOk: this.frameOk,
    }
  }
}

/** "147" / "147s" / "02:27" / "1:02:03" → 秒 */
export function toSeconds(v) {
  if (v == null) return 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const s = String(v).trim()
  if (!s) return 0
  if (/^\d+$/.test(s)) return Number(s)
  const parts = s.split(':').map(Number)
  if (parts.some(Number.isNaN)) return 0
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

/** 秒 → "12:34" / "1:02:03" */
export function fmtDur(sec) {
  const n = Math.round(Number(sec) || 0)
  if (!n) return ''
  const h = Math.floor(n / 3600)
  const m = Math.floor((n % 3600) / 60)
  const s = n % 60
  const p = (x) => String(x).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`
}

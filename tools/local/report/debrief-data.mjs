/**
 * debrief 的数据层：把 debrief.mjs 采集到的原始结果整理成一个**纯数据** report 对象。
 *
 * 这一层只做"整理"：
 *   · 不发请求、不读文件、不写文件、不打印；
 *   · 不做排版（缩进、补齐、分隔符、`×2`、`🔥` 这类都在渲染器里）；
 *   · 输出对象可以直接 JSON.stringify，交给别的渲染器用。
 *
 * 为什么拆出来：debrief 原来一边取数一边 console.log，想换个输出形态（JSON、简报）
 * 就只能复制整个脚本。现在取数 → report → renderer，渲染器只认 report，不认网络。
 */

/** report 结构版本：以后字段改名时靠它判断，别用日期当版本号。 */
export const REPORT_SCHEMA = 'bw.debrief.report/1'

/**
 * 把采集到的原始数据整理成 report。
 *
 * @param {object} input
 * @param {string} input.bvid              视频号
 * @param {object} input.options           本次运行的参数（bucket/top/grid/comments/no-frames/substrip/score）
 * @param {object} input.meta              元信息（原始 view.data 里用到的字段）
 * @param {object} input.cover             封面：{ ok: true, file } | { ok: false, error }
 * @param {object} input.subtitles         字幕：{ entries, file } | { entries: [] }
 * @param {object} input.danmaku           弹幕：{ entries, claimed } | null
 * @param {object} input.comments          热评：{ code, replies } | { error }
 * @param {object} input.frames            画面：{ enabled, error, toolLines, sheet, strip }
 * @param {boolean} input.score            --score 评分卡开关（文本在渲染器里）
 * @returns {object} report
 */
export function buildDebriefReport(input = {}) {
  const options = {
    bucketSeconds: 30,
    topN: 5,
    grid: '3x3',
    commentCount: 8,
    noFrames: false,
    substrip: false,
    score: false,
    ...(input.options ?? {}),
  }
  const subtitleEntries = Array.isArray(input.subtitles?.entries) ? input.subtitles.entries : []
  return {
    schema: REPORT_SCHEMA,
    bvid: String(input.bvid ?? ''),
    options,
    meta: normalizeMeta(input.meta),
    cover: normalizeCover(input.cover),
    subtitles: normalizeSubtitles(input.subtitles),
    danmaku: normalizeDanmaku(input.danmaku, {
      subtitles: subtitleEntries,
      bucketSeconds: Number(options.bucketSeconds),
      topN: Number(options.topN),
    }),
    comments: normalizeComments(input.comments),
    frames: normalizeFrames(input.frames),
    score: Boolean(input.score ?? options.score),
  }
}

/** 从抽帧子进程的 stdout 里挑出要原样打出去的行，并取出 SHEET 路径（--substrip 要用）。 */
export function parseFrameOutput(stdout) {
  const text = String(stdout ?? '')
  const toolLines = []
  for (const line of text.split('\n')) {
    if (/^(SHEET|SUBS|实际画质|取帧方式)/.test(line)) toolLines.push(line)
  }
  const sheet = (text.split('\n').find((l) => l.startsWith('SHEET:')) || '').slice(6).trim() || null
  return { toolLines, sheet }
}

function normalizeMeta(m) {
  const meta = m ?? {}
  return {
    title: meta.title,
    owner: meta.owner,
    tname: meta.tname ?? null,
    // 上游是 new Date(d.pubdate * 1000).toLocaleDateString('zh-CN')，这里只换算，格式化留给渲染器
    pubdateMs: Number(meta.pubdate) * 1000,
    durSeconds: Number(meta.durSeconds ?? 0),
    desc: meta.desc ?? null,
    stat: {
      view: meta.stat?.view,
      like: meta.stat?.like,
      favorite: meta.stat?.favorite,
      coin: meta.stat?.coin,
      danmaku: meta.stat?.danmaku,
      reply: meta.stat?.reply,
    },
  }
}

function normalizeCover(c) {
  if (!c) return { ok: false, error: '未知错误' }
  if (c.ok) return { ok: true, file: c.file ?? null }
  return { ok: false, error: String(c.error ?? '未知错误') }
}

function normalizeSubtitles(s) {
  const entries = Array.isArray(s?.entries) ? s.entries : []
  if (!entries.length) return { mode: 'none' }
  const last = entries[entries.length - 1]
  return {
    mode: 'single',
    file: s.file ?? null,
    lineCount: entries.length,
    fromSeconds: Number(entries[0].from),
    // 上游：fmt(body.at(-1).to ?? body.at(-1).from)
    toSeconds: Number(last.to ?? last.from),
  }
}

function normalizeDanmaku(d, { subtitles, bucketSeconds, topN }) {
  const entries = Array.isArray(d?.entries) ? d.entries : []
  if (!entries.length) return { available: false }
  const count = entries.length
  const claimed = Number(d.claimed ?? 0)

  // 刷屏波：归一化后聚类，占全片 >30% 且 ≥20 条的算刷屏（实测仪式弹幕连带变体能吃掉 87%）
  const norm = (s) => s.replace(/[\s\p{P}\p{S}]/gu, '')
  const keyCounts = {}
  for (const x of entries) {
    // ⚠️ 实测漏检：整条都是标点/表情的刷屏（如「?」×500）归一化后变成空串 → 直接跳过就漏了 ✗
    //    所以空串单独记成一个键，让下面的 >30% 规则一样生效。
    const k = norm(x.text) || '<纯符号>'
    keyCounts[k] = (keyCounts[k] ?? 0) + 1
  }
  const spamKeys = Object.entries(keyCounts).filter(([, c]) => c >= 20 && c / count > 0.3).map(([k]) => k)
  const isSpam = (text) => { const k = norm(text); return k.length === 0 || spamKeys.some((s) => k.includes(s)) }
  const spamHits = entries.filter((x) => isSpam(x.text)).length

  const buckets = new Map()
  for (const x of entries) {
    const k = Math.floor(x.t / bucketSeconds) * bucketSeconds
    if (!buckets.has(k)) buckets.set(k, { raw: [], real: [] })
    const b = buckets.get(k)
    b.raw.push(x)
    if (!isSpam(x.text)) b.real.push(x)
  }
  // ⚠️ 峰值按**剔刷屏后**排序：否则开场仪式弹幕会把真正的名场面挤下去
  const realTotal = [...buckets.values()].reduce((n, b) => n + b.real.length, 0)
  const avgReal = realTotal / Math.max(1, buckets.size)
  const peaks = [...buckets.entries()]
    .sort((a, b) => b[1].real.length - a[1].real.length)
    .slice(0, topN)
    .map(([k, b]) => {
      const counts = {}
      for (const x of b.real) counts[x.text] = (counts[x.text] ?? 0) + 1
      const top = Object.entries(counts).sort((a, b2) => b2[1] - a[1]).slice(0, 6)
        .map(([text, c]) => ({ text, count: c }))
      return {
        start: k,
        end: k + bucketSeconds,
        realCount: b.real.length,
        rawCount: b.raw.length,
        // 对齐到字幕时间轴：取桶中点那一行字幕
        subtitleLine: subtitleAt(subtitles, k + bucketSeconds / 2),
        top,
        // 「🔥」的判据：有效条数 ≥ 平均 1.5 倍。放在数据层，渲染器只管挑字符。
        hot: b.real.length >= avgReal * 1.5,
      }
    })

  const all = {}
  for (const x of entries) if (!isSpam(x.text) && x.text.length >= 2) all[x.text] = (all[x.text] ?? 0) + 1
  const topAll = Object.entries(all).sort((a, b2) => b2[1] - a[1]).slice(0, 12)
    .map(([text, c]) => ({ text, count: c }))

  return {
    available: true,
    count,
    claimed,
    // XML 只给采样集（标称 26 万条实测只给 600 条）→ 采样比要一起带出去，别让人当全集看
    sampleRatio: claimed ? Math.max(1, Math.round(claimed / count)) : null,
    // 没刷屏波时是 null，渲染器据此决定打不打那两行
    spam: spamKeys.length
      ? { hits: spamHits, keys: spamKeys.map((k) => ({ normalized: k, count: keyCounts[k] })) }
      : null,
    bucketCount: buckets.size,
    realTotal,
    avgReal,
    peaks,
    topAll,
  }
}

/** 取 t 秒处的字幕行；没字幕返回 null。语义与重构前的 subAt 一致。 */
function subtitleAt(entries, t) {
  if (!entries.length) return null
  let best = null
  for (const l of entries) {
    if (l.from <= t && t <= (l.to ?? l.from + 3)) return l.content
    if (l.from <= t && (!best || l.from > best.from)) best = l
  }
  return best?.content ?? null
}

function normalizeComments(c) {
  const src = c ?? {}
  const replies = Array.isArray(src.replies) ? src.replies : []
  return {
    ok: !src.error,
    // ⚠️ code 原样保留（可能是 undefined）：旧输出是 `code=${rep?.code}`，别在这里补默认值
    code: src.code,
    error: src.error ? String(src.error) : null,
    items: replies.map((r) => ({
      like: r.like,
      rcount: r.rcount ?? 0,
      uname: r.member?.uname,
      // 旧输出在这里做换行压平和 160 字截断；属于数据整理，放这一层
      text: String(r.content?.message ?? '').replace(/\n+/g, ' ').slice(0, 160),
    })),
  }
}

function normalizeFrames(f) {
  const src = f ?? {}
  if (!src.enabled) return { enabled: false }
  const strip = src.strip ?? { enabled: false }
  return {
    enabled: true,
    error: src.error ? String(src.error) : null,
    toolLines: (Array.isArray(src.toolLines) ? src.toolLines : []).map((l) => String(l)),
    sheet: src.sheet ?? null,
    strip: strip.enabled
      ? {
        enabled: true,
        error: strip.error ? String(strip.error) : null,
        noMp4: Boolean(strip.noMp4),
        outPng: strip.outPng ?? null,
        everySeconds: Number(strip.everySeconds ?? 7),
        rows: Number(strip.rows ?? 0),
      }
      : { enabled: false },
  }
}

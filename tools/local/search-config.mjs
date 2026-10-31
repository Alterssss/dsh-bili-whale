import { cv } from './bw-config.mjs'
// search-config.mjs —— LOCAL：找片策略的唯一配置源
// 搜索侧的时间条件要统一，方便修改和整理；
//   热搜/排行不做搜索侧时间过滤，改由"筛查侧"按同一套天数筛。
//
// 改这一处，discover / round / 筛查 全都跟着变。

export const CONFIG = {
  // 搜索侧时间窗梯次（单位天），3 → 7 → 30 → 365 → 2年 → 3年
  // 每一轮凑够配额就停，不够才往下一个窗口放宽
  windows: [3, 7, 30, 365, 730, 1095],

  // 筛选侧时间梯次（单位天），同一套规矩：7 → 30 → 365 → 2年 → 3年
  // 用在热搜/排行这类"没有搜索侧时间过滤"的来源上：先只要 7 天内的，不够再放宽
  filterWindows: [7, 30, 365, 730, 1095],

  // 兼容旧名字（其他地方还引用 maxAgeDays 的话，取筛选侧的最后一个 = 3 年）
  maxAgeDays: 1095,

  // 质量下限（两条都要满足）
  minPlay: cv('minPlay'),
  minDm: cv('minDm'),

  // 每轮至少要有几条"热搜来源"的片子（这里 2026-10-29 定，随时可改）
  //   只有在 热搜可选数 ≥ 1 且 N > 兴趣词数 时才启用；
  //   热搜实际不够这么多，就保持实际数量，缺口用兴趣视频随机补回，总数仍是 N
  minHotCount: cv('minHotCount'),

  // 抽帧时每段下多少秒（这里 2026-10-29 定：10 秒）
  //   段越长，能在更大的范围里挑"画面变化"的那一帧；10 秒大约占全片 9×10 秒
  frameSegmentSeconds: 10,

  // 分段下载的并发数（"为什么不能并行" → 可以，默认 3 路）
  //   调大更快，但对 CDN 的连接数上去了；9 是最激进，3 比较稳
  segmentConcurrency: cv('segmentConcurrency'),

  // 老搜索（feed.mjs）的分组上限：命中组 / 无命中组都按 ceil(N ÷ 这个数)
  //   老路径也要跟配置走，别在代码里写死
  legacyPerDivisor: 2,

  // 合集字幕采样：分P 超过这个数，就只抽这么多集（第一集 + 等间隔）
  //   默认 4；改这里即可
  subsSampleMax: cv('subsSampleMax'),

  // 单次请求的超时（毫秒）——每次请求 20 秒，不再设视频级总超时
  //   处理数据本身不耗时，慢的都是等接口；每请求兜底就够，外面再套总超时只会误杀
  requestTimeoutMs: 20000,

  // 失败后的重试间隔（秒）—— 统一 5 秒，改这里全链路生效
  retryDelaySec: cv('retryDelaySec'),

  // 每个兴趣词先攒多少候选，再从里面随机抽
  perKeywordPool: 12,
}

export const daysAgo = (isoDate) => {
  if (!isoDate) return Infinity
  const t = new Date(isoDate).getTime()
  if (!Number.isFinite(t)) return Infinity
  return (Date.now() - t) / 86400000
}

export const withinMaxAge = (item) => daysAgo(item?.pubdate) <= CONFIG.maxAgeDays

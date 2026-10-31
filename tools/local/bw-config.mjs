// bw-config.mjs —— 养鱼（bili-whale）自己的配置文件。
//   规范（）：
//     · 字段名 = 项目简称 + cfg + 字段名 → bw_cfg_xxx
//     · 每个字段必须有注释，写清「控制什么」「调大 / 调小分别会怎样」
//     · 不跟别的项目共用一份配置
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const OVERRIDE = path.join(HOME, '.dsh/bili-whale.config.json')

export const bw_cfg = {
  // ─── 找片阈值 ────────────────────────────────────────
  // 通过筛选的最低播放量。调高 → 只剩热门，冷门好片进不来；调低 → 几百播放的混进来。
  bw_cfg_minPlay: 1000,
  // 通过筛选的最低弹幕数。调高 → 只看有人讨论的；调低 → 没人看的也进来。
  bw_cfg_minDm: 10,
  // 每轮热搜/热门保底几条。调高 → 更贴大盘热点；调低 → 更贴兴趣，但可能重复。
  bw_cfg_minHotCount: 2,
  // 每个兴趣词先攒多少候选再随机抽。调高 → 更随机，但请求更多。
  bw_cfg_perKeywordPool: 12,
  // 搜索侧时间窗梯次（天）。上一档凑不够才放宽到下一档。
  bw_cfg_windows: [3, 7, 30, 365, 730, 1095],
  // 筛选侧时间窗梯次（天）。比搜索侧更严，防止老片混进来。
  bw_cfg_filterWindows: [7, 30, 365, 730, 1095],
  // 最老能接受多少天以前的视频。调大 → 能捞到老片；调小 → 只要新的。
  bw_cfg_maxAgeDays: 1095,
  // 老 feed 兜底时每个词取几条（总数 ÷ 它）。
  bw_cfg_legacyPerDivisor: 2,

  // 每轮最多深读几条。数字 = 上限（取 min(它, 筛出数)）；字符串 'all' = 全读。
  //   调大 → 一轮读得更多、更慢更费请求；调小 → 快，但可能漏掉好片。
  //   默认 3 是沿用上游唤醒词里「挑 2–3 条深读」的上限。
  bw_cfg_deepReadMax: 3,   // 仓库默认 3；本地想全读就在配置里写 "all"

  // ─── 合集处理 ────────────────────────────────────────
  // 分P 数大于它就判定为「合集」。
  bw_cfg_multiPartThreshold: 3,
  // 一轮里允许几个合集，超过就筛掉后面的。调到 0 = 只要单集。
  bw_cfg_multiPartPerRound: 1,
  // 合集字幕采样几集（第 1 集 + 等间隔）。调大 → 读得全但更慢。
  bw_cfg_subsSampleMax: 4,

  // ─── 超时与重试 ──────────────────────────────────────
  // 单次 HTTP 请求的超时。只管一次请求，不管整条视频。
  bw_cfg_requestTimeoutMs: 20000,
  // 失败后等几秒重试一次；再失败就放弃。
  bw_cfg_retryDelaySec: 5,
  // 抽帧每一段的超时。超了就跳过这一段。
  bw_cfg_segTimeoutMs: 20000,
  // 单集时长小于它的视频，抽帧改串行（短片的九段挤在一起，并发只会互相拖）。
  bw_cfg_shortSerialSec: 300,
  // 抽帧时每段取几秒的区间。
  bw_cfg_segmentSeconds: 10,
  // 抽帧并发几路。调到 9 也不会更快（受 CDN 限速），但更容易触发风控。
  bw_cfg_segmentConcurrency: 3,

  // ─── 相关推荐补采 ────────────────────────────────────
  // 相关视频的播放量门槛，低于它的不采。
  bw_cfg_relatedMinPlay: 20000,
  // 每个源视频最多从相关推荐里取几条。
  bw_cfg_relatedTakeMax: 5,

  // ─── 标签与分区 ──────────────────────────────────────
  // 标签保留门槛：count 低于它的，在月度清理时删掉。
  bw_cfg_tagMinKeep: 5,
  // 多久清理一次标签（天）。不是每次采集都清。
  bw_cfg_tagPruneDays: 30,
  // 每天报统计时，只报次数大于它的条目。
  bw_cfg_tagMinCountTop: 5,
  // 总览里每条视频最多显示几个 tag。
  bw_cfg_overviewTagMax: 3,

  // 是否把「读到第几步」的进度写到 stderr。
  //   开：终端能看见 [3/6] 字幕… 这类进度（stdout 仍然只有正式报告，可重定向、可对比）
  //   关：全程静默，只在最后一次性输出（仓库默认关 —— 别人跑起来更干净）
  bw_cfg_progressOnStderr: false,

  // ─── 输出与额度 ──────────────────────────────────────
  // 每小时读取预算（本地自设闸门，不是 B站 限制）。
  bw_cfg_readHourly: 1500,
  // 每天读取预算。
  bw_cfg_readDaily: 8000,
  // 分享/推荐的打分门槛（满分 20），低于它不分享。
  bw_cfg_shareMinScore: 13,
  // 单条私信字数上限（B站 硬上限 300，留余量）。
  bw_cfg_dmMaxChars: 280,
  // 总览一条私信放几条视频，超了就拆多条（9 条 → 5+4）。
  bw_cfg_overviewPerMessage: 5,
}

// 短名读取：cv('minPlay') → bw_cfg.bw_cfg_minPlay
// 2026-10-31：优先读 ~/.dsh/bili-whale.config.json 里的同名覆盖 ——
//   这样仓库里保持通用默认值，本地想全读/开耗时只改配置，不用改代码、也不用每次合代码再改回来。
export const cv = (name) => {
  const key = 'bw_cfg_' + name
  try {
    const user = JSON.parse(fs.readFileSync(OVERRIDE, 'utf8'))
    if (user[key] !== undefined) return user[key]
  } catch {}
  return bw_cfg[key]
}

/** 允许 ~/.dsh/bili-whale.config.json 里的同名键覆盖默认值（方便不改代码调参） */
export function bwConfig() {
  const out = { ...bw_cfg }
  try {
    const user = JSON.parse(fs.readFileSync(OVERRIDE, 'utf8'))
    for (const k of Object.keys(out)) {
      if (user[k] !== undefined) out[k] = user[k]
    }
  } catch {}
  return out
}

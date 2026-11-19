import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DSH_HOME } from './paths.mjs'

export const NIGHT_DEFAULTS = Object.freeze({ windows: [{ start: '20:00', end: '24:00', wakes: 1 }], skipChance: 0.3, minGapMin: 10, maxVideos: 5 })

// 合并规则（第 7 项）：新配置优先；旧文件只补齐"新配置里没有的字段"，
// 显式关闭（false / 0 / 空数组）必须保留，不能被旧值覆盖。
export function mergeNightConfig({ user = {}, legacy = {}, defaults = NIGHT_DEFAULTS } = {}) {
  const merged = { ...defaults, ...user }
  let migrated = false
  for (const [key, value] of Object.entries(legacy ?? {})) {
    if (value === undefined) continue
    if (!Object.prototype.hasOwnProperty.call(user, key)) {
      merged[key] = value
      migrated = true
    }
  }
  return { merged, migrated }
}

const configFile = (home) => process.env.BILI_WHALE_CONFIG || path.join(home, 'bili-whale.config.json')

// 迁移一次：先备份原文件，再原子替换；成功后写 migratedFromLegacy，
// 从此不再从 whale-night.config.json 叠加，避免旧值又把新设置盖回去。
function migrateToUserFile(home, whole, night) {
  const file = configFile(home)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-night-${stamp}`)
  } catch { return false }
  const next = { ...whole, night: { ...night, migratedFromLegacy: true } }
  const tmp = `${file}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    try { fs.rmSync(tmp, { force: true }) } catch {}
    return false
  }
}

export function readNightConfig(home = DSH_HOME) {
  let whole = {}, user = {}, legacy = {}
  try {
    whole = JSON.parse(fs.readFileSync(configFile(home), 'utf8'))
    user = whole.night ?? {}
  } catch {}
  try {
    legacy = JSON.parse(fs.readFileSync(path.join(home, 'whale-night.config.json'), 'utf8'))
  } catch {}

  // 已经迁移过 / 新配置里已有标记：只认新配置。
  if (user.migratedFromLegacy === true) {
    const { merged } = mergeNightConfig({ user, legacy: {} })
    return merged
  }
  const { merged, migrated } = mergeNightConfig({ user, legacy })
  if (migrated && Object.keys(user).length >= 0) {
    // 只有确实从旧文件补了字段才落盘；失败不影响本次返回值（下次再试）。
    if (migrateToUserFile(home, whole, merged)) return { ...merged, migratedFromLegacy: true }
  }
  return merged
}

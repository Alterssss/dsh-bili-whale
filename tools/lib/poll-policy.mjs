// 正常空闲保持基础间隔；仅连续失败退避，最长 15 分钟（保留更长的自定义间隔）。
// 2026-10-30 改：下限 15s → 5s。主人要求私信「像正常聊天一样」，15 秒最低档太慢。
//   ⚠️ 读预算（readHourly 600 / readDaily 3000）仍在 traffic.mjs 里把关，
//   5 秒一轮 ≈ 720 次/时 ≈ 17280 次/天，但真正发请求前会被读预算挡住 ✓
export function pollDelay(baseSeconds, failureRounds = 0) {
  const value = Number(baseSeconds)
  const base = Number.isFinite(value) && value > 0 ? Math.max(5, value) : 60
  const rounds = Number.isFinite(failureRounds) ? Math.min(8, Math.max(0, failureRounds)) : 0
  return Math.min(Math.max(base, 900), base * 2 ** rounds) * 1000
}

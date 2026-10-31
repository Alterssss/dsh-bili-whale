// feedfill.mjs —— LOCAL：feed 的补齐逻辑（上游没有这个目录，升级不会碰）
// 为什么要有：上游把「同一命中组最多 PER 条」和「无命中组最多 3 条」写死，
//   候选池再大也只吐四五条，--n 20 形同虚设。
//
// 2026-10-29 加下限（实测踩到）：只按分数补，会把播放个位数的新片也捞上来
//   实测那轮十条里补进四条，播放 0–7。所以补齐时加一道质量下限：
//   播放 ≥ 1000 或 弹幕 ≥ 10 才算"像样"，两边都不行的不补进清单。
//   这条下限**只作用于补齐这一步**，不动他原来的多样性限流和三关筛查。
const MIN_PLAY = 1000
const MIN_DM = 10

// 2026-10-29：两条都要（且）。播放 ≥ 1000 且 弹幕 ≥ 10，只有一边达标的不要。
export const looksReal = (x) => Number(x?.play ?? 0) >= MIN_PLAY && Number(x?.dm ?? 0) >= MIN_DM

// uniq   —— 洗完、排好序的候选
// picked —— 已经通过多样性限流的那些
// n      —— 目标条数
export function fillToN(uniq, picked, n) {
  if (!Array.isArray(uniq) || !Array.isArray(picked)) return []
  const lack = Number(n) - picked.length
  if (!(lack > 0)) return []
  const chosen = new Set(picked.map((x) => x.bv))
  return uniq
    .filter((x) => !chosen.has(x.bv))
    .filter(looksReal)
    .slice(0, lack)
}

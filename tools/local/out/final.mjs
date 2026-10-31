// out/final.mjs —— LOCAL：「该写【给他的信】」草稿要素 + 「还差两步」提示（round:done 订阅者，order 40 / 60）
import { hooks } from '../hooks.mjs'

// 2026-10-30 改：自动推"BV 清单"不及格（没有观后感）。这里不再自动发，
//   改为打印一份草稿要素，由我自己写【给他的信】（总评一条 + 推荐@一条）。
hooks.on('round:done', ({ items, N, LANDING, TIMING_ON }) => {
  console.log('[该写【给他的信】（草稿要素）]')
  // 抽帧失败条数按 frameOk === false 数；round 会拿 batch-debrief 的 frameFailures 回填这个字段
  //   （修 a：不回填的话 items 上永远是 null，这里恒为 0）
  if (TIMING_ON) console.log(`  落点 ${LANDING} · 看 ${items.slice(0, N).length} 条 · 抽帧失败 ${items.filter((r) => r.frameOk === false).length} 条`)
  console.log('  → 总评一条：挑这轮最想说的那件事，写观后感（不是列清单）')
  console.log('  → 推荐一条：挑第一名，走 comment --share 或 dm --share，带标题+链接')
}, 40)

// 2026-10-30：notify 和分享都得我自己写文案，脚本只能提醒（不然会像这两天一样一条都不推）
hooks.on('round:done', () => {
  console.log('[还差两步 · 要我自己做]')
  console.log('  1) 该写 notify：把「给他的信」里最想说的那段推给他（node bili.mjs notify "…"）')
  console.log('  2) 该看分享：按标尺打分挑第一名，值得才分享（dm --share --target <BV> …）')
}, 60)

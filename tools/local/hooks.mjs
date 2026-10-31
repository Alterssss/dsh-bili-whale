// hooks.mjs —— LOCAL：极简事件总线，输出块从 round.mjs 拆出来后在这里自注册。
// 2026-10-31：round.mjs 只管流程（找片 → 深读 → 采标签 → 收尾），
//   输出按块放 out/，各自 hooks.on('round:done', …)，由流程末尾一次 hooks.run 触发。
// order 小的先跑：有跨文件交错的段落（相关补采 → 给他的信 → 分区 → 还差两步）靠它保持原行序。
// 单个 handler 抛错不影响后面的 handler，只打一行提示。
const bus = new Map()

export const hooks = {
  on(event, handler, order = 0) {
    const list = bus.get(event) ?? []
    list.push({ handler, order })
    bus.set(event, list)
  },
  async run(event, ctx) {
    const list = [...(bus.get(event) ?? [])].sort((a, b) => a.order - b.order)
    for (const { handler } of list) {
      try {
        await handler(ctx)
      } catch (e) {
        const msg = String(e?.message ?? e).split(/\r?\n/)[0].slice(0, 120)
        console.error('（输出块出错：' + msg + '）')
      }
    }
  },
}

/**
 * node 运行时解析（index.js 与 scheduler.js 共用）
 *
 * 为什么单独抽出来：这段逻辑原先在两个文件里各有一份完全相同的实现，
 * 改一处容易漏另一处。这里收成一份。
 *
 * 注意：在 DSH Desktop 里 process.execPath 是 Electron 主程序，它**不能**当 node 用 ——
 * 把 [script, ...args] 传进去不会执行脚本，而是静默返回空 stdout，调用方几乎无从察觉。
 * 因此这里不再静默回退，找不到就显式报错。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 平台感知的 node 可执行文件名（macOS/Linux 上是 node，不是 node.exe） */
export const NODE_BIN = process.platform === 'win32' ? 'node.exe' : 'node'

/** DSH 自带 node 运行时的候选 bin 目录（跨平台）。 */
export function nodeBinDirs(dshHome) {
  const bases = [
    path.join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node'),
    path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node'),
  ]
  return bases.map((b) => path.join(b, 'bin'))
}

/** 解析一个可用于执行脚本的 node 运行时；找不到就抛错，不静默回退。 */
export function resolveNodeRuntime(dshHome) {
  const cands = [
    process.env.DSH_NODE,
    ...nodeBinDirs(dshHome).map((d) => path.join(d, NODE_BIN)),
  ].filter(Boolean)
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c } catch {}
  }
  throw new Error(
    '[bili-whale] 找不到可用的 node 运行时。已尝试：\n  ' + cands.join('\n  ') +
    '\n请设置 DSH_NODE 环境变量指向 node' + (process.platform === 'win32' ? '.exe' : '') + ' 的绝对路径。'
  )
}

import { resolveHome } from './home.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// Verify execution using a file: an Electron process can exit zero without running JS.
export function probeRuntime(file, env) {
  let dir
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-node-'))
    const proof = path.join(dir, 'proof')
    const r = spawnSync(file, ['-e', 'require("fs").writeFileSync(process.argv[1],process.versions.node)', proof],
      { env, stdio: 'ignore', windowsHide: true, timeout: 10000 })
    return !r.error && r.status === 0 && /^\d+\./.test(fs.readFileSync(proof, 'utf8'))
  } catch { return false }
  finally { if (dir) fs.rmSync(dir, { recursive: true, force: true }) }
}
export function resolveRuntime(dshHome, options = {}) {
  const env = options.env ?? process.env, platform = options.platform ?? process.platform
  const home = options.home ?? resolveHome({env})
  const electron = options.electron ?? Boolean(process.versions.electron)
  const current = options.execPath ?? process.execPath
  const probe = options.probe ?? probeRuntime
  const bin = platform === 'win32' ? 'node.exe' : 'node'
  const cands = [env.DSH_NODE, env.DSH_DESKTOP_NODE_EXECUTABLE]
  for (const root of new Set([path.join(dshHome, 'dsh-runtimes'), path.join(home, '.dsh', 'dsh-runtimes')])) {
    try { for (const d of fs.readdirSync(root)) cands.push(path.join(root, d, 'dependencies', 'node', 'bin', bin)) } catch {}
  }
  const sep = platform === 'win32' ? ';' : ':'
  for (const dir of String(env.PATH ?? '').split(sep)) if (dir) cands.push(path.join(dir.replace(/^"|"$/g, ''), bin))
  if (platform === 'darwin') cands.push('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node', '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node')
  if (platform === 'win32' && env.ProgramFiles) cands.push(path.join(env.ProgramFiles, 'nodejs', bin))
  if (options.allowCurrent && !electron) cands.push(current)
  for (const file of new Set(cands.filter(Boolean))) {
    try { if (fs.statSync(file).isFile() && probe(file, env)) return { file, env: { ...env } } } catch {}
  }
  if (electron) {
    const nodeEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' }
    if (probe(current, nodeEnv)) return { file: current, env: nodeEnv }
  }
  throw Error('[bili-whale] 找不到可执行脚本的 node 运行时，请设置 DSH_NODE 为真实 node 的绝对路径')
}

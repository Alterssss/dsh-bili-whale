import { activityRemaining } from './activity.mjs'
// File-backed capture works where Windows sandbox disallows anonymous pipes.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
export function execFileSync(file, args = [], options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-capture-'))
  const out = path.join(dir, 'stdout'), err = path.join(dir, 'stderr')
  const fds = []
  try {
    fds.push(fs.openSync(out, 'wx', 0o600), fs.openSync(err, 'wx', 0o600))
    const remaining=activityRemaining()
    const result = spawnSync(file, args, { ...options, timeout: Math.min(options.timeout ?? 120000,remaining??Infinity),
      windowsHide: true, stdio: ['ignore', ...fds] })
    for (const fd of fds.splice(0)) fs.closeSync(fd)
    const stdout = fs.readFileSync(out), stderr = fs.readFileSync(err)
    if (result.error || result.status !== 0) {
      const e = result.error ?? new Error(`子进程失败 (${result.status}): ${stderr.toString('utf8').slice(0, 1000)}`)
      Object.assign(e, { status: result.status, stdout, stderr }); throw e
    }
    return options.encoding ? stdout.toString(options.encoding) : stdout
  } finally {
    for (const fd of fds) fs.closeSync(fd)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

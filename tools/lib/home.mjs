import os from 'node:os'
import path from 'node:path'
export function resolveHome({env=process.env, homedir=()=>os.homedir(), userInfo=()=>os.userInfo(), paths=path}={}) {
  const valid = value => typeof value === 'string' && value.trim() && paths.isAbsolute(value) && paths.resolve(value) !== paths.parse(paths.resolve(value)).root
  for (const value of [env.USERPROFILE, env.HOME]) if (valid(value)) return paths.resolve(value)
  for (const read of [homedir, () => userInfo().homedir]) {
    try { const value=read(); if (valid(value)) return paths.resolve(value) } catch {}
  }
  throw Error('无法确定用户主目录：请配置绝对路径 USERPROFILE 或 HOME；拒绝使用根目录或当前目录。')
}

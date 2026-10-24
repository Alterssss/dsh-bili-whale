import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'

export class AuthError extends Error {}

/** Preserve the old JSON format; reject header injection before any network request. */
export function parseManualCookie(input = {}) {
  const pick = (raw, key) => {
    const value = String(raw ?? '').trim()
    const match = value.match(new RegExp('(?:^|;)\\s*' + key + '=([^;]+)', 'i'))
    return (match ? match[1] : value.replace(new RegExp('^' + key + '\\s*=', 'i'), ''))
      .replace(/^["'\s]+|["';\s]+$/g, '').trim()
  }
  const credentials = {
    sessdata: pick(input.sessdata, 'SESSDATA'),
    bili_jct: pick(input.bili_jct, 'bili_jct'),
    buvid3: pick(input.buvid3, 'buvid3'),
  }
  if (credentials.sessdata.length < 20 || credentials.sessdata.length > 8192
    || !/^[0-9a-fA-F]{32}$/.test(credentials.bili_jct)
    || Object.values(credentials).some(value => /[\r\n;\x00-\x1f\x7f]/.test(value) || value.length > 8192))
    throw new AuthError('凭据不完整或格式无效，请重新扫码，或检查 SESSDATA 与 bili_jct。')
  return credentials
}

export function protectCredentials(file) {
  if (process.platform !== 'win32') { fs.chmodSync(file, 0o600); return }
  const options = { encoding: 'utf8', windowsHide: true, timeout: 10000 }
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  const sid = execFileSync(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], options).match(/S-1-\d+(?:-\d+)+/)?.[0]
  if (!sid) throw new AuthError('无法确认当前 Windows 用户，未保存凭据。')
  execFileSync(path.join(system, 'icacls.exe'), [file, '/reset', '/Q'], options)
  execFileSync(path.join(system, 'icacls.exe'), [file, '/inheritance:r', '/grant:r', `*${sid}:(F)`, '/Q'], options)
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

/** One writer for both QR and manual import; old credentials survive every pre-commit failure. */
export function createCredentialStore({ file, pending, verify, protect = protectCredentials }) {
  let tail = Promise.resolve()
  const save = (input, { signal, check = () => {} } = {}) => {
    const task = tail.then(async () => {
      check()
      const credentials = parseManualCookie(input)
      const oldText = read(file)
      const account = await verify(credentials, { signal })
      check()
      let items, pendingText
      try {
        pendingText = read(pending)
        items = pendingText === null ? [] : JSON.parse(pendingText).items
        if (!Array.isArray(items)) throw Error()
      } catch { throw new AuthError('无法读取待审草稿，未替换登录态；请先检查待审队列。') }
      if (items.length) {
        let oldAccount
        try { if (oldText) oldAccount = await verify(parseManualCookie(JSON.parse(oldText)), { signal }) }
        catch { /* An unverified identity is not permission to transfer old drafts. */ }
        if (!oldAccount || oldAccount.mid !== account.mid)
          throw new AuthError('仍有待审草稿，不能切换账号；请先用原账号处理或拒绝草稿，再重新登录。')
      }
      check()
      if (signal?.aborted) throw new AuthError('登录已取消，未保存。')
      if (read(file) !== oldText) throw new AuthError('登录态已在别处变化，请重新扫码。')
      if (read(pending) !== pendingText) throw new AuthError('待审草稿已变化，未替换登录态；请处理后重试。')
      const temp = `${file}.${randomUUID()}.tmp`
      try {
        if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw Error()
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const fd = fs.openSync(temp, 'wx', 0o600)
        try {
          // Restrict the empty file before it ever contains credentials.
          protect(temp)
          check()
          fs.writeFileSync(fd, JSON.stringify(credentials, null, 2) + '\n')
          fs.fsyncSync(fd)
        } finally { fs.closeSync(fd) }
        fs.renameSync(temp, file)
      } catch (error) {
        if (error instanceof AuthError) throw error
        throw new AuthError('凭据保存失败，旧登录态未替换；请检查文件权限。')
      } finally {
        if (fs.existsSync(temp)) fs.unlinkSync(temp)
      }
      return account
    })
    tail = task.catch(() => {})
    return task
  }
  return { save }
}

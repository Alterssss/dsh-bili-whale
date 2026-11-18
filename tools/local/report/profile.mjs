/**
 * profile.mjs —— 渲染器（profile）的加载与检查。
 *
 * 位置：$DSH_HOME/whale-work/profiles/<name>.mjs（用 BW_DEBRIEF_PROFILE=<name> 选中）。
 * 契约：export function render(report) { return { lines: string[] } }
 *
 * 检查顺序（任何一步不过都返回 errors，由调用方 exit 2）：
 *   名字合法（挡 ../ 之类）→ 文件存在 → 能 import → 导出 render → required 是字符串数组
 * 另提供 required 契约检查：profile 声明要用的字段，report 里缺了就把缺的列出来。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { dshPath } from '../../lib/paths.mjs'

/** 名字安全：只允许最朴素的文件名，挡掉 ../ 与绝对路径。 */
export const safeName = (n) => /^[A-Za-z0-9._-]+$/.test(String(n ?? ''))

/** profile 目录与文件路径（$DSH_HOME/whale-work/profiles）。 */
export const profilesDir = () => dshPath('whale-work', 'profiles')
export const profileFile = (name) => path.join(profilesDir(), `${name}.mjs`)

/**
 * 静态检查（不渲染、不取数据）。
 * 返回 { ok, name, file, fn, required, errors[] }
 */
export async function loadProfile(name) {
  const file = profileFile(name)
  const fail = (message) => ({ ok: false, name, file, fn: null, required: [], errors: [message] })

  if (!safeName(name)) {
    return fail(`名字不合法：${JSON.stringify(String(name))}（只允许字母/数字/点/下划线/短横线）`)
  }
  if (!fs.existsSync(file)) {
    return fail(`找不到文件：${file}`)
  }
  let mod
  try {
    mod = await import(pathToFileURL(file).href)
  } catch (e) {
    return fail(`加载失败：${String(e?.message ?? e)}`)
  }
  const errors = []
  const fn = typeof mod.render === 'function' ? mod.render : null
  if (!fn) errors.push('没有导出 render(report) 函数')
  let required = []
  if (mod.required !== undefined) {
    if (!Array.isArray(mod.required) || mod.required.some((x) => typeof x !== 'string')) {
      errors.push('required 必须是字符串数组，例如 export const required = ["meta.title", "subtitles.lines"]')
    } else required = mod.required
  }
  return { ok: errors.length === 0, name, file, fn, required, errors }
}

/** 按 "a.b.c" 取值；取不到返回 undefined。 */
export function getPath(obj, dotted) {
  let cur = obj
  for (const k of String(dotted).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[k]
  }
  return cur
}

/**
 * 契约检查：profile 声明了 required 时，逐条确认真实 report 里有没有这个字段。
 * 返回 { ok, missing:[], available:[顶层字段] }
 */
export function checkRequired(required, report) {
  const missing = []
  for (const p of required ?? []) {
    if (getPath(report, p) === undefined) missing.push(p)
  }
  const available = Object.keys(report ?? {})
  return { ok: missing.length === 0, missing, available }
}

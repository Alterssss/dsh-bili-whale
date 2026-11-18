const genericWords = new Set(['工具', '插件', '教程', '视频', '内容', '分享', '推荐'])
const normalize = value => String(value ?? '').normalize('NFKC').trim().toLowerCase()

export function preferenceSearch(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 100)
}

export function preferenceMatches(title, preference) {
  const text = normalize(title)
  const parts = [...new Set(normalize(preference).split(/[\s·,，、/]+|与|和|及/).filter(Boolean))]
  if (!parts.length) return false
  const contains = term => {
    if (!/^[a-z0-9_]+$/.test(term)) return text.includes(term)
    return new RegExp('(?:^|[^a-z0-9_])' + term + '(?:$|[^a-z0-9_])').test(text)
  }
  const specific = parts.filter(part => !genericWords.has(part))
  const generic = parts.filter(part => genericWords.has(part))
  return specific.every(contains) && (!generic.length || generic.some(contains))
}

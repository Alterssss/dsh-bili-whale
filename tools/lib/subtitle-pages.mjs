export function selectSubtitlePages(view, options={}) {
  const pages = view.pages?.length ? view.pages : [{page:1,cid:view.cid,duration:view.duration,part:view.title}]
  if (options.page !== undefined) {
    const number = Number(options.page)
    const page = pages.find(item => item.page === number)
    if (!Number.isInteger(number) || !page) throw Error('--page 指定的分 P 不存在')
    return [page]
  }
  if (options['all-pages']) return pages
  const count = Number(options['sample-pages'] ?? process.env.BW_SUBS_SAMPLE_MAX ?? 1)
  if (!Number.isInteger(count) || count < 1 || count > 20) throw Error('--sample-pages 必须是 1–20 的整数')
  if (count >= pages.length) return pages
  return Array.from({length:count}, (_, index) => pages[Math.floor(index * pages.length / count)])
}

export function pickSubtitle(tracks, language) {
  if (language) return tracks.find(track => track.lan === language)
  return tracks.find(track => track.lan === 'zh-CN') ??
    tracks.find(track => /^zh(?:-|$)/.test(String(track.lan))) ??
    tracks.find(track => track.lan === 'ai-zh') ??
    tracks.find(track => track.lan === 'ai-en') ?? tracks[0]
}

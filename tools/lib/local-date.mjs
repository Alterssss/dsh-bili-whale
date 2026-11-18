// Calendar keys use the host's local timezone; ISO strings remain correct for
// absolute event timestamps. Keep these two representations separate.
export function localDay(value = Date.now()) {
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) throw Error('无效本地日期')
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

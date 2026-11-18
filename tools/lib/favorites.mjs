import fs from 'node:fs'
export function favoriteItems(ledger, account) {
  const mid=String(account ?? '')
  return mid ? (ledger.items ?? []).filter(x => x && String(x.account ?? '') === mid) : []
}
export function readFavorites(file) {
  let text
  try { text=fs.readFileSync(file,'utf8') } catch (error) { if(error.code==='ENOENT') return {items:[]}; throw error }
  const data=JSON.parse(text)
  if (!data || !Array.isArray(data.items) || data.items.some(x => !x || typeof x !== 'object')) throw Error('收藏账本格式损坏，已停止操作；请保留原文件并修复。')
  return data
}
export function verifiedFavoriteAccount(nav, configured) {
  const mid=String(nav?.data?.mid ?? '')
  if(nav?.code!==0) throw Error('收藏账号验证失败：'+(nav?.message ?? nav?.code ?? '无响应'))
  if(nav.data?.isLogin!==true || !/^[1-9]\d{0,19}$/.test(mid) || (typeof nav.data.mid==='number' && !Number.isSafeInteger(nav.data.mid))) throw Error('收藏账号未登录，请重新登录。')
  if(!configured || mid!==String(configured)) throw Error('收藏账号与配置不一致，请在设置页重新登录并确认账号后再试。')
  return mid
}
export function selectFavoriteFolder(list, account) {
  if(!Array.isArray(list)) throw Error('收藏夹列表无效')
  const pick=list.find(f=>/默认/.test(f?.title ?? '')) ?? list[0]
  if(!pick || !/^[1-9]\d*$/.test(String(pick.id)) || (typeof pick.id==='number' && !Number.isSafeInteger(pick.id))) throw Error('没有可用收藏夹，请先在网页创建收藏夹。')
  const owner=pick.mid ?? pick.upper?.mid
  if(owner!=null && String(owner)!==String(account)) throw Error('收藏夹所属账号不一致，已停止收藏。')
  return {id:pick.id,title:pick.title}
}

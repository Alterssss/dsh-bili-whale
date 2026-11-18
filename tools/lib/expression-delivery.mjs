// Immutable send coordinates and deterministic platform prefix, shared by
// finalization and both transports. No fuzzy stripping of mentions or body text.
export function shareText(text,ownerName) {
  if(!ownerName)throw Error('分享需要 owner.name；请先在设置页填写主人昵称')
  const prefix='@'+ownerName,body=String(text).trim()
  if(body===prefix||body.startsWith(prefix+' ')||body.startsWith(prefix+'\n'))return body
  if(body.includes('@'))throw Error('分享草稿已有其他 @；请明确目标后修改一次，或放弃')
  return prefix+' '+body
}
export function freezeDelivery(draft,cfg={}) {
  const channel=draft.channel==='dynamic'?'dynamic':['reply','public-comment'].includes(draft.scene)?'comment':'dm'
  const result={version:2,channel,scene:draft.scene,target:draft.target,thread:draft.thread??'',parent:String(draft.parent??''),text:draft.text,share:draft.share??null}
  if(channel==='dynamic'){
    if(draft.scene!=='public-comment'||!/^\d+$/.test(result.target)||result.thread||result.parent||draft.share===true)throw Error('动态草稿需要公开场景、账号 mid，不能带评论坐标或分享标记')
    result.share=false;return result
  }
  if(channel==='comment'){
    const match=String(result.thread).match(/^(\d+):(\d+):(\d+|top)$/)
    if(!match)throw Error('评论草稿需要 thread="type:oid:root"；主评论的 root 写 top')
    result.type=match[1];result.oid=match[2];result.root=match[3]==='top'?'':match[3]
    if((draft.scene==='reply')!==!!result.parent)throw Error('scene 与 parent 不一致：楼中楼用 reply 并填 parent；主评论用 public-comment')
    if(result.parent&&!result.root)throw Error('回复草稿缺少 root；请填写真实根评论坐标')
    if(/^BV[0-9A-Za-z]{10}$/.test(result.target))result.bvid=result.target
    else if(result.target!==result.oid)throw Error('target 应为 BV 号或与 thread 相同的 oid')
    result.referer=draft.referer|| (result.bvid?'https://www.bilibili.com/video/'+result.bvid+'/':(result.type==='1'?'https://www.bilibili.com/':'https://www.bilibili.com/opus/'+result.oid))
    if(!/^https:\/\/(?:www\.)?bilibili\.com\//.test(result.referer))throw Error('评论草稿 referer 必须是 B站 HTTPS 页面')
    // Finalize displays both permitted transport forms when share is unspecified.
    if(!result.parent&&result.share!==false&&cfg.owner?.name){
      try{result.shareText=shareText(draft.text,cfg.owner.name);result.ownerName=String(cfg.owner.name)}
      catch(e){if(result.share===true)throw e;result.shareError=e.message}
    }
    if(result.share===true&&!result.shareText)throw Error('分享只能是主评论，且需配置主人昵称')
  }else{
    if(!/^\d+$/.test(result.target))throw Error('私信草稿 target 应为主人 mid')
    if(cfg.owner?.mid&&result.target!==String(cfg.owner.mid))throw Error('私信草稿目标与主人 mid 不一致')
    if(result.parent||result.thread)throw Error('私信草稿不能包含评论线程坐标')
    result.share=draft.scene==='private-recommendation'
    result.video=draft.video||String(draft.text).match(/BV[0-9A-Za-z]{10}/)?.[0]||''
  }
  return result
}
export function draftForm(draft,{share=false,ownerName=''}={}) {
  const d=draft.delivery
  if(!d)return share?shareText(draft.text,ownerName):draft.text // v1 compatibility
  if(d.share!==null&&d.share!==share)throw Error('分享方式与已定稿不一致；请使用定稿输出的发送方式')
  if(share&&d.channel==='comment'){
    if(!d.shareText||d.ownerName!==ownerName)throw Error('主人昵称或分享前缀已变化；请重新核对并创建草稿')
    return d.shareText
  }
  return d.text
}
export function getDraft(store,id,channel) {
  const d=store.read().drafts.find(d=>d.id===id)
  if(!d)throw Error('草稿 ID 不存在；先 expression prepare → finalize，再传返回的 ID')
  if(d.status!=='pending')throw Error('草稿尚未定稿或已发送/放弃；请检查 expression finalize 的输出')
  if(store.now()-d.at>86400000)throw Error('草稿超过 24 小时；请重新核对素材和目标')
  const actual=d.delivery?.channel??(['reply','public-comment'].includes(d.scene)?'comment':'dm')
  if(actual!==channel)throw Error('草稿通道不一致：应使用 '+actual+' --draft '+id)
  return d
}
function matching(key,explicit,frozen) {
  if(explicit!==undefined&&String(explicit)!==String(frozen??''))throw Error('草稿 '+key+' 不匹配；已固化为 '+String(frozen??'空')+'，移除重复参数后使用 --draft，或重新创建目标正确的草稿')
}
export function commentFromDraft(store,args,cfg) {
  const d=getDraft(store,String(args.get('draft')),'comment'),delivery=d.delivery??freezeDelivery(d,cfg)
  const share=args.has('share')||delivery.share===true
  if(share&&delivery.parent)throw Error('楼中楼草稿不能当分享主评论发送')
  const text=draftForm(d,{share,ownerName:String(cfg.owner?.name??'')})
  for(const key of ['oid','bvid','type','root','parent','referer']){
    let supplied=args.get(key)
    if(key==='root'&&String(supplied)==='0')supplied=delivery.parent||''
    matching(key,supplied,delivery[key]??'')
    if(delivery[key])args.set(key,delivery[key]);else args.delete(key)
  }
  if(args.has('message')&&![d.text,text].includes(String(args.get('message'))))throw Error('草稿正文不匹配；移除 --message，直接使用 --draft；需要改文案时先 revise（最多一次）')
  args.set('message',text)
  if(share){args.set('share',true);args.set('auto',true)}
  return delivery
}
export function dmFromDraft(store,opt,cfg) {
  const d=getDraft(store,String(opt.draft),'dm'),delivery=d.delivery??freezeDelivery(d,cfg)
  matching('主人 mid',String(cfg.owner?.mid??''),delivery.target)
  if(opt.msg!==undefined&&String(opt.msg)!==d.text)throw Error('草稿正文不匹配；移除 --msg，使用 --draft；改正文请先 revise（最多一次）')
  if(opt.share!==undefined&&!!opt.share!==delivery.share)throw Error('私信分享方式与草稿 scene 不一致')
  if(opt.target!==undefined)matching('视频 target',opt.target,delivery.video)
  opt.msg=d.text
  if(delivery.share){opt.share=true;if(delivery.video)opt.target=delivery.video}
  return delivery
}

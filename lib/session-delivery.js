import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { maintenancePaused } from './maintenance.js'

// One queue owns session selection and persona acknowledgement for all channels.
export function createSessionDelivery({controller,dshHome,cwd,sessionId,config,persona,turnContext=()=>'',isBusy=()=>false,now=Date.now,log=()=>{},onSession=()=>{}}) {
  const file=path.join(dshHome,'whale-session.json')
  let state={id:sessionId,startedAt:now()},ready=false,tail=Promise.resolve(),lastDelivered=0
  // 2026-10-24：进程启动后有没有投递过 —— 用来做「重启后首次必注入人设」
  //   因为 DSH 的 create() 返回 { sessionId, agentPreset? }，分不出"新建"还是"复用" ✗
  let booted=false
  try {
    const saved=JSON.parse(fs.readFileSync(file,'utf8'))
    if(typeof saved.id!=='string'||!saved.id||!Number.isFinite(saved.startedAt)||saved.startedAt<0)throw Error('invalid state')
    state=saved
  } catch(e) { if(e.code!=='ENOENT')throw Error('会话状态损坏，请检查 whale-session.json，避免误建会话') }
  onSession(state.id)
  lastDelivered=Number.isFinite(state.deliveredAt)?state.deliveredAt:0
  function save(next) {
    fs.mkdirSync(dshHome,{recursive:true})
    const tmp=file+'.'+crypto.randomUUID()+'.tmp'
    try {fs.writeFileSync(tmp,JSON.stringify(next));fs.renameSync(tmp,file)} finally {fs.rmSync(tmp,{force:true})}
  }
  return {
    send(request,signal,{retainUntilAck=false}={}) {
      const job=tail.then(async()=>{
        if (maintenancePaused(dshHome)) throw Error('养鱼维护验证中，自动投递已暂停')
        signal?.throwIfAborted()
        const cfg=config(),days=Number(cfg.sessionRotateDays??0),once=cfg.personaOncePerSession===true
        const persist=retainUntilAck||!!state.pendingRequest||once||(Number.isFinite(days)&&days>0)
        const rotating=!state.pendingRequest&&Number.isFinite(days)&&days>0&&now()-state.startedAt>=days*86400000&&now()-lastDelivered>=8*60000&&!isBusy()
        let next=rotating?{id:crypto.randomUUID(),startedAt:now(),rotatedFrom:state.id}:state
        if(retainUntilAck){
          if(!request.requestId)throw Error('可靠交付需要 requestId')
          next={...next,pendingRequest:request.requestId}
        }
        let created = null
        if(!ready||rotating) {
          try {created = await controller.create({sessionId:next.id,cwd})}
          catch(e) {if(rotating)throw e;log('沿用现有会话；若投递失败将保留重试状态')}
        }
        // 2026-10-24 修第二版（审查报告第 3 条 + 复审）：
        //   上一版想靠 create() 的返回字段判断"是不是新建会话" ✗
        //   但 DSH 的 sessionController.create 返回的是 { sessionId, agentPreset? }
        //   —— 根本没有 created / fresh 这种布尔 ✗ 那段判断永远为假 ✗
        //   （而且注释写着"拿不到信号就往多注入那边靠"，代码却继续跳过 ✗ 自相矛盾）
        //
        // 现在的做法：接口分不出来就不分 ✗
        //   每次【进程启动后的第一次投递】都重新注入完整人设 + 日记恢复指引 ✓
        //   之后同一会话内按 personaIHash 去重 ✓
        //   代价：每次重启多重注入一次人设（~1000 字）✓ 换来"她不会重启后失忆"✓
        //   只开 personaIze 开关时才这样；关着的时候每条都注入，和以前一样 ✓
        const bootFirst = !booted
        if(persist)save(next)
        if(rotating)log(`会话轮换：${state.id} → ${next.id}；旧会话保留`)
        state=next;ready=true;onSession(state.id)
        signal?.throwIfAborted()
        const block=persona(),fingerprint=crypto.createHash('sha256').update(block).digest('hex')
        const include=!once||bootFirst||state.personaHash!==fingerprint
        const reminder=cfg.dialogueMode==='character'?block:`人设依据：${path.join(process.env.USERPROFILE||process.env.HOME||'.','.bili-ai/persona.md')}；上下文缺失时重读。`
        const diary=`先读本地日记恢复记忆：${path.join(dshHome,'whale-diary.md')} 和 ${path.join(dshHome,'whale-diary-private.md')}；不要将旧会话未确认事项当成已完成。`
        const prefix=[include?block:reminder,turnContext(request),...((!state.deliveredAt||bootFirst)?[diary]:[])].filter(Boolean).join('\n')
        const content=[...(request.content??[])]
        if(content[0]?.type==='text')content[0]={...content[0],text:prefix+'\n'+content[0].text}
        else content.unshift({type:'text',text:prefix})
        if (maintenancePaused(dshHome)) throw Error('养鱼维护验证中，自动投递已暂停')
        try {await controller.prompt({...request,sessionId:state.id,content},signal)}
        catch(e) {ready=false;throw e}
        booted=true   // 投递成功了才算
        lastDelivered=now()
        state={...state,personaHash:fingerprint,deliveredAt:lastDelivered}
        // Delivery succeeded: persistence failure must not make callers retry it.
        if(persist)try {save(state)} catch(e){log('会话已投递，但保存人设标记失败：'+e.message)}
      })
      tail=job.catch(()=>{})
      return job
    },
    confirm(requestId) {
      const job=tail.then(()=>{
        if(state.pendingRequest!==requestId)return
        const next={...state};delete next.pendingRequest
        save(next);state=next
      })
      tail=job.catch(()=>{});return job
    },
  }
}

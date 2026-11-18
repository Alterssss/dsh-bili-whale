// Persist categories only: never copy model output, tokens, paths or source text.
export function formationDiagnostic(error){
 const known={FORMATION_LEASE_EXPIRED:'作业租约到期，未确认提交',FORMATION_INPUT_SIZE:'归纳模型输入超限',FORMATION_OUTPUT_SIZE:'归纳模型输出超限',FORMATION_LLM_TIMEOUT:'宿主文本模型调用超时',FORMATION_LLM_UNAVAILABLE:'宿主文本模型不可用',FORMATION_CANCELLED:'宿主文本模型调用取消',FORMATION_FINISH_INVALID:'宿主文本模型未正常完成',FORMATION_INCOMPLETE:'宿主文本模型输出为空或缺少完成事件',FORMATION_TOOL_CALL:'归纳文本模型尝试调用工具',FORMATION_FILE_TIMEOUT:'未收到完整归纳结果文件',FORMATION_CREATE_TIMEOUT:'建立归纳会话超时',FORMATION_FILE_INVALID:'结果文件类型、大小或路径校验失败',FORMATION_MANIFEST_INVALID:'归纳交付状态损坏',FORMATION_UNAVAILABLE:'宿主会话接口不可用',FORMATION_TIMEOUT:'归纳整轮超时',FORMATION_STOPPED:'归纳已停止'}
 const categories={EVIDENCE_DAYS:'模式需要跨 UTC+8 日期的独立证据',EVIDENCE_SOURCE:'缺少有效的独立来源或已确认发送行为',SELF_SCOPE:'自我认知主体、类型或审核边界未通过',SOURCE_CHANGED:'来源变化、删除或证据链缺失',SOURCE_QUOTE:'来源不在本批次或原文引用不匹配',VERSION_CONFLICT:'替换目标版本冲突',PERMISSION_CHANGED:'权限代次变化或已暂停',LEASE_INVALID:'作业租约、令牌或阶段无效',INVALID_FIELDS:'候选字段或审核结构不完整',PRIVATE_SCOPE:'私密来源不能用于公开范围',OWNER_AUTHORITY:'推断不能替代主人规则',TIMEOUT:'归纳超时',STOPPED:'归纳已停止',INVALID_JSON:'输出不是有效 JSON',FAILED:'归纳操作失败'}
 for(const [key,value] of Object.entries(categories))known['FORMATION_'+key]=value
 if(Object.hasOwn(known,error?.code??''))return {code:error.code,reason:known[error.code],...(error.details?{details:error.details}:{})}
 const message=String(error?.message??'')
 const rules=[
  [/跨日/,'EVIDENCE_DAYS','模式需要跨 UTC+8 日期的独立证据'],
  [/独立来源|已确认发送|发送行为/,'EVIDENCE_SOURCE','缺少有效的独立来源或已确认发送行为'],
  [/自我认知|subject/,'SELF_SCOPE','自我认知的主体、类型或审核边界未通过'],
  [/来源已变化|证据链|来源.*删除/,'SOURCE_CHANGED','来源哈希变化、删除或证据链缺失'],
  [/原文引用|本批次.*来源/,'SOURCE_QUOTE','来源不在本批次或原文引用不匹配'],
  [/版本冲突|替换.*版本|替换目标/,'VERSION_CONFLICT','替换目标版本冲突（CAS）'],
  [/权限|暂停/,'PERMISSION_CHANGED','权限代次已变化或已暂停'],
  [/过期|阶段已变化|作业无效/,'LEASE_INVALID','作业租约、令牌或阶段无效'],
  [/appliesTo|doThis|falsifiedBy|字段|文本为空|候选|替代解释|审核需|审核 key|审核动作|审核必须/,'INVALID_FIELDS','候选字段或审核结构不完整'],
  [/私密|私人场景/,'PRIVATE_SCOPE','私密来源不能用于公开范围'],
  [/主人已确认|可信主人/,'OWNER_AUTHORITY','推断不能替代主人已确认规则'],
  [/超时/,'TIMEOUT','归纳超时，旧操作已取消'],
  [/停止/,'STOPPED','归纳已停止'],
  [/JSON|Unexpected token/,'INVALID_JSON','输出不是有效 JSON'],
 ]
 const found=rules.find(([pattern])=>pattern.test(message))
 return {code:'FORMATION_'+(found?.[1]??'FAILED'),reason:found?.[2]??'归纳操作失败，请检查对应阶段'}
}

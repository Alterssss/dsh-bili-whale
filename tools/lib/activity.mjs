// Budget propagation for plugin-managed read subprocesses. This is not an OS sandbox.
export function activityRemaining(env=process.env,now=Date.now()) {
  if(!env.WHALE_ACTIVITY_DEADLINE)return null
  const remaining=Number(env.WHALE_ACTIVITY_DEADLINE)-now
  if(!Number.isFinite(remaining)||remaining<=0)throw Error('自主活动时间预算已耗尽')
  return remaining
}
export function activityCommand(command,env=process.env) {
  if(activityRemaining(env)!==null&&!['feed','debrief','comments','search','round','discover','batch-debrief'].includes(command))throw Error('自主活动子进程只允许读取工具')
}
export function activityFetch(input,options={},env=process.env) {
  const remaining=activityRemaining(env)
  if(remaining===null)return options
  const method=String(options.method??input?.method??'GET').toUpperCase()
  if(!['GET','HEAD'].includes(method))throw Error('自主活动子进程不能执行账号写请求')
  const deadline=AbortSignal.timeout(Math.max(1,Math.floor(remaining)))
  return {...options,signal:options.signal?AbortSignal.any([options.signal,deadline]):deadline}
}

import {setTimeout,clearTimeout} from 'node:timers'
// Scheduler fixtures suppress boot/interval timers, not the 50ms lock retry
// timers used by concurrent receipt and listener transactions.
export function preserveRetryTimers(){
  const fakeTimeout=globalThis.setTimeout,fakeClear=globalThis.clearTimeout
  globalThis.setTimeout=(fn,ms,...args)=>ms<=1000?setTimeout(fn,ms,...args):fakeTimeout(fn,ms,...args)
  globalThis.clearTimeout=t=>typeof t?.hasRef==='function'?clearTimeout(t):fakeClear(t)
}

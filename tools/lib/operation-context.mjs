import {AsyncLocalStorage} from 'node:async_hooks'
const operations=new AsyncLocalStorage()
export const withOperationSignal=(signal,fn)=>operations.run(signal,fn)
export function checkOperation(){operations.getStore()?.throwIfAborted()}

#!/usr/bin/env node
import {DSH_HOME} from '../lib/paths.mjs'
import {readMemory} from '../lib/memory.mjs'
try {
  const args=process.argv.slice(2), mode=args.shift() || 'context', options={mode}
  while(args.length) {
    const key=args.shift()
    if(key==='--private') {options.includePrivate=true;continue}
    const name={'--date':'date','--bv':'bv','--keyword':'keyword','--offset':'offset'}[key]
    if(!name || !args.length || args[0].startsWith('--'))throw Error('usage: memory context | memory recall [--date YYYY-MM-DD] [--bv BV…] [--keyword text] [--private] [--offset N]')
    const value=args.shift()
    if(name==='offset' && !/^\d+$/.test(value))throw Error('offset must be a nonnegative integer')
    options[name]=name==='offset'?Number(value):value
  }
  if(mode!=='recall' && (options.includePrivate || options.offset!==undefined))throw Error('--private and --offset are only available for explicit recall')
  console.log(JSON.stringify(readMemory(DSH_HOME,options)))
} catch(e) {console.error(e.message);process.exitCode=2}

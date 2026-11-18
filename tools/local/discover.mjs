import {discover} from './pipeline.mjs'
try{const r=await discover(process.argv.slice(2).filter(x=>x!=='--json'));if(process.argv.includes('--json'))console.log(JSON.stringify(r));else {for(const x of r.items)console.log(`${x.bv} ${x.t} · ${x.d}s · ${x.parts}P`);console.log('候选不足：'+r.shortfall)}}catch(e){console.error(e.message);process.exitCode=1}

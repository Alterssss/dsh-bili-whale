import fs from 'node:fs'
import {batchDebrief} from './pipeline.mjs'
const argv=process.argv.slice(2),get=k=>{const i=argv.indexOf(k);return i>=0?argv[i+1]:undefined}
try{const bvs=argv.filter(x=>/^BV[0-9A-Za-z]{10}$/.test(x));if(get('--from'))bvs.push(...fs.readFileSync(get('--from'),'utf8').split(/\s+/).filter(Boolean));const r=await batchDebrief(bvs,{noFrames:argv.includes('--no-frames'),concurrency:get('--concurrency'),samplePages:Number(get('--sample-pages')??1)});console.log(JSON.stringify(r));if(r.failed.length)process.exitCode=1}catch(e){console.error(e.message);process.exitCode=1}

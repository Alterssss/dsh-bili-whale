import {relatedCollect} from './pipeline.mjs'
try{console.log(JSON.stringify(await relatedCollect(process.argv.slice(2))))}catch(e){console.error(e.message);process.exitCode=1}

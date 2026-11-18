import {collectTags} from './pipeline.mjs'
try{console.log(JSON.stringify(await collectTags(process.argv.slice(2))))}catch(e){console.error(e.message);process.exitCode=1}

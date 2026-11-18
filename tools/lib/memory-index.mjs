import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const require=createRequire(import.meta.url)
// Chinese bigrams are lexical retrieval, not semantic embeddings.
export function terms(text) {
  const out=String(text).toLowerCase().match(/[a-z0-9_]+/g)??[]
  for(const run of String(text).match(/[\u3400-\u9fff]+/g)??[]) {const a=Array.from(run);if(a.length===1)out.push(run);for(let i=0;i<a.length-1;i++)out.push(a[i]+a[i+1])}
  return [...new Set(out)].slice(0,2000)
}
export function rebuildIndex(dir,state) {
  const {DatabaseSync}=require('node:sqlite'),tmp=path.join(dir,'search.build.sqlite'),file=path.join(dir,'search.sqlite')
  fs.rmSync(tmp,{force:true});const db=new DatabaseSync(tmp)
  try {
    db.exec('CREATE VIRTUAL TABLE entries USING fts5(id UNINDEXED, tokens); CREATE TABLE meta(revision INTEGER); BEGIN')
    const put=db.prepare('INSERT INTO entries(id,tokens) VALUES (?,?)')
    for(const m of state.memories.filter(m=>m.active&&m.recallEnabled!==false))put.run(m.id,terms(m.text+' '+JSON.stringify(m.policy??{})).join(' '))
    db.prepare('INSERT INTO meta VALUES (?)').run(state.revision);db.exec('COMMIT')
  } finally {db.close()}
  fs.renameSync(tmp,file)
  return {status:'ok',revision:state.revision,entries:state.memories.filter(m=>m.active&&m.recallEnabled!==false).length}
}
export function indexCandidates(dir,query) {
  const tokens=terms(query).slice(0,64);if(!tokens.length)return []
  const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(path.join(dir,'search.sqlite'),{readOnly:true})
  try{return db.prepare('SELECT id FROM entries WHERE entries MATCH ? ORDER BY rank LIMIT 200').all(tokens.map(x=>'"'+x.replaceAll('"','""')+'"').join(' OR ')).map(r=>r.id)}finally{db.close()}
}

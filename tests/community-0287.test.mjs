import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {resolveHome} from '../tools/lib/home.mjs'
import {favoriteItems,readFavorites,verifiedFavoriteAccount,selectFavoriteFolder} from '../tools/lib/favorites.mjs'
import {qrPng} from '../lib/qr.js'
const root=fileURLToPath(new URL('../',import.meta.url))
test('HOME resolver rejects relative/root candidates and falls back to OS user information',()=>{
 const base={paths:path.posix,homedir:()=>'',userInfo:()=>({homedir:'/users/test'})}
 for(const env of [{},{USERPROFILE:'',HOME:''},{USERPROFILE:'.',HOME:'/' }]) assert.equal(resolveHome({...base,env}),'/users/test')
 assert.equal(resolveHome({...base,env:{USERPROFILE:'/users/a',HOME:'/users/b'}}),'/users/a')
 assert.equal(resolveHome({...base,paths:path.win32,env:{USERPROFILE:'C:\\Users\\test'}}),'C:\\Users\\test')
 assert.throws(()=>resolveHome({...base,env:{},userInfo:()=>{throw Error()}}),/无法确定用户主目录/)
})
test('favorites account filtering preserves legacy records without attributing them to new accounts',()=>{
 const d={items:[{bv:'legacy'},{account:'111',bv:'a'},{account:'222',bv:'b'}]}
 assert.deepEqual(favoriteItems(d,'111').map(x=>x.bv),['a']);assert.deepEqual(favoriteItems(d,'222').map(x=>x.bv),['b']);assert.equal(d.items.length,3)
 assert.equal(favoriteItems(d,'').length,0)
})
test('favorites reject logged-out, mismatched and foreign-folder identities',()=>{
 assert.equal(verifiedFavoriteAccount({code:0,data:{isLogin:true,mid:111}},'111'),'111')
 for(const data of [{isLogin:false,mid:111},{isLogin:true,mid:222},{isLogin:true,mid:0}]) assert.throws(()=>verifiedFavoriteAccount({code:0,data},'111'))
 assert.throws(()=>selectFavoriteFolder([{id:1,mid:222,title:'默认'}],'111'),/所属账号/)
 assert.throws(()=>selectFavoriteFolder([{id:0}],'111'))
})
function sandbox(t){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-0287-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const data=path.join(home,'.bili-ai');fs.mkdirSync(data)
 const cfg=path.join(home,'custom-config.json');fs.writeFileSync(cfg,JSON.stringify({self:{mid:'111'},owner:{mid:'222'},notify:{type:'none'}}));fs.writeFileSync(path.join(data,'credentials.json'),JSON.stringify({sessdata:'fake',bili_jct:'a'.repeat(32)}))
 const env={...process.env,USERPROFILE:home,HOME:home,DSH_HOME:path.join(home,'.dsh'),BILI_WHALE_CONFIG:cfg,BILI_TRAFFIC_TEST:'1',BILI_NO_CACHE:'1',TEST_REQUESTS:path.join(home,'requests'),NODE_OPTIONS:'--import='+pathToFileURL(path.join(root,'tests/helpers/favorites-fetch.mjs')).href}
 const run=(args)=>spawnSync(process.execPath,[path.join(root,'tools/commands/fav.mjs'),...args],{env,encoding:'utf8',timeout:15000})
 return {home,data,env,run,ledger:path.join(data,'favorites.json'),requests:()=>fs.existsSync(env.TEST_REQUESTS)?fs.readFileSync(env.TEST_REQUESTS,'utf8'):''}
}
const args=['BV1234567890','--reason','这个视频值得再看一次']
test('favorites CLI checks real account before any POST',t=>{
 const s=sandbox(t);s.env.TEST_NAV_MID='333';const r=s.run([...args,'--go']);assert.notEqual(r.status,0);assert.match(r.stderr,/账号与配置不一致/);assert.doesNotMatch(s.requests(),/POST/)
})
test('favorites CLI preserves legacy records, uses verified folder, and writes account only after success',t=>{
 const s=sandbox(t);const legacy={bv:'old',favId:999};fs.writeFileSync(s.ledger,JSON.stringify({items:[legacy]}))
 let r=s.run([...args,'--dry']);assert.equal(r.status,0,r.stderr);assert.doesNotMatch(s.requests(),/POST/)
 r=s.run([...args,'--go']);assert.equal(r.status,0,r.stderr);const d=readFavorites(s.ledger);assert.deepEqual(d.items[0],legacy);assert.equal(d.items[1].account,'111');assert.equal(d.items[1].favId,123)
 assert.match(s.requests(),/add_media_ids=123/)
 assert.equal(JSON.parse(s.run(['--list','--legacy','--json']).stdout).items.length,1)
 r=s.run([...args,'--go']);assert.notEqual(r.status,0);assert.equal((s.requests().match(/POST/g)||[]).length,1)
})
test('favorites rejection and corrupt ledger never produce a success record',t=>{
 const s=sandbox(t);s.env.TEST_FAV_CODE='11010';const r=s.run([...args,'--go']);assert.notEqual(r.status,0);assert.match(r.stderr,/收藏夹不存在/);assert.equal(fs.existsSync(s.ledger),false)
 fs.writeFileSync(s.ledger,'broken');assert.notEqual(s.run([...args,'--go']).status,0);assert.equal(fs.readFileSync(s.ledger,'utf8'),'broken')
})
test('QR rendering bounds invalid allocation options',()=>{
 for(const o of [{width:1e8},{margin:-1},{scale:0},{ec:'bad'}]) assert.throws(()=>qrPng('test',o))
})

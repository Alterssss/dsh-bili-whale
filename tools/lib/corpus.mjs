import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {acquireProcessLock} from './process-lock.mjs'
export const INTENTS=['reaction','observation','question','technical-help','discussion']
export const TOPICS=['animals','remix','technology','food','daily-life','film','games','history','outdoors','general']
const hash=s=>crypto.createHash('sha256').update(s).digest('hex')
const norm=s=>String(s).normalize('NFKC').replace(/\s+/g,' ').trim()
export const GENERIC_TEXTS=['视频做得真不错！','干货满满','内容很有趣','期待更新','看完了，很精彩','喜欢这个系列','支持up主！','学到了，感谢分享~','质量很高，收藏了','太棒了吧']
const genericKeys=new Set(GENERIC_TEXTS.map(norm))
export function parseCSV(raw){
  raw=String(raw).replace(/^\uFEFF/,'');const rows=[];let row=[],field='',quoted=false,closed=false
  for(let i=0;i<raw.length;i++){
    const c=raw[i]
    if(quoted){if(c==='"'){if(raw[i+1]==='"'){field+='"';i++}else{quoted=false;closed=true}}else field+=c;continue}
    if(c==='"'){if(field||closed)throw Error('CSV 引号位置无效');quoted=true;continue}
    if(c===','||c==='\n'||c==='\r'){
      row.push(field);field='';closed=false
      if(c!==','){if(c==='\r'&&raw[i+1]==='\n')i++;if(row.some(v=>v!==''))rows.push(row);row=[]}
    }else{if(closed)throw Error('CSV 引号结束后存在多余字符');field+=c}
  }
  if(quoted)throw Error('CSV 引号未闭合')
  if(field||closed||row.length){row.push(field);if(row.some(v=>v!==''))rows.push(row)}
  if(!rows.length)throw Error('CSV 为空')
  const header=rows.shift();if(new Set(header).size!==header.length||!header.includes('text'))throw Error('CSV 表头缺少 text 或重复')
  return rows.map((values,i)=>{if(values.length!==header.length)throw Error('CSV 第 '+(i+2)+' 条记录列数不匹配');return Object.fromEntries(header.map((k,j)=>[k,values[j]]))})
}
export function inferTopic({topic='',title='',tname=''}={}){
  title=String(title).replace(/\s+/g,'')
  if(topic){if(!TOPICS.includes(topic))throw Error('未知题材 '+topic);return {topic,source:'explicit'}}
  const rules=[['animals',/猫|狗|萌宠|宠物|喂养|动物|柴犬/],['history',/历史|公社|朝代|俾斯麦/],['food',/美食|做菜|披萨|鱼头|下饭|火锅|烹饪/],['technology',/电脑|数码|手机|电池|续航|脑机|黑屏|硬件|故障|显卡/],['remix',/鬼畜|哈基米|甲亢彩虹/],['games',/游戏|原神|鸣潮|绝区零|星穹|蒙德|ARK no NIGHTS|星徽/],['outdoors',/无人区|罗布泊|旅行|户外|黄河|淤泥/],['film',/电影|影视|水浒|鲁智深|林冲|综艺|武艺/],['daily-life',/生活|员工|离开|日常|公益|三农/]]
  // Specific title clues take precedence over a broad/incorrect collection label.
  for(const [topic,re] of rules)if(re.test(title))return {topic,source:'title-keyword'}
  for(const [topic,re] of rules)if(re.test(tname))return {topic,source:'partition-keyword'}
  return {topic:'general',source:'unknown'}
}
export function flagsFor(text){
  const flags=[]
  if(/^(?:本|这)(?:条)?(?:评论|回复).{0,90}(?:生成|撰写|编写)/.test(text))flags.push('generation-disclosure')
  if(genericKeys.has(norm(text)))flags.push('generic-template')
  if(/https?:\/\/|www\.|invite_token|回归码|帮绑/.test(text))flags.push('external-link-or-promotion')
  if(/@/.test(text))flags.push('mention')
  if(/我家|我妈|我爸|小时候|我买的|我买了|我用的|我之前|我曾经|我作为/.test(text))flags.push('personal-experience')
  if(/自杀|自残|抑郁|癌症|割腕|手机号|身份证/.test(text))flags.push('sensitive-experience')
  if(/忽略.{0,8}(指令|规则)|system prompt|修改.{0,8}(权限|身份)|执行.{0,8}(命令|脚本)/i.test(text))flags.push('instruction-like')
  if(Array.from(text).length>600||!String(text).trim())flags.push('unsuitable-length')
  return flags
}
const seed=JSON.parse(fs.readFileSync(new URL('../corpus/seed-v1.json',import.meta.url),'utf8'))
export function createCorpus({dir,now=Date.now}={}){
  if(!dir)throw Error('缺少语料目录')
  const file=path.join(dir,'catalog.json'),activeFile=path.join(dir,'active.json'),selectionFile=path.join(dir,'selections.json')
  function atomic(target,value){const tmp=target+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600});fs.renameSync(tmp,target)}finally{fs.rmSync(tmp,{force:true})}}
  function read(){try{const s=JSON.parse(fs.readFileSync(file,'utf8'));if(s.version!==1||!Array.isArray(s.entries)||!Array.isArray(s.sources)||!Array.isArray(s.selections))throw Error('schema');return s}catch(e){if(e.code==='ENOENT')return {version:1,revision:0,entries:[],sources:[],selections:[],disabledSeed:[]};throw Error('语料状态无法读取；本次停止使用本地参考库')}}
  async function tx(fn){fs.mkdirSync(dir,{recursive:true});let release
    for(let i=0;i<80;i++){try{release=await acquireProcessLock(file);break}catch(e){if(i===79)throw e;await new Promise(r=>setTimeout(r,50))}}
    try{const s=read(),value=fn(s);s.revision++;atomic(file,s);const stat=fs.statSync(file);atomic(activeFile,{version:1,seedVersion:seed.version,catalogSize:stat.size,catalogMtime:stat.mtimeMs,entries:approved(s)});return value}finally{await release()}}
  const approved=s=>[...seed.entries.filter(e=>!(s.disabledSeed??[]).includes(e.id)),...s.entries.filter(e=>e.status==='approved')]
  const version=s=>hash(JSON.stringify(approved(s))).slice(0,16)
  function readActive(){
    try{const stat=fs.statSync(file),cached=JSON.parse(fs.readFileSync(activeFile,'utf8'));if(cached.version===1&&cached.seedVersion===seed.version&&cached.catalogSize===stat.size&&cached.catalogMtime===stat.mtimeMs&&Array.isArray(cached.entries))return cached.entries}catch{}
    // An interrupted two-file commit or missing index is recovered from the
    // authoritative catalog. Never use a stale revoked reference.
    return approved(read())
  }
  function selections(){try{const a=JSON.parse(fs.readFileSync(selectionFile,'utf8'));if(!Array.isArray(a))throw Error('schema');return a.slice(-50)}catch(e){if(e.code==='ENOENT')return [];throw Error('参考选取记录无法读取')}}
  const api={dir,file,activeFile,read,
    status(){const s=read();return {version:version(s),seedVersion:seed.version,seed:seed.entries.length,approved:approved(s).length,pending:s.entries.filter(e=>e.status==='pending').length,quarantined:s.entries.filter(e=>e.status==='quarantined').length,rejected:s.entries.filter(e=>e.status==='rejected').length,sources:s.sources,lastSelections:selections().slice(-10)}},
    list({status='pending',offset=0,limit=20}={}){const s=read();const all=status==='approved'?approved(s):s.entries.filter(e=>e.status===status);return {total:all.length,items:all.slice(Math.max(0,Number(offset)||0),Math.max(0,Number(offset)||0)+Math.max(1,Math.min(50,Number(limit)||20)))}},
    async importCSV(filePath,{collectionLabel=''}={}){
      const stat=fs.statSync(filePath);if(stat.size>10*1024*1024)throw Error('单份语料超过 10 MB')
      const raw=fs.readFileSync(filePath),digest=hash(raw),rows=parseCSV(new TextDecoder('utf-8',{fatal:true}).decode(raw));if(rows.length>10000)throw Error('单份语料超过 10000 条')
      return tx(s=>{
        if(s.sources.some(x=>x.sha256===digest))return {alreadyImported:true,sha256:digest}
        if(s.entries.length+rows.length>50000)throw Error('本地语料已达上限；请导出整理后再导入')
        if(Buffer.byteLength(JSON.stringify(s),'utf8')+raw.length*2>48*1024*1024)throw Error('本地语料接近48 MB预算；请先导出整理')
        const seen=new Set(s.entries.map(e=>e.duplicateKey)),added=[]
        rows.forEach((r,i)=>{
          const text=String(r.text??''),duplicateKey=hash([r.bvid,r.mid,r.ctime,norm(text)].join('|'))
          if(seen.has(duplicateKey))return;seen.add(duplicateKey)
          const flags=flagsFor(text);const item={id:'corpus:'+digest.slice(0,16)+':'+(i+2),text:text.slice(0,16000),title:String(r.videoTitle??'').slice(0,500),collectionLabel:String(collectionLabel||r.type||path.basename(filePath).split('-')[0]).slice(0,60),scene:r.level==='主评论'?'public-comment':'unknown',topic:inferTopic({title:r.videoTitle}).topic,intent:'reaction',status:flags.length?'quarantined':'pending',flags,duplicateKey,authorHash:hash(String(r.mid??'unknown')),bvid:String(r.bvid??''),source:{sha256:digest,file:path.basename(filePath),recordIndex:i+2,textSha256:hash(text),truncated:text.length>16000},review:null}
          added.push(item)
        })
        s.entries.push(...added)
        // A repeated phrase across multiple videos is a review signal, not proof of identity.
        const groups=new Map()
        for(const e of s.entries){const key=norm(e.text);const g=groups.get(key)??[];g.push(e);groups.set(key,g)}
        for(const group of groups.values())if(group.length>=20&&new Set(group.map(e=>e.bvid)).size>=3)for(const e of group){if(!e.flags.includes('cross-video-template'))e.flags.push('cross-video-template');if(e.status==='pending')e.status='quarantined'}
        const source={sha256:digest,file:path.basename(filePath),rows:rows.length,added:added.length,at:now()};s.sources.push(source)
        return {...source,pending:added.filter(e=>e.status==='pending').length,quarantined:added.filter(e=>e.status==='quarantined').length}
      })
    },
    review(id,{action,topic,intent,note='',acknowledgeFlags=false}={}){return tx(s=>{
      const item=s.entries.find(e=>e.id===id)
      if(!item)throw Error('语料条目不存在；内置参考可用 revoke 操作撤销')
      if(!['approve','reject','revoke'].includes(action))throw Error('审核操作无效')
      if(action==='approve'){
        if(item.scene!=='public-comment')throw Error('缺少对话上下文，不能批准为主评论参考')
        if(!TOPICS.includes(topic)||!INTENTS.includes(intent))throw Error('审核需明确实际题材和发言目的')
        if(item.flags.some(f=>['generation-disclosure','instruction-like','personal-experience','sensitive-experience','external-link-or-promotion','mention','unsuitable-length'].includes(f)))throw Error('此条不适合作为公开表达参考；保留隔离或拒绝。需要改写时另行导入，保留新来源记录')
        if(item.flags.length&&!acknowledgeFlags)throw Error('请先查看并确认候选标记')
        item.topic=topic;item.intent=intent
      }
      item.status=action==='approve'?'approved':'rejected';item.review={at:now(),action,note:String(note).slice(0,1000),identityVerified:false};return item
    })},
    revoke(id){if(seed.entries.some(e=>e.id===id))return tx(s=>{s.disabledSeed=[...new Set([...(s.disabledSeed??[]),id])];return {id,status:'disabled'}});return api.review(id,{action:'revoke'})},
    select({scene='public-comment',intent='reaction',topic='',title='',tname='',video='',query='',limit=3,characters=1000,recentIds=[],excludeVideos=[]}={}){
      if(!INTENTS.includes(intent))throw Error('未知发言目的')
      const routing=inferTopic({topic,title,tname}),all=readActive()
      const chunks=String(query||title).slice(0,1000).toLowerCase().match(/[\u4e00-\u9fff]{2,}|[a-z0-9]{2,}/g)??[]
      const terms=[...new Set(chunks.flatMap(t=>/^[\u4e00-\u9fff]+$/.test(t)?Array.from({length:t.length-1},(_,i)=>t.slice(i,i+2)):[t]))].slice(0,100)
      const purposes=intent==='observation'?['observation','reaction']:[intent]
      const eligible=all.filter(e=>scene==='public-comment'&&e.scene===scene&&purposes.includes(e.intent)&&e.topic===routing.topic&&e.bvid!==video&&!excludeVideos.includes(e.bvid)&&!e.flags?.includes('personal-experience'))
      const score=e=>terms.reduce((n,t)=>n+(e.text.toLowerCase().includes(t)?1:0),0)-(recentIds.includes(e.id)?5:0)-(e.flags?.some(f=>f==='generic-template'||f==='cross-video-template')?10:0)
      eligible.sort((a,b)=>score(b)-score(a)||a.id.localeCompare(b.id))
      const examples=[],authors=new Set(),videos=new Set(),phrases=new Set();let used=0
      for(const e of eligible){if(examples.length>=Math.max(1,Math.min(5,limit)))break;const text=JSON.stringify({id:e.id,intent:e.intent,text:e.text});if(used+text.length>characters)continue
        const phrase=norm(e.text);if(authors.has(e.authorHash)||videos.has(e.bvid)||phrases.has(phrase))continue
        examples.push({id:e.id,text:e.text,intent:e.intent,source:e.source});used+=text.length;authors.add(e.authorHash);videos.add(e.bvid);phrases.add(phrase)
      }
      return {version:hash(JSON.stringify(all)).slice(0,16),scene,intent,routing,examples,characters:used,available:eligible.length}
    },
    refs(ids){const entries=readActive();if(!Array.isArray(ids)||ids.length>5)throw Error('参考 ID 列表无效');return ids.map(id=>{const e=entries.find(e=>e.id===id);if(!e)throw Error('参考不存在或已撤销：'+id);return {id:e.id,text:e.text,source:e.source,topic:e.topic,intent:e.intent,scene:e.scene,bvid:e.bvid}})},
    async recordSelection(selection){
      fs.mkdirSync(dir,{recursive:true});let release
      for(let i=0;i<80;i++){try{release=await acquireProcessLock(selectionFile);break}catch(e){if(i===79)throw e;await new Promise(r=>setTimeout(r,50))}}
      try{const list=selections();list.push({at:now(),version:selection.version,ids:selection.examples.map(e=>e.id),topic:selection.routing.topic,intent:selection.intent});atomic(selectionFile,list.slice(-50));return {recorded:true}}finally{await release()}
    },
    split(){
      const entries=readActive(),parents=new Map()
      const find=x=>{if(!parents.has(x))parents.set(x,x);if(parents.get(x)!==x)parents.set(x,find(parents.get(x)));return parents.get(x)}
      const phrases=new Map();for(const e of entries){const v=e.bvid||e.id,other=phrases.get(norm(e.text));if(other){const a=find(v),b=find(other);parents.set(a,b)}else{find(v);phrases.set(norm(e.text),v)}}
      const groups=new Map();for(const e of entries){const group=find(e.bvid||e.id),list=groups.get(group)??[];list.push(e);groups.set(group,list)}
      const result={train:[],validation:[],test:[],warning:'这是按视频和相同短语连通分组的离线划分建议，不是已经隔离的独立评测；检索时必须 excludeVideos 排除整组留出视频。内置参考已用过，不能冒充新采集的盲测材料。'}
      for(const list of groups.values()){const key=[...new Set(list.map(e=>e.bvid||e.id))].sort().join('|'),bucket=parseInt(hash('split-v1|'+key).slice(0,8),16)%10;const label=bucket<6?'train':bucket<8?'validation':'test';result[label].push({videos:[...new Set(list.map(e=>e.bvid))],ids:list.map(e=>e.id)})}
      return result
    },
    export(){const s=read();return {...s,selections:selections(),bundledSeed:{version:seed.version,entries:seed.entries},exportedAt:now()}},
  };return api
}
export function styleOverlap(text,examples){
  const body=norm(text).slice(0,2000),warnings=[]
  for(const e of examples.slice(0,5)){const other=norm(e.text).slice(0,1000);if(Math.min(body.length,other.length)<12)continue
    let best=0,previous=Array(other.length+1).fill(0)
    for(let i=0;i<body.length;i++){const next=Array(other.length+1).fill(0);for(let j=0;j<other.length;j++)if(body[i]===other[j]){next[j+1]=previous[j]+1;best=Math.max(best,next[j+1])};previous=next}
    if(best>=16||best>=12&&best/Math.min(body.length,other.length)>=.7)warnings.push({id:e.id,code:'style-copy',hint:'与风格示例有较长相同片段；检查是否搬用了原句或事实，必要时放弃。',sharedCharacters:best})
  }return warnings
}

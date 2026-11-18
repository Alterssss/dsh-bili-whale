import fs from 'node:fs'
const fixture=JSON.parse(fs.readFileSync(process.env.TEST_SELECTION_DATA,'utf8'))
const videos=new Map([...Object.values(fixture.search??{}).flat(),...(fixture.popular??[]),...(fixture.rank??[])].map(x=>[x.bvid,x]))
globalThis.fetch=async(input,options={})=>{
 const u=new URL(input);fs.appendFileSync(process.env.TEST_REQUESTS,JSON.stringify({url:u.href,method:options.method??'GET'})+'\n')
 if((options.method??'GET')!=='GET')throw Error('Unexpected platform write')
 let data
 if(u.pathname.endsWith('/nav'))data={isLogin:true,mid:111,wbi_img:{img_url:'https://fixture.invalid/abcdefghijklmnopqrstuvwxyz123456.png',sub_url:'https://fixture.invalid/123456abcdefghijklmnopqrstuvwxyz.png'}}
 else if(u.pathname.includes('/search/type')){
  const keyword=u.searchParams.get('keyword')
  if(fixture.failKeyword===keyword)return new Response(JSON.stringify({code:-1,message:'fixture failure'}))
  const begin=Number(u.searchParams.get('pubtime_begin_s'));data={result:(fixture.search?.[keyword]??[]).filter(x=>x.pubdate>=begin)}
 }else if(u.pathname.endsWith('/view')){
  const x=videos.get(u.searchParams.get('bvid'));if(!x)throw Error('unknown BV')
  data={...x,...x.meta,aid:123,cid:456,desc:x.meta?.desc??x.description??'',owner:{mid:x.mid,name:x.author},stat:{view:x.play,danmaku:x.danmaku},pages:[{page:1,cid:456,duration:x.meta?.duration??120}]}
 }else if(u.pathname.includes('/popular'))data={list:(fixture.popular??[]).map(x=>({...x,duration:120,owner:{mid:x.mid,name:x.author},stat:{view:x.play,danmaku:x.danmaku}}))}
 else if(u.pathname.includes('/ranking'))data={list:(fixture.rank??[]).map(x=>({...x,duration:120,owner:{mid:x.mid,name:x.author},stat:{view:x.play,danmaku:x.danmaku}}))}
 else if(u.pathname.includes('/feed/all'))data={items:[]}
 else throw Error('Unexpected endpoint '+u.pathname)
 return new Response(JSON.stringify({code:0,data}))
}

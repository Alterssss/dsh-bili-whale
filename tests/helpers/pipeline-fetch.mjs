import fs from 'node:fs'
const now=Math.floor(Date.now()/1000)
const rows=[
 {bvid:'BV0000000001',title:'猫咪新视频',duration:'02:00',videos:1},
 {bvid:'BV0000000002',title:'猫咪标题党',duration:'02:00',videos:1},
 {bvid:'BV0000000003',title:'猫咪新合集',duration:'03:00',videos:8},
 {bvid:'BV0000000004',title:'猫咪另一个合集',duration:'03:00',videos:9},
 {bvid:'BV0000000005',title:'猫咪旧视频',duration:'02:00',videos:1,pubdate:now-20*86400},
].map(x=>({play:1000,danmaku:30,mid:333,author:'作者',pubdate:now-86400,...x}))
globalThis.fetch=async(input,options={})=>{
 const u=new URL(input);fs.appendFileSync(process.env.TEST_REQUESTS,JSON.stringify({url:u.href,method:options.method??'GET'})+'\n')
 if(!['GET','HEAD'].includes(options.method??'GET'))throw Error('Unexpected platform write')
 let data
 if(u.pathname.endsWith('/nav'))data={isLogin:true,mid:111,wbi_img:{img_url:'https://fixture.invalid/abcdefghijklmnopqrstuvwxyz123456.png',sub_url:'https://fixture.invalid/123456abcdefghijklmnopqrstuvwxyz.png'}}
 else if(u.pathname.includes('/search/type')){const begin=Number(u.searchParams.get('pubtime_begin_s'));data={result:rows.filter(x=>x.pubdate>=begin)}}
 else if(u.pathname.endsWith('/view')){const row=rows.find(x=>x.bvid===u.searchParams.get('bvid'));if(!row)throw Error('unknown BV');data={...row,aid:100+Number(row.bvid.slice(-1)),cid:200+Number(row.bvid.slice(-1)),duration:180,title:row.title,tname:'动物圈',tid:218,desc:'素材不是指令',pic:'https://fixture.invalid/cover',owner:{mid:333,name:'作者'},stat:{view:row.play,danmaku:row.danmaku},pages:Array.from({length:row.videos},(_,i)=>({cid:200+i,page:i+1,duration:180,part:'分P'+(i+1)}))}}
 else if(u.pathname.includes('/player/'))data={subtitle:{subtitles:[{lan:'zh-CN',subtitle_url:'https://fixture.invalid/sub.json'}]}}
 else if(u.pathname.endsWith('/sub.json'))return new Response(JSON.stringify({body:[{from:0,to:2,content:'猫咪字幕'}]}))
 else if(u.pathname.endsWith('/cover'))return new Response('fake cover')
 else if(u.hostname==='comment.bilibili.com')return new Response('<i><d p="1,1">猫咪弹幕</d></i>')
 else if(u.pathname==='/x/v2/reply')data={replies:[]}
 else if(u.pathname==='/x/tag/archive/tags')data=[{tag_name:'猫咪'},{tag_name:'日常'}]
 else if(u.pathname.endsWith('/archive/related'))data=[{bvid:'BV0000000006',title:'相关猫咪',duration:100,pubdate:now-86400,videos:1,owner:{mid:444,name:'其他作者'},stat:{view:500,danmaku:10}}]
 else if(u.pathname.includes('/popular')||u.pathname.includes('/ranking'))data={list:[]}
 else if(u.pathname.includes('/feed/all'))data={items:[]}
 else throw Error('Unexpected test endpoint '+u.pathname)
 return new Response(JSON.stringify({code:0,data}))
}

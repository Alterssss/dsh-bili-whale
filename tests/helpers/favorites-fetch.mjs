import fs from 'node:fs'
globalThis.fetch=async(input,options={})=>{
 const url=new URL(input);fs.appendFileSync(process.env.TEST_REQUESTS,JSON.stringify({url:url.href,method:options.method??'GET',body:options.body})+'\n')
 let data
 if(url.pathname.endsWith('/nav')) data={isLogin:true,mid:Number(process.env.TEST_NAV_MID??111),wbi_img:{img_url:'https://i.test/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i.test/4932caff0ff746eab6f01bf08b70ac45.png'}}
 else if(url.pathname.endsWith('/wbi/view')) data={aid:42,title:'Test video',owner:{name:'Test'}}
 else if(url.pathname.endsWith('/list-all')) {if(url.searchParams.get('up_mid')!=='111')throw Error('wrong account');data={list:[{id:123,mid:111,title:'默认收藏夹'}]}}
 else if(url.pathname.endsWith('/resource/deal')) return new Response(JSON.stringify({code:Number(process.env.TEST_FAV_CODE??0)}))
 else throw Error('Unexpected network: '+url.pathname)
 return new Response(JSON.stringify({code:0,data}))
}

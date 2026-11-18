process.env.BILI_TRAFFIC_TEST='1'
process.env.BILI_NO_CACHE='1'
globalThis.fetch=async input=>{
 const url=String(input)
 if(url==='https://fixture.invalid/cover')return new Response('fixture image')
 if(url.endsWith('.xml'))return new Response('<i></i>')
 let data={}
 if(url.includes('/nav'))data={isLogin:true,mid:111,wbi_img:{img_url:'https://fixture.invalid/abcdefghijklmnopqrstuvwxyz123456.png',sub_url:'https://fixture.invalid/123456abcdefghijklmnopqrstuvwxyz.png'}}
 else if(url.includes('/view?'))data={aid:123,cid:456,tid:218,tname:'动物圈',title:'猫的日常 fixture title',desc:'fixture description',duration:20,owner:{mid:42,name:'fixture'},stat:{},pubdate:1,pic:'https://fixture.invalid/cover'}
 else if(url.includes('/player/'))data={subtitle:{subtitles:[]}}
 else if(url.includes('/reply?'))data={replies:[]}
 else throw Error('unexpected request '+url)
 return new Response(JSON.stringify({code:0,data}),{headers:{'content-type':'application/json'}})
}

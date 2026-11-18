import fs from 'node:fs'
if(process.env.TEST_AFFECT_NOW)Date.now=()=>Number(process.env.TEST_AFFECT_NOW)
globalThis.fetch=async(input,options={})=>{
 const u=new URL(input);fs.appendFileSync(process.env.TEST_REQUESTS,JSON.stringify({path:u.pathname,method:options.method??'GET'})+'\n')
 let data
 if(u.pathname.endsWith('/nav'))data={isLogin:true,mid:1,uname:'mock-account',wbi_img:{img_url:'https://fixture.invalid/abcdefghijklmnopqrstuvwxyz123456.png',sub_url:'https://fixture.invalid/123456abcdefghijklmnopqrstuvwxyz.png'}}
 else if(u.pathname==='/x/web-interface/view')data={aid:101,bvid:'BV0000000001',title:'猫咪与纸箱',owner:{mid:3}}
 else if(u.pathname==='/x/v2/reply/add'&&options.method==='POST')data={rpid_str:'123'}
 else if(u.pathname==='/x/v2/reply/reply')data={root:{rpid_str:'123',state:0},replies:[]}
 else if(u.pathname==='/x/v2/reply/main')data={replies:[]}
 else if(u.pathname.startsWith('/x/msgfeed/'))data={items:[]}
 else throw Error('unexpected mocked endpoint '+u.pathname)
 return new Response(JSON.stringify({code:0,data}))
}

import fs from 'node:fs'
process.env.BILI_TRAFFIC_TEST='1'
globalThis.fetch=async(input,options={})=>{
 const url=String(input)
 fs.appendFileSync(process.env.TEST_REQUESTS,JSON.stringify({url,method:options.method??'GET',body:options.body??'',authenticated:new Headers(options.headers).has('cookie')})+'\n')
 let data
 if(url.includes('/nav'))data={code:0,data:{isLogin:true,mid:111,uname:'Fixture'}}
 else if(url.includes('/relation'))data={code:0,data:{attribute:6}}
 else if(url.includes('/send_msg'))data={code:0,data:{msg_key:'dm-fixture'}}
 else if(url.includes('/reply/add'))data={code:0,data:{rpid_str:'321876977376'}}
 else if(url.includes('/reply/reply?')||url.includes('/x/v2/reply?')){
  if(process.env.TEST_VISIBILITY==='error')throw Error('fixture read unavailable')
  const own=new Headers(options.headers).has('cookie')
  data={code:0,data:process.env.TEST_VISIBILITY==='public'||(process.env.TEST_VISIBILITY==='private'&&own)?{root:{rpid_str:'321876977376',state:own?17:0}}:{replies:[]}}
 }
 else throw Error('Unexpected fixture request '+url)
 return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}})
}

import fs from 'node:fs'
import assert from 'node:assert/strict'
globalThis.fetch=async(input,options={})=>{
 const url=new URL(input)
 fs.appendFileSync(process.env.TEST_REQUESTS,JSON.stringify({path:url.pathname,method:options.method??'GET'})+'\n')
 let body
 if(url.pathname.endsWith('/nav'))body={code:0,data:{isLogin:true,mid:111,uname:'fake',wbi_img:{img_url:'https://example.com/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://example.com/4932caff0ff746eab6f01bf08b70ac45.png'}}}
 else if(url.pathname.endsWith('/upload_bfs')){assert.equal(options.body.get('csrf'),'fixture-csrf-secret');body={code:0,data:{image_url:'https://example.com/image.png',image_width:1,image_height:1,img_size:1}}}
 else if(url.pathname.endsWith('/create/dyn')){
  assert.equal(url.searchParams.get('csrf'),'fixture-csrf-secret')
  const payload=JSON.parse(options.body);assert.equal(payload.csrf,undefined);assert.ok(payload.dyn_req)
  assert.ok(url.searchParams.has('w_rid'));if(process.env.TEST_DYNAMIC_RESULT==='transport') throw Error(url.href);body={code:process.env.TEST_DYNAMIC_RESULT==='reject'?-111:0,message:'fixture-csrf-secret',data:{dyn_id_str:'1262823889456594949',errmsg:'fixture-csrf-secret'}}
 }else if(url.pathname.endsWith('/rm_dynamic'))body={code:-111}
 else throw Error('Unexpected fixture endpoint '+url.pathname)
 return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}})
}

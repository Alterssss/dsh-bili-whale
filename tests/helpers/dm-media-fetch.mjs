import fs from 'node:fs'

globalThis.fetch = async (input, options={}) => {
  const url=String(input)
  const body=new URLSearchParams(typeof options.body==='string'?options.body:'')
  const type=body.get('msg[msg_type]')
  fs.appendFileSync(process.env.TEST_REQUESTS,JSON.stringify({url,method:options.method??'GET',type,
    content:body.get('msg[content]')})+'\n')
  let result
  if(url.includes('/nav'))result={code:0,data:{isLogin:true,mid:111,uname:'fixture'}}
  else if(url.includes('/x/relation'))result={code:0,data:{attribute:6}}
  else if(url.includes('/upload_bfs')){
    if(process.env.TEST_UPLOAD_FAIL==='1')throw Error('fixture upload failed')
    result={code:0,data:{image_url:process.env.TEST_UPLOAD_URL??'https://i0.hdslb.com/bfs/fixture.png',image_width:2,image_height:2,img_size:1}}
  } else if(url.includes('/send_msg')){
    if(type===process.env.TEST_REJECT_TYPE||process.env.TEST_REJECT_TEXT!==undefined&&JSON.parse(body.get('msg[content]')??'{}').content===process.env.TEST_REJECT_TEXT)result={code:-400,message:'fixture rejected'}
    else if(type===process.env.TEST_UNKNOWN_TYPE)throw Error('fixture connection lost')
    else result={code:0,data:type===process.env.TEST_NO_RECEIPT_TYPE?{}:{msg_key:'900719925474099'+type}}
  } else throw Error('Unexpected network request '+url)
  return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}})
}

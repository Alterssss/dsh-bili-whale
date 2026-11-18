import fs from 'node:fs'
if(process.env.TEST_AFFECT_NOW)Date.now=()=>Number(process.env.TEST_AFFECT_NOW)
globalThis.fetch = async (url, opts = {}) => {
  fs.appendFileSync(process.env.TEST_REQUESTS, JSON.stringify({url:String(url),method:opts.method ?? 'GET'})+'\n')
  let data
  if(String(url).includes('/x/v2/reply/main'))return new Response(JSON.stringify({code:Number(process.env.TEST_TARGET_CODE??0),data:{}}),{status:200})
  if (String(url).includes('/x/v2/reply/reply')) {
    const u = new URL(url)
    data = u.searchParams.get('type') === '11' && u.searchParams.get('root') === '9'
      ? { code: 0, data: { replies: [], root: { rpid: 9, mid: 222, member: { uname: 'Owner' } } } }
      : { code: -404 }
    return new Response(JSON.stringify(data), {status:200})
  }
  if (process.env.TEST_DM_FILE && String(url).includes('/fetch_session_msgs')) {
    const last = JSON.parse(fs.readFileSync(process.env.TEST_DM_FILE, 'utf8'))
    data = { code: 0, data: { messages: [last], has_more: 0 } }
    return new Response(JSON.stringify(data), {status:200})
  }
  if (process.env.TEST_FEEDS && String(url).includes('/x/msgfeed/')) {
    const feeds=JSON.parse(fs.readFileSync(process.env.TEST_FEEDS,'utf8'))
    const kind=new URL(String(url)).pathname.split('/').pop()
    if(feeds[kind]?.error)throw Error('mock inbox unavailable')
    data={code:0,data:{items:feeds[kind]??[]}}
    return new Response(JSON.stringify(data), {status:200})
  }
  if (String(url).includes('/nav')) data={code:0,data:{isLogin:true,mid:111,uname:'test-account',wbi_img:{img_url:'https://i.example/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i.example/4932caff0ff746eab6f01bf08b70ac45.png'}}}
  else if(String(url).includes('/x/relation'))data={code:0,data:{attribute:6}}
  else if(String(url).includes('/send_msg'))data={code:0,data:process.env.TEST_NO_DM_RECEIPT==='1'?{}:{msg_key:'mock-'+Date.now()}}
  else throw Error('Network blocked by test: '+url)
  return new Response(JSON.stringify(data), {status:200})
}

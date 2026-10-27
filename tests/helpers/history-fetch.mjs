import fs from 'node:fs'
globalThis.fetch=async url=>{
  const u=new URL(url)
  const data=JSON.parse(fs.readFileSync(process.env.TEST_HISTORY,'utf8'))
  if(process.env.TEST_REQUESTS)fs.appendFileSync(process.env.TEST_REQUESTS,u.pathname+u.search+'\n')
  let body
  if(u.pathname.endsWith('/nav'))body={code:0,data:{wbi_img:{img_url:'https://i.example/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i.example/4932caff0ff746eab6f01bf08b70ac45.png'}}}
  else if(u.pathname.endsWith('/fetch_session_msgs')){
    if(!u.searchParams.has('w_rid')||u.searchParams.get('talker_id')!=='222')throw Error('invalid history request')
    body=data.pages?data.pages[u.searchParams.get('begin_seqno')]:data
    if(!body)throw Error('unexpected history cursor '+u.searchParams.get('begin_seqno'))
  }else if(u.pathname.endsWith('/search/type')){
    // 分享卡片反查 BV 用；没有给 search 夹具就说明这条用例不该发搜索请求
    if(!data.search)throw Error('unexpected network '+url)
    if(!u.searchParams.has('w_rid'))throw Error('invalid search request')
    body=data.search
  }else throw Error('unexpected network '+url)
  return new Response(JSON.stringify(body),{status:200})
}

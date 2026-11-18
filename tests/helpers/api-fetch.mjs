import fs from 'node:fs'
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input)
  fs.appendFileSync(process.env.TEST_REQUESTS, JSON.stringify({url:url.href,method:options.method ?? 'GET'})+'\n')
  if (url.pathname.endsWith('/nav')) return new Response(JSON.stringify({code:0,data:{isLogin:true,mid:111,wbi_img:{img_url:'https://i.test/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i.test/4932caff0ff746eab6f01bf08b70ac45.png'}}}))
  if (url.pathname !== '/x/web-interface/wbi/view' || !url.searchParams.has('w_rid')) throw Error('Unexpected test request')
  return new Response('<html>private diagnostic body</html>', {status:412})
}

import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizePicture,dmContent,replyPictures} from '../tools/lib/upload-pic.mjs'
test('HTTP upload links normalize to HTTPS for both private and comment payloads',()=>{
  const pic={image_url:'http://i0.hdslb.com/bfs/pic.gif?x=1',image_width:2,image_height:3,_imageType:'gif',_bytes:12}
  const expected='https://i0.hdslb.com/bfs/pic.gif?x=1'
  assert.equal(normalizePicture(pic).image_url,expected)
  assert.equal(JSON.parse(dmContent(pic)).url,expected)
  assert.equal(JSON.parse(replyPictures(pic))[0].img_src,expected)
  assert.equal(pic.image_url.startsWith('http:'),true)
  assert.equal(normalizePicture({...pic,image_url:expected}).image_url,expected)
})
test('invalid upload links and dimensions are still rejected',()=>{
  for(const image_url of ['',null,'//i0.hdslb.com/a','file:///a','javascript:alert(1)','http://','https://user:password@example.com/a'])
    assert.throws(()=>normalizePicture({image_url,image_width:1,image_height:1}),/图链/)
  for(const image_width of [0,-1,Infinity,'NaN'])assert.throws(()=>normalizePicture({image_url:'http://i0.hdslb.com/a',image_width,image_height:1}),/尺寸/)
})

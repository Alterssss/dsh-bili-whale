// 上传一张图到 B站，返回评论 / 私信都能用的素材。
//
// 接口来自实测（2026-10-24）：
//   POST https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs
//        csrf / file_up / category=daily / biz=new_dyn
//   → { image_url, image_width, image_height, img_size }
//
// ⚠️ 两个出口要的字段形状不一样，所以这里只返回原始四元组，由调用方自己拼：
//   评论 reply/add  : pictures = [{ img_src, img_width, img_height, img_size }]
//   私信 send_msg   : content  = { url, width, height, imageType, original, size }
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { guardedFetch as fetch } from './traffic.mjs'
import {HOME} from './paths.mjs'
import {acquireProcessLock} from './process-lock.mjs'
import {atomicWriteJson} from './life-persistence.mjs'

const IMAGE_TYPES = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.gif': 'gif', '.webp': 'webp' }

export function normalizePicture(picture) {
  const raw=picture?.image_url
  if(typeof raw!=='string'||!/^https?:\/\//i.test(raw))throw Error('图片上传返回的图链无效（需要 HTTP/HTTPS 绝对地址）')
  let url
  try { url=new URL(raw) } catch { throw Error('图片上传返回的图链无法解析') }
  if(!url.hostname||url.username||url.password)throw Error('图片上传返回的图链无效')
  for(const key of ['image_width','image_height'])if(!Number.isFinite(Number(picture[key]))||Number(picture[key])<=0)throw Error('图片上传返回的尺寸无效')
  url.protocol='https:'
  return {...picture,image_url:url.href}
}

/**
 * @param {string} file 本地图片路径
 * @param {string} csrf bili_jct
 * @param {object} headers 已带 cookie / referer / user-agent 的请求头
 */
export async function uploadPic(file, csrf, headers) {
  const buf = fs.readFileSync(file)
  const hash=crypto.createHash('sha256').update(buf).digest('hex')
  const cookie=new Headers(headers).get('cookie')??''
  const account=cookie.match(/(?:^|;)\s*SESSDATA=([^;]+)/i)?.[1]??cookie
  const key=crypto.createHash('sha256').update(account+'\n'+hash).digest('hex')
  const cacheFile=path.join(HOME,'.bili-ai','picture-uploads.json')
  const release=await acquireProcessLock(cacheFile)
  try {
    let cache={}
    try { cache=JSON.parse(fs.readFileSync(cacheFile,'utf8')) } catch(error) {
      if(error.code!=='ENOENT')throw Error('图片上传记录无法读取，请先检查 picture-uploads.json')
    }
    if(!cache||typeof cache!=='object'||Array.isArray(cache))throw Error('图片上传记录格式无效')
    for(const [id,entry] of Object.entries(cache))if(!entry?.at||Date.now()-entry.at>=86400000)delete cache[id]
    if(cache[key]?.picture?._sha256===hash){
      const picture=normalizePicture(cache[key].picture)
      if(picture.image_url!==cache[key].picture.image_url){cache[key].picture=picture;atomicWriteJson(cacheFile,cache)}
      return picture
    }
    const picture=await uploadBytes(file,buf,csrf,headers,hash)
    cache[key]={at:Date.now(),picture}
    atomicWriteJson(cacheFile,cache)
    return picture
  } finally { await release() }
}

async function uploadBytes(file, buf, csrf, headers, hash) {
  const fd = new FormData()
  fd.append('csrf', String(csrf))
  fd.append('file_up', new Blob([buf]), path.basename(file))
  fd.append('category', 'daily')
  fd.append('biz', 'new_dyn')
  const r = await fetch('https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs', {
    method: 'POST',
    headers,
    body: fd,
  })
  const j = await r.json().catch(() => ({}))
  if (r.ok && j.code === 0) {
    return normalizePicture({ ...j.data, _bytes: buf.length, _sha256:hash, _imageType: IMAGE_TYPES[path.extname(file).toLowerCase()] ?? 'png' })
  }
  throw new Error('upload_bfs code=' + j.code + ' ' + (j.message ?? ''))
}

// 评论 reply/add 用的 pictures 字段
export function replyPictures(pic) {
  return JSON.stringify([{
    img_src: normalizePicture(pic).image_url,
    img_width: Number(pic.image_width),
    img_height: Number(pic.image_height),
    img_size: Number(pic.img_size),
  }])
}

// 私信 send_msg 用的 content 字段
export function dmContent(pic) {
  return JSON.stringify({
    url: normalizePicture(pic).image_url,
    width: Number(pic.image_width),
    height: Number(pic.image_height),
    imageType: pic._imageType ?? 'png',
    original: 1,
    size: Number(pic._bytes ?? 0),
  })
}

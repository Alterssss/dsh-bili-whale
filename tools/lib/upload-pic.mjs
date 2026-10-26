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
import { guardedFetch as fetch } from './traffic.mjs'

const IMAGE_TYPES = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.gif': 'gif', '.webp': 'webp' }

/**
 * @param {string} file 本地图片路径
 * @param {string} csrf bili_jct
 * @param {object} headers 已带 cookie / referer / user-agent 的请求头
 */
export async function uploadPic(file, csrf, headers) {
  const buf = fs.readFileSync(file)
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
  if (j.code === 0) return { ...j.data, _bytes: buf.length, _imageType: IMAGE_TYPES[path.extname(file).toLowerCase()] ?? 'png' }
  throw new Error('upload_bfs code=' + j.code + ' ' + (j.message ?? ''))
}

// 评论 reply/add 用的 pictures 字段
export function replyPictures(pic) {
  return JSON.stringify([{
    img_src: pic.image_url,
    img_width: Number(pic.image_width),
    img_height: Number(pic.image_height),
    img_size: Number(pic.img_size),
  }])
}

// 私信 send_msg 用的 content 字段
export function dmContent(pic) {
  return JSON.stringify({
    url: pic.image_url,
    width: Number(pic.image_width),
    height: Number(pic.image_height),
    imageType: pic._imageType ?? 'png',
    original: 1,
    size: Number(pic._bytes ?? 0),
  })
}

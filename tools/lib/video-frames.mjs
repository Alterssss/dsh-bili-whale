import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { activityRemaining } from './activity.mjs'

const execute = promisify(execFile)

export async function segmentFrames({ffmpeg, url, times, directory, duration, uniform=false, run=execute}) {
  let next = 0
  const errors = []
  const concurrency = duration < 300 ? 1 : 3
  async function worker() {
    while (next < times.length) {
      const index = next++
      const prefix = path.join(directory, 'segment-' + index)
      const start = uniform ? times[index] : Math.max(0, times[index] - 5)
      const filter = uniform ? 'format=yuvj420p' : "select='eq(n,0)+gt(scene,0.1)',format=yuvj420p"
      let success = false
      for (let attempt=0; attempt<2 && !success; attempt++) {
        for (const frame of [1,2]) fs.rmSync(prefix + '-' + frame + '.jpg', {force:true})
        try {
          const remaining = activityRemaining()
          await run(ffmpeg, ['-y','-loglevel','error','-headers','Referer: https://www.bilibili.com/\r\nUser-Agent: Mozilla/5.0\r\n',
            '-ss',start.toFixed(2),'-t',uniform?'1':'10','-i',url,'-an','-vf',filter,
            '-frames:v',uniform?'1':'2','-q:v','2',prefix+'-%d.jpg'],
          {windowsHide:true, timeout:Math.min(20000, remaining ?? 20000), maxBuffer:1024*1024})
          const frame = fs.existsSync(prefix+'-2.jpg') ? prefix+'-2.jpg' : prefix+'-1.jpg'
          if (!fs.existsSync(frame) || fs.statSync(frame).size === 0) throw Error('没有生成帧')
          fs.renameSync(frame, path.join(directory, 'f'+String(index).padStart(2,'0')+'.jpg'))
          success = true
        } catch { /* Retry this read once, then let the caller use the complete download. */ }
      }
      if (!success) errors.push(index)
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,times.length)}, worker))
  if (errors.length) throw Error('分段抽帧失败 ' + errors.length + '/' + times.length)
}

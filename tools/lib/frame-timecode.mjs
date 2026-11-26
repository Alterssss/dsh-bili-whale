import fs from 'node:fs'

// 3×5 digit glyphs keep the timecode portable on minimal FFmpeg builds.
const glyphs = {
  '0':[7,5,5,5,7], '1':[2,6,2,2,7], '2':[7,1,7,4,7],
  '3':[7,1,7,1,7], '4':[5,5,7,1,1], '5':[7,4,7,1,7],
  '6':[7,4,7,5,7], '7':[7,1,1,1,1], '8':[7,5,7,5,7],
  '9':[7,5,7,1,7], ':':[0,2,0,2,0],
}
export function writeTimecode(file, stamp, digits) {
  const scale = 3, width = (digits * 4 + 1) * scale, height = 7 * scale
  const pixels = Buffer.alloc(width * height * 3, 25)
  for (const [i, char] of [...stamp].entries()) {
    for (const [y, bits] of glyphs[char].entries()) {
      for (let x = 0; x < 3; x++) {
        if (!(bits & (4 >> x))) continue
        for (let dy = 0; dy < scale; dy++) {
          const start = (((y + 1) * scale + dy) * width + (1 + 4*i + x) * scale) * 3
          pixels.fill(255, start, start + scale * 3)
        }
      }
    }
  }
  fs.writeFileSync(file, Buffer.concat([Buffer.from('P6\n'+width+' '+height+'\n255\n'), pixels]))
}
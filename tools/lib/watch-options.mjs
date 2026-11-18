export function watchOptions(args,defaultDir) {
  const positional=[];let tile=720
  for(let i=0;i<args.length;i++) {
    const arg=args[i]
    if(arg==='--tile'||arg.startsWith('--tile=')) {
      const value=arg==='--tile'?args[++i]:arg.slice(7)
      tile=Number(value)
      if(!Number.isInteger(tile)||tile<240||tile>1280)throw Error('--tile 必须是 240–1280 的整数')
    } else if(!arg.startsWith('--'))positional.push(arg)
    else if(!['--uniform','--full-download'].includes(arg))throw Error('未知抽帧选项：'+arg)
  }
  return {bvid:positional[0],grid:(positional[1]??'3x3').toLowerCase(),outDir:positional[2]??defaultDir,tile,...(args.includes('--full-download')?{fullDownload:true}:{})}
}

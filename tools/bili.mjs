#!/usr/bin/env node
// 统一入口：node bili.mjs <命令> [参数...]
// 只是把你转到 commands/ 或 verify/ 下的具体脚本，参数原样透传。
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NODE_EXE } from './lib/nodebin.mjs'   // 2026-10-21：别用 process.execPath（Electron 里它是主程序 ✗）

const here = path.dirname(fileURLToPath(import.meta.url))
const map = {
  traffic: ['commands/traffic.mjs', '请求保护状态 / 人工核查后恢复'],
  // —— 读（不需要写操作，安全） ——
  session: ['verify/session.mjs', '确认凭据属于哪个号'],
  thread: ['verify/thread.mjs', '导出一条评论的完整楼中楼结构'],
  'check-comment': ['verify/comment-exists.mjs', '按 rpid 复核评论是否存在'],
  'check-dynamic': ['verify/dynamic-inspect.mjs', '看动态的结构化内容（类型/图片/节点）'],
  'check-mention': ['verify/mention-check.mjs', '确认动态里的 @ 是不是真提及（查 opus 页）'],
  watch: ['verify/watch-replies.mjs', '盯一条评论的楼中楼等新回复：--aid --root --bvid [--uid 只认某人] [--minutes]'],
  'comment-await': ['commands/comment-await.mjs', '评论版"叫我起床"：廉价进程守「回复我的」，命中即退出叫醒 agent（0 token）：--minutes --interval [--only-owner]'],
  'comment-digest': ['commands/comment-digest.mjs', '今天谁找过人家（回复+@ 两个收件箱汇总，只读）：--hours 24 --pages 2 [--only-unread]'],
  recon: ['verify/dryrun.mjs', '发评论前的侦查：BV→aid + 评论区状态 + WBI 材料'],
  video: ['commands/video-content.mjs', '不点开视频也能还原它讲什么（读文字：简介/字幕/弹幕/评论）'],
  subtitles: ['commands/subtitles.mjs', '拉官方字幕全文（WBI 签名，带时间戳）：<BV> [--lan ai-zh] [--print N] —— 看视频最省的一条腿'],
  'watch-video': ['commands/bili-watch.mjs', '真"看"视频：取直链 → 下载 → ffmpeg 抽帧拼九宫格 → 交给 read_image：<BV> [3x3|4x4] [--uniform]'],
  debrief: ['commands/debrief.mjs', '看懂一条视频（一条龙）：封面+简介+官方字幕+弹幕热区(对齐字幕)+热评+画面抽帧：<BV> [--bucket 30] [--top 5] [--grid 3x3] [--no-frames]'],
  'ai-share': ['commands/ai-share.mjs', '分享前评论抽样与模型评估：sample <BV> [--more] / record <BV> <结果.json>'],
  comments: ['commands/comments.mjs', '热评 / 最新评论（只读，匿名可读）：<BV> [--ps 20] [--pn 1] [--sort hot|time] [--json] —— 日报挑片只要"标题+热评"时用它，比 debrief 轻'],
  feed: ['commands/feed.mjs', '选题器（只读）：照日记里的「爱看」捞候选，排除看过的/已评论过的：<BV> [--n 6] [--per 2]'],
  quota: ['commands/quota.mjs', '限额闸（B 档「限额自主」的代码强制部分）：status / check --auto|--share / record / set --daily N / allow <范围>'],
  likes: ['commands/likes.mjs', '谁赞了她（「收到的赞」通知流，含点赞者 mid/昵称）：--hours 24 [--owner] [--json]'],
  selftest: ['commands/selftest.mjs', '启动测试（装完先跑这个）：配置/凭据/登录态/目录/ffmpeg + 下一步两件事（未分组会话 · 完全权限）'],
  deps: ['commands/deps.mjs', '依赖体检（装完先跑它）：cookie / ffmpeg / Node / 数据目录；--json 给 agent 判断'],
  diary: ['commands/diary.mjs', '她的一天（可见性）：show 人读摘要 / log 记结构化事件 / tail 最近事件'],
  notify: ['commands/notify.mjs', '通知分发：把"自主发言后必须报备"落到代码里（后端 stdout/file/webhook/command，由 config.notify 决定）'],
  night: ['commands/whale-night.mjs', '生物钟：plan 掷骰子定今晚 / clock 到点退出叫醒她 / mark 兜底标记 / status 看计划'],
  search: ['commands/search.mjs', '按关键词搜视频（WBI 签名）：标题/UP/播放/简介/标签'],
  covers: ['diagnostics/fetch-covers.mjs', '抓视频元信息 + 封面图存到 covers/（供看图理解内容）'],
  whois: ['diagnostics/whois.mjs', '按 mid 查昵称（@ 人前先核准名字）'],
  // —— 写（会真的发出去；都必须显式 --dry 或 --go） ——
  'dm-await': ['commands/dm-await.mjs', '私信监听（只认主人；命中打印 DM_HIT）'],
  like: ['commands/like.mjs', '视频点赞：<BV> --dry|--go|--check'],
  follow: ['commands/follow.mjs', '关注用户：<mid> --dry|--go|--check'],
  'video-danmaku': ['commands/video-danmaku.mjs', '视频 P1 弹幕：--bvid <BV> --at <秒> --msg <内容> --dry|--go [--auto]'],
  fav: ['commands/fav.mjs', '收藏（我想留着）：判据强制 · --list / --check / <BV> --reason … --dry|--go'],
  dm: ['commands/dm.mjs', '私信（专属通道）：一天只锁定 1 个收信人（对这个人数不限）· 只发主人 · 必须互关'],
  comment: ['commands/comment.mjs', '发一条视频评论；带 --root/--parent 就是二级回复'],
  'reply-draft': ['commands/reply-draft.mjs', '待审回复（B 档：发前审核）：add 进队列 / list / drop / take'],
  'comment-del': ['commands/comment-del.mjs', '删除自己发的一条评论（x/v2/reply/del，只能删自己的）'],
  dynamic: ['commands/dynamic.mjs', '动态：post / rm / check'],
  'dynamic-image': ['commands/dynamic-image.mjs', '发图文动态（上传图片 + 可带 @节点）'],
  'dynamic-edit': ['commands/edit-dynamic.mjs', '编辑已存在的动态（文字/图片都能改，id 不变、评论与点赞保留）：<dyn_id> <文本文件> [--go]'],
  danmaku: ['commands/danmaku.mjs', '直播间弹幕：pre 预检 / send 发送 / history 回读 / live 实时流'],
  await: ['commands/danmaku-await.mjs', '直播间"叫我起床"：出现该回的弹幕就退出，交给 agent 回（质量优先）'],
  // —— 排查 ——
}

const [cmd, ...rest] = process.argv.slice(2)
if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
  console.log('用法: node bili.mjs <命令> [参数...]\n')
  console.log('命令:')
  for (const [name, [, desc]] of Object.entries(map)) console.log(`  ${name.padEnd(16)} ${desc}`)
  console.log('\n安全约定（脚本里也强制）:')
  console.log('  · 写操作必须显式给 --dry（只打印请求）或 --go（真的发）')
  console.log('  · 先跑 session 确认是哪个号；写操作后一定用 check-*/thread/history 回读复核')
  console.log('  · 一次一条。批量、定时、多房间铺量不是这套工具的用途')
  process.exit(cmd ? 0 : 2)
}
// 2026-10-21 修 Issue #5：这 9 个脚本只认位置参数（argv[2]/argv[3]/…），
//   但 help 和 README 教的是 --key 形式 → 参数原样透传进去后，脚本拿到的是字符串 "--bvid"，
//   拼出的 URL 变成 ?bvid=--bvid → B站回 -400，看起来特别像 WBI 失效 / cookie 过期（极易误判 ✗）
//   这里做一层翻译：只在"给出的键正好是期望顺序的前缀"时才转位置参数；给不全就不动，
//   让脚本原来的报错照旧暴露出来（不猜、不静默 ✗）
import { translateNamed } from './lib/cli-args.mjs'

const entry = map[cmd]
if (!entry) {
  console.error(`未知命令: ${cmd}\n跑 "node bili.mjs help" 看清单。`)
  process.exit(2)
}
const r = spawnSync(NODE_EXE, [path.join(here, entry[0]), ...translateNamed(cmd, rest)], { stdio: 'inherit' })
process.exit(r.status ?? 1)

# PR #62：找片到素材报告

本地适配于 0.4.28.10。新入口不执行评论、私信或动态发送；只读取平台材料、记录实际素材来源和保存本地统计。

## 常用命令

```powershell
node tools/bili.mjs round --n 6 --dry
node tools/bili.mjs round --n 6 --no-frames --json
node tools/bili.mjs round --n 6 --sample-pages 2
node tools/bili.mjs discover --n 6 --kw 猫咪 --json
node tools/bili.mjs batch-debrief BV1234567890 BVabcdefghij --no-frames --concurrency 2
node tools/bili.mjs debrief BV1234567890 --sample-pages 2 --no-frames --json
node tools/bili.mjs config show
node tools/bili.mjs config set deepReadMax 3
node tools/bili.mjs config set maxDuration 1800
node tools/bili.mjs config set multiPartPerRound 0
```

`--dry` 只获取并列出候选，不深读、不写阅读事件、不统计标签、不发送消息；可能产生原有 API/搜索缓存。`--no-related` 跳过相关推荐。`--kw` 可重复。round 的 `--n` 是候选数，不是承诺读满的数量；默认最多深读 3 条，候选不足明确返回 shortfall。

batch-debrief 支持 `--from` 读取空白分隔的 BV 文件；每批 1–20 个有效 BV，默认两路子进程并发。HTTP 仍经过现有请求层的跨进程节流、风控与读取预算，不能把两路并发理解为运行速度固定翻倍。

## 选题与记忆

- 配置兴趣词逐档搜索 3、7、30、365、730、1095 天的内容，候选不足才继续放宽。先按兴趣分组轮流分配名额，组内优先近期视频，再按兴趣/反馈权重与固定随机键选取。元信息核验为不同兴趣保留尝试预算；兴趣搜索放宽后仍不足，才查询热门、排行与关注来源。
- 保留 dislike、主人审核的观看排除规则、已看/已评记录、当前账号收藏过滤和既有反馈权重。补位仍走相同条件，不会为了凑数放宽禁看规则。
- 元信息核验后执行时长与多 P 限额；默认分 P 数超过 3 视为合集，一轮最多 1 个。元信息预算用尽或合格结果不足时返回缺口，不无限请求。
- debrief 仍写原有 video-read 来源事件；保留多 P 标签及 readByModel=false。只准备图片不能声称已经看过图片。
- 标签按账号/主人隔离，保存在 life 目录的 video-tags.json；同一 BV 重复采集不会重复累计。仅已读来源计入兴趣统计，相关推荐标为 related，不记成已读。
- 标签和分区统计只提供参考，不自动改 preferences，也不制造个人想法或另一份日记。保存最多 2000 个视频的统计记录；不使用上游按低频阈值自动删除标签的策略。

## 配置

配置位于现有 BILI_WHALE_CONFIG（或 DSH_HOME/bili-whale.config.json）的 pipeline 对象。config set 会验证值并保留其他配置。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| windows | [3,7,30,365,730,1095] | 递增时间窗，最多 8 档 |
| perKeywordPool | 12 | 每词候选池上限 |
| minPlay / minDm | 0 / 0 | 可选额外门槛；仍保留原有低质量过滤，不强制追热门 |
| minDuration / maxDuration | 0 / 7200 | 时长范围（秒） |
| multiPartThreshold / multiPartPerRound | 3 / 1 | 合集判据 / 每轮上限 |
| deepReadMax | 3 | 深读上限，或 JSON 字符串 all |
| concurrency | 2 | 批量深读并发，1–3 |
| relatedSources / relatedTakeMax | 2 / 2 | 相关来源数 / 每来源候选数 |
| relatedMinPlay | 0 | 相关推荐播放门槛 |
| timeoutMs | 900000 | 每条深读子进程超时 |
| explorationMax | 1 | 未命中兴趣的探索候选合计上限，0–3；0 禁用 |
| maxMetadata | 40 | 单次选题最多核验的元信息数量 |

兼容同名上游 bw_cfg_windows、perKeywordPool、minPlay、minDm、multiPartThreshold、multiPartPerRound、deepReadMax、relatedTakeMax、relatedMinPlay；pipeline 字段优先。其余旧 bw_cfg_* 不接管本地风险预算、私信限额或分段抽帧参数。

timing.enabled 仅控制本地耗时展示，JSON 输出始终含阶段耗时。输出订阅 out/overview、report、stats、final 通过 hooks 的 round:done 挂载，但 `out/` 被 .gitignore 忽略，全新 clone 里并不存在：缺哪块就跳过哪块，此时 round 打印一行摘要（条数、耗时、存档路径）代替，采集与存档不受影响。想恢复分项报告，把对应文件放回 tools/local/out/ 即可，不改流程代码。

## 结构化报告与渲染器

默认仍输出中文素材报告；debrief --json 输出 bw.debrief.report/1 对象，包含 meta、cover、subtitles（含采样分 P 与条目）、danmaku、comments、frames、warnings、trust、evidenceId。批处理仅接受退出码 0、BV 对应且带来源回执的 JSON，不以输出长度判断成功。失败项进入 failed，批处理退出非零；不自动重试已可能写入来源事件的深读。

可在 DSH_HOME/whale-work/profiles/brief.mjs 写入本机可信渲染器：

```js
export const required = ['meta.title']
export function render(report) {
  return {lines: [report.meta.title]}
}
```

设置 BW_DEBRIEF_PROFILE=brief 后执行普通 debrief。缺失文件、错误导出、缺少 required 字段或非法返回值会报错，不静默回退。profile 是本地执行代码，并非沙箱；外部视频材料不能指定或安装渲染器。--json 走固定数据协议，不运行自定义 profile。

完整 round 结果保存到 DSH_HOME/whale-work/rounds，里面包含成功视频的完整报告、失败原因与相关候选。读取该报告并查看图片后，再由原有表达/发送流程判断是否分享。

兴趣命中以标题、简介或标签中的配置词匹配为依据，搜索来源本身不算命中；这不是语义质量或标题党识别器。所有未命中兴趣的来源共享 explorationMax，不为凑满数量放宽排除条件。兴趣素材不足时保留 shortfall，不能保证固定最低兴趣条数。

feed/discover --json 的 stdout 保持完整纯 JSON。diagnostics 给出兴趣/探索数量、元信息预算、每个兴趣的搜索窗口与错误；items 包含 interestMatches、interestEvidence 和 selectionReason。可用 `node tools/bili.mjs config set explorationMax 0` 关闭无关探索。

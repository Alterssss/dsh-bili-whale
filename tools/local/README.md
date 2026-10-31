# tools/local —— 本地找片流水线

这套脚本是「本地养的找片工具」：**找片 → 深读 → 采标签 → 相关推荐补采 → 输出**，
全程只读 B 站、只写本地文件，不往外发任何东西。
它不改上游任何文件，只调用 `node bili.mjs …` 的现成命令（debrief / feed / comment-digest / quota 等），
所以上游升级时不会被冲掉；需要取新东西时只动 `tools/local/` 这一层。

所有 `node tools/local/xxx.mjs` 都可以单独跑，`round.mjs` 只是把常用顺序串成一轮。

---

## 1. 流水线概览

`round.mjs` 一条命令按顺序跑完五个阶段：

```
① 找片     按兴趣词与时间窗搜索，配额随机取并加热搜保底，凑够 N 条
            对应 discover.mjs（filter.mjs 做统一筛选，video-entry.mjs 承载每条数据）

② 深读     并发读取字幕、评论、弹幕与画面帧，产出可读的结构化素材
            对应 batch-debrief.mjs（内部调 debrief 取字幕/热评/弹幕，调 segment-watch 抽帧，
            text-probe 先用三类探针判定内容是否完整）

③ 采标签   把已读视频的标签计入统计，供之后反选更有效的兴趣词
            对应 collect-tags-round.mjs + tagstore.mjs（两级标签库，按月清理低频词）

④ 相关补采  从相关推荐里补收高播放视频的标签与分区，只取前几条
            对应 related-collect.mjs + region-store.mjs（有播放量门槛与条数上限）

⑤ 输出     打印耗时、超时、总览、收信草稿与「下一步该做什么」的提示
            对应 out/{report,overview,stats,final}.mjs（hooks 订阅，可增删）
```

**这条流水线只做「读」和「统计」：找片、深读、采标签、补采、打印下一步提示。发送动作（评论 / 分享 / 私信）不在本命令内执行 —— 上游的 feed、debrief 同样如此，由唤醒流程或调用方另行决定。**

下面是每个阶段的具体做法（概览说「现在怎么跑」，第 2 节说「比原来强在哪」）。

### discover.mjs —— 找片

- **时间窗梯次**：搜索侧的窗口按 `3 → 7 → 30 → 365 → 730 → 1095` 天逐级放宽，某个窗口凑够候选就停，
  不会一上来就搜三年，也不会因为新片太少直接空手。
- **按播放排序**：搜索用 `order=click`，先按播放量排，避免拿到冷门库存。
- **配额随机**：每个兴趣词先攒一池候选（`bw_cfg_perKeywordPool`），再从中**随机**抽配额条。
  配额 = `N ÷ 兴趣词数`（不足 1 的每个词先给 1 条）——不是永远抽最高的那几条，不然每轮都是同一批。
- **热搜保底**：每轮至少有 `bw_cfg_minHotCount` 条来自热搜/排行榜。热搜不够就保持实际数，
  缺口用兴趣池随机补回，总数仍然是 N。
- **合集限流**：一轮里分P 超过 `bw_cfg_multiPartThreshold` 的合集最多留 `bw_cfg_multiPartPerRound` 个，
  多出来的直接筛掉，免得一轮全在读同一个系列。
- 筛选统一走 `filter.mjs`（看过没 → 质量下限 → 时间上限），新搜索、老搜索、热搜共用一套。

### batch-debrief.mjs —— 深读

- **并发深读**：默认同时跑 2 条（`READ_CONC` 可改），两条视频的请求并行发出，墙钟时间大约减半。
- **分段抽帧**：默认走 `segment-watch.mjs`（`--seg-frames`）只下需要的几小段再抽帧，
  省掉 95% 的流量；新方法失效会自动回退上游的整片下载，并提示「新方法失效，请排查」。
- **三类探针**：`text-probe.mjs` 同时探字幕 / 评论 / 弹幕，各 30 秒超时、失败给空，
  按「缺几样」给 A/B/C 评级；三类全空的只取画面帧，不再白等文字。
- 抽帧成功就把原片删掉（`shots/video/` 不堆垃圾）；失败的不删，方便排查。

### 采标签 → 相关补采

- `collect-tags-round.mjs`：给这批 BV 打 B站 标签，写进两级标签库。
- `related-collect.mjs`：从每条视频的相关推荐里，挑播放量 > `bw_cfg_relatedMinPlay` 的，
  按播放从高到低取最多 `bw_cfg_relatedTakeMax` 条，把它们的 tag 和分区也收进库。

### 收尾（日记行 / 扫描）

- `diary-lines.mjs`：把本轮结果拼成日记表格行（打印出来，自己复制进日记，不写任何远端）；
- `bili.mjs comment-digest`：扫最近 24 小时有没有人回复 / @ 我（只读）；
- `bili.mjs quota react --auto`：核对最近 48 小时有没有新表态（只读 + 记本地，不发任何东西）。

都是「读」，不会往外发东西。

### 输出块（out/）

`round.mjs` 末尾只 `hooks.run('round:done', payload)` 触发一次，各块自己 `hooks.on(...)` 注册，
靠 `order` 保持行序（放一起改容易互相踩，拆开后每个块一个文件）：

| order | 文件 | 输出 |
|---|---|---|
| 10 | `out/report.mjs` | 本轮耗时表 + 本轮超时表 |
| 20 | `out/overview.mjs` | 「看了哪些」：每条带分区 + 最多 3 个 tag，5 条一组 |
| 30 | `out/stats.mjs` | 相关推荐补采 |
| 40 | `out/final.mjs` | 「该写【给他的信】」草稿要素（含抽帧失败条数） |
| 50 | `out/stats.mjs` | 分区记录 |
| 60 | `out/final.mjs` | 「还差两步」提示 |

payload 里有几个值只有流程自己知道，由 `round.mjs` 传进去：

- `logPath`：本轮 `batch-debrief` 的日志路径 —— **耗时表必须读这个**，
  不能去 `batch-logs/` 里猜「最新那个 .log」，否则并发跑或上一轮刚结束时会读串；
- `startAt`：本轮开始时间 —— **超时表从这个时刻往后筛**，
  不再固定「最近 20 分钟」（一轮跑超过 20 分钟时，前半段的超时会整段漏掉）；
- `items` 里的 `frameOk`：由 `round.mjs` 拿 `batch-debrief` 返回的 `frameFailures` 回填成 `false`，
  否则 `out/final.mjs` 的「抽帧失败 N 条」永远是 0。

---

## 2. 与原流程的区别

### 原流程（上游 0.4.6）

```bash
node bili.mjs feed            # 出选题（打分 + 多样性限流）
node bili.mjs debrief BV…     # 手动一条条深读
#   人肉看结果，挑 2–3 条写观后感
node bili.mjs fav / comment   # 手动收藏 / 评论
```

- 选题只靠 `feed` 的打分：容易捞到几年前的老爆款，同一个兴趣词翻来覆去还是那几条；
- 深读一条条串行：一轮十几分钟，中间还得人盯着；
- 没有 tag / 分区统计：兴趣词是手写的，搜出来全是教程合集、标题党时没有依据换词。

### 新流程

```bash
node tools/local/round.mjs    # 一条命令串起来
# discover → batch-debrief（并发深读 + 分段抽帧 + 三类探针）→ 采标签 → 相关推荐补采 → 输出
```

| 环节 | 原来 | 现在 | 为什么这么改 |
|---|---|---|---|
| 找片 | 只按 `feed` 打分 | 时间窗梯次（3/7/30/365/730/1095 天）+ 按播放排序 + 每词配额随机 + 热搜保底 + 合集限流 | feed 容易捞到几年前的老爆款；固定打分还会让同一个词每轮都是那几条 —— 梯次保证新片不多时也能凑够，随机保证每轮不一样，热搜保底让「全站都在看」的那几条不漏，合集限流避免一轮全在读同一个系列 |
| 深读 | 串行一条条 `bili.mjs debrief` | 2 条并发（`READ_CONC`）+ 三类探针（字幕 / 评论 / 弹幕，各 30 秒超时、失败返空；单次请求另 20 秒兜底） | 串行一轮十几分钟；探针在深读**之前**就判定内容完整度（A/B/C 评级），缺得太多就不再硬等文字深读，直接只取画面帧 |
| 抽帧 | 下载整片再抽帧 | 分段直取（`segment-watch.mjs`，见 PR1：只下需要的几小段），失效自动回退整片 | 省约 95% 流量，也不把几百 MB 原片堆到盘上（成功抽完即删） |
| 标签 / 分区 | 无 | 采标签 + 分区统计（见下一节） | 从统计结果反向挑兴趣词，换掉那些搜出来全是教程合集 / 标题党的宽泛词 |
| 输出 | 各命令自己打印，要人拼 | `out/*.mjs` 统一输出：耗时表 / 超时表 / 总览（含分区+tag）/ 相关推荐补采 / 分区记录 / 该写的信 / 还差两步 | 跑完一眼能看到「读了什么、花了多久、哪一步超时」，不用再翻日志拼结果 |

输出块的开关：

- **耗时表 / 超时表 / 落点**：跟配置文件里的 `timing.enabled`（仓库默认**关**）。不开就完全静默；
- **总览 / 相关推荐补采 / 分区 / 该写的信**：只跟着 `round.mjs` 走 —— 跑 round 才有，不跑就没有，
  不影响任何上游命令的输出。

### 默认行为不变的边界

- **上游命令一个都没改**：`debrief` / `feed` / `comment-digest` / `quota` 等仍是原来的实现和输出，
  `round.mjs` 只是按顺序调用它们；不跑 `round.mjs` 就没有新流程。
- **`bili.mjs` 只多了一行**：注册 `config` 子命令；`config` 是新增命令，老命令的行为不变。
- **不设 `DSH_HOME`、不改配置文件时**：数据仍落在默认的 `~/.dsh`；`timing.enabled` 默认关，
  不输出耗时 / 超时 / 落点 —— 跟原来一样安静。落点只打印，**不会自动发私信**（要发自己发）。
- **不新增依赖**：只用 Node 内置模块和仓库里已有的 `tools/lib/*`。

---

## 3. 为什么统计 tag 和分区

目的只有一个：**从统计结果里反向挑兴趣词**。

搜出来的结果好不好，取决于兴趣词准不准。宽泛的词（比如一个大类名）搜出来经常全是教程合集、
标题党、搬运，真正想看的反而被埋掉。所以把「看过 / 搜到 / 相关推荐里出现」的视频的 tag 和分区攒起来，
就能看出：哪些 tag 反复出现在「真的看完的那些片」上 —— 那些才是能搜出好东西的词，
拿去换掉那些搜出来全是垃圾的宽泛词，搜索命中率就上来了。

**怎么控制代价**（不让统计拖慢一轮）：

- **tag 只对已经决定深读的视频采**：一条视频一次请求，不额外扫全站；
- **分区随搜索结果免费拿**：`discover` 的搜索结果里本来就带 `typename`，记一次不多发请求；
- **相关推荐补采有门槛**：只有播放量 > `bw_cfg_relatedMinPlay` 的才采，且每轮最多 `bw_cfg_relatedTakeMax` 条；
- **统计只写本地、不参与找片决策**：找片时不读这些文件，所以统计本身不增加一轮的耗时。

统计口径只算「兴趣来源」的视频；热搜 / 排行榜不参与（它们的分布跟个人兴趣无关）。

---

## 4. 怎么跑

在仓库根目录：

```bash
# 跑一轮：默认 10 条，用配置里的兴趣词
node tools/local/round.mjs

# 要 9 条
node tools/local/round.mjs --n 9

# 指定关键词（可重复；给了就不读配置里的兴趣词）
node tools/local/round.mjs --n 6 --kw 新番 --kw 家常菜

# 只找片、列清单，不深读（快，适合调搜索策略）
node tools/local/round.mjs --n 1 --dry

# 只读文字、不抽帧（快、省流量）
node tools/local/round.mjs --no-frames

# 跳过采标签
node tools/local/round.mjs --no-tags
```

在 `tools/` 目录里跑也一样（`round.mjs` 给子进程的 cwd 会自动指对）：

```bash
cd tools && node ../tools/local/round.mjs --n 9
```

单独跑某一步：

```bash
node tools/local/discover.mjs --n 5 --kw 新番            # 只列候选（加 --json 出机器可读结果）
node tools/local/batch-debrief.mjs BV1xx BV1yy --seg-frames --size 5
node tools/local/batch-debrief.mjs --from bvs.txt --no-frames
node tools/local/collect-tags-round.mjs BV1xx BV1yy --src round --kwcount 4
node tools/local/related-collect.mjs                     # 读最近一份 discover 日志补采
node tools/local/diary-lines.mjs --at "2026-10-30 22:10" # 出日记表格行
node tools/local/region-store.mjs BV1xx BV1yy            # 记分区 + 打分区统计
```

### 开关

- 找片的调参都在 `tools/local/bw-config.mjs`（字段名 `bw_cfg_*`，每个字段上面有注释说明
  「控制什么」「调大/调小分别会怎样」），也可以在配置文件里用同名键覆盖，**不用改代码**。
  常用几个：
  - `bw_cfg_deepReadMax`：一轮深读上限（默认 3，写 `"all"` 就是不封顶）；
  - `bw_cfg_multiPartPerRound` / `bw_cfg_multiPartThreshold`：合集限流；
  - `bw_cfg_relatedMinPlay` / `bw_cfg_relatedTakeMax`：相关推荐补采门槛；
  - `bw_cfg_minPlay` / `bw_cfg_minDm`：质量下限；
  - `bw_cfg_subsSampleMax`：合集字幕采样几集。
- `timing.enabled`（配置文件里）：耗时表 / 超时表 / 落点这类「本地诊断输出」的总开关。
  仓库默认不出这些（别人跑起来干净）。
- `READ_CONC`（环境变量）：深读并发数，默认 2。`SEG_CONC` 覆盖分段抽帧的并发数，默认 3。
- `--n` / `--kw` / `--dry` / `--no-frames` / `--no-tags` / `--min-hot`：见上面的用法。

### 没有本地配置时会发生什么

第一次跑（或者换台机器）什么配置都没有时，行为是确定的、不会报错：

- **`$DSH_HOME/bili-whale.config.json` 不存在** → 全部走 `tools/local/bw-config.mjs` 里的默认值
  （`cv()` 内部 try/catch 兜底），不报错、也不需要先建文件；
- **`timing` 开关缺失** → 视为关闭：不打印耗时表、落点（也就不会自动发私信）；
- **环境变量缺失**（`DSH_HOME` / `BILI_WHALE_CONFIG` / `READ_CONC` / `SEG_CONC`）→ 用默认行为：
  数据在 `~/.dsh`、配置在 `$DSH_HOME/bili-whale.config.json`、深读并发 2、分段并发 3；
- **数据文件不存在**（`tag-stats.json` / `regions.jsonl` / `timeout-log.jsonl`）→ 读不到就当空数据，
  第一次写入时自动创建目录（`fs.mkdirSync(..., { recursive: true })`）；
- **凭据不存在**（`~/.bili-ai/credentials.json`）→ 搜索/视频接口走匿名：能公开读的照常读，
  需要登录的那几步会给空结果，不会把整轮跑挂。

本仓库**不读取** `BW_*` 这类环境变量（只有上面列出的这几个），也没有额外的隐藏开关。

---

## 5. 数据落在哪

全部用 `tools/lib/paths.mjs` 的 `dshPath()` 拼，不写死任何绝对路径；
`dshPath()` 的根是 `$DSH_HOME`，没设就是 `~/.dsh`。要搬位置就设 `DSH_HOME`，不用改代码。

| 路径（相对 dsh home） | 内容 |
|---|---|
| `whale-work/discover-logs/discover-<UTC>.json` | 每轮找片的参数、trace、候选清单 |
| `whale-work/batch-logs/debrief-<UTC>.log` | 每轮深读日志（含 `TIMING ...` 计时行、探针评级、抽帧失败） |
| `whale-work/tag-stats.json` | 两级标签库：`videos` / `tags` / `cooccur` |
| `whale-work/regions.jsonl` | 分区统计（一行一条，append） |
| `whale-work/feed-logs/feed-<UTC>.jsonl` | 老路径（feed）每次的来源日志 |
| `bili-whale/timeout-log.jsonl` | 超时记录（跟 `timing.enabled` 共用一个开关） |
| `shots/video/` | 抽帧用的原片 / 产物目录（深读成功后自动删原片） |

凭据（cookie）在**用户主目录**下的 `.bili-ai/`，跟 dsh home 无关，用 `homePath()` 拼：
`homePath('.bili-ai', 'credentials.json')`。

配置文件用 `configPath`：默认 `$DSH_HOME/bili-whale.config.json`，可用 `BILI_WHALE_CONFIG` 覆盖。

---

## 6. 目录一览

| 文件 | 作用 |
|---|---|
| `round.mjs` | 串起一轮：找片 → 深读 → 采标签 → 收尾 → 输出块 |
| `discover.mjs` | 找片（搜索梯次 / 配额随机 / 热搜保底 / 合集限流 / 补分P信息） |
| `filter.mjs` | 统一筛选（看过没 / 质量下限 / 时间上限） |
| `video-entry.mjs` | 一条视频一个 `VideoItem`，字段跟着条目走 |
| `search-config.mjs` | 找片策略的唯一配置源（时间窗、并发、超时等） |
| `bw-config.mjs` | `bw_cfg_*` 调参默认值 + `cv('字段')` 读取（配置文件可覆盖） |
| `batch-debrief.mjs` | 批量深读（重试、空输出检测、并发、分段抽帧、探针） |
| `segment-watch.mjs` | 分段下载抽帧（省流量；失效回退整片下载） |
| `text-probe.mjs` | 字幕 / 评论 / 弹幕三类探针，出 A/B/C 评级 |
| `retry.mjs` / `timeout-log.mjs` | 失败重试一次 / 超时记录 |
| `tagstore.mjs` | 两级标签库（一级 = 高频，二级 = 全量，按月剔除低频） |
| `region-store.mjs` | 分区统计 |
| `collect-tags-round.mjs` | 给一批 BV 采标签 |
| `related-collect.mjs` | 相关推荐补采 |
| `diary-lines.mjs` | 拼日记表格行 |
| `feedfill.mjs` / `feedlog.mjs` | 老路径（feed）的补齐逻辑 / 来源日志 |
| `hooks.mjs` + `out/` | 极简事件总线 + 各输出块（耗时 / 总览 / 统计 / 收尾提示） |

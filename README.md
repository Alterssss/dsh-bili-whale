# DSH B 站鲸鱼插件

鲸鱼是运行在 DeepSeek Harness（DSH）中的 B 站陪伴插件。她按作息找片，阅读字幕和简介，按需查看抽帧，并把有来源的发现写入日记或留作分享话题。设置入口为 **设置 → 养鱼**。

## 安装

需要 DSH 和 Node.js 22.13+（22.x）或 23.4+，推荐 Node.js 24 LTS。抽帧需要 ffmpeg，文字浏览可以单独使用。

从 GitHub 获取 `v1.0.0` 源码，进入解压后的目录运行：

```powershell
npm ci
dsh plugin --profile desktop add "link:C:\path\to\dsh-bili-whale"
```

将命令中的路径替换为实际源码目录，然后启动或重启 DSH。已有本地链接安装可以更新其指向的源码，再重启 DSH。升级时保留原配置目录、凭据和 `whale-life` 数据目录。

## 配置

| 菜单 | 常用设置 |
| --- | --- |
| 角色与账号 | 扫码登录 B 站、填写主人 UID 和昵称、编辑人设 |
| 兴趣与作息 | 设置喜好、浏览窗口和候选片数量 |
| 分享 | 选择 B 站私信或公开评论 @，设置每日上限 |
| 监听与通知 | 分别开启评论和主人私信监听，设置通知渠道和公开日记推送 |
| 自主活动 | 启用自主浏览与主动聊天、日记、补话、久未联系私信或公开动态 |
| 运行与高级设置 | 查看调度状态，管理记忆、表达参考、会话及工具目录 |

设置保存后，可在插件目录运行 `node tools/bili.mjs selftest`，或在菜单使用 **依赖体检**。调度器首次 tick 后会更新运行状态。测试推送会调用当前配置的通知渠道。

## 浏览、记忆与分享

- 浏览优先匹配已有兴趣，先读文字素材，再按需抽帧。心情和分享欲依据可核验的原文更新，后台分析可以返回空结果。
- 公开评论使用公开来源形成的待分享话题。成功发出的正文经覆盖核对后才结算。主动聊天按开关、安静时段和额度判断，补话依据最近一轮已确认的主人私信。
- 浏览和私人会话可跨重启续接。长期归纳直接调用宿主模型。公开表达只使用可公开的来源。
- 后台分别生成公开和私人日记。开启公开日记推送后，新公开日记成功提交并更新 Markdown 时，按配置的渠道尝试推送一次。私人日记通过本地命令查看。

## 诊断与开发

```powershell
node tools/bili.mjs selftest
node tools/bili.mjs life status
node tools/bili.mjs life affect-explain
node tools/bili.mjs life diary-status
node tools/bili.mjs diary show
node tools/bili.mjs diary show --private
npm run test:startup
npm test
```

配置默认位于 `DSH_HOME/bili-whale.config.json`，凭据位于用户目录下的 `.bili-ai/credentials.json`。两个 Markdown 日记位于 `DSH_HOME/whale-life/<身份指纹>/`，准确路径可用 `life diary-status` 查看。

启动回归和自动化测试使用隔离目录与模拟宿主。日常安装的 `selftest` 会查询 B 站登录态。更多实现细节见 [长期状态契约](LIFE-STATE-CONTRACT.md) 和 [找片与阅读流水线](tools/local/README.md)。

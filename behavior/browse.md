# 浏览与分享
这是持续浏览主线，输入按公开范围提供；不能主动读取私人日记或私人对话。分享出口由本轮share.via决定，不改变浏览会话。
先deps检查；feed挑选不超过本轮maxVideos，再debrief --no-frames，按偏好与内容兴趣挑2–3条完整debrief（含画面）；没读到的画面不能说看过。必要时参考debrief提供的有界写法材料，详细工具流程用behavior read tools。
深读后用 life context "本轮公开视频分享" public-recommendation 刷新当前公开分享倾向和待分享素材；只从有公开来源的具体内容决定是否值得分享，私人话题不能带入评论。分享欲高时可优先考虑相关内容，低时可以保留；没有合适内容就不发。
可互动分享、独白或不发；沿用原包互动分享每日最多一次的要求，已用后可独白或不发，不硬找主人。互动遵守share.via及额度，独白不@主人、不带--share，仍受账号写预算和规则限制。发前查询准确坐标，--dry后--go；需要草稿时保留taskId，公开评论用public-comment，私人分享用private-recommendation（读取记忆仍限public-recommendation）。
想收藏时用fav --reason先--dry后--go，判据和额度以工具为准。结尾comment-digest --hours 24，按已配置通知方式汇总；不逐条强行报备。经历由工具记录，特殊反思可life reflect但不算独立事实。可无产出结束，不编日记。附加只读活动以本次令牌与预算为准，不能照正常分享流程新增发送。

批量读取可用 node tools/bili.mjs round --n <不超过本轮maxVideos> --no-frames --json，一次完成找片、有限并发深读、标签与相关推荐；也可先加 --dry 只看候选。读取返回 file 指向的完整素材报告；需要画面再对选中视频 debrief。失败项不能说已读，相关候选只代表发现、不代表看过；标签统计不自动成为偏好。本流程不发消息，分享仍走原有评估与发送流程。

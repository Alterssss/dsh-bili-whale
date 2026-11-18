# 工具详细索引
全部入口：node <插件目录>/tools/bili.mjs 命令；当前工作目录已能找到bili.mjs时可省略目录。behavior read <章节>重读规范；behavior reload请求下次投递重载规范，不会重投旧任务。
表达：expression prepare 候选.json；字段scene、target、text、taskId、sourceIds/claims，评论另填thread=type:oid:root和parent。expression revise ID 修改.txt最多一次；expression finalize ID取得固定delivery；comment/dm --draft ID --dry，再--go；不合适expression discard ID。requireDraft由本次配置决定，direct只是起草方式。
公开互动：share.via=comment时，comment --share --auto --reason 原因 --score 分数 --rank 1，并核对真实BV/oid；aiCommentGuard开启时先ai-share sample BV，核对不可信rows后ai-share record BV 文件，只有allowed/insufficient继续。blocked/uncertain不补一次notify变相分享。
私人互动：share.via=dm时，dm --msg 含BV链接的正文 --share --target BV --reason 原因 --score 分数 --rank 1；只给主人。独白：comment --message 正文并带实际坐标，不加--share、不@主人。全部写操作先--dry再--go，实际额度/偏好/未知发送检查优先，不能从规范推断额外权限。
私信表情包：dm --msg 正文 --pic 图片路径 会先发文字、再发图片，各有独立回执；仅发图片用 dm --pic 图片路径。两种都先 --dry 再 --go。文字已成功而图片失败时不要重发正文；明确拒绝后可单独重试图片，结果未知时先核查回执。发送可能等待已配置的冷却，按阶段输出判断进度。
收藏：fav BV --reason 原因（至少6字），同类至少2条时按工具要求--better；只留三个月后还想看且说得出原因的内容，额度以工具校验为准。
写法：expression references 视频来源事件ID reaction|observation|question|technical-help|discussion；只用适合当前目的的参考。风格ID填styleRefIds，事实仍填sourceIds/claims。
表情包见behavior read stickers；记忆分页与决策字段见behavior read memory。

多段私信：`dm-batch --file <字符串数组.json> --task <本次taskId> --dry` → `--go`；`--status` 查看进度，`--resume <组ID> --dry|--go` 只续发剩余正文，`--cancel <组ID>` 取消未派发部分（存在未知发送时禁止取消）。预览不写草稿或发网络请求，正式发送逐条预检。最大 6 条，账号冷却可能使整组耗时数分钟。
公开动态草稿：`expression prepare` 输入 `channel:"dynamic",scene:"public-comment",target:"自己mid",share:false`，定稿后 `dynamic post --draft ID --auto --dry` 再 `--go`。不要把私人素材改标为公开；自动动态由独立设置开关控制。

PR #62 批量工具：round --n 6 --no-frames [--json]；discover --n 6 --kw 关键词 --json；batch-debrief <BV...> --no-frames --concurrency 2。round --dry 仅列候选；debrief --json 返回带 evidenceId 的结构化素材。config show / config set <pipeline字段> <JSON值> 调整找片参数。

日记：diary show [--days 1]；diary show --private [--days 1]；life diary-status 查看生成状态与两个派生文件的实际路径；life diary-render 从权威事件恢复文件。life diary <JSON文件> 可明确保存感想，data.visibility=public/private，默认私人；不把私人来源改标公开。

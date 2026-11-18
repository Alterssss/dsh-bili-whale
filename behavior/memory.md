# 按需记忆与决策
先使用当前有界摘要，缺资料再检索，不全文重读日记。life search按CLI场景参数查询；公开浏览不得使用--private或private场景读取。
动态记忆固定启用：life memory-catalog 请求.json 场景，JSON带taskId、query，可带historical/cursor；原始历史用memory-history。memory-fetch请求带taskId、id、expectedVersion；历史事件还需kind:event和目录返回的archive。分页返回fragment、contentHash、nextOffsetBytes，必须续读拼成完整JSON才可判断例外。目录/读取不增加真实性，过期条目仅为历史。
life decision 文件.json记录taskId、action(reply/recommend/postpone/ask/abstain/analyze)、reason、memoryIds、output。只引用本任务已供应/授权读取的ID；草稿prepare保留taskId。决定是模型自述，不是实际执行回执。

subject=self是自身行为理解，不是主人要求或外部事实。暂停和恢复使用life pause / life resume；暂停不能撤回已经发出的请求。

# 给 DSH：0.4.26 主动分享跳过与失败诊断修复

日期：2026-11-03。版本：0.4.26-memory.20261103。
基线：已交付的 0.4.25，保留其记忆清理与主动召回。只改工作区副本；未覆盖宿主插件、未改真实状态、未发送消息。

## 本次改动

- 在现有 send/skip 提示中明确：话题前提被新记忆否定、已不适用或无具体内容时选择 skip，不为旧话题凑寒暄。没有新增模型调用。
- 正常覆盖结果 covered=false：丢弃未发送草稿，沿用 finishAffectPlan(skip) 推迟话题，返回 status=skipped、stage=coverage-check、reason=topic-not-covered。话题不标为完成，不发送；不再抛 AFFECT_WORKER_FAILED。
- 模型主动 skip 返回 status=skipped、stage=generate、reason=model-skipped。
- 覆盖格式错误、JSON 错误、模型调用中断仍是失败；不能把异常变成正常跳过。
- worker 状态保留阶段：analysis / coverage（历史回执复核）/ claim / generate / prepare / edit / finalize / coverage-check / ready / send。
- complete 调用携带 stage，测试记录无需再按正文猜阶段。失败保留标准格式的原始 code（如 V10_FINISH_INVALID）及 details；JSON 解析异常为 AFFECT_INVALID_JSON，草稿结构错误为 AFFECT_DRAFT_INVALID 或 AFFECT_EDIT_INVALID。

## 程序验证

全量 506 项通过，0 失败、0 跳过。
- 原覆盖拒绝测试改为断言 skipped、草稿 discarded、话题 deferred、无发送、分享值只按现有 skip 规则扣减，立即再次 tick 不重发。
- 新增 analysis/generate/edit/coverage-check 四个阶段宿主错误的定位与错误码保留测试。
- 新增无效生成 JSON、无效覆盖结果仍报失败的测试。
- 原有完整生成/编辑/覆盖/模拟 reserve-dispatch-settle 链路通过。
这些是注入模型结果的程序验证，不替代真实模型验收。

## DSH 本轮验收（隔离运行）

1. 核对包版本和 manifest。加载 0.4.26 的 worker 与 store，保留隔离状态。只借用宿主模型服务，不接真实发送。
2. 做一份固定的准备快照：同一时间、同一近期中性消息、同一待分享话题、同一分享欲与配置。准备完毕后再克隆两臂，只替换完整旧版/新版记忆。每次运行从此快照恢复，不能每轮推进一天。
3. 在这项控制变量实验里，清理准备快照中的待分析队列或用正常流程先处理完再复制，确保 tick 不会额外分析历史熬夜消息并创建不同话题。历史 coverage 队列同样保持一致。注明这只是隔离测试构造，不是自然积累触发；不要改产品代码绕过这些环节。
4. 旧/新各跑三次实际 worker.tick。保存每次 complete 的 stage、完整 prompt、raw、error.code/details，worker 结果及 memoryRefs。保存初稿、编辑后最终草稿和实际模拟发送正文，不能用初稿冒充最终正文。
5. 对完整 prompt 做差异核查；除目标记忆外，时间、近期消息、话题和表达要求一致。若不一致，先修验证脚本，不计算因果通过率。
6. 模拟发送依照 tests/affect.test.mjs 的完整链路：validateAffectPlanRequest → reserve → dispatch(本地模拟函数) → settle(模拟回执)。不能只返回 {ok:true}。严格不调用真实平台发送；模拟回执必须标注，不能称为真实投递证据。
7. 不预设 new 必须 skip：合理 skip、合适的 send 都允许。若覆盖不通过，应返回正常 skipped 并保留未完成话题，而非 failed；若模型未正常结束，应按实际 stage/code 报失败。

## v10 结果纠正

- old1 是编辑阶段 V10_FINISH_INVALID；old2 是分析阶段同类错误，不是无回执。
- new1/new2/new3 均在发送前收到 covered=false。0.4.26 针对此路径改为正常推迟。
- old3 到达模拟发送，但旧脚本未结算状态，所以 send-unconfirmed。无需真实平台回执也能验证程序结算链路，用模拟回执即可。
- v10 只有 5 个生成 send 的结果，非 6 个；old3 最终编辑稿也不等于初稿。

## 边界

- 本次没有修改公开表达提示，也未解决“未见复现→无人复现”的模型不稳定问题。
- 保留原有 skip 的推迟与分值处理，不新增话题取消、重写或新的调度机制。
- 提示能否让真实模型稳定识别过时话题需本轮验证；程序不强制按文字相似度判定。
- 仍未验证自然积累触发。一次性宿主验证入口按前次方式运行后恢复并记录哈希，不常驻、不反复自动启动。

交付：源码 ZIP、SHA256、manifest、完整测试日志及相对 0.4.25 的代码差异。

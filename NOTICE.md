# NOTICE · 第三方与免责

本项目（`dsh-bili-whale`）自身代码以 **MIT** 许可发布（见 `LICENSE`）。

## 它依赖/参考了这些第三方

| 名称 | 用途 | 许可 / 说明 |
|---|---|---|
| **Bilibili API** | 全部功能都调 B 站公开接口 | 非官方；本项目**不包含** B 站任何代码或数据 |
| **bilibili-API-collect** | `tools/docs/` 里的接口文档整理自该项目（社区维护的 B 站接口文档） | 遵循其原项目许可；仅作接口说明用，**不随本项目分发**时请以原仓库为准 |
| **ffmpeg** | 抽帧 / 看画面（`tools/lib/ffmpeg.mjs` 只是**定位并调用**它） | **LGPL v2.1+**（若用 GPL 构建则为 GPL）。本项目**不打包** ffmpeg：请自行安装，或使用发布页附带的 LGPL 构建（附其 LICENSE 与源码链接：https://ffmpeg.org）|
| **Node.js** | 运行环境 | MIT |

## 免责

- 本项目是**个人自用工具的公开版**：它用**你自己的账号**在 B 站做评论/回复/发动态等动作，**后果由使用者自负**。
- 不要用于批量刷量、水军、骚扰、绕过风控或任何违反 B 站用户协议的行为。
- 遵循平台规则，撞到风控（验证码 / 限流 / 判刷屏）就该停手，本项目内置了"撞到就停"的护栏。
- 本项目与 B 站、DeepSeek 官方均无隶属关系。

## 0.4.28 社区整合来源

动态、动态编辑、Opus 验证及点赞/关注命令与相关测试选择性复用并适配自 [PR #51](https://github.com/Alterssss/dsh-bili-whale/pull/51)，贡献者 Siilent-Sea；沿用本仓库 MIT 许可，许可全文见 LICENSE。

下载续传、分享卡片、仅主人过滤、缺失 buvid3 兼容、分段抽帧和多 P 字幕的实现参考社区 [#41](https://github.com/Alterssss/dsh-bili-whale/pull/41)（1607320631）、[#48](https://github.com/Alterssss/dsh-bili-whale/pull/48)（gi29734401）、[#54](https://github.com/Alterssss/dsh-bili-whale/pull/54)（Sawwwww541）、[#57](https://github.com/Alterssss/dsh-bili-whale/pull/57)（HaireXe-d）、[#61](https://github.com/Alterssss/dsh-bili-whale/pull/61)（plcAcss991），按本地版本重新适配。完整范围与未整合项目见 COMMUNITY-FIXES-2026-11-05.md。

### 既有解析器来源

`tools/lib/legacy-memory-parser.mjs` 适配自本仓库 PR #46，commit `748221821a85941447b3450e45d94853adb7cf1f`，原文件 `tools/lib/memory.mjs`，MIT，Copyright (c) 2026 ALTERSSSS；许可全文见 LICENSE。未复制该 PR 的强制私人上下文 prompt。

### 0.4.28.7 社区适配

内置二维码适配自 PR #69，commit `90121bf410a51b8321f763b925a5976fb71c3b26`；vendor/qrcode/qrcode.mjs 为 Kazuhiko Arase 的 MIT 实现，全文许可见 vendor/qrcode/LICENSE。报备称呼参考 PR #70。路径与收藏修复分别针对 issue #71、#73。

### PR #62 流水线与报告

功能适配自 plcAcss991 的 [PR #62](https://github.com/Alterssss/dsh-bili-whale/pull/62)，固定 commit `5994cc4a71aa3276fb419988f26f48ffed5ab8de`。`tools/local/report` 三个模块及 debrief 的数据/渲染接线复用并修改自该提交，沿用原仓库 MIT 许可（LICENSE）。其余流程按本地权限、账本、路径和请求保护重新实现。

# 表情包

这里是这条鲸鱼的 42 张表情包（480×480 PNG）：`index.json` 是目录，`small/` 是图。

`index.json` 每条记录：

```json
{
  "file": "01-开心.png",
  "path": "small/01-开心.png",
  "cn": "开心",
  "mood": "happy",
  "tags": ["开心", "高兴"],
  "desc": "眯眼大笑，双手张开，旁边有星星和小花",
  "w": 480, "h": 480,
  "bytes": 227245,
  "addedAt": "2026-10-29T00:53:30.759Z"
}
```

## 怎么用

运行时从 `~/.bili-ai/stickers/` 读（不是从插件目录读），所以先放到位：

```powershell
# 把仓库里的 stickers/ 整个复制过去
New-Item -ItemType Directory -Force "$HOME\.bili-ai\stickers" | Out-Null
Copy-Item .\stickers\index.json  "$HOME\.bili-ai\stickers\" -Force
Copy-Item .\stickers\small       "$HOME\.bili-ai\stickers\small" -Recurse -Force
```

然后：

```powershell
node tools/bili.mjs stickers list        # 简短目录（编号/名字/情绪）
node tools/bili.mjs stickers list 12     # 从第 12 条继续
node tools/bili.mjs stickers get 开心     # 拿到准确文件路径
```

配图时把 `path` 传给发图参数：

```powershell
node tools/bili.mjs dm      --msg "…" --pic "$HOME\.bili-ai\stickers\small\01-开心.png" --dry
node tools/bili.mjs comment BV… --message "…" --pic <路径> --dry
```

**没有合适的图就不要配**——表情包是锦上添花，硬配比不配更出戏。

## 换成你自己的图

1. 把 PNG 放进 `~/.bili-ai/stickers/`（`small/` 与可选的 `original/`）
2. 在 `index.json` 里追加记录，字段照上面的格式：`path` 必须与真实相对路径一致
3. 别手写坏 `path`：`stickers get` 会做越界与类型校验，路径错了会直接报错而不是静默取错图

字段约定：

| 字段 | 含义 |
| --- | --- |
| `file` / `path` | 文件名 / 相对 `~/.bili-ai/stickers/` 的路径（运行时以 `path` 为准） |
| `cn` | 中文名，`stickers get` 可以直接用名字匹配 |
| `mood` | 情绪分类，用于按场景挑图 |
| `tags` | 同义/相关词，便于检索 |
| `desc` | 画面描述，给模型判断"这张图配不配这句话" |
| `w` / `h` / `bytes` | 尺寸与体积（自检用） |

## 来源与许可

这些图来自公开网络的表情包素材，仅用于这条鲸鱼的**本地**表达（发私信/评论时配图）。
它们不随 MIT 代码许可授权；如果你要再分发或商用，请自行确认原图权利。
不想用可以整套删掉：删掉 `~/.bili-ai/stickers/` 后，配图能力自动失效，其它功能不受影响。

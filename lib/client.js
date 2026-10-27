/**
 * dsh-bili-whale —— 客户端半边：DSH「设置」里的 **养鱼** section（完整版）
 *
 * 历史（2026-10-18）：
 *   v1 只放了 6 个字段（owner/persona/作息窗口）→ 主人说"和微信端讲的不一样" ✗。
 *   真因：宿主半边那份独立页面 `settings.html` 有 25 个字段，但它被 DSH 的信任栅栏挡着打不开 ✗，
 *        而 section 是我另写的精简版 ✗ → 两套界面、一个配置，看着像两个插件。
 *   v2（本文件）：把那 25 个字段**按同一份配置结构**搬进 section ✓；渲染改成**数据驱动**
 *                （FIELDS 是唯一真相；加字段只改这个数组 ✓）。
 *
 * 数据流：section ⇄ `/dsh-bili/api/*`（同源 fetch ✓）⇄ `~/.dsh/bili-whale.config.json`
 *         —— 与 bilibili-tools 的 `lib/config.mjs` 读**同一份文件** ✓，不存在"两套配置"。
 *         ⚠️ 保存时提交**整份配置**（load 回来原样改几个键）→ 未显示的字段不会被抹掉 ✓
 */
window.__ModuleLoader__.load({
  id: "dsh-bili-whale",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createElement: h, useCallback, useEffect, useState, useRef } = React;

    const API = "/dsh-bili/api";
    const CSS_TAG = "dsh-bili-whale/section.css";
    const CSS = [
      ".blw{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}",
      ".blw-title{margin:0;font-size:16px;font-weight:500;line-height:24px}",
      ".blw-intro{color:var(--dsw-alias-label-tertiary);margin:0 0 4px;font-size:13px;line-height:20px}",
      ".blw-group{margin-top:14px;font-size:13px;font-weight:600;line-height:20px}",
      ".blw-panel{border:1.5px dashed color-mix(in srgb,var(--dsw-alias-label-primary,#808080) 38%,transparent);border-radius:10px;padding:16px 18px;margin:4px 0;min-width:0;box-sizing:border-box}",
      ".blw-panel .blw-group:first-child{margin-top:0;font-size:14px;line-height:22px;margin-bottom:6px}",
      ".blw-panel .blw-hint{font-size:12px;line-height:19px}",
      ".blw-panel>summary{cursor:pointer;font-weight:600;line-height:22px}",
      ".blw-panel[open]>summary{margin-bottom:12px}",
      ".blw-panel .blw-panel{border:none;padding:0;margin:0}",
      ".blw-panel>.blw-out{margin-top:0}",
      "@media(max-width:600px){.blw-panel{padding:12px}.blw-panel .blw-cookie{min-width:0!important;width:100%}.blw-panel .blw-input,.blw-panel .blw-select{max-width:100%;box-sizing:border-box}}",

      ".blw-rows{display:flex;flex-direction:column}",
      ".blw-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 20px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}",
      ".blw-row:last-child{border-bottom:none}",
      ".blw-row>div:first-child{flex:1;min-width:190px}",
      ".blw-label{font-size:13px;line-height:19px}",
      ".blw-hint{color:var(--dsw-alias-label-tertiary);margin-top:3px;font-size:11.5px;line-height:17px}",
      ".blw-input,.blw-select{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 8px;min-width:180px;outline:none}",
      ".blw-input:focus-visible,.blw-select:focus-visible{border-color:var(--dsw-alias-brand-primary)}",
      ".blw-input.blw-wide{min-width:260px}",
      ".blw-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}",
      ".blw-btn{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff);border:none;border-radius:6px;font-size:12.5px;height:30px;padding:0 12px;cursor:pointer}",
      ".blw-btn:disabled{opacity:.5;cursor:default}",
      ".blw-btn2{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}",
      ".blw-out{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);background:rgba(127,127,127,.08);border-radius:8px;padding:10px 12px;max-height:240px;overflow:auto;margin-top:10px}",
      ".blw-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-top:8px;white-space:pre-line}",
      ".blw-hint.blw-pre{white-space:pre-line}",
      ".blw-badge{display:inline-block;font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;background:rgba(127,127,127,.14);color:var(--dsw-alias-label-secondary);margin-left:6px}",
      ".blw-cookie{display:flex;flex-direction:column;gap:8px;min-width:250px}",
    ].join("");

    // ── 唯一真相：字段清单（加字段只改这里 ✓）────────────────────────────
    //   kind: text | number | list（逗号分隔数组）| switch | select
    const FIELDS = [
      {group:"会话成本",path:["sessionRotateDays"],label:"会话轮换天数",hint:"0 不轮换；开启后在空闲时创建新会话，保留旧会话",kind:"number"},
      {group:"会话成本",path:["personaOncePerSession"],label:"每会话减少重复人设",hint:"默认关闭；成功投递后去重，人设变化会重新注入",kind:"switch"},
      {group:"分享前检查",path:["share","aiCommentGuard"],label:"疑似 AI 评论检查（试用）",hint:"仅主动 @ 分享；按视频缓存 6 小时，超阈值暂缓并推送",kind:"switch"},
      { group: "工具链", path: ["home"], label: "专用会话目录", hint: "已存在目录的绝对路径；留空用默认目录。重启后新建会话生效，已有会话不迁移", kind: "text", wide: true },
      { group: "日记与推送", path: ["listen", "mentionSummary"], label: "主人 @ 请求总结", hint: "默认关闭。开启后处理主人含总结/摘要/概括的新 @，通过消息推送通道发送", kind: "switch" },
      { group: "作息", path: ["night", "minGapMin"], label: "最小唤醒间隔（分钟）", hint: "默认 10；窗口放不下就少醒几次", kind: "number" },
      { group: "她是谁", path: ["persona", "name"], label: "角色名", hint: "她怎么被称呼", kind: "text" },
      { group: "她是谁", path: ["persona", "ownerTitle"], label: "她怎么称呼你", hint: "例如「主人」", kind: "text" },
      { group: "她是谁", path: ["persona", "selfClaim"], label: "她怎么自称", hint: "例如「我」/「人家」", kind: "text" },
      { group: "角色", path: ["character", "name"], label: "姓名", hint: "角色的唯一姓名，与B站账号昵称分开", kind: "text" },
      { group: "角色", path: ["character", "identity"], label: "身份", hint: "角色背景", kind: "textarea" },
      { group: "角色", path: ["character", "personality"], label: "性格", hint: "她的判断和态度", kind: "textarea" },
      { group: "角色", path: ["character", "behavior"], label: "行为", hint: "她如何理解事情、决定是否接话", kind: "textarea" },
      { group: "角色", path: ["character", "style"], label: "口吻", hint: "她平时怎么说话", kind: "textarea" },
      { group: "角色", path: ["character", "relationship"], label: "相处方式", hint: "可选，例如怎么称呼你", kind: "textarea" },
      { group: "角色", path: ["character", "alternates"], label: "备用语气", hint: "每行一条，可留空", kind: "lines" },
      { group: "角色", path: ["character", "probability"], label: "备用语气概率", hint: "0表示保持默认口吻", kind: "number", min: 0, max: 1, step: 0.05 },
      { group: "角色", path: ["character", "planner"], label: "回应规划", hint: "先理解话题和自身态度，再执行和回复", kind: "switch" },
      { group: "角色", path: ["character", "replyer"], label: "独立组织回复", hint: "聊天最终发言由角色单独组织，工具调用保持原样", kind: "switch" },
      { group: "角色机制", path: ["dialogueMode"], label: "人格机制", hint: "独立角色替换旧人设；兼容模式用于保留旧配置", kind: "select", options: [{ value: "character", label: "独立角色" }, { value: "local", label: "旧版兼容" }] },
      { group: "人格与表达", path: ["voice", "enabled"], label: "自然表达", hint: "默认开启。直接使用初始人格和留言习惯；关闭后沿用原有人设，不添加表达约束", kind: "switch" },
      { group: "人格与表达", path: ["voice", "personality"], label: "核心人格", hint: "已经填好初始性格，可以直接用；有自己的人设时以原设定为准", kind: "textarea" },
      { group: "人格与表达", path: ["voice", "behaviorStyle"], label: "行为准则", hint: "默认先看懂内容，再挑有话想说的地方留言，不硬找话题", kind: "textarea" },
      { group: "人格与表达", path: ["voice", "replyStyle"], label: "默认表达习惯", hint: "默认简短、白话，抓具体细节说感受，少写总结和客套话", kind: "textarea" },
      { group: "人格与表达", path: ["voice", "multipleStyles"], label: "备用语气（每行一条）", hint: "偶尔换一种说法，每行一条；最多 20 条，每条最多 1000 字", kind: "lines" },
      { group: "人格与表达", path: ["voice", "multipleProbability"], label: "备用语气概率", hint: "默认 0.15：大约 15% 的任务换一种语气；0 从不切换，1 每次切换", kind: "number", min: 0, max: 1, step: 0.05 },
      { group: "人格与表达", path: ["voice", "styleMode"], label: "语气变化方式", hint: "平时保持默认即可；固定第一条适合检查自己写的语气", kind: "select", options: [{ value: "random", label: "偶尔换一种语气（推荐）" }, { value: "first", label: "固定使用第一条" }, { value: "off", label: "不使用备用语气" }] },
      { group: "人格与表达", path: ["voice", "expressionTopK"], label: "每次口癖候选数", hint: "0 禁用口癖；最多 20。口癖库通过 voice import 导入，不会自动学习", kind: "number", min: 0, max: 20, step: 1 },

      { group: "2. 绑定主号", path: ["owner", "mid"], label: "主号 UID 或个人空间链接", hint: "填你日常使用的账号。例如 123456 或 https://space.bilibili.com/123456；不要填小号", kind: "text" },
      { group: "2. 绑定主号", path: ["owner", "name"], label: "主号昵称", hint: "用于公开 @ 你的显示名称，按主号当前昵称填写", kind: "text" },
      { group: "小号账号信息", path: ["self", "mid"], label: "小号 UID", hint: "登录后自动识别，不需要手动填", kind: "text", readOnly: true },
      { group: "小号账号信息", path: ["self", "name"], label: "小号昵称", hint: "上次识别的账号；请在小号登录区域核验有效性", kind: "text", readOnly: true },

      { group: "作息", path: ["night", "skipChance"], label: "今晚不看的概率", hint: "0.3 = 三成", kind: "number" },
      { group: "作息", path: ["night", "maxVideos"], label: "单次醒来观看视频数量", hint: "初筛的候选数；筛完再挑 2–3 条深读", kind: "number" },

      { group: "口味", path: ["preferences", "like"], label: "爱看", hint: "逗号分隔", kind: "list" },
      { group: "口味", path: ["preferences", "dislike"], label: "不爱看", hint: "逗号分隔", kind: "list" },

      { group: "日记与推送", path: ["diary", "push"], label: "推送日记摘要", hint: "关掉 = 她照写两本日记，但不推给你（日记本身不能关 ✓）", kind: "switch" },

      { group: "工具链", path: ["toolsPath"], label: "工具目录", hint: "留空 = 用插件自带的 tools/ 或开发目录", kind: "text", wide: true },
    ];

    const getPath = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
    const setPath = (obj, path, value) => {
      let cur = obj;
      for (let i = 0; i < path.length - 1; i += 1) {
        const k = path[i];
        if (cur[k] == null || typeof cur[k] !== "object") cur[k] = typeof path[i + 1] === "number" ? [] : {};
        cur = cur[k];
      }
      cur[path[path.length - 1]] = value;
    };

    function useStyleOnce() {
      useEffect(() => {
        if (typeof document === "undefined") return;
        if (!document.getElementById(CSS_TAG)) {
          const el = document.createElement("style");
          el.id = CSS_TAG;
          el.textContent = CSS;
          document.head.appendChild(el);
        }
      }, []);
    }

    function Row({ f, cfg, set }) {
      const raw = getPath(cfg, f.path);
      const common = { className: "blw-input" + (f.wide ? " blw-wide" : "") };
      // 2026-10-18 修：list 字段以前"值 = 数组 join、改动 = split 回数组" ✗
      //   → 你一打逗号，join 立刻把它吞掉（输入框里根本打不出逗号 ✗）
      //   现在：本地文本 state 管显示 ✓ 数组只在解析时更新 ✓（逗号能打、末尾逗号也不会乱跳 ✓）
      const [listText, setListText] = useState(Array.isArray(raw) ? raw.join("，") : (raw ?? ""));
      useEffect(() => {
        setListText(Array.isArray(raw) ? raw.join("，") : (raw ?? ""));
      }, [JSON.stringify(raw ?? null)]);
      let control;
      if (f.kind === "textarea" || f.kind === "lines") {
        control = h("textarea", { ...common, rows: 3, style: { height: "auto", width: "100%", boxSizing: "border-box", padding: "6px 8px" },
          maxLength: f.kind === "textarea" ? 3000 : undefined,
          "aria-label": f.label,
          value: f.kind === "lines" ? (Array.isArray(raw) ? raw.join("\n") : "") : (raw ?? ""),
          onChange: (e) => set(f.path, f.kind === "lines" ? e.target.value.split("\n") : e.target.value) });
      } else if (f.kind === "list") {
        control = h("input", {
          ...common,
          value: listText,          // ← 显示用本地文本（逗号不会被吞 ✓）
          readOnly: !!f.readOnly,
          onChange: (e) => {
            const v = e.target.value;
            setListText(v);          // 先原样显示（中文逗号、英文逗号、末尾逗号都能打 ✓）
            // 再解析成数组写进配置（空项过滤掉，不会因为末尾逗号多出一个空串 ✓）
            set(f.path, v.split(/[,，]/).map((s) => s.trim()).filter(Boolean));
          },
        });
      } else if (f.kind === "number") {
        control = h("input", { ...common, type: "number", step: f.step ?? "any", min: f.min, max: f.max, value: raw ?? "", readOnly: !!f.readOnly,
          onChange: (e) => set(f.path, e.target.value === "" ? undefined : Number(e.target.value)) });
      } else if (f.kind === "switch") {
        control = h("input", { type: "checkbox", checked: !!raw, disabled: !!f.readOnly,
          onChange: (e) => set(f.path, e.target.checked) });
      } else if (f.kind === "select") {
        control = h("select", { className: "blw-select", value: raw ?? "", disabled: !!f.readOnly,
          onChange: (e) => set(f.path, e.target.value) },
          f.options.map((o) => h("option", { key: o.value ?? o, value: o.value ?? o }, o.label ?? o)));
      } else {
        control = h("input", { ...common, value: raw ?? "", readOnly: !!f.readOnly,
          onChange: (e) => set(f.path, e.target.value) });
      }
      return h("div", { className: "blw-row" },
        h("div", null,
          h("div", { className: "blw-label" }, f.label, f.readOnly ? h("span", { className: "blw-badge" }, "只读") : null),
          f.hint ? h("div", { className: "blw-hint" }, f.hint) : null),
        control);
    }

    // ── 作息窗口编辑器（2026-10-18 主人画的草图）─────────────────────────
    //   ①  07:00 – 09:00   （醒来 1 次）   [x]
    //   ②  17:00 – 18:00   （醒来 1 次）   [x]
    //   [ + 添加窗口 ]
    //   每个窗口自带"醒来几次"；保存时把总和写回 night.maxWakesPerDay（工具链读它 ✓）
    const NUMS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];
    function WindowsEditor({ cfg, set }) {
      const wins = getPath(cfg, ["night", "windows"]);
      const list = Array.isArray(wins) ? wins : [];
      const upd = (i, patch) => set(["night", "windows"], list.map((w, j) => (j === i ? { ...w, ...patch } : w)));
      const del = (i) => set(["night", "windows"], list.filter((_, j) => j !== i));
      const add = () => set(["night", "windows"], [...list, { start: "20:00", end: "22:00", wakes: 1 }]);
      const timeInput = (v, onChange) =>
        h("input", { className: "blw-input", style: { width: "86px", minWidth: "86px" }, value: v ?? "", onChange: (e) => onChange(e.target.value) });
      return h("div", null,
        h("div", { className: "blw-rows" },
          list.length === 0
            ? h("div", { className: "blw-hint" }, "（没有窗口 = 永远不醒；至少加一个）")
            : list.map((w, i) =>
                h("div", { className: "blw-row", key: i },
                  h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
                    h("span", { className: "blw-hint", style: { minWidth: "18px" } }, NUMS[i] ?? String(i + 1)),
                    timeInput(w.start, (v) => upd(i, { start: v })),
                    h("span", { className: "blw-hint" }, "–"),
                    timeInput(w.end, (v) => upd(i, { end: v })),
                    h("span", { className: "blw-hint" }, "醒来"),
                    h("input", { className: "blw-input", style: { width: "56px", minWidth: "56px" }, type: "number", min: 1,
                      value: w.wakes ?? 1, onChange: (e) => upd(i, { wakes: Number(e.target.value) || 1 }) }),
                    h("span", { className: "blw-hint" }, "次")),
                  h("button", { className: "blw-btn blw-btn2", disabled: list.length <= 1, onClick: () => del(i), title: "删掉这个窗口" }, "×"))),
        h("div", { style: { marginTop: "8px" } },
          h("button", { className: "blw-btn blw-btn2", onClick: add }, "+ 添加窗口"))));
    }

    // ── 开关行（复选框 + 说明）──────────────────────────────────────────
    function SwitchRow({ label, hint, value, onChange, disabled }) {
      return h("div", { className: "blw-row" },
        h("div", null,
          h("div", { className: "blw-label" }, label),
          hint ? h("div", { className: "blw-hint" }, hint) : null),
        h("input", { type: "checkbox", checked: !!value, disabled: !!disabled, onChange: (e) => onChange(e.target.checked) }));
    }

    // ── 【分享评论】（主动 @ 你）· 2026-10-18 主人给的排版 ────────────────
    function ShareEditor({ cfg, set }) {
      const s = cfg.share ?? {};
      const daily = cfg.quota?.shareDaily ?? 3;
      // 2026-10-19：分享方式二选一 —— comment=评论区公开 @ / dm=私信给你（必须带视频链接）
      const via = s.via === "dm" ? "dm" : "comment";
      const viaRadio = ([value, label, hint]) =>
        h("label", { key: value, style: { display: "flex", alignItems: "flex-start", gap: "8px", marginBottom: "10px", cursor: "pointer" } },
          h("input", { type: "radio", name: "blw-share-via", checked: via === value, style: { marginTop: "3px" }, onChange: () => set(["share", "via"], value) }),
          h("div", null,
            h("div", { className: "blw-label" }, label),
            h("div", { className: "blw-hint" }, hint)));
      return h("div", null,
        h("div", { className: "blw-group" }, "4. 主动分享"),
        h("div", { className: "blw-rows" },
          h(SwitchRow, { label: "主动推荐视频", hint: "开启并保存后，会在作息内选视频主动发给主号。关闭只停主动推荐，不影响私信回复", value: s.enabled !== false, onChange: (v) => set(["share", "enabled"], v) }),
          h("div", { className: "blw-row" },
            h("div", null,
              h("div", { className: "blw-label" }, "分享方式（二选一）"),
              h("div", { className: "blw-hint" }, "只在「有值得分享的」时才发；一条都不值得就一条都不发 ✓")),
            h("div", null,
              viaRadio(["comment", "评论区 @ 你", "在视频评论区发一条带 @ 的公开评论 ✓（原功能 · 别人也看得到）"]),
              viaRadio(["dm", "B站私信", "不发公开评论 ✗ 直接把分享内容 + 视频链接私信给你 ✓（更干净 ✓ 需要互关 ✓）"]))),
          h("div", { className: "blw-row" },
            h("div", null,
              h("div", { className: "blw-label" }, "每天上限"),
              h("div", { className: "blw-hint" }, via === "dm"
                ? "每天主动推荐的视频上限；普通私信回复不占推荐额度，但仍受请求保护限制"
                : "同一视频 7 天内一次 · 只从「深读过的」里挑 · 调大时会弹警告")),
            h("input", { className: "blw-input", style: { width: "80px", minWidth: "80px" }, type: "number", min: 0,
              value: daily, onChange: (e) => set(["quota", "shareDaily"], Number(e.target.value)) }))));
    }

    // ── 【全天监听】（别人找她）· 2026-10-18 主人给的排版 ──────────────────
    function ListenEditor({ cfg, set }) {
      const L = cfg.listen ?? {};
      const sel = (value, options, onChange) =>
        h("select", { className: "blw-select", value, onChange: (e) => onChange(e.target.value) },
          options.map(([v, label]) => h("option", { key: v, value: v }, label)));
      const num = (value, onChange, w = "70px") =>
        h("input", { className: "blw-input", style: { width: w, minWidth: w }, type: "number", min: 0, value: value ?? "", onChange: (e) => onChange(Number(e.target.value)) });
      return h("div", null,
        h("div", { className: "blw-group" }, "评论区与直播互动（可选）"),
        h("div", { className: "blw-rows" },
          h(SwitchRow, { label: "评论区监听", hint: "查「回复我的 / @我的」；按配置间隔检查（默认 60 秒），仅失败时退避", value: L.comment !== false, onChange: (v) => set(["listen", "comment"], v) }),
          // 2026-10-24 主人要求去掉「查一次间隔」这个输入框：
          //   填了也不准 —— 实际节奏为配置间隔，加上失败退避和平台暂停，
          //   那个框给的是"承诺值"，跟真实行为对不上。节奏交给代码，不再暴露 ✓

          h("div", { className: "blw-row" },
            h("div", null, h("div", { className: "blw-label" }, "只回"), h("div", { className: "blw-hint" }, "哪种通知算「找她」")),
            sel(L.scope ?? "both", [["both", "直接回我的 + @我的"], ["reply", "只回直接回我的"]], (v) => set(["listen", "scope"], v))),
          h(SwitchRow, { label: "同一个人最多只回一条", hint: "30 天内只回一次同一人（默认开 ✓）", value: L.oncePerPerson !== false, onChange: (v) => set(["listen", "oncePerPerson"], v) }),
          h(SwitchRow, { label: "作息窗口外也处理评论", hint: "只影响评论区，不影响主号私信回复", value: !!L.allDay, onChange: (v) => set(["listen", "allDay"], v) }),

          h(SwitchRow, { label: "直播间监听", hint: "蹲直播间弹幕里有没有叫她", value: !!L.live, onChange: (v) => set(["listen", "live"], v) }),
          h("div", { className: "blw-row" },
            h("div", null, h("div", { className: "blw-label" }, "直播间房间号"), h("div", { className: "blw-hint" }, "留空 = 不蹲直播")),
            h("input", { className: "blw-input", style: { width: "120px", minWidth: "120px" }, value: L.liveRoom ?? "", placeholder: "例如 12345", onChange: (e) => set(["listen", "liveRoom"], e.target.value) })),
          h("div", { className: "blw-row" },
            h("div", null, h("div", { className: "blw-label" }, "直播间只回"), h("div", { className: "blw-hint" }, "只回主人 = 观众的一律不理；只回艾特她的 = 只看有没有人叫她")),
            sel(L.liveScope ?? "owner", [["owner", "只回主人"], ["mention", "只回艾特她的"]], (v) => set(["listen", "liveScope"], v)))),
        h("div", { className: "blw-out" },
          "【风控护栏 · 不可关】撞到 12015 / 12051 / 10031 → 立刻停监听 + 报你\n" +
          "评论只处理回复小号、或 @ 小号的通知，不会寻找主号在全站的留言。主号评论可自动回复；其他人的回复先进入待审草稿。"));
    }

    // ── 【待审核】（2026-10-18 主人选 B 档：她的回复先给你看，你点「发」才发）──────
    function PendingEditor() {
      const [items, setItems] = useState([]);
      const [busy, setBusy] = useState("");
      const [msg, setMsg] = useState("");

      const load = useCallback(async () => {
        try { const r = await fetch(`${API}/pending`, { headers: { accept: "application/json" } }); const j = await r.json(); setItems(j.items ?? []) } catch {}
      }, []);
      useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t) }, [load]);

      const act = async (id, what) => {
        setBusy(id + what); setMsg("");
        try {
          const r = await fetch(`${API}/pending/${what}`, {
            method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ id }),
          });
          const j = await r.json().catch(() => ({}));
          setMsg(j.ok
            ? (what === "approve" ? `✓ 已发出${j.rpid ? " · rpid=" + j.rpid : ""}` : "✓ 已删掉（也记了一笔「否」✓）")
            : `✗ ${j.error ?? "失败"}`);
          await load();
        } catch (e) { setMsg("✗ " + e.message) } finally { setBusy("") }
      };

      return h("div", null,
        h("div", { className: "blw-group" }, "待审核" + (items.length ? `（${items.length} 条）` : "")),
        h("div", { className: "blw-hint", style: { marginTop: "2px" } }, "她回复别人之前，草稿先到这儿 —— 你点「发」才发 ✓（否掉也会记一笔，她会学着改 ✓）"),
        h("div", { className: "blw-rows" },
          items.length === 0
            ? h("div", { className: "blw-hint", style: { padding: "8px 0" } }, "（队列是空的 ✓）")
            : items.map((x) => h("div", { className: "blw-row", key: x.id },
              h("div", null,
                h("div", { className: "blw-label" }, `→ ${x.who || "对方"}`, h("span", { className: "blw-badge" }, String(x.at ?? "").slice(5, 16).replace("T", " "))),
                x.src ? h("div", { className: "blw-hint" }, `他说：${String(x.src).slice(0, 80)}`) : null,
                h("div", { className: "blw-hint", style: { color: "var(--dsw-alias-label-primary)", marginTop: "4px" } }, `你要回：${x.message}`)),
              h("div", { style: { display: "flex", gap: "6px" } },
                h("button", { className: "blw-btn", disabled: !!busy, onClick: () => act(x.id, "approve") }, busy === x.id + "approve" ? "发出中…" : "发"),
                h("button", { className: "blw-btn blw-btn2", disabled: !!busy, onClick: () => act(x.id, "reject") }, "删"))))),
        msg ? h("div", { className: msg.startsWith("✓") ? "blw-hint" : "blw-err" }, msg) : null);
    }

    // ── 【消息推送】（她看完一轮，把摘要送到哪）· 2026-10-18 主人给的排版 ──────
    function NotifyEditor({ cfg, set, save }) {
      const n = cfg.notify ?? {};
      // 旧配置里可能是 stdout / file → 界面上按「不推送」显示（不误导 ✓），选新方式时会被覆盖 ✓
      const type = ["none", "desktop", "dm", "webhook", "command"].includes(n.type) ? n.type : "none";
      const [testing, setTesting] = useState(false);
      const [testOut, setTestOut] = useState("");
      const setType = (v) => set(["notify", "type"], v);
      const radio = ([value, label]) =>
        h("label", { key: value, style: { display: "inline-flex", alignItems: "center", gap: "6px", marginRight: "14px", cursor: "pointer", fontSize: "13px" } },
          h("input", { type: "radio", name: "blw-notify", checked: type === value, onChange: () => setType(value) }),
          label);
      const test = async () => {
        setTesting(true); setTestOut("…正在保存设置（测试前先落盘 ✓）\n");
        try {
          // 2026-10-19：测试前**先保存** ✓
          //   以前测试读的是磁盘上的旧配置 → "点了别的单选、测试却还发到旧通道" ✗
          //   现在"你看到的就是你测的" ✓
          if (!await save()) throw new Error("设置没有保存成功，已停止发送测试通知");
          const r = await fetch(`${API}/notify-test`, { method: "POST", headers: { accept: "application/json" } });
          const j = await r.json().catch(() => ({}));
          setTestOut((j.ok ? "✓ 已发送（设置已自动保存 ✓）\n" : "✗ 失败（设置已自动保存 ✓）\n") + (j.out || "") + (j.err ? "\n" + j.err : ""));
        } catch (e) { setTestOut("✗ " + e.message); } finally { setTesting(false); }
      };
      const box = { className: "blw-out", style: { marginTop: "8px" } };
      return h("div", null,
        h("div", { className: "blw-group" }, "摘要与运行通知（可选）"),
        h("div", { className: "blw-hint", style: { marginTop: "2px" } }, "只决定日记摘要和运行通知送到哪里，与回复主号私信、主动推荐视频分别设置。"),
        h("div", { className: "blw-rows" },
          h("div", { className: "blw-row" },
            h("div", null, h("div", { className: "blw-label" }, "方式"),
              h("div", { className: "blw-hint" }, "不推送 = 只写日记与事件流")),
            h("div", null, ["none", "desktop", "dm", "webhook", "command"].map((v, i) =>
              radio([v, ["不推送", "桌面通知", "B站私信", "Webhook", "自定义命令"][i]])))),

          type === "webhook" ? h("div", null,
            h("div", { className: "blw-row" },
              h("div", null, h("div", { className: "blw-label" }, "Webhook 地址"),
                h("div", { className: "blw-hint" }, "飞书 / 钉钉 / 企业微信 / QQ机器人 / WorkBuddy —— 把机器人给的地址贴进来就行（报文按域名自动适配 ✓）")),
              h("input", { className: "blw-input blw-wide", style: { minWidth: "300px" }, value: n.url ?? "", placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/…", onChange: (e) => set(["notify", "url"], e.target.value) })),
            h("div", { className: "blw-row" },
              h("div", null, h("div", { className: "blw-label" }, "模板"),
                h("div", { className: "blw-hint" }, "纯文本最稳；飞书/钉钉选 markdown 会漂亮一些")),
              h("select", { className: "blw-select", value: n.template ?? "text", onChange: (e) => set(["notify", "template"], e.target.value) },
                h("option", { value: "text" }, "纯文本"),
                h("option", { value: "markdown" }, "markdown")))) : null,

          type === "command" ? h("div", { className: "blw-row" },
            h("div", null, h("div", { className: "blw-label" }, "自定义命令"),
              h("div", { className: "blw-hint" }, "cmd = 可执行文件（如 node.exe）；消息**自动作为最后一个参数**传进去 ✓"),
              h("div", { className: "blw-hint" }, "⚠️ 不再支持 $MSG（2026-10-18 弃用：走 shell 有命令注入风险 ✗）")),
            h("input", { className: "blw-input blw-wide", style: { minWidth: "300px" }, value: n.cmd ?? "", placeholder: 'C:\\path\\to\\node.exe', onChange: (e) => set(["notify", "cmd"], e.target.value) }),
            h("div", { className: "blw-hint", style: { marginTop: "6px" } }, "参数（JSON 数组，可留空；比如 [\"C:/path/to/cli.js\"]）"),
            h("input", {
              className: "blw-input blw-wide", style: { minWidth: "300px" },
              value: JSON.stringify(n.args ?? []),
              onChange: (e) => {
                try { const v = JSON.parse(e.target.value); set(["notify", "args"], Array.isArray(v) ? v : []) } catch {}
              },
              placeholder: '["C:/path/to/cli.js"]',
            })) : null),

        h("div", { className: "blw-actions", style: { borderTop: "none", marginTop: "8px", paddingTop: "0" } },
          h("button", { className: "blw-btn blw-btn2", onClick: test, disabled: testing }, testing ? "发送中…" : "实际发送一条测试通知"),
          type === "none" ? h("span", { className: "blw-hint" }, "（方式=不推送时，测试只验证命令能跑通）") : null),
        testOut ? h("div", box, testOut) : null);
    }

    function QrLogin({ disabled, onAccount, onActiveChange }) {
      const [qr, setQr] = useState(null);
      const [error, setError] = useState("");
      const flow = useRef({ generation: 0, id: null, timer: null });
      const call = async (name, body = {}) => {
        const response = await fetch(`${API}/auth/qr/${name}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok) throw new Error(result.error || "登录操作失败，请重试。");
        return result;
      };
      const cancel = () => {
        flow.current.generation++;
        clearTimeout(flow.current.timer);
        const id = flow.current.id;
        flow.current.id = null;
        if (id) void call("cancel", { id }).catch(() => {});
      };
      useEffect(() => () => cancel(), []);
      const start = async () => {
        cancel(); setError(""); setQr({ status: "starting" });
        const generation = flow.current.generation;
        try {
          const initial = await call("start");
          if (generation !== flow.current.generation) {
            void call("cancel", { id: initial.id }).catch(() => {}); return;
          }
          flow.current.id = initial.id;
          setQr(initial);
          const poll = async () => {
            try {
              const result = await call("poll", { id: initial.id });
              if (generation !== flow.current.generation) return;
              setQr(result);
              if (result.status === "success") {
                onAccount(result.account);
                flow.current.id = null;
              } else if (["waiting", "scanned"].includes(result.status)) {
                flow.current.timer = setTimeout(poll, 2000);
              }
            } catch (e) {
              if (generation !== flow.current.generation) return;
              cancel(); setError(e.message); setQr({ status: "error" });
            }
          };
          flow.current.timer = setTimeout(poll, 2000);
        } catch (e) {
          if (generation === flow.current.generation) { setError(e.message); setQr({ status: "error" }); }
        }
      };
      const active = ["starting", "waiting", "scanned"].includes(qr?.status);
      useEffect(() => {
        onActiveChange(active);
        return () => onActiveChange(false);
      }, [active, onActiveChange]);
      const status = {
        starting: "正在生成二维码…", waiting: "用哔哩哔哩 App 扫码登录。",
        scanned: "已扫码，请在手机上确认。", expired: "二维码已过期，请重新生成。",
        cancelled: "已取消，原登录态未改变。",
        success: qr?.account ? `已登录：${qr.account.name}（mid ${qr.account.mid}）` : "",
      }[qr?.status];
      return h("div", { className: "blw-cookie" },
        qr?.image ? h("img", { src: qr.image, alt: "B 站登录二维码", width: 220, height: 220 }) : null,
        status ? h("div", { className: "blw-hint", role: "status" }, status) : null,
        error || qr?.error ? h("div", { className: "blw-err", role: "alert" }, error || qr.error) : null,
        qr?.account?.warn ? h("div", { className: "blw-err" }, qr.account.warn) : null,
        h("div", { style: { display: "flex", gap: "8px" } },
          h("button", { className: "blw-btn", onClick: start, disabled: disabled || active }, qr ? "重新生成二维码" : "扫码登录"),
          active ? h("button", { className: "blw-btn blw-btn2", onClick: () => { cancel(); setQr({ status: "cancelled" }); } }, "取消登录") : null));
    }

    function SmallAccountLogin({ cfg, onAccount, disabled = false, onActiveChange = () => {} }) {
      const [loginAttempt, setLoginAttempt] = useState(null);
      const [pending, setPending] = useState(false);
      const [message, setMessage] = useState("");
      const active = pending || ["connecting", "confirm"].includes(loginAttempt?.state);
      useEffect(() => { onActiveChange(active); return () => onActiveChange(false); }, [active, onActiveChange]);
      const post = async (action, body = {}) => {
        const response = await fetch(API + "/login/" + action, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || "登录操作失败，请重试");
        return result;
      };
      useEffect(() => {
        if (!loginAttempt || loginAttempt.state !== "connecting") return;
        let cancelled = false, timer;
        const poll = async () => {
          try {
            const result = await post("poll", { id: loginAttempt.id });
            if (cancelled) return;
            setLoginAttempt(q => q?.id === loginAttempt.id ? { ...q, ...result } : q);
            if (result.state === "error") setMessage(result.error || "获取失败，请按引导检查后重试");
            if (result.state === "connecting") timer = setTimeout(poll, 1000);
          } catch (e) { if (!cancelled) { setMessage(e.message); setLoginAttempt(q => ({ ...q, state: "error" })); } }
        };
        timer = setTimeout(poll, 1000);
        return () => { cancelled = true; clearTimeout(timer); };
      }, [loginAttempt?.id, loginAttempt?.state]);
      useEffect(() => () => { if (loginAttempt?.id) post("cancel", { id: loginAttempt.id }).catch(() => {}); }, [loginAttempt?.id]);
      const run = async (action) => {
        setPending(true); setMessage("");
        try {
          const result = await post(action, loginAttempt?.id ? { id: loginAttempt.id } : {});
          if (action === "start") setLoginAttempt(result);
          if (action === "cancel") setLoginAttempt(null);
          if (result.account && ["saved", "verified"].includes(result.state)) {
            onAccount(result.account);
            setMessage(`已${result.state === "saved" ? "保存" : "核验"}小号：${result.account.name}（UID ${result.account.mid}）`);
            if (result.account.warn) setMessage(result.account.warn);
            if (action === "confirm") setLoginAttempt(null);
          }
          if (result.state === "missing") setMessage("还没有保存小号登录态，请先从 Chrome 获取。");
        } catch (e) { setMessage(e.message); } finally { setPending(false); }
      };
      const ownerMid = String(cfg.owner?.mid ?? "").match(/(?:space\.bilibili\.com\/)?([1-9]\d*)\/?$/)?.[1];
      const sameAccount = loginAttempt?.account?.mid && loginAttempt.account.mid === ownerMid;
      return h("div", { className: "blw-rows" },
        h("div", { className: "blw-group" }, "1. 登录小号"),
        h("p", { className: "blw-hint" }, "复用正常 Chrome 中已登录的 B 站小号，不启动新浏览器、不重新登录、不安装扩展。读取后先核对账号，再确认保存。"),
        h("ol", { className: "blw-hint" },
          h("li", null, "先在正常 Chrome 打开 B 站，并确认登录的是小号。"),
          h("li", null, "在地址栏粘贴 chrome://inspect/#remote-debugging，开启远程调试（Chrome 144 或更新版本）。"),
          h("li", null, "点击下方获取按钮，再在 Chrome 本次连接弹窗中点「允许」。仅开启开关还不够。"),
          h("li", null, "返回这里核对昵称和 UID，点击确认才会保存。连接完成会自动断开，不关闭浏览器。")),
        h("p", { className: "blw-hint" }, "授权本身是浏览器级调试权限；本功能只查询 B 站的三个字段并只读核验账号。不会读取其他站点的 Cookie，不会发消息。用完可在 Chrome 关闭远程调试。"),
        h("div", { className: "blw-label" }, cfg.self?.mid ? `上次绑定：${cfg.self.name || "小号"}（UID ${cfg.self.mid}）；当前是否有效请点「检查小号登录」` : "尚未绑定小号"),
        h("div", { className: "blw-actions" },
          h("button", { className: "blw-btn", disabled: disabled || pending || loginAttempt?.state === "connecting", onClick: () => run("start") }, loginAttempt ? "重新从 Chrome 获取" : "从当前 Chrome 获取登录态"),
          h("button", { className: "blw-btn blw-btn2", disabled: disabled || pending, onClick: () => run("status") }, "检查小号登录"),
          loginAttempt ? h("button", { className: "blw-btn blw-btn2", disabled: pending, onClick: () => run("cancel") }, "取消登录") : null),
        loginAttempt?.state === "connecting" ? h("p", { role: "status", className: "blw-hint" }, "正在连接正常 Chrome…请切换到 Chrome，允许本次调试请求。最多等待约两分钟；也可以取消。") : null,
        loginAttempt?.state === "confirm" ? h("div", null,
          h("p", { className: "blw-label" }, `即将使用：${loginAttempt.account.name}（UID ${loginAttempt.account.mid}）`),
          h("p", { className: "blw-hint" }, "登录所需的三个字段已齐全，Cookie 值不会显示在页面中。"),
          h("p", { className: "blw-hint" }, "请核对这是小号。确认后只保存登录态，不开启监听或主动分享；已有开启的功能会按原设置继续运行。"),
          sameAccount ? h("p", { className: "blw-err" }, "这与填写的主号相同，请在 Chrome 切换到小号后重新获取。") : null,
          h("button", { className: "blw-btn", disabled: disabled || pending || !!sameAccount, onClick: () => run("confirm") }, "确认并保存这个小号")) : null,
        message ? h("p", { role: "status", className: "blw-hint" }, message) : null);
    }

    function SetupGuide({ cfg, set }) {
      const same = cfg.self?.mid && String(cfg.self.mid) === String(cfg.owner?.mid);
      return h("div", { className: "blw-out", style: { fontFamily: "inherit", maxHeight: "none" } },
        h("strong", null, "第一次使用：先连通两个账号"),
        h("ol", null,
          h("li", null, "登录小号：小号负责浏览、留言和发私信。"),
          h("li", null, "绑定主号：填你日常使用的主号 UID 或空间链接；主号和小号要互相关注。"),
          h("li", null, "开启私信回复并保存：你用主号找小号，它才会自动回复。"),
          h("li", null, "以后需要时再开主动分享；不影响前面的私信聊天。")),
        h("p", null, `当前表单（普通设置保存后生效）：小号：${cfg.self?.mid ? "已绑定，仍需核验登录有效性" : "未绑定"} · 主号：${cfg.owner?.mid ? "已填写" : "未填写"} · 私信回复：${cfg.listen?.dm ? "开启" : "关闭"}`),
        same ? h("p", { className: "blw-err" }, "主号和小号不能是同一个账号。") : null,
        h("button", { className: "blw-btn blw-btn2", onClick: () => {
          set(["listen", "dm"], true); set(["listen", "comment"], false); set(["listen", "live"], false);
          set(["share", "enabled"], false); set(["share", "via"], "dm"); set(["notify", "type"], "none");
        } }, "填入新手配置：只回复主号私信"),
        h("p", { className: "blw-hint" }, "只填写表单，点底部「保存」后才生效。会关闭主动分享、评论监听、直播监听和摘要推送。保存后收到主号私信可自动发出回复，无需逐条审核。DSH 需保持运行、电脑不能休眠。"));
    }

    function PrivateReplyEditor({ cfg, set }) {
      return h("div", null,
        h("div", { className: "blw-group" }, "3. 私信回复"),
        h(SwitchRow, { label: "自动回复主号私信", value: !!cfg.listen?.dm, onChange: value => set(["listen", "dm"], value),
          hint: "只读取并回复已绑定主号的私信；开启并保存后会实际发送回复，不用逐条审核。主号、小号必须互关。" }),
        h("p", { className: "blw-hint" }, "约每分钟检查一次，再加生成与发送时间；平台限制时可能延迟。与刷视频作息、评论区的「窗口外也回复」开关无关。不要为了收私信开启主动分享或消息推送。"));
    }

    function BiliWhaleSection() {
      useStyleOnce();
      const [cfg, setCfg] = useState(null);
      const [savedJson, setSavedJson] = useState("");   // 2026-10-19：用来判断"有没有未保存的改动" ✓
      const [out, setOut] = useState("");
      const [err, setErr] = useState("");
      const [busy, setBusy] = useState("");
      const [ck, setCk] = useState({ sessdata: "", bili_jct: "", buvid3: "" });
      const [ckMsg, setCkMsg] = useState("");
      // 2026-10-21：她专属的人设（~/.bili-ai/persona.md）—— 自由输入 + 注入 ✓
      const [personaText, setPersonaText] = useState("");
      const [personaMsg, setPersonaMsg] = useState("");
      const [personaBytes, setPersonaBytes] = useState(0);
      const [automationPaused, setAutomationPaused] = useState(false);
      const [qrActive, setQrActive] = useState(false);
      const [chromeActive, setChromeActive] = useState(false);
      const updateAccount = useCallback(account => {
        setCfg(current => ({ ...current, self: account }));
        setSavedJson(current => { try { return JSON.stringify({ ...JSON.parse(current), self: account }); } catch { return current; } });
      }, []);

      const load = useCallback(async () => {
        setErr("");
        try {
          const r = await fetch(`${API}/settings`, { headers: { accept: "application/json" } });
          if (!r.ok) throw new Error(`HTTP ${r.status}${r.status === 403 ? "（被信任栅栏拒绝）" : ""}`);
          const j = await r.json();
          setAutomationPaused(j.automationPaused === true);
          setCfg(j.config ?? {});
          setSavedJson(JSON.stringify(j.config ?? {}));
          // 人设单独一个文件，顺手读一下 ✓
          try {
            const pr = await fetch(`${API}/persona`, { headers: { accept: "application/json" } });
            if (pr.ok) { const pj = await pr.json(); setPersonaText(pj.text ?? ""); setPersonaBytes(pj.bytes ?? 0); }
          } catch {}
        } catch (e) { setErr(`读取配置失败：${e.message}`); }
      }, []);

      useEffect(() => { load(); }, [load]);

      const set = (path, value) => setCfg((c) => {
        const next = JSON.parse(JSON.stringify(c ?? {}));
        setPath(next, path, value);
        return next;
      });

      const save = async () => {
        setBusy("save"); setErr(""); setOut("");
        try {
          const wins = cfg?.night?.windows ?? [];
          const total = Math.max(1, wins.reduce((s, w) => s + (Number(w.wakes) || 1), 0));
          const body = { ...(cfg ?? {}), night: { ...(cfg?.night ?? {}), maxWakesPerDay: total } };
          const check = await fetch(`${API}/settings`, { headers: { accept: "application/json" } });
          if (!check.ok) throw new Error(`读取保存接口失败：HTTP ${check.status}`);
          const capabilities = await check.json();
          if (["character", "natural-dialogue"].includes(body.dialogueMode) && !capabilities.supportedDialogueModes?.includes("character")) {
            throw new Error("设置页已更新，但 DSH 后台仍是旧版本。请完整退出并重启 DSH 后再保存；本次修改尚未写入。");
          }
          const r = await fetch(`${API}/settings`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            // 2026-10-18：宿主现在两种都收 ✓，这里显式包一层最稳（以前发裸对象 → 宿主 merge 到 {}
            body: JSON.stringify({ config: body }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.ok || !j.config) throw new Error(j.error || `保存接口未确认写入（HTTP ${r.status}）`);
          setOut(`✓ 已保存${j.warn ? `\n⚠️ ${j.warn}` : ""}\n配置：${j.configPath ?? "~/.dsh/bili-whale.config.json"}`);
          if (j.config) { setCfg(j.config); setSavedJson(JSON.stringify(j.config)); }
          return true;
        } catch (e) { setErr(`保存失败：${e.message}`); return false; } finally { setBusy(""); }
      };

      const injectPersona = async () => {
        setBusy("persona"); setPersonaMsg("");
        try {
          const r = await fetch(`${API}/persona`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ text: personaText }),
          });
          const j = await r.json();
          if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
          setPersonaBytes(j.bytes ?? 0);
          setPersonaMsg(j.detail ?? "✓ 已注入");
        } catch (e) { setPersonaMsg("✗ " + e.message); }
        finally { setBusy(""); }
      };

      const deps = async () => {
        setBusy("deps"); setErr(""); setOut("检查中…");
        try {
          const r = await fetch(`${API}/deps`, { headers: { accept: "application/json" } });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          const lines = (j.items ?? []).map((i) => `${i.ok ? "✓" : "✗"} ${i.name} — ${i.detail ?? ""}`);
          const schedulerOk = j.scheduler?.ok === true;
          lines.push(`${schedulerOk ? "✓" : "✗"} 生物钟 — ${j.scheduler?.reason ?? "未返回调度器状态"}`);
          if (j.error) lines.push(j.error);
          // 2026-10-19：体检后顺手重读配置 ✓ 不然「她自己 mid/昵称」那两格永远显示旧值 ✗
          if (j.self) lines.push("", `她自己：${j.self.name}（mid ${j.self.mid}）✓`);
          await load();
          setOut([...lines, "", j.ok && schedulerOk ? "全部可用 ✓" : "有项不可用 ✗"].join("\n"));
        } catch (e) { setErr(`依赖体检失败：${e.message}`); } finally { setBusy(""); }
      };

      const saveCookie = async () => {
        setBusy("cookie"); setErr(""); setCkMsg("");
        try {
          const r = await fetch(`${API}/cookie`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify(ck),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          setCkMsg(`✓ ${j.detail ?? "已写入"}` + (j.warn ? `\n${j.warn}` : ""));   // 永不回显 cookie ✓（warn 要说出来 ✗ 不然等于没查）
          setCk({ sessdata: "", bili_jct: "", buvid3: "" });
        } catch (e) { setCkMsg(`✗ ${e.message}`); } finally { setBusy(""); }
      };

      if (!cfg) {
        return h("div", { className: "blw" },
          h("h3", { className: "blw-title" }, "养鱼"),
          err ? h("div", { className: "blw-err" }, err) : h("div", { className: "blw-hint" }, "读取中…"));
      }

      const groups = [];
      for (const f of FIELDS) {
        if (cfg.dialogueMode === "character" && ["她是谁", "人格与表达"].includes(f.group)) continue;
        if (cfg.dialogueMode !== "character" && f.group === "角色") continue;
        let g = groups.find((x) => x.name === f.group);
        if (!g) { g = { name: f.group, fields: [] }; groups.push(g); }
        g.fields.push(f);
      }
      // 渲染顺序（2026-10-22 主人定，见下面的 GROUP_ORDER）：
      //   她是谁 → 你（主人）→ 口味 → 作息 →【分享评论 + 全天监听】→ 日记与推送 → 消息推送 → 工具链
      // 2026-10-21：人设块 —— 挂在「她是谁」那一组下面 ✓（主人要求放这三个字段下面）
      const personaBlock = () => [
          h("div", { className: "blw-group" }, "她的人设（只属于她）"),
          h("div", { className: "blw-rows" },
            h("div", { className: "blw-row" },
              h("div", null,
                h("div", { className: "blw-label" }, "人设正文"),
                h("div", { className: "blw-hint" },
                  "写到 ", h("code", null, "~/.bili-ai/persona.md"),
                  "，只影响她（不影响别的会话 ✓）。每次唤醒/监听都会附在提示里 ✓",
                  h("br"),
                  "建议写：身份与来历 / 说话腔调 / 在意什么、怕什么 / 明确不要的行为。上限 20000 字，注入时只取前 20000 字 ✓")),
              h("div", { className: "blw-cookie", style: { minWidth: "420px" } },
                h("textarea", {
                  className: "blw-input",
                  rows: 12,
                  placeholder: "例如：\n她的名字是…\n她说话时会…\n她在意…\n她绝对不会…",
                  value: personaText,
                  onChange: (e) => setPersonaText(e.target.value),
                  style: { resize: "vertical", fontFamily: "inherit", lineHeight: "1.6" },
                }),
                h("div", { className: "blw-hint" },
                  "当前 " + personaBytes + " 字节" + (personaText.length > 20000 ? "（超过 20000 上限 ✗）" : "")),
                h("button", { className: "blw-btn", onClick: injectPersona, disabled: !!busy || personaText.length > 20000 },
                  busy === "persona" ? "注入中…" : "注入人设"),
                personaMsg ? h("div", { className: personaMsg.startsWith("✓") ? "blw-hint" : "blw-err" }, personaMsg) : null))),
      ];

      const renderGroup = (g) => h("div", { key: g.name, className: "blw-panel" },
        h("div", { className: "blw-group" }, g.name),
        g.name === "角色" ? h("div", null,
          h("div", { className: "blw-hint" }, "仅属于这条鱼。B站账号昵称不影响角色姓名。")) : null,
        g.name === "人格与表达" ? h("div", null,
          h("div", { className: "blw-hint" }, "已准备好初始人格，无须调参数。留言会优先聊具体细节，简短接话，少写总结；已有的名字、经历和人设仍然保留。"),
          h("div", { className: "blw-hint" }, "例如：比起“这个视频内容丰富，令人受益匪浅”，更像“后面那个转场居然接上了”。语气会影响表达，是否留言仍由内容和原有设置决定。"),
          h("button", { className: "blw-btn blw-btn2", disabled: !!busy, onClick: async () => {
            try {
              const response = await fetch(API + "/settings", { headers: { accept: "application/json" } });
              const data = await response.json();
              if (!response.ok || !data.voiceDefaults) throw new Error("暂时无法读取默认人格");
              set(["voice"], data.voiceDefaults);
              setOut("已填入默认人格，点击下方「保存」后生效。原有角色设定不会被修改。");
            } catch (e) { setErr(e.message); }
          } }, "恢复默认人格"),
          h("div", { className: "blw-hint" }, "只恢复下面的性格与表达设置，保存后生效。")) : null,
        g.name === "作息" ? h(WindowsEditor, { cfg, set }) : null,
        g.name === "人格与表达" ? h("div", null,
          h("div", { className: "blw-rows" }, g.fields.filter(f => f.path[1] === "enabled").map(f => h(Row, { key: f.path.join("."), f, cfg, set }))),
          h("details", null, h("summary", { className: "blw-label", style: { cursor: "pointer", marginTop: "10px" } }, "自定义人格与表达（可选）"),
            h("div", { className: "blw-rows" }, g.fields.filter(f => f.path[1] !== "enabled").map(f => h(Row, { key: f.path.join("."), f, cfg, set }))))) :
          h("div", { className: "blw-rows" }, g.fields.map((f) => h(Row, { key: f.path.join("."), f, cfg, set }))),
        // 2026-10-21：人设块放在这三个字段【下面】✓（主人要求）
        g.name === "她是谁" ? h("div", null, personaBlock()) : null);
      // 2026-10-22 修：分组顺序显式定死 ✗ 不再靠 FIELDS 里字段出现的先后
      //   （v0.4.2 把新字段插在 FIELDS 最前面 → 工具链跑到了第一位 ✗ 整个页面顺序乱了）
      //   主人定的顺序：她是谁 → 你 → 口味 → 作息 →【分享 / 监听】→ 日记与推送 → 消息推送 → 工具链
      const GROUP_ORDER = ["2. 绑定主号"]
      const byName = (n) => groups.find((g) => g.name === n)
      const orderedTop = GROUP_ORDER.map(byName).filter(Boolean)
      // 2026-10-24 主人要求：「分享前检查」要提到「分享」前面 ✓
      const orderedPreShare = ["分享前检查"].map(byName).filter(Boolean)
      const orderedMid = ["日记与推送"].map(byName).filter(Boolean)
      const orderedTool = ["工具链"].map(byName).filter(Boolean)
      // 兜底：万一以后又加了新分组，别让它消失 ✗
      const known = new Set([...GROUP_ORDER, "小号账号信息", "分享前检查", "日记与推送", "工具链"])
      const leftovers = groups.filter((g) => !known.has(g.name))
      const ci = { className: "blw-input" };

      return h("div", { className: "blw" },
        h("h3", { className: "blw-title" }, "养鱼"),
        automationPaused ? h("p", { className: "blw-hint", role: "status" }, "维护验证中：自动浏览、监听和任务投递暂时暂停；设置仍可正常保存。") : null,
        h("p", { className: "blw-intro" },
          "一个小号负责行动，一个主号负责接收。先按引导连通私信，再决定是否开启主动分享。",
          "所有值写进 ", h("code", null, "~/.dsh/bili-whale.config.json"),
          cfg.dialogueMode === "character" ? "（角色和普通设置统一点击保存；Chrome 登录态另行确认）。" : "（普通设置需点击保存；Chrome 登录态和人设正文有各自的确认按钮）。"),

        h("section", { className: "blw-panel" }, h(SetupGuide, { cfg, set })),
        h("section", { className: "blw-panel" }, h(SmallAccountLogin, { cfg, disabled: qrActive || !!busy, onActiveChange: setChromeActive, onAccount: updateAccount }),
          h("details", null, h("summary", { className: "blw-label" }, "其他登录方式：扫码"),
            h(QrLogin, { disabled: chromeActive || !!busy, onActiveChange: setQrActive, onAccount: updateAccount }))),
        h("details", { className: "blw-panel" }, h("summary", { className: "blw-label" }, "小号账号信息（自动识别）"), renderGroup(byName("小号账号信息"))),
        h("details", { className: "blw-panel" }, h("summary", { className: "blw-label" }, "无法连接 Chrome？手动填写小号 Cookie（备用）"),
        h("div", { className: "blw-rows" },
          h("div", { className: "blw-row" },
            h("div", null,
              h("div", { className: "blw-label" }, "小号登录凭据"),
              h("div", { className: "blw-hint" }, "浏览器 F12 → Cookie 里复制（SESSDATA 是 HttpOnly，console 拿不到 ✗）；写入后永不回显 ✓")),
            h("div", { className: "blw-cookie" },
              h("input", { ...ci, type: "password", autoComplete: "off", placeholder: "SESSDATA", value: ck.sessdata, onChange: (e) => setCk((s) => ({ ...s, sessdata: e.target.value })) }),
              h("input", { ...ci, type: "password", autoComplete: "off", placeholder: "bili_jct", value: ck.bili_jct, onChange: (e) => setCk((s) => ({ ...s, bili_jct: e.target.value })) }),
              h("input", { ...ci, placeholder: "buvid3（可空）", value: ck.buvid3, onChange: (e) => setCk((s) => ({ ...s, buvid3: e.target.value })) }),
              h("button", { className: "blw-btn blw-btn2", onClick: saveCookie, disabled: !!busy || qrActive || chromeActive || !ck.sessdata || !ck.bili_jct },
                busy === "cookie" ? "写入中…" : "写入凭据"),
              ckMsg ? h("div", { className: (ckMsg.startsWith("✓") ? "blw-hint blw-pre" : "blw-err") }, ckMsg) : null)))),
        ...orderedTop.map(renderGroup),
        h("section", { className: "blw-panel" }, h(PrivateReplyEditor, { cfg, set })),
        ...orderedPreShare.map(renderGroup),

        h("section", { className: "blw-panel" }, h(ShareEditor, { cfg, set })),
        h("section", { className: "blw-panel" }, h(ListenEditor, { cfg, set })),

        ...orderedMid.map(renderGroup),
        h("section", { className: "blw-panel" }, h(NotifyEditor, { cfg, set, save })),
        ...leftovers.map(renderGroup),
        ...orderedTool.map(renderGroup),

        h("div", { className: "blw-actions" },
          h("button", { className: "blw-btn", onClick: save, disabled: !!busy || qrActive || chromeActive }, busy === "save" ? "保存中…" : "保存"),
          cfg && savedJson && JSON.stringify(cfg) !== savedJson
            ? h("span", { style: { marginLeft: "10px", color: "#ffb020", fontSize: "13px" } }, "● 有改动还没保存（改了不点保存 = 没生效 ✗）")
            : null,
          h("button", { className: "blw-btn blw-btn2", onClick: deps, disabled: !!busy }, busy === "deps" ? "体检中…" : "依赖体检"),
          h("button", { className: "blw-btn blw-btn2", onClick: load, disabled: !!busy || qrActive || chromeActive }, "重新读取")),

        err ? h("div", { className: "blw-err" }, err) : null,
        out ? h("div", { className: "blw-out" }, out) : null,
        h("div", { className: "blw-hint" }, "装完先点「依赖体检」：cookie / ffmpeg / node / 数据目录 都 ✓ 才算可用。"));
    }

    const inject = ["slots"];
    const NS = "bili-whale";
    const NAMES = { nav: "养鱼" };

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              { name: "settings.section", id: NS, order: 6, label: () => NAMES.nav },
              BiliWhaleSection,
            ),
            "bili-whale: settings section",
          ),
        "bili-whale: settings section",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.BiliWhaleSection = BiliWhaleSection;
    exports.FIELDS = FIELDS;
    return module.exports;
  },
});

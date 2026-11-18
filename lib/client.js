/** DSH 设置页。编辑可见字段时保留完整配置。 */
window.__ModuleLoader__.load({
  id: "dsh-bili-whale",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createElement: h, useCallback, useEffect, useState, useRef } = React;

    const API = new URL("dsh-bili/api", document.baseURI).pathname;
    const CSS_TAG = "dsh-bili-whale/section.css";
    const CSS = [
      ".blw{font-size:14px;line-height:1.5;max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:6px}",
      ".blw :is(input,select,button,textarea,summary,label,pre,code,h3){font-size:inherit}",
      ".blw-title{margin:0;font-weight:500;line-height:24px}",
      ".blw-intro{color:var(--dsw-alias-label-tertiary);margin:0 0 4px;line-height:20px}",
      ".blw-group{margin-top:14px;font-weight:600;line-height:20px}",
      ".blw-section{border-top:1px solid var(--dsw-alias-border-l2);padding:8px 0}.blw-section>summary{cursor:pointer;font-weight:600;padding:4px 0}",
      ".blw-rows{display:flex;flex-direction:column}",
      ".blw-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 20px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}",
      ".blw-row:last-child{border-bottom:none}",
      ".blw-row>div:first-child{flex:1;min-width:190px}",
      ".blw-label{line-height:19px}",
      ".blw-hint{color:var(--dsw-alias-label-tertiary);margin-top:3px;line-height:17px}",
      ".blw-input,.blw-select{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);height:28px;padding:0 8px;min-width:180px;outline:none}",
      ".blw-input:focus-visible,.blw-select:focus-visible{border-color:var(--dsw-alias-brand-primary)}",
      ".blw-input.blw-wide{min-width:260px}",
      ".blw-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}",
      // 2026-10-25 修：主按钮文字原来写死 #fff —— 深色主题下 brand-primary = #f9fafb（近白），
      //   于是「白底白字」，保存 / 注入人设 / 发 三个按钮只剩一块白，字看不见（对比度 1.05:1）✗
      //   与之配对的 token 是 label-primary-foreground（深色 #0f1115 / 浅色 #fff）✓
      //   兜底 #fff：老版本 DSH 的 brand-primary 是蓝色，没有这个 token 时也仍然可读。
      ".blw-btn{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff);border:none;border-radius:6px;height:30px;padding:0 12px;cursor:pointer}",
      ".blw-btn:disabled{opacity:.5;cursor:default}",
      ".blw-btn2{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}",
      ".blw-out{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:17px;color:var(--dsw-alias-label-secondary);background:rgba(127,127,127,.08);border-radius:8px;padding:10px 12px;max-height:240px;overflow:auto;margin-top:10px}",
      ".blw-err{color:var(--dsw-alias-state-error-primary);line-height:18px;margin-top:8px;white-space:pre-line}",
      ".blw-hint.blw-pre{white-space:pre-line}",
      ".blw-badge{display:inline-block;line-height:16px;padding:1px 7px;border-radius:999px;background:rgba(127,127,127,.14);color:var(--dsw-alias-label-secondary);margin-left:6px}",
      ".blw-cookie{display:flex;flex-direction:column;gap:8px;min-width:250px}",
    ].join("");

    // ── 唯一真相：字段清单（加字段只改这里 ✓）────────────────────────────
    //   kind: text | number | list（逗号分隔数组）| switch | select
    const FIELDS = [
      {group:"自主活动",path:["life","autonomy"],label:"允许自主浏览与主动聊天",hint:"可在唤醒后追加只读浏览，并在满足条件时主动私信。",kind:"switch"},
      {group:"自主活动",path:["diary","enabled"],label:"自动写日记",hint:"根据公开浏览和私人交流分别记录。",kind:"switch",defaultValue:true},
      {group:"自主活动",path:["chat","followup"],label:"聊完后补话",hint:"有未说完的内容时，回复后几分钟内可再发一条私信。",kind:"switch"},
      {group:"自主活动",path:["chat","idle"],label:"久未联系时主动私信",hint:"有具体话题时，她可以主动联系你。",kind:"switch"},
      {group:"自主活动",path:["chat","shareReply"],label:"分享评论收到回复时提醒我",hint:"通过私信提醒，需要开启评论监听。",kind:"switch"},
      {group:"自主活动",path:["chat","dynamic"],label:"允许自主发公开动态",hint:"浏览后有值得公开分享的感想时，她可以发布动态。",kind:"switch"},
      {group:"会话成本",path:["sessionRotateDays"],label:"会话轮换天数",hint:"0 不轮换；开启后在空闲时创建新会话，保留旧会话",kind:"number"},
      {group:"会话成本",path:["personaOncePerSession"],label:"每会话减少重复人设",hint:"默认开启；成功投递后去重，人设变化或重启后会重新注入",kind:"switch"},
      {group:"分享前检查",path:["share","aiCommentGuard"],label:"疑似 AI 评论检查（试用）",hint:"仅主动 @ 分享；按视频缓存 6 小时，超阈值暂缓并推送",kind:"switch"},
      { group: "工具链", path: ["home"], label: "专用会话目录", hint: "已存在目录的绝对路径；留空用默认目录。重启后新建会话生效，已有会话不迁移", kind: "text", wide: true },
      { group: "她是谁", path: ["persona", "name"], label: "角色名", hint: "她怎么被称呼", kind: "text" },
      { group: "她是谁", path: ["persona", "ownerTitle"], label: "她怎么称呼你", hint: "例如「主人」", kind: "text" },
      { group: "她是谁", path: ["persona", "selfClaim"], label: "她怎么自称", hint: "例如「我」/「人家」", kind: "text" },

      { group: "你（主人）", path: ["owner", "mid"], label: "主人 mid", hint: "用来认「谁回过她 / 谁点了赞」", kind: "text" },
      { group: "你（主人）", path: ["owner", "name"], label: "主人昵称", hint: "@ 分享时写进正文", kind: "text" },
      { group: "你（主人）", path: ["self", "mid"], label: "她自己 mid", hint: "只读（来自 cookie）", kind: "text", readOnly: true },
      { group: "你（主人）", path: ["self", "name"], label: "她自己昵称", hint: "只读（来自 nav）", kind: "text", readOnly: true },

      { group: "作息", path: ["night", "skipChance"], label: "今晚不看的概率", hint: "0.3 = 三成", kind: "number" },
      { group: "作息", path: ["night", "maxVideos"], label: "单次醒来观看视频数量", hint: "初筛的候选数；筛完再挑 2–3 条深读", kind: "number" },

      { group: "口味", path: ["preferences", "like"], label: "爱看", hint: "逗号分隔", kind: "list" },
      { group: "口味", path: ["preferences", "dislike"], label: "不爱看", hint: "逗号分隔", kind: "list" },

      { group: "日记与推送", path: ["diary", "push"], label: "推送新写的公开日记", hint: "通过下方通知渠道发送公开日记原文。", kind: "switch" },

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
        const existing = document.getElementById(CSS_TAG);
        if (existing) {
          if (existing.textContent !== CSS) existing.textContent = CSS;
        } else {
          const el = document.createElement("style");
          el.id = CSS_TAG;
          el.textContent = CSS;
          document.head.appendChild(el);
        }
      }, []);
    }

    function Row({ f, cfg, set }) {
      const raw = getPath(cfg, f.path) ?? f.defaultValue;
      const common = { className: "blw-input" + (f.wide ? " blw-wide" : "") };
      // 2026-10-18 修：list 字段以前"值 = 数组 join、改动 = split 回数组" ✗
      //   → 你一打逗号，join 立刻把它吞掉（输入框里根本打不出逗号 ✗）
      //   现在：本地文本 state 管显示 ✓ 数组只在解析时更新 ✓（逗号能打、末尾逗号也不会乱跳 ✓）
      const [listText, setListText] = useState(Array.isArray(raw) ? raw.join("，") : (raw ?? ""));
      useEffect(() => {
        setListText(Array.isArray(raw) ? raw.join("，") : (raw ?? ""));
      }, [JSON.stringify(raw ?? null)]);
      let control;
      if (f.kind === "list") {
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
        control = h("input", { ...common, type: "number", step: "any", value: raw ?? "", readOnly: !!f.readOnly,
          onChange: (e) => set(f.path, e.target.value === "" ? undefined : Number(e.target.value)) });
      } else if (f.kind === "switch") {
        control = h("input", { type: "checkbox", "aria-label": f.label, checked: !!raw, disabled: !!f.readOnly,
          onChange: (e) => set(f.path, e.target.checked) });
      } else if (f.kind === "select") {
        control = h("select", { className: "blw-select", value: raw ?? "", disabled: !!f.readOnly,
          onChange: (e) => set(f.path, e.target.value) },
          f.options.map((o) => h("option", { key: o, value: o }, o)));
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
        h("input", { type: "checkbox", "aria-label": label, checked: !!value, disabled: !!disabled, onChange: (e) => onChange(e.target.checked) }));
    }

    // ── 【分享评论】（主动 @ 你）· 2026-10-18 主人给的排版 ────────────────
    function ShareEditor({ cfg, set }) {
      const s = cfg.share ?? {};
      const daily = cfg.quota?.shareDaily ?? 3;
      // 2026-10-19：分享方式二选一 —— comment=评论区公开 @ / dm=私信给你（必须带视频链接）
      const enabled = s.enabled !== false;
      return h("div", null,
        h(SwitchRow, {label:"允许主动分享", value:enabled, onChange:v=>set(["share","enabled"],v)}),
        enabled && h("div", {className:"blw-row"},
          h("label", {htmlFor:"blw-share-via"}, "分享给我的方式"),
          h("select", {id:"blw-share-via",className:"blw-select",value:s.via ?? "dm",onChange:e=>set(["share","via"],e.target.value)},
            h("option",{value:"dm"},"B 站私信（需互关）"),
            h("option",{value:"comment"},"公开评论 @ 我"))),
        enabled && h("div", {className:"blw-row"},
          h("label",{htmlFor:"blw-share-limit"},"每日分享上限"),
          h("input",{id:"blw-share-limit",className:"blw-input",type:"number",min:0,max:20,value:daily,onChange:e=>set(["quota","shareDaily"],Number(e.target.value))})));
    }

    function ListenEditor({ cfg, set }) {
      const L=cfg.listen ?? {}, comments=L.comment!==false;
      const toggle=(key,label,value,hint)=>h(SwitchRow,{label,value,hint,onChange:v=>set(["listen",key],v)});
      return h("div",null,
        h("section",{"aria-label":"评论区监听"},
        h("div",{className:"blw-group"},"评论区监听"),
        toggle("comment","接收评论通知",comments),
        comments && h("div",{className:"blw-row"},
          h("label",{htmlFor:"blw-listen-scope"},"接收范围"),
          h("select",{id:"blw-listen-scope",className:"blw-select",value:L.scope ?? "both",onChange:e=>set(["listen","scope"],e.target.value)},
            h("option",{value:"both"},"直接回复和 @ 提及"),h("option",{value:"reply"},"仅直接回复"))),
        comments && toggle("onlyOwner","只处理主人的评论",!!L.onlyOwner),
        comments && toggle("oncePerPerson","同一人 30 天内最多回复一次",!!L.oncePerPerson),
        comments && toggle("allDay","作息窗口外也监听评论",!!L.allDay),
        comments && toggle("mentionSummary","响应主人的 @ 总结请求",!!L.mentionSummary,"通过通知渠道发送总结。")),
        h("section",{"aria-label":"私信监听"},
          h("div",{className:"blw-group"},"私信监听"),
          toggle("dm","接收主人的私信",!!L.dm)));
    }

    // ── 【待审核】（2026-10-18 主人选 B 档：她的回复先给你看，你点「发」才发）──────
    function DeliveryPanel(){
      const [state,setState]=useState(null),[error,setError]=useState('');
      const load=useCallback(async()=>{
        try{const r=await fetch(API+'/status');const j=await r.json();if(!r.ok||!j.ok)throw Error(j.error||'读取失败');setState({...j.delivery,scheduler:j.scheduler,today:j.today,timezone:j.timezone});setError('')}
        catch(e){setError(e.message)}
      },[]);
      useEffect(()=>{load()},[load]);
      const last=state?.lastWake;
      const labels={accepted:'宿主已接受（未验证 agent 执行）',unconfirmed:'结果未确认，本次不会重投',dispatching:'等待宿主确认',failed:'投递失败'};
      return h('div',null,h('div',{className:'blw-group'},'运行概览'),
        state&&h('p',{className:'blw-hint'},`调度日期：${state.today} · 宿主时区：${state.timezone||'未知'}`),
        state?.scheduler&&h('p',{className:'blw-hint'},`调度阶段：${state.scheduler.activeRun?.stage||state.scheduler.status||'诊断不可用'} · 最近检查：${state.scheduler.lastTickAt?new Date(state.scheduler.lastTickAt).toLocaleString():'尚未检查'}`),
        state?.scheduler?.lastError&&h('p',{className:'blw-err'},'最近调度错误：'+state.scheduler.lastError.message),
        ...(state?.scheduler?.recent??[]).map((item,i)=>h('p',{key:i,className:'blw-hint'},`${new Date(item.at).toLocaleTimeString()} · ${item.kind} · ${item.reason}${item.stage?' · '+item.stage:''}${item.error?' · '+item.error:''}`)),
        h('p',{className:'blw-hint'},last?`上次唤醒投递：${labels[last.status]||last.status} · ${new Date(last.updatedAt).toLocaleString()}`:'尚无唤醒投递记录'),
        last?.error&&h('p',{className:'blw-hint'},last.error),
        state?.unconfirmed>0&&h('p',{className:'blw-err'},`${state.unconfirmed} 条投递待核查。检查 DSH 会话是否运行；不要直接重发未确认任务。`),
        state?.consecutiveFailures>=2&&h('p',{className:'blw-err'},'已连续两次或以上未确认唤醒，请检查 DSH 会话、权限与宿主日志。'),
        error&&h('p',{className:'blw-err'},error),
        h('button',{className:'blw-btn blw-btn2',onClick:load},'刷新运行状态'));
    }

    function CorpusPanel(){
      const [status,setStatus]=useState(null),[items,setItems]=useState([]),[total,setTotal]=useState(0),[filter,setFilter]=useState('pending'),[offset,setOffset]=useState(0);
      const [error,setError]=useState(''),[busy,setBusy]=useState(false),[chosen,setChosen]=useState(null),[topic,setTopic]=useState('general'),[intent,setIntent]=useState('reaction'),[note,setNote]=useState(''),[ack,setAck]=useState(false);
      const topics={animals:'动物',remix:'鬼畜',technology:'科技数码',food:'美食','daily-life':'生活',film:'影视',games:'游戏',history:'历史',outdoors:'户外',general:'通用'};
      const intents={reaction:'反应',observation:'观察',question:'提问','technical-help':'技术说明',discussion:'讨论'};
      async function run(action='list',extra={}){
        setBusy(true);setError('');
        try{
          const r=await fetch(API+'/corpus',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,status:filter,offset,limit:10,...extra})});const j=await r.json();if(!r.ok||!j.ok)throw Error(j.error||'操作失败');setStatus(j.state);
          if(action==='list'){setItems(j.result.items);setTotal(j.result.total)}
          else if(action==='export'){const url=URL.createObjectURL(new Blob([JSON.stringify(j.result,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='whale-corpus-export.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
          else {setChosen(null);const q=await fetch(API+'/corpus',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'list',status:filter,offset,limit:10})});const z=await q.json();if(!q.ok||!z.ok)throw Error(z.error||'刷新失败');setItems(z.result.items);setTotal(z.result.total)}
        }catch(e){setError(e.message)}finally{setBusy(false)}
      }
      useEffect(()=>{run('list')},[filter,offset]);
      const button=(text,fn,disabled=false)=>h('button',{className:'blw-btn blw-btn2',disabled:busy||disabled,onClick:fn},text);
      const select=(value,set,options)=>h('select',{className:'blw-select',value,onChange:e=>set(e.target.value)},Object.entries(options).map(([id,label])=>h('option',{key:id,value:id},label)));
      return h('details',null,h('summary',{className:'blw-group'},'表达参考库与语料审核'),
        h('p',{className:'blw-hint'},'这里只审核写法，不认证作者身份、不确认视频事实、不写入主人记忆。CSV 导入命令：node tools/bili.mjs corpus import <文件或目录>。新导入内容不会自动进入参考。'),
        status&&h('p',{className:'blw-hint'},`可用 ${status.approved}（内置 ${status.seed}） · 待审 ${status.pending} · 隔离 ${status.quarantined} · 版本 ${status.version}`),
        select(filter,v=>{setFilter(v);setOffset(0);setChosen(null)},{pending:'待审核',quarantined:'隔离观察',approved:'已批准/内置',rejected:'已拒绝'}),button('刷新',()=>run('list')),button('导出',()=>run('export')),
        h('div',{className:'blw-hint'},`第 ${offset+1}–${Math.min(total,offset+items.length)} 条 / 共 ${total}`),
        ...items.map(item=>h('div',{key:item.id,className:'blw-row'},h('div',null,h('div',null,item.text),h('div',{className:'blw-hint'},JSON.stringify({id:item.id,title:item.title,bvid:item.bvid,topic:item.topic,intent:item.intent,flags:item.flags,source:item.source}))),button('查看并标注',()=>{setChosen(item);setTopic(item.topic);setIntent(item.intent);setAck(false);setNote('')}),filter==='approved'&&button('撤销',()=>run('revoke',{id:item.id})))),
        button('上一页',()=>setOffset(Math.max(0,offset-10)),offset===0),button('下一页',()=>setOffset(offset+10),offset+items.length>=total),
        chosen&&h('div',null,h('pre',{className:'blw-out'},chosen.text),select(topic,setTopic,topics),select(intent,setIntent,intents),h('input',{className:'blw-input',value:note,placeholder:'审核说明',onChange:e=>setNote(e.target.value)}),h('label',null,h('input',{type:'checkbox',checked:ack,onChange:e=>setAck(e.target.checked)}),'已查看候选标记'),
          button('批准为写法参考',()=>run('review',{id:chosen.id,review:{action:'approve',topic,intent,note,acknowledgeFlags:ack}}),filter==='approved'),button('拒绝',()=>run('review',{id:chosen.id,review:{action:'reject',note}}),filter==='approved')),
        error&&h('div',{className:'blw-err',role:'alert'},error));
    }

    function LifePanel() {
      const [state,setState]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
      const [query,setQuery]=useState(''),[result,setResult]=useState(''),[note,setNote]=useState('');
      const [proposal,setProposal]=useState('{"type":"memory","text":"","sourceIds":[],"visibility":"private"}');
      const [eventId,setEventId]=useState(''),[receipt,setReceipt]=useState(''),[verified,setVerified]=useState(false);
      async function run(action,params={}) {
        setBusy(true);setError('');
        try {
          const r=await fetch(API+'/life',action?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...params})}:{});
          const j=await r.json();if(!r.ok||!j.ok)throw Error(j.error||'操作失败');
          if(j.state)setState(j.state);
          if(action==='export'){
            const url=URL.createObjectURL(new Blob([JSON.stringify(j.result,null,2)],{type:'application/json'}));
            const a=document.createElement('a');a.href=url;a.download='whale-life-export.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
          } else if(j.result)setResult(JSON.stringify(j.result,null,2));
        } catch(e){setError(e.message)} finally{setBusy(false)}
      }
      useEffect(()=>{run()},[]);
      const button=(label,action,params={},disabled=false)=>h('button',{className:'blw-btn blw-btn2',disabled:busy||disabled,onClick:()=>run(action,params)},label);
      const input=(value,set,placeholder)=>h('input',{className:'blw-input',value,placeholder,onChange:e=>set(e.target.value)});
      const row=(key,...children)=>h('div',{key,className:'blw-row'},...children);
      return h('details',null,h('summary',{className:'blw-group'},'记忆、线程与长期运行管理'),
        h('p',{className:'blw-hint'},'支持唤醒时后台归纳，普通理解经独立提取与复核形成；明确长期要求才可成为规则。推断可被纠正。导出含私密记录。'),
        state?.formationWorker&&h('p',{className:state.formationWorker.status==='unavailable'?'blw-err':'blw-hint'},'自动归纳：'+state.formationWorker.status+' · '+(state.formationWorker.reason??state.formationWorker.stage??'')),
        button('刷新'),state&&button(state.paused?'恢复主动活动':'暂停主动活动','pause',{value:!state.paused}),
        button('动态记忆状态','dynamic-status'),button('预览动态字段迁移','memory-migrate'),button('应用动态字段迁移','memory-migrate',{apply:true}),button('学习状态','learning-status'),button('行为轨迹','traces'),button('维护短期状态','maintain'),button('归档','archive'),button('导出完整记录','export'),button('预览旧日记迁移','migrate'),button('应用旧日记快照迁移','migrate',{apply:true}),button('重建检索索引','rebuild-index'),button('校验恢复检查点','replay-check'),button('绑定旧日记（仅私人可读）','bind-legacy',{name:'whale-diary.md'}),button('绑定私人日记','bind-legacy',{name:'whale-diary-private.md'}),
        state&&h('div',{className:'blw-hint'},`近期事件 ${state.events} · 归档 ${state.archives} · 未确认发送 ${state.pending.length}`),
        row('search',input(query,setQuery,'搜索来源/旧经历'),button('检索（含归档）','search',{query})),
        row('note',input(note,setNote,'你的反馈原文'),button('保存主人反馈','owner-note',{text:note},!note.trim())),
        h('p',{className:'blw-hint'},'复制上方反馈返回的事件 ID 到 sourceIds。偏好：type=preference，effect=exclude/prefer，scope={scene:watch/recommend/public/private/all,field:keyword/author/bvid/mention-owner,value:对象}。expiresAt 为毫秒时间戳；baseId 可替换旧记忆。人格用 type=persona，不改核心规则。表达策略用 type=expression_policy、scope.scenes、policy.defaultBehavior 和 policy.exceptions（条件、行为、来源）；审核前核对完整例外。'),
        h('textarea',{className:'blw-input',style:{width:'100%',height:100},value:proposal,onChange:e=>setProposal(e.target.value),'aria-label':'记忆提案 JSON'}),
        h('button',{className:'blw-btn blw-btn2',disabled:busy,onClick:()=>{try{run('propose',{proposal:JSON.parse(proposal)})}catch(e){setError(e.message)}}},'提交提案'),
        ...(state?.proposals??[]).filter(p=>p.status==='pending').map(p=>row(p.id,
          h('div',null,h('strong',null,p.type+' · '+p.text),h('div',{className:'blw-hint'},JSON.stringify({id:p.id,sourceIds:p.sourceIds,scope:p.scope,visibility:p.visibility,expiresAt:p.expiresAt,baseId:p.baseId,baseVersion:p.baseVersion,policy:p.policy,derivedFrom:p.derivedFrom}))),
          button('查看来源','sources',{ids:p.sourceIds}),p.type!=='reopen'&&button('接受','accept',{id:p.id,expectedRevision:state.revision}),button('拒绝','reject',{id:p.id}))),
        ...(state?.memories??[]).filter(m=>m.active).map(m=>row(m.id,h('div',null,m.text,h('div',{className:'blw-hint'},'ID '+m.id+' · '+m.type+' · '+JSON.stringify({scope:m.scope,version:m.version,policy:m.policy,recallEnabled:m.recallEnabled,epistemic:m.epistemic,independentDays:m.independentDays,relatedEvents:m.relevance?.version===(m.version??1)?m.relevance.tags.length:0,relationNeedsReview:!!m.relevance?.reviewNeeded,behaviorLinks:m.behaviorLinks,reviewAfter:m.reviewAfter}))),button(m.recallEnabled===false?'恢复取回':'停止取回','suppress',{id:m.id,value:m.recallEnabled!==false}),button('查看动态解释','memory-explain',{id:m.id}),button('保护保存','memory-retention',{id:m.id,protect:true,reason:'主人在管理页要求保护保存'}),button('取消保护','memory-retention',{id:m.id,protect:false}),button('撤销 / 回退该变化','revoke',{id:m.id}))),
        h('p',{className:'blw-hint'},'线程恢复：先检索该线程的新收件事件，填入 ID；冷却和当日预算不会被清空。'),
        input(eventId,setEventId,'新收件事件 ID'),
        ...(state?.threads??[]).slice(-30).map(t=>row(t.key,h('div',null,`${t.key} · ${t.status} · 本段 ${t.count} / 当日 ${t.daily} · ${t.reason||''}`),button('结束','close',{thread:t.key}),button('确认新问题并恢复','reopen',{thread:t.key,eventId},!eventId))),
        h('p',{className:'blw-hint'},'未确认发送必须先到平台回读。确认未发出才解锁；确认已发出请填写平台回执 ID。'),
        h('label',null,h('input',{type:'checkbox',checked:verified,onChange:e=>setVerified(e.target.checked)}),'我已在平台核查'),input(receipt,setReceipt,'平台回执 ID'),
        ...(state?.pending??[]).map(p=>row(p.id,h('div',null,p.channel+' → '+p.target),button('确认已发出','resolve',{id:p.id,status:'sent',receipt,confirmed:verified},!verified||!receipt),button('确认未发出','resolve',{id:p.id,status:'not-sent',confirmed:verified},!verified))),
        h('details',null,h('summary',null,'议程 / 活动预算 / 人格版本'),h('pre',{className:'blw-out'},JSON.stringify({agenda:state?.agenda,leases:state?.leases,activities:state?.activities,persona:state?.memories?.filter(m=>m.type==='persona')},null,2))),
        error&&h('div',{className:'blw-err',role:'alert'},error),result&&h('pre',{className:'blw-out'},result));
    }

    function PendingEditor() {
      const [items, setItems] = useState([]);
      const [busy, setBusy] = useState("");
      const [msg, setMsg] = useState("");

      const load = useCallback(async () => {
        try { const r = await fetch(`${API}/pending`, { headers: { accept: "application/json" } }); const j = await r.json(); if(!r.ok||j.ok===false)throw Error(j.error??"草稿读取失败"); setItems(j.items ?? []) } catch { setMsg("草稿刷新失败，请检查连接或诊断记录") }
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
      const test = async () => {
        setTesting(true); setTestOut("…正在保存设置（测试前先落盘 ✓）\n");
        try {
          // 2026-10-19：测试前**先保存** ✓
          //   以前测试读的是磁盘上的旧配置 → "点了别的单选、测试却还发到旧通道" ✗
          //   现在"你看到的就是你测的" ✓
          if (!await save()) { setTestOut("设置保存失败，请先检查保存提示。"); return; }
          const r = await fetch(`${API}/notify-test`, { method: "POST", headers: { accept: "application/json" } });
          const j = await r.json().catch(() => ({}));
          setTestOut((j.ok ? "✓ 已发送（设置已自动保存 ✓）\n" : "✗ 失败（设置已自动保存 ✓）\n") + (j.out || "") + (j.err ? "\n" + j.err : ""));
        } catch (e) { setTestOut("✗ " + e.message); } finally { setTesting(false); }
      };
      const box = { className: "blw-out", style: { marginTop: "8px" } };
      return h("div", null,
        h("div", { className: "blw-group" }, "消息推送"),
        h("div", { className: "blw-rows" },
          h("div", { className: "blw-row" },
            h("label", {htmlFor:"blw-notify-channel"}, "推送渠道"),
            h("select", {id:"blw-notify-channel",className:"blw-select",value:type,onChange:e=>setType(e.target.value)},
              [["none","不推送"],["desktop","桌面通知"],["dm","B 站私信"],["webhook","Webhook"],["command","自定义命令"]]
                .map(([value,label])=>h("option",{key:value,value},label)))),
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
          h("button", { className: "blw-btn blw-btn2", onClick: test, disabled: testing }, testing ? "发送中…" : "发条测试"),
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

    function BiliWhaleSection() {
      useStyleOnce();
      const [cfg, setCfg] = useState(null);
      const [savedJson, setSavedJson] = useState("");   // 2026-10-19：用来判断"有没有未保存的改动" ✓
      const [out, setOut] = useState("");
      const [err, setErr] = useState("");
      const [busy, setBusy] = useState("");
      const [ck, setCk] = useState({ sessdata: "", bili_jct: "", buvid3: "" });
      const [ckMsg, setCkMsg] = useState("");
      const [qrActive, setQrActive] = useState(false);
      // 2026-10-21：她专属的人设（~/.bili-ai/persona.md）—— 自由输入 + 注入 ✓
      const [personaText, setPersonaText] = useState("");
      const [personaMsg, setPersonaMsg] = useState("");
      const [personaBytes, setPersonaBytes] = useState(0);

      const load = useCallback(async () => {
        setErr("");
        try {
          const r = await fetch(`${API}/settings`, { headers: { accept: "application/json" } });
          if (!r.ok) throw new Error(`HTTP ${r.status}${r.status === 403 ? "（被信任栅栏拒绝）" : ""}`);
          const j = await r.json();
          setCfg(j.config ?? {});
          setSavedJson(JSON.stringify(j.config ?? {}));
          // 人设单独一个文件，顺手读一下 ✓
          try {
            const pr = await fetch(`${API}/persona`, { headers: { accept: "application/json" } });
            if (pr.ok) { const pj = await pr.json(); setPersonaText(pj.text ?? ""); setPersonaBytes(pj.bytes ?? 0); }
          } catch { setPersonaMsg('人设读取失败，请稍后重试') }
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
          const r = await fetch(`${API}/settings`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            // 2026-10-18：宿主现在两种都收 ✓，这里显式包一层最稳（以前发裸对象 → 宿主 merge 到 {}
            body: JSON.stringify({ config: body }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
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
          if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
          setCkMsg(`✓ ${j.detail ?? "已写入"}` + (j.warn ? `\n${j.warn}` : ""));   // 永不回显 cookie ✓（warn 要说出来 ✗ 不然等于没查）
          setCk({ sessdata: "", bili_jct: "", buvid3: "" });
          if (j.self) updateAccount(j.self);
        } catch (e) { setCkMsg(`✗ ${e.message}`); } finally { setBusy(""); }
      };

      const updateAccount = ({ mid, name }) => {
        const self = { mid, name };
        setCfg((current) => ({ ...current, self }));
        setSavedJson((current) => current ? JSON.stringify({ ...JSON.parse(current), self }) : current);
      };

      if (!cfg) {
        return h("div", { className: "blw" },
          h("h3", { className: "blw-title" }, "养鱼"),
          err ? h("div", { className: "blw-err" }, err) : h("div", { className: "blw-hint" }, "读取中…"));
      }

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
                  "建议写：身份与来历 / 说话腔调 / 在意什么、怕什么 / 明确不要的行为。上限 20000 字，注入时只取前 3000 字 ✓")),
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

      const rows = name => h("div", {className:"blw-rows"}, FIELDS.filter(f=>f.group===name).map(f=>h(Row,{key:f.path.join("."),f,cfg,set})));
      const group = (name) => h("div", { key: name },
        h("div", { className: "blw-group" }, name),
        name === "作息" ? h(WindowsEditor, { cfg, set }) : null,
        rows(name),
        // 2026-10-21：人设块放在这三个字段【下面】✓（主人要求）
        name === "她是谁" ? h("div", null, personaBlock()) : null);
      const section = (title, ...children) => h("details", {className:"blw-section"},
        h("summary", null, title), ...children);
      const ci = { className: "blw-input" };
      const accountSection = h("details",{key:"account",className:"blw-section",open:!cfg.self?.mid},
        h("summary",null,"角色与账号"),
        h("div", { className: "blw-group" }, "B 站登录"),
        h("div", { className: "blw-row" },
          h("div", null,
            h("div", { className: "blw-label" }, cfg.self?.mid ? `当前账号：${cfg.self.name}（${cfg.self.mid}）` : "连接 B 站账号"),
            h("div", { className: "blw-hint" }, "手机确认后验证并保存登录态；失败或取消保留原登录态。")),
          h(QrLogin, { disabled: !!busy, onAccount: updateAccount, onActiveChange: setQrActive })),
        h("details", null,
          h("summary", { className: "blw-hint", style: { cursor: "pointer", marginTop: "8px" } }, "手动导入 Cookie"),
        h("div", { className: "blw-rows" },
          h("div", { className: "blw-row" },
            h("div", null,
              h("div", { className: "blw-label" }, "凭据"),
              h("div", { className: "blw-hint" }, "浏览器 F12 → Cookie 里复制（SESSDATA 是 HttpOnly，console 拿不到 ✗）；写入后永不回显 ✓")),
            h("div", { className: "blw-cookie" },
              h("input", { ...ci, type: "password", autoComplete: "off", placeholder: "SESSDATA", value: ck.sessdata, onChange: (e) => setCk((s) => ({ ...s, sessdata: e.target.value })) }),
              h("input", { ...ci, type: "password", autoComplete: "off", placeholder: "bili_jct", value: ck.bili_jct, onChange: (e) => setCk((s) => ({ ...s, bili_jct: e.target.value })) }),
              h("input", { ...ci, type: "password", autoComplete: "off", placeholder: "buvid3（可空）", value: ck.buvid3, onChange: (e) => setCk((s) => ({ ...s, buvid3: e.target.value })) }),
              h("button", { className: "blw-btn blw-btn2", onClick: saveCookie, disabled: !!busy || qrActive || !ck.sessdata || !ck.bili_jct },
                busy === "cookie" ? "写入中…" : "写入凭据"),
              ckMsg ? h("div", { className: (ckMsg.startsWith("✓") ? "blw-hint blw-pre" : "blw-err") }, ckMsg) : null)))),
        group("你（主人）"),group("她是谁"));


      return h("div", { className: "blw" },
        h("h3", { className: "blw-title" }, "养鱼"),
        accountSection,
        section("兴趣与作息", group("口味"), group("作息")),
        section("分享", h(ShareEditor, {cfg,set})),
        section("监听与通知", h(ListenEditor, { cfg, set }), group("日记与推送"), h(NotifyEditor, { cfg, set, save })),
        section("自主活动", rows("自主活动")),
        section("运行与高级设置", h(DeliveryPanel), group("分享前检查"), group("会话成本"), group("工具链"), h(LifePanel), h(CorpusPanel)),
        h("div", { className: "blw-actions" },
          h("button", { className: "blw-btn", onClick: save, disabled: !!busy || qrActive }, busy === "save" ? "保存中…" : "保存"),
          cfg && savedJson && JSON.stringify(cfg) !== savedJson
            ? h("span", { style: { marginLeft: "10px", color: "#ffb020" } }, "有未保存的更改")
            : null,
          h("button", { className: "blw-btn blw-btn2", onClick: deps, disabled: !!busy }, busy === "deps" ? "体检中…" : "依赖体检"),
          h("button", { className: "blw-btn blw-btn2", onClick: load, disabled: !!busy || qrActive }, "重新读取")),

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

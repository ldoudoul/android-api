(function () {
  "use strict";

  var LS_CONV = "lc.conv.v1";
  var DEF_SETTINGS = {
    theme: "auto", fontSize: 15, systemPrompt: "", temperature: 0.7,
    maxTokens: 0, stream: true, lastProviderId: "", lastModel: ""
  };
  var PRESETS = [
    { key: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", protocol: "openai", models: ["deepseek-chat", "deepseek-reasoner"] },
    { key: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", protocol: "openai", models: ["gpt-4o", "gpt-4o-mini"] },
    { key: "kimi", name: "Kimi", baseUrl: "https://api.moonshot.cn/v1", protocol: "openai", models: ["kimi-latest", "moonshot-v1-8k"] },
    { key: "zhipu", name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", protocol: "openai", models: ["glm-4-plus", "glm-4-flash"] },
    { key: "qwen", name: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", protocol: "openai", models: ["qwen-plus", "qwen-max", "qwen-turbo"] },
    { key: "silicon", name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", protocol: "openai", models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"] },
    { key: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com", protocol: "anthropic", models: ["claude-sonnet-4-5", "claude-opus-4-1"] },
    { key: "custom", name: "自定义", baseUrl: "", protocol: "openai", models: [] }
  ];

  var B = (window.Native && typeof window.Native.getProviders === "function") ? window.Native : localBridge();

  var state = {
    providers: [], settings: {}, convs: [], activeId: null,
    stream: null, drawer: false, sheet: false, page: null, editing: null,
    stick: true, loaded: false, attachments: []
  };

  var $ = function (id) { return document.getElementById(id); };
  var chatWrap, chatEl, inputEl, sendBtn, sendIcon, pageEl, sheetEl, sheetBody, toastEl;

  /* ---------------- utils ---------------- */
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.classList.remove("show"); }, 2000);
  }
  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast("已复制"); }, function () { fallbackCopy(text); });
        return;
      }
    } catch (e) { }
    fallbackCopy(text);
  }

  function cleanNulls(s) {
    s = String(s == null ? "" : s);
    if (s === "null") return "";
    return s.replace(/^(?:null){2,}/, "");
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); toast("已复制"); } catch (e) { toast("复制失败"); }
    document.body.removeChild(ta);
  }

  /* ---------------- local bridge (desktop preview) ---------------- */
  function localBridge() {
    function get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } }
    return {
      getProviders: function () { return JSON.stringify(get("lc.providers") || []); },
      saveProvider: function (json) {
        var p = JSON.parse(json), arr = get("lc.providers") || [];
        if (!p.id) p.id = uid();
        var i = arr.findIndex(function (x) { return x.id === p.id; });
        if (i >= 0) arr[i] = p; else arr.push(p);
        localStorage.setItem("lc.providers", JSON.stringify(arr));
        return p.id;
      },
      deleteProvider: function (id) {
        var arr = (get("lc.providers") || []).filter(function (x) { return x.id !== id; });
        localStorage.setItem("lc.providers", JSON.stringify(arr));
      },
      setKey: function (id, k) { localStorage.setItem("lc.key." + id, k); return true; },
      clearKey: function (id) { localStorage.removeItem("lc.key." + id); },
      hasKey: function (id) { return !!localStorage.getItem("lc.key." + id); },
      getSettings: function () { return localStorage.getItem("lc.settings") || "{}"; },
      saveSettings: function (j) { localStorage.setItem("lc.settings", j); },
      startChat: function () {
        setTimeout(function () {
          window.__api.onEvent(JSON.stringify({ id: "preview", type: "error", message: "桌面预览模式：请在安卓端测试真实请求" }));
        }, 120);
      },
      cancelChat: function () { },
      testProvider: function () {
        setTimeout(function () {
          window.__api.onTest(JSON.stringify({ ok: true, message: "桌面预览模式（未发起真实请求）" }));
        }, 150);
      },
      setTheme: function () { },
      setBackDepth: function () { },
      openUrl: function (u) { window.open(u, "_blank"); },
      pickMedia: function () { toast("桌面预览模式：请在安卓端选择图片或视频"); },
      readClipboard: function () { return ""; },
      deleteMedia: function () { },
      toast: toast,
      version: function () { return "1.1.0-preview"; }
    };
  }

  /* ---------------- markdown ---------------- */
  function inlineMd(s) {
    var codes = [];
    var t = esc(s);
    t = t.replace(/\x60([^\x60\n]+)\x60/g, function (_, c) {
      codes.push(c);
      return "\u0001" + (codes.length - 1) + "\u0001";
    });
    t = t.replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/__([\s\S]+?)__/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    t = t.replace(/~~([\s\S]+?)~~/g, "<del>$1</del>");
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
    t = t.replace(/\u0001(\d+)\u0001/g, function (_, i) { return "<code>" + codes[+i] + "</code>"; });
    return t;
  }

  function isTableSep(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
  }

  function tableCells(line) {
    var s = line.trim();
    if (s.charAt(0) === "|") s = s.slice(1);
    if (s.charAt(s.length - 1) === "|") s = s.slice(0, -1);
    return s.split("|").map(function (x) { return x.trim(); });
  }

  function renderMarkdown(src) {
    var lines = String(src || "").replace(/\r\n/g, "\n").split("\n");
    var out = [], i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (/^\x60\x60\x60/.test(line)) {
        var lang = line.replace(/^\x60\x60\x60/, "").trim();
        var buf = [];
        i++;
        while (i < lines.length && !/^\x60\x60\x60/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push('<div class="code"><div class="code-head"><span>' + esc(lang || "code") +
          '</span><button data-copy="1">复制</button></div><pre><code>' + esc(buf.join("\n")) + "</code></pre></div>");
        continue;
      }
      if (!line.trim()) { i++; continue; }
      var m = line.match(/^(#{1,4})\s+(.*)$/);
      if (m) {
        var lv = m[1].length;
        out.push("<h" + lv + ">" + inlineMd(m[2]) + "</h" + lv + ">");
        i++; continue;
      }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
      if (/^\s*>\s?/.test(line)) {
        var qb = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { qb.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        out.push("<blockquote>" + inlineMd(qb.join("\n")).replace(/\n/g, "<br>") + "</blockquote>");
        continue;
      }
      if (line.indexOf("|") >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var head = tableCells(line), rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") >= 0) {
          rows.push(tableCells(lines[i]));
          i++;
        }
        var th = head.map(function (c) { return "<th>" + inlineMd(c) + "</th>"; }).join("");
        var tb = rows.map(function (r) {
          return "<tr>" + head.map(function (_, k) { return "<td>" + inlineMd(r[k] || "") + "</td>"; }).join("") + "</tr>";
        }).join("");
        out.push('<div class="table-wrap"><table><thead><tr>' + th + "</tr></thead><tbody>" + tb + "</tbody></table></div>");
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        var ordered = /^\s*\d+[.)]\s+/.test(line);
        var tag = ordered ? "ol" : "ul", items = [];
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          items.push("<li>" + inlineMd(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, "")) + "</li>");
          i++;
        }
        out.push("<" + tag + ">" + items.join("") + "</" + tag + ">");
        continue;
      }
      var pb = [];
      while (i < lines.length && lines[i].trim() &&
        !/^\x60\x60\x60/.test(lines[i]) && !/^(#{1,4})\s+/.test(lines[i]) &&
        !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && !/^\s*>\s?/.test(lines[i])) {
        pb.push(lines[i]); i++;
      }
      out.push("<p>" + inlineMd(pb.join("\n")).replace(/\n/g, "<br>") + "</p>");
    }
    return out.join("");
  }

  /* ---------------- storage ---------------- */
  function loadProviders() {
    try { state.providers = JSON.parse(B.getProviders()) || []; } catch (e) { state.providers = []; }
  }
  function loadSettings() {
    var raw = {};
    try { raw = JSON.parse(B.getSettings()) || {}; } catch (e) { raw = {}; }
    state.settings = Object.assign({}, DEF_SETTINGS, raw);
  }
  function saveSettings() {
    B.saveSettings(JSON.stringify(state.settings));
  }
  function loadConvs() {
    try { state.convs = JSON.parse(localStorage.getItem(LS_CONV) || "[]") || []; } catch (e) { state.convs = []; }
    state.convs.forEach(function (c) {
      (c.messages || []).forEach(function (m) {
        if (m.role !== "assistant") return;
        m.content = cleanNulls(m.content);
        m.reasoning = cleanNulls(m.reasoning);
      });
    });
  }
  function saveConvs() {
    if (state.convs.length > 40) state.convs = state.convs.slice(0, 40);
    try {
      localStorage.setItem(LS_CONV, JSON.stringify(state.convs));
    } catch (e) {
      if (!state.storageWarned) {
        state.storageWarned = true;
        toast("本地存储已满，请删除部分旧对话");
      }
    }
    renderSidebar();
  }
  function activeConv() {
    for (var i = 0; i < state.convs.length; i++) if (state.convs[i].id === state.activeId) return state.convs[i];
    return null;
  }

  function deleteConvMedia(conv) {
    if (!conv) return;
    (conv.messages || []).forEach(function (m) {
      (m.attachments || []).forEach(function (a) {
        if (a && a.id) {
          try { B.deleteMedia(a.id); } catch (e) { }
        }
      });
    });
  }

  /* ---------------- theme ---------------- */
  function isDark() {
    var t = state.settings.theme || "auto";
    if (t === "dark") return true;
    if (t === "light") return false;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function applyTheme() {
    var dark = isDark();
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    document.documentElement.style.setProperty("--chat-fs", (state.settings.fontSize || 15) + "px");
    B.setTheme(dark);
  }

  /* ---------------- model target ---------------- */
  function targetModel() {
    var p = null, i;
    for (i = 0; i < state.providers.length; i++) {
      if (state.providers[i].id === state.settings.lastProviderId) { p = state.providers[i]; break; }
    }
    if (p && p.models && p.models.length) {
      var m = p.models.indexOf(state.settings.lastModel) >= 0 ? state.settings.lastModel : p.models[0];
      return { provider: p, model: m };
    }
    for (i = 0; i < state.providers.length; i++) {
      if (state.providers[i].models && state.providers[i].models.length) {
        return { provider: state.providers[i], model: state.providers[i].models[0] };
      }
    }
    return null;
  }
  function renderModelName() {
    var t = targetModel();
    var el = $("modelName");
    if (!t) { el.textContent = "选择模型"; el.classList.add("top-unset"); }
    else { el.textContent = t.model; el.classList.remove("top-unset"); }
  }

  /* ---------------- welcome / chat render ---------------- */
  function welcomeHtml() {
    return '<div id="welcome"><div class="welcome-mark">D</div><h1>你好，我是 deepseek</h1>' +
      '<p>连接你自己的大模型 API，随时随地对话</p><div class="suggests">' +
      '<button class="suggest" data-p="帮我写一份本周工作周报，语气正式简洁">写一份工作周报</button>' +
      '<button class="suggest" data-p="用通俗的方式解释一下量子纠缠">解释一个复杂概念</button>' +
      '<button class="suggest" data-p="把下面这句话翻译成地道的英文：细节决定成败">翻译成英文</button>' +
      '<button class="suggest" data-p="给我制定一个每周三次、每次 40 分钟的新手健身计划">制定健身计划</button>' +
      "</div></div>";
  }

  function attachmentsHtml(atts) {
    if (!atts || !atts.length) return "";
    var h = '<div class="atts">';
    for (var i = 0; i < atts.length; i++) {
      var a = atts[i] || {};
      h += '<div class="att">';
      if (a.thumb) h += '<img src="' + a.thumb + '" alt="">';
      else h += '<div class="ph" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--sub)">' +
        (a.type === "video" ? "视频" : "图片") + "</div>";
      if (a.type === "video") h += '<span class="play">▶</span>';
      h += "</div>";
    }
    return h + "</div>";
  }

  function messageHtml(m) {
    if (m.role === "user") {
      return '<div class="msg user" data-mid="' + m.id + '"><div class="user-wrap">' +
        attachmentsHtml(m.attachments) + '<div class="bubble">' + esc(m.content) + "</div></div></div>";
    }
    var reasoning = "";
    if (m.reasoning) {
      reasoning = '<details class="reason"' + (m.status === "streaming" ? " open" : "") +
        '><summary>思考过程</summary><div class="reason-text">' + esc(m.reasoning) + "</div></details>";
    }
    var body;
    if (m.status === "streaming") {
      body = m.content ? renderMarkdown(m.content) : '<span class="typing"><i></i><i></i><i></i></span>';
    } else {
      body = m.content ? renderMarkdown(m.content) : "";
    }
    var err = m.error ? '<div class="err">' + esc(m.error) + "</div>" : "";
    var actions = "";
    if (m.status !== "streaming") {
      actions = '<div class="actions"><button data-act="copy">复制</button>' +
        (m.role === "assistant" ? '<button data-act="regen">重新生成</button>' : "") + "</div>";
    }
    var tag = m.model ? '<span class="tag">' + esc(m.model) + "</span>" : "";
    return '<div class="msg ai" data-mid="' + m.id + '"><div class="avatar">D</div><div class="body">' +
      '<div class="who"><b>deepseek</b>' + tag + "</div>" + reasoning +
      '<div class="md' + (m.status === "streaming" && m.content ? " cursor" : "") + '">' + body + "</div>" +
      err + actions + "</div></div>";
  }

  function renderChat(keepScroll) {
    var conv = activeConv();
    if (!conv || !conv.messages.length) {
      chatEl.innerHTML = welcomeHtml();
      state.stick = true;
      return;
    }
    var html = "";
    for (var i = 0; i < conv.messages.length; i++) html += messageHtml(conv.messages[i]);
    chatEl.innerHTML = html;
    if (!keepScroll || state.stick) scrollBottom();
  }

  function scrollBottom() {
    chatWrap.scrollTop = chatWrap.scrollHeight;
    state.stick = true;
  }

  var rafPending = null, rafId = 0;
  function patchLater(m) {
    rafPending = m;
    if (rafId) return;
    rafId = requestAnimationFrame(function () {
      rafId = 0;
      var msg = rafPending;
      rafPending = null;
      if (msg) patchMessage(msg);
    });
  }
  function patchMessage(m) {
    var el = chatEl.querySelector('.msg[data-mid="' + m.id + '"]');
    if (!el) return;
    var md = el.querySelector(".md");
    if (!md) return;
    if (m.reasoning) {
      var r = el.querySelector(".reason");
      if (!r) {
        var d = document.createElement("details");
        d.className = "reason";
        d.open = m.status === "streaming";
        d.innerHTML = "<summary>思考过程</summary><div class=\"reason-text\"></div>";
        md.parentNode.insertBefore(d, md);
        r = d;
      }
      r.querySelector(".reason-text").textContent = m.reasoning;
    }
    if (m.content) {
      md.innerHTML = renderMarkdown(m.content);
      md.classList.add("cursor");
    }
    if (state.stick) chatWrap.scrollTop = chatWrap.scrollHeight;
  }

  function finishStream(conv) {
    state.stream = null;
    saveConvs();
    renderChat(true);
    renderComposer();
    renderModelName();
  }

  /* ---------------- sending ---------------- */
  function historyFor(conv) {
    var out = [];
    var msgs = conv.messages.slice(0, -1);
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if ((m.role === "user" || m.role === "assistant") && (m.content || (m.attachments && m.attachments.length))) {
        var item = { role: m.role, content: m.content };
        if (m.role === "user" && m.attachments && m.attachments.length) {
          item.attachments = m.attachments.map(function (a) {
            return { id: a.id, type: a.type, mime: a.mime, name: a.name };
          });
        }
        out.push(item);
      }
    }
    return out.slice(-24);
  }

  function send(text) {
    text = String(text || "").trim();
    var atts = state.attachments.slice();
    if ((!text && !atts.length) || state.stream) return;
    var target = targetModel();
    if (!target) {
      toast("请先在设置中添加服务商与模型");
      openSettings("providers");
      return;
    }
    if (!B.hasKey(target.provider.id)) {
      toast("请先配置 " + target.provider.name + " 的 API Key");
      editProvider(target.provider.id);
      return;
    }
    if (atts.length) {
      var hasVideo = atts.some(function (a) { return a.type === "video"; });
      if ((target.provider.protocol || "openai") === "anthropic" && hasVideo) {
        toast("Anthropic 接口暂不支持视频，请切换到支持视频的模型");
        return;
      }
      if (/api\.deepseek\.com/i.test(target.provider.baseUrl || "")) {
        toast("DeepSeek 接口不支持图片/视频，请切换到视觉模型（如 qwen-vl、GLM-4V）");
        return;
      }
    }
    var title = text || (atts.length ? (atts[0].type === "video" ? "视频消息" : "图片消息") : "");
    var conv = activeConv();
    if (!conv) {
      conv = { id: uid(), title: title.slice(0, 26), messages: [], createdAt: Date.now(), updatedAt: Date.now() };
      state.convs.unshift(conv);
      state.activeId = conv.id;
    }
    var um = { id: uid(), role: "user", content: text, attachments: atts, ts: Date.now() };
    var am = {
      id: uid(), role: "assistant", content: "", reasoning: "", status: "streaming",
      providerId: target.provider.id, model: target.model, ts: Date.now()
    };
    conv.messages.push(um, am);
    if (conv.messages.length === 2) conv.title = title.slice(0, 26);
    conv.updatedAt = Date.now();
    state.attachments = [];
    renderAttachStrip();
    if (state.settings.lastProviderId !== target.provider.id || state.settings.lastModel !== target.model) {
      state.settings.lastProviderId = target.provider.id;
      state.settings.lastModel = target.model;
      saveSettings();
    }
    saveConvs();
    renderChat(true);
    scrollBottom();
    renderModelName();

    var rid = "r" + uid();
    state.stream = { rid: rid, convId: conv.id, mid: am.id };
    renderComposer();

    var payload = {
      id: rid,
      providerId: target.provider.id,
      model: target.model,
      messages: historyFor(conv),
      systemPrompt: state.settings.systemPrompt || "",
      temperature: Number(state.settings.temperature),
      maxTokens: Number(state.settings.maxTokens) || 0,
      stream: state.settings.stream !== false
    };
    B.startChat(JSON.stringify(payload));
  }

  function stopStream() {
    if (!state.stream) return;
    var rid = state.stream.rid;
    var conv = null, msg = null;
    for (var i = 0; i < state.convs.length; i++) {
      if (state.convs[i].id === state.stream.convId) {
        conv = state.convs[i];
        for (var j = 0; j < conv.messages.length; j++) if (conv.messages[j].id === state.stream.mid) msg = conv.messages[j];
        break;
      }
    }
    B.cancelChat(rid);
    if (msg) {
      msg.status = "stopped";
      if (!msg.content) msg.content = "（已停止生成）";
    }
    if (conv) finishStream(conv);
    else { state.stream = null; renderComposer(); }
  }

  function regenerate(mid) {
    var conv = activeConv();
    if (!conv || state.stream) return;
    var idx = -1;
    for (var i = 0; i < conv.messages.length; i++) if (conv.messages[i].id === mid) idx = i;
    if (idx < 0) return;
    var user = null;
    for (var k = idx - 1; k >= 0; k--) {
      if (conv.messages[k].role === "user") { user = conv.messages[k]; break; }
    }
    if (!user) return;
    state.attachments = (user.attachments || []).slice();
    conv.messages = conv.messages.slice(0, idx);
    conv.updatedAt = Date.now();
    saveConvs();
    renderChat(true);
    renderAttachStrip();
    send(user.content);
  }

  /* ---------------- sidebar ---------------- */
  function groupLabel(ts) {
    var d = new Date(ts), now = new Date();
    var a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var b = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    var diff = Math.round((a - b) / 86400000);
    if (diff <= 0) return "今天";
    if (diff === 1) return "昨天";
    if (diff < 7) return "本周";
    return "更早";
  }

  function renderSidebar() {
    var list = $("convList");
    if (!list) return;
    if (!state.convs.length) { list.innerHTML = '<div class="conv-empty">暂无对话记录</div>'; return; }
    var groups = {}, order = ["今天", "昨天", "本周", "更早"];
    order.forEach(function (g) { groups[g] = []; });
    state.convs.forEach(function (c) { groups[groupLabel(c.updatedAt || c.createdAt)].push(c); });
    var html = "";
    order.forEach(function (g) {
      if (!groups[g].length) return;
      html += '<div class="conv-group">' + g + "</div>";
      groups[g].forEach(function (c) {
        html += '<div class="conv-item' + (c.id === state.activeId ? " active" : "") + '" data-id="' + c.id + '">' +
          '<span class="t">' + esc(c.title || "新对话") + "</span>" +
          '<button class="del" data-more="' + c.id + '" aria-label="更多">⋯</button></div>';
      });
    });
    list.innerHTML = html;
  }

  function openDrawer() {
    state.drawer = true;
    $("drawer").classList.add("open");
    $("scrim").classList.add("show");
    $("drawer").setAttribute("aria-hidden", "false");
    updateBackDepth();
  }
  function closeDrawer() {
    state.drawer = false;
    $("drawer").classList.remove("open");
    $("scrim").classList.remove("show");
    $("drawer").setAttribute("aria-hidden", "true");
    updateBackDepth();
  }

  function newChat() {
    if (state.stream) stopStream();
    state.activeId = null;
    state.attachments = [];
    renderChat();
    renderSidebar();
    closeDrawer();
    inputEl.value = "";
    autoGrow();
    renderAttachStrip();
    renderComposer();
    setTimeout(function () { try { inputEl.focus(); } catch (e) { } }, 60);
  }

  function openConv(id) {
    state.activeId = id;
    state.stick = true;
    renderChat();
    renderSidebar();
    closeDrawer();
    renderComposer();
  }

  /* ---------------- sheets ---------------- */
  function openSheet(html) {
    sheetBody.innerHTML = html;
    sheetEl.classList.add("open");
    state.sheet = true;
    updateBackDepth();
  }
  function closeSheet() {
    sheetEl.classList.remove("open");
    state.sheet = false;
    updateBackDepth();
  }

  function openModelSheet() {
    var rows = [], i, j;
    for (i = 0; i < state.providers.length; i++) {
      var p = state.providers[i];
      var models = p.models || [];
      for (j = 0; j < models.length; j++) {
        var on = p.id === state.settings.lastProviderId && models[j] === state.settings.lastModel;
        rows.push('<button class="sheet-row" data-pid="' + esc(p.id) + '" data-model="' + esc(models[j]) + '">' +
          '<div class="sp"><b>' + esc(models[j]) + '</b><div class="sub">' + esc(p.name) +
          (B.hasKey(p.id) ? "" : " · 未配置密钥") + "</div></div>" + (on ? '<span class="check">✓</span>' : "") + "</button>");
      }
    }
    if (!rows.length) {
      rows.push('<div class="sheet-row"><div class="sp"><b>还没有可用模型</b><div class="sub">请先添加服务商并填写模型名称</div></div></div>');
    }
    openSheet('<div class="sheet-grip"></div><div class="sheet-title">选择模型</div>' + rows.join("") +
      '<div class="sheet-sep"></div><button class="sheet-row" data-manage="1"><div class="sp"><b>管理服务商</b>' +
      '<div class="sub">添加 API、编辑模型</div></div><span class="chev">›</span></button>');
  }

  function convMore(id) {
    var c = null;
    for (var i = 0; i < state.convs.length; i++) if (state.convs[i].id === id) c = state.convs[i];
    if (!c) return;
    openSheet('<div class="sheet-grip"></div><div class="sheet-title">' + esc(c.title || "新对话") + "</div>" +
      '<button class="sheet-row" data-rename="' + id + '"><div class="sp"><b>重命名</b></div></button>' +
      '<button class="sheet-row" data-dellate="' + id + '"><div class="sp" style="color:var(--danger)"><b>删除对话</b></div></button>');
  }

  function renameSheet(id) {
    var c = null;
    for (var i = 0; i < state.convs.length; i++) if (state.convs[i].id === id) c = state.convs[i];
    if (!c) return;
    openSheet('<div class="sheet-grip"></div><div class="sheet-title">重命名对话</div>' +
      '<div class="field"><input id="renameInput" value="' + esc(c.title || "") + '" maxlength="40"></div>' +
      '<div style="padding:0 16px 8px"><button class="btn-primary" data-do-rename="' + id + '">保存</button></div>');
    setTimeout(function () {
      var el = $("renameInput");
      if (el) { el.focus(); el.select(); }
    }, 120);
  }

  /* ---------------- settings pages ---------------- */
  function ensurePage() {
    if (pageEl) return;
    pageEl = document.createElement("div");
    pageEl.className = "page";
    pageEl.id = "settingsRoot";
    $("app").appendChild(pageEl);
  }

  function openSettings(page) {
    ensurePage();
    state.page = page || "main";
    renderPage();
    pageEl.classList.add("open");
    updateBackDepth();
  }
  function closeSettings() {
    if (pageEl) pageEl.classList.remove("open");
    state.page = null;
    state.editing = null;
    loadProviders();
    renderModelName();
    updateBackDepth();
  }
  function renderPage() {
    ensurePage();
    var title = "设置", body = "";
    if (state.page === "providers") { title = "模型服务"; body = providersPage(); }
    else if (state.page === "edit") { title = state.editing && state.editing.id ? "编辑服务商" : "添加服务商"; body = editPage(); }
    else { title = "设置"; body = mainPage(); }
    pageEl.innerHTML = '<div class="page-head"><button class="icon-btn" data-back="1">' +
      '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></button><h2>' + title + "</h2></div>" +
      '<div class="page-body">' + body + "</div>";
  }

  function mainPage() {
    var s = state.settings;
    var configured = state.providers.filter(function (p) { return B.hasKey(p.id); }).length;
    var t = targetModel();
    var theme = s.theme || "auto";
    var seg = '<div class="seg" data-seg="theme">' +
      '<button data-theme-val="auto" class="' + (theme === "auto" ? "on" : "") + '">自动</button>' +
      '<button data-theme-val="light" class="' + (theme === "light" ? "on" : "") + '">浅色</button>' +
      '<button data-theme-val="dark" class="' + (theme === "dark" ? "on" : "") + '">深色</button></div>';
    return '<div class="group-label">模型</div><div class="group">' +
      '<button class="row" data-nav="providers"><div class="sp">模型服务<div class="mini">' +
      state.providers.length + " 个服务 · " + configured + " 个已配置密钥</div></div>" +
      '<span class="val">' + (t ? esc(t.provider.name) : "未选择") + '</span><span class="chev">›</span></button>' +
      '<button class="row" data-nav="model-sheet"><div class="sp">当前模型</div><span class="val">' +
      (t ? esc(t.model) : "未选择") + '</span><span class="chev">›</span></button></div>' +

      '<div class="group-label">外观</div><div class="group">' +
      '<div class="row"><div class="sp">主题</div>' + seg + "</div>" +
      '<div class="row"><div class="sp">字号</div><div class="stepper">' +
      '<button data-fs="-1">−</button><span>' + (s.fontSize || 15) + '</span><button data-fs="1">+</button></div></div>' +
      '<div class="row"><div class="sp">流式输出<div class="mini">逐字显示回复</div></div>' +
      '<button class="switch ' + (s.stream ? "on" : "") + '" data-toggle="stream"></button></div></div>' +

      '<div class="group-label">生成参数</div><div class="group">' +
      '<div class="field"><label>系统提示词</label><textarea id="sysPrompt" placeholder="例如：你是一个简洁专业的中文助手">' +
      esc(s.systemPrompt || "") + "</textarea></div>" +
      '<div class="field"><label>温度（越高越发散）</label><div class="range" style="padding:0">' +
      '<input type="range" id="tempRange" min="0" max="2" step="0.1" value="' + Number(s.temperature || 0) + '">' +
      '<b id="tempVal">' + Number(s.temperature || 0).toFixed(1) + "</b></div></div>" +
      '<div class="field"><label>最大输出 tokens</label><input id="maxTokens" type="number" inputmode="numeric" min="0" value="' +
      (Number(s.maxTokens) || 0) + '"><div class="hint">填 0 表示使用服务端默认值</div></div></div>' +

      '<div class="group-label">关于</div><div class="group">' +
      '<div class="row"><div class="sp">deepseek</div><span class="val">v1.1.0</span></div>' +
      '<div class="row"><div class="sp">数据存储<div class="mini">对话与附件保存在本机，不上传第三方</div></div></div>' +
      '<div class="row"><div class="sp">使用说明<div class="mini">仅用于个人自用，请遵守各 API 服务条款</div></div></div></div>' +
      '<div class="mini" style="text-align:center;padding:18px 6px">支持 OpenAI 兼容接口与 Anthropic 原生接口</div>';
  }

  function providersPage() {
    var html = '<div class="group">';
    if (!state.providers.length) {
      html += '<div class="row"><div class="sp">还没有服务商</div></div>';
    }
    state.providers.forEach(function (p) {
      var has = B.hasKey(p.id);
      html += '<button class="row" data-edit="' + esc(p.id) + '"><div class="sp">' + esc(p.name) +
        '<div class="mini">' + esc(p.baseUrl || "未填写 Base URL") + "</div></div>" +
        '<span class="val" style="color:' + (has ? "var(--ok)" : "var(--sub)") + '">' +
        (has ? "已配置" : "未配置") + '</span><span class="chev">›</span></button>';
    });
    html += "</div>";
    html += '<button class="btn-primary" data-add="1">＋ 添加服务商</button>';
    html += '<div class="mini" style="padding:0 4px">内置 DeepSeek、OpenAI、Kimi、智谱、通义、硅基流动、Anthropic 预设，也支持任意 OpenAI 兼容地址（如本地 Ollama）。</div>';
    return html;
  }

  function editPage() {
    var e = state.editing;
    if (!e) return "";
    var chips = PRESETS.map(function (p) {
      var on = e.baseUrl === p.baseUrl && (e.protocol || 'openai') === p.protocol;
      return '<button class="chip' + (on ? ' on' : '') + '" data-preset="' + p.key + '">' + esc(p.name) + "</button>";
    }).join("");
    var has = e.id ? B.hasKey(e.id) : false;
    return '<div class="chips">' + chips + "</div>" +
      '<div class="group">' +
      '<div class="field"><label>名称</label><input id="fName" value="' + esc(e.name || "") + '" placeholder="例如：DeepSeek"></div>' +
      '<div class="field"><label>协议</label><div class="seg" style="width:100%" data-seg="protocol">' +
      '<button data-proto="openai" class="' + (e.protocol !== "anthropic" ? "on" : "") + '">OpenAI 兼容</button>' +
      '<button data-proto="anthropic" class="' + (e.protocol === "anthropic" ? "on" : "") + '">Anthropic</button></div></div>' +
      '<div class="field"><label>Base URL</label><input id="fBase" value="' + esc(e.baseUrl || "") +
      '" placeholder="https://api.deepseek.com" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false">' +
      '<div class="hint">可填到 /v1 或域名根路径，应用会自动补全接口地址</div></div>' +
      '<div class="field"><label>模型（用逗号或换行分隔）</label><textarea id="fModels" placeholder="deepseek-chat, deepseek-reasoner">' +
      esc((e.models || []).join(", ")) + "</textarea></div>" +
      '<div class="field"><label>API Key</label><div class="key-row">' +
      '<input id="fKey" type="text" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="' +
      (has ? "已保存，留空则不修改" : "sk-...") + '">' +
      '<button class="key-paste" data-paste-key="1">粘贴</button></div>' +
      '<div class="hint">可直接输入或从剪贴板粘贴，保存后不会出现在对话记录中</div></div>' +
      "</div>" +
      '<div class="group">' +
      '<div class="field"><label>额外请求头（JSON，可选）</label><textarea id="fHeaders" placeholder="{&quot;X-Custom&quot;:&quot;value&quot;}">' +
      esc(e.extraHeaders && Object.keys(e.extraHeaders).length ? JSON.stringify(e.extraHeaders, null, 2) : "") + "</textarea></div></div>" +
      '<button class="btn-ghost" data-test="1">测试连接</button>' +
      '<div id="testResult" class="test-result"></div>' +
      '<button class="btn-primary" data-save="1">保存</button>' +
      (e.id ? '<button class="btn-ghost" style="color:var(--danger);border-color:transparent" data-delete="1">删除此服务商</button>' : "");
  }

  function editProvider(id) {
    var p = null;
    for (var i = 0; i < state.providers.length; i++) if (state.providers[i].id === id) p = state.providers[i];
    state.editing = p ? JSON.parse(JSON.stringify(p)) : { name: "", baseUrl: "", protocol: "openai", models: [], extraHeaders: {} };
    state.page = "edit";
    ensurePage();
    renderPage();
    if (!pageEl.classList.contains("open")) {
      pageEl.classList.add("open");
      updateBackDepth();
    }
  }

  function saveProviderForm() {
    var e = state.editing;
    if (!e) return;
    var name = $("fName").value.trim();
    var base = $("fBase").value.trim();
    var models = $("fModels").value.split(/[\n,，]/).map(function (x) { return x.trim(); }).filter(Boolean);
    var key = $("fKey").value.trim();
    var headers = {};
    var rawHeaders = $("fHeaders").value.trim();
    if (rawHeaders) {
      try { headers = JSON.parse(rawHeaders); } catch (err) { toast("额外请求头不是合法 JSON"); return; }
    }
    if (!name) { toast("请填写名称"); return; }
    if (!base) { toast("请填写 Base URL"); return; }
    if (!models.length) { toast("请至少填写一个模型"); return; }
    var payload = { id: e.id || "", name: name, baseUrl: base, protocol: e.protocol, models: models, extraHeaders: headers };
    var id = B.saveProvider(JSON.stringify(payload));
    if (!id) { toast("保存失败"); return; }
    if (key && !B.setKey(id, key)) { toast("密钥保存失败"); return; }
    loadProviders();
    if (!state.settings.lastProviderId || state.settings.lastProviderId === "custom") {
      state.settings.lastProviderId = id;
      state.settings.lastModel = models[0];
      saveSettings();
    }
    renderModelName();
    state.page = "providers";
    renderPage();
    toast("已保存");
  }

  function testProviderForm() {
    var e = state.editing;
    if (!e) return;
    var base = $("fBase").value.trim();
    var key = $("fKey").value.trim();
    var models = $("fModels").value.split(/[\n,，]/).map(function (x) { return x.trim(); }).filter(Boolean);
    var box = $("testResult");
    if (box) { box.className = "test-result"; box.textContent = "正在测试…"; }
    B.testProvider(JSON.stringify({
      id: e.id || "", baseUrl: base, protocol: e.protocol,
      apiKey: key, models: models
    }));
  }

  /* ---------------- composer ---------------- */
  function renderAttachStrip() {
    var strip = $("attachStrip");
    if (!strip) return;
    var html = "";
    for (var i = 0; i < state.attachments.length; i++) {
      var a = state.attachments[i] || {};
      html += '<div class="attach-chip">';
      if (a.thumb) html += '<img src="' + a.thumb + '" alt="">';
      else html += '<div class="ph">' + (a.type === "video" ? "视频" : "图片") + "</div>";
      if (a.type === "video") html += '<span class="vbadge">视频</span>';
      html += '<button class="x" data-att-remove="' + i + '" aria-label="移除附件">×</button></div>';
    }
    strip.innerHTML = html;
    strip.classList.toggle("show", state.attachments.length > 0);
  }

  function renderComposer() {
    var streaming = !!state.stream;
    sendBtn.classList.toggle("stop", streaming);
    if (streaming) {
      sendIcon.innerHTML = '<rect x="7" y="7" width="10" height="10" rx="2"></rect>';
      sendBtn.disabled = false;
      sendBtn.setAttribute("aria-label", "停止生成");
    } else {
      sendIcon.innerHTML = '<path d="M12 19V5M5 12l7-7 7 7"></path>';
      sendBtn.disabled = !inputEl.value.trim() && !state.attachments.length;
      sendBtn.setAttribute("aria-label", "发送");
    }
  }

  function autoGrow() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 132) + "px";
  }

  /* ---------------- back depth ---------------- */
  function updateBackDepth() {
    var d = 0;
    if (state.sheet) d = 1;
    else if (state.page) d = state.page === "main" ? 1 : 2;
    else if (state.drawer) d = 1;
    B.setBackDepth(d);
  }

  function goBack() {
    if (state.sheet) { closeSheet(); return; }
    if (state.page) {
      if (state.page === "edit") { state.page = "providers"; renderPage(); updateBackDepth(); return; }
      if (state.page === "providers") { state.page = "main"; renderPage(); updateBackDepth(); return; }
      closeSettings();
      return;
    }
    if (state.drawer) { closeDrawer(); return; }
  }

  /* ---------------- native callbacks ---------------- */
  window.__api = {
    onEvent: function (raw) {
      var e;
      try { e = JSON.parse(raw); } catch (err) { return; }
      if (!state.stream || e.id !== state.stream.rid) return;
      var conv = null, msg = null;
      for (var i = 0; i < state.convs.length; i++) {
        if (state.convs[i].id === state.stream.convId) {
          conv = state.convs[i];
          for (var j = 0; j < conv.messages.length; j++) if (conv.messages[j].id === state.stream.mid) msg = conv.messages[j];
          break;
        }
      }
      if (!msg) return;
      if (e.type === "delta" || e.type === "reasoning") {
        var t = e.text == null ? "" : String(e.text);
        if (t === "null" && !(e.type === "delta" ? msg.content : msg.reasoning)) return;
        if (!t) return;
        if (e.type === "delta") msg.content += t;
        else msg.reasoning = (msg.reasoning || "") + t;
        patchLater(msg);
      }
      else if (e.type === "error") {
        msg.status = "error";
        msg.error = e.message || "请求失败";
        if (conv) finishStream(conv);
      } else if (e.type === "done") {
        msg.status = "done";
        msg.content = cleanNulls(msg.content);
        msg.reasoning = cleanNulls(msg.reasoning);
        if (!msg.content) msg.content = "（服务端没有返回内容）";
        if (conv) finishStream(conv);
      }
    },
    onTest: function (raw) {
      var r;
      try { r = JSON.parse(raw); } catch (err) { return; }
      var box = $("testResult");
      if (!box) return;
      box.className = "test-result " + (r.ok ? "ok" : "bad");
      box.textContent = r.message || (r.ok ? "连接成功" : "连接失败");
    },
    onMedia: function (raw) {
      var arr;
      try { arr = JSON.parse(raw) || []; } catch (err) { return; }
      if (!arr.length) return;
      var room = 6 - state.attachments.length;
      var take = Math.min(room, arr.length);
      for (var i = 0; i < take; i++) state.attachments.push(arr[i]);
      if (arr.length > take) toast("最多添加 6 个附件");
      renderAttachStrip();
      renderComposer();
    }
  };

  window.__app = { onBack: goBack };

  /* ---------------- bind ---------------- */
  function bind() {
    chatWrap = $("chatWrap");
    chatEl = $("chat");
    inputEl = $("input");
    sendBtn = $("sendBtn");
    sendIcon = $("sendIcon");
    sheetEl = $("sheet");
    sheetBody = $("sheetBody");
    toastEl = $("toast");

    $("menuBtn").addEventListener("click", openDrawer);
    $("newBtn").addEventListener("click", newChat);
    $("newChatBtn").addEventListener("click", newChat);
    $("settingsBtn").addEventListener("click", function () { closeDrawer(); openSettings("main"); });
    $("scrim").addEventListener("click", closeDrawer);
    $("modelBtn").addEventListener("click", openModelSheet);

    $("plusBtn").addEventListener("click", function () {
      try { B.pickMedia(); } catch (e) { toast("无法打开文件选择器"); }
    });

    $("attachStrip").addEventListener("click", function (ev) {
      var btn = ev.target.closest ? ev.target.closest("[data-att-remove]") : null;
      if (!btn) return;
      var idx = Number(btn.getAttribute("data-att-remove"));
      var a = state.attachments[idx];
      if (a && a.id) { try { B.deleteMedia(a.id); } catch (e) { } }
      state.attachments.splice(idx, 1);
      renderAttachStrip();
      renderComposer();
    });

    sendBtn.addEventListener("click", function () {
      if (state.stream) stopStream();
      else { var v = inputEl.value; inputEl.value = ""; autoGrow(); renderComposer(); send(v); }
    });

    inputEl.addEventListener("input", function () { autoGrow(); renderComposer(); });
    inputEl.addEventListener("focus", function () {
      $("composerBox").classList.add("focus");
      setTimeout(function () { if (state.stick) scrollBottom(); }, 260);
    });
    inputEl.addEventListener("blur", function () { $("composerBox").classList.remove("focus"); });
    inputEl.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        if (window.matchMedia("(min-width: 640px)").matches) {
          ev.preventDefault();
          var v = inputEl.value;
          inputEl.value = "";
          autoGrow();
          renderComposer();
          send(v);
        }
      }
    });

    chatEl.addEventListener("click", function (ev) {
      var t = ev.target;
      var sug = t.closest ? t.closest(".suggest") : null;
      if (sug) { send(sug.getAttribute("data-p")); return; }
      var a = t.closest ? t.closest("a") : null;
      if (a) {
        ev.preventDefault();
        B.openUrl(a.getAttribute("href"));
        return;
      }
      var copyBtn = t.closest ? t.closest("[data-copy]") : null;
      if (copyBtn) {
        var pre = copyBtn.closest(".code").querySelector("pre");
        copyText(pre.innerText || pre.textContent || "");
        return;
      }
      var act = t.closest ? t.closest("[data-act]") : null;
      if (act) {
        var row = act.closest(".msg");
        var mid = row ? row.getAttribute("data-mid") : null;
        var conv = activeConv();
        var msg = null;
        if (conv) for (var i = 0; i < conv.messages.length; i++) if (conv.messages[i].id === mid) msg = conv.messages[i];
        if (!msg) return;
        if (act.getAttribute("data-act") === "copy") copyText(msg.content || "");
        if (act.getAttribute("data-act") === "regen") regenerate(mid);
      }
    });

    $("convList").addEventListener("click", function (ev) {
      var more = ev.target.closest ? ev.target.closest("[data-more]") : null;
      if (more) { ev.stopPropagation(); convMore(more.getAttribute("data-more")); return; }
      var item = ev.target.closest ? ev.target.closest(".conv-item") : null;
      if (item) openConv(item.getAttribute("data-id"));
    });

    sheetBody.addEventListener("click", function (ev) {
      var t = ev.target;
      var modelRow = t.closest ? t.closest("[data-model]") : null;
      if (modelRow) {
        state.settings.lastProviderId = modelRow.getAttribute("data-pid");
        state.settings.lastModel = modelRow.getAttribute("data-model");
        saveSettings();
        renderModelName();
        closeSheet();
        toast("已切换模型");
        return;
      }
      if (t.closest && t.closest("[data-manage]")) { closeSheet(); openSettings("providers"); return; }
      var ren = t.closest ? t.closest("[data-rename]") : null;
      if (ren) { renameSheet(ren.getAttribute("data-rename")); return; }
      var del = t.closest ? t.closest("[data-dellate]") : null;
      if (del) {
        var id = del.getAttribute("data-dellate");
        state.convs.forEach(function (c) { if (c.id === id) deleteConvMedia(c); });
        state.convs = state.convs.filter(function (c) { return c.id !== id; });
        if (state.activeId === id) { state.activeId = null; renderChat(); }
        saveConvs();
        closeSheet();
        toast("对话已删除");
        return;
      }
      var doRen = t.closest ? t.closest("[data-do-rename]") : null;
      if (doRen) {
        var rid = doRen.getAttribute("data-do-rename");
        var val = $("renameInput").value.trim();
        state.convs.forEach(function (c) { if (c.id === rid) c.title = val || c.title; });
        saveConvs();
        closeSheet();
        return;
      }
    });

    $("sheet").addEventListener("click", function (ev) {
      if (ev.target.getAttribute && ev.target.getAttribute("data-close") === "sheet") closeSheet();
    });

    document.addEventListener("click", function (ev) {
      if (!pageEl || !pageEl.classList.contains("open")) return;
      var t = ev.target;
      if (t.closest && t.closest("[data-back]")) {
        if (state.page === "edit") { state.page = "providers"; renderPage(); updateBackDepth(); }
        else if (state.page === "providers") { state.page = "main"; renderPage(); updateBackDepth(); }
        else closeSettings();
        return;
      }
      var nav = t.closest ? t.closest("[data-nav]") : null;
      if (nav) {
        if (nav.getAttribute("data-nav") === "providers") { state.page = "providers"; renderPage(); updateBackDepth(); }
        if (nav.getAttribute("data-nav") === "model-sheet") { openModelSheet(); }
        return;
      }
      var themeBtn = t.closest ? t.closest("[data-theme-val]") : null;
      if (themeBtn) {
        state.settings.theme = themeBtn.getAttribute("data-theme-val");
        saveSettings();
        applyTheme();
        renderPage();
        return;
      }
      var fsBtn = t.closest ? t.closest("[data-fs]") : null;
      if (fsBtn) {
        var nf = Math.min(20, Math.max(13, (state.settings.fontSize || 15) + Number(fsBtn.getAttribute("data-fs"))));
        state.settings.fontSize = nf;
        saveSettings();
        applyTheme();
        renderPage();
        return;
      }
      var tg = t.closest ? t.closest("[data-toggle]") : null;
      if (tg) {
        state.settings.stream = !state.settings.stream;
        saveSettings();
        renderPage();
        return;
      }
      var pv = t.closest ? t.closest("[data-proto]") : null;
      if (pv) {
        state.editing.protocol = pv.getAttribute("data-proto");
        renderPage();
        return;
      }
      var pre = t.closest ? t.closest("[data-preset]") : null;
      if (pre) {
        var key = pre.getAttribute("data-preset");
        var src = null;
        PRESETS.forEach(function (p) { if (p.key === key) src = p; });
        if (src) {
          var e = state.editing;
          e.name = src.name;
          e.baseUrl = src.baseUrl;
          e.protocol = src.protocol;
          e.models = src.models.slice();
          renderPage();
          toast("已填入 " + src.name + " 预设");
        }
        return;
      }
      if (t.closest && t.closest("[data-add]")) {
        state.editing = { name: "", baseUrl: "", protocol: "openai", models: [], extraHeaders: {} };
        state.page = "edit";
        renderPage();
        return;
      }
      var ed = t.closest ? t.closest("[data-edit]") : null;
      if (ed) { editProvider(ed.getAttribute("data-edit")); return; }
      if (t.closest && t.closest("[data-paste-key]")) {
        var pasted = "";
        try { pasted = B.readClipboard() || ""; } catch (e2) { pasted = ""; }
        var keyEl = $("fKey");
        if (keyEl && pasted) {
          keyEl.value = pasted.trim();
          keyEl.focus();
          toast("已粘贴");
        } else {
          toast("剪贴板为空，可长按输入框直接粘贴");
        }
        return;
      }
      if (t.closest && t.closest("[data-save]")) { saveProviderForm(); return; }
      if (t.closest && t.closest("[data-test]")) { testProviderForm(); return; }
      if (t.closest && t.closest("[data-delete]")) {
        var eid = state.editing && state.editing.id;
        if (!eid) return;
        B.deleteProvider(eid);
        loadProviders();
        state.settings.lastProviderId = "";
        state.settings.lastModel = "";
        saveSettings();
        state.page = "providers";
        renderPage();
        toast("已删除");
        return;
      }
    });

    document.addEventListener("input", function (ev) {
      if (!pageEl || !pageEl.classList.contains("open")) return;
      var t = ev.target;
      if (t.id === "sysPrompt") { state.settings.systemPrompt = t.value; saveSettings(); }
      else if (t.id === "maxTokens") { state.settings.maxTokens = Number(t.value) || 0; saveSettings(); }
      else if (t.id === "tempRange") {
        state.settings.temperature = Number(t.value);
        var label = $("tempVal");
        if (label) label.textContent = Number(t.value).toFixed(1);
        saveSettings();
      }
    });

    chatWrap.addEventListener("scroll", function () {
      state.stick = (chatWrap.scrollHeight - chatWrap.scrollTop - chatWrap.clientHeight) < 140;
    });

    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      var onChange = function () { if ((state.settings.theme || "auto") === "auto") applyTheme(); };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  /* ---------------- init ---------------- */
  function init() {
    loadProviders();
    loadSettings();
    loadConvs();
    bind();
    applyTheme();
    renderModelName();
    renderSidebar();
    state.activeId = null;
    renderChat();
    renderAttachStrip();
    renderComposer();
    bindMobileKeyboard();
    state.loaded = true;
  }

  function bindMobileKeyboard() {
    if (!window.visualViewport) return;
    window.visualViewport.addEventListener("resize", function () {
      if (state.stick) setTimeout(scrollBottom, 60);
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();

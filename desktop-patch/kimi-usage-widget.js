/* Kimi Code 桌面版用量面板 (kimi-usage-widget.js) v4 紧凑版
 * 由 patch-desktop.py 注入到 desktop-dist/index.html。单文件零依赖。
 * 数据: 内嵌 kap-server REST(/oauth/usage, /sessions, /sessions/{id}/status) + WebSocket(/api/v1/ws)。
 * 桌面版升级后会被覆盖, 重新运行 patch-desktop.py 即可。
 */
(function () {
  'use strict';
  if (window.__kimiUsageWidgetLoaded) return;
  window.__kimiUsageWidgetLoaded = true;

  /* ================= 工具 ================= */

  var $ = function (sel, el) { return (el || document).querySelector(sel); };

  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  function fmtNum(n) {
    if (n == null || isNaN(n)) return '–';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }

  function fmtDur(ms) {
    if (ms == null || isNaN(ms)) return '–';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    return Math.floor(s / 60) + 'm' + (s % 60) + 's';
  }

  function fmtReset(iso) {
    var ms = new Date(iso) - Date.now();
    if (isNaN(ms)) return '';
    var d = new Date(iso);
    var when = d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    if (ms <= 0) return '已到重置时间';
    var h = Math.floor(ms / 36e5), m = Math.floor(ms % 36e5 / 6e4);
    return '重置 ' + when + ' (剩 ' + (h > 0 ? h + 'h' : '') + m + 'm)';
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  var store = {
    get: function (k, dft) {
      try { var v = localStorage.getItem(k); return v == null ? dft : JSON.parse(v); }
      catch (e) { return dft; }
    },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };

  /* ================= 诊断与状态 ================= */

  var diagLog = [];
  function diag(msg, extra) {
    var entry = { t: new Date().toISOString().slice(11, 19), msg: msg };
    if (extra !== undefined) entry.extra = String(extra).slice(0, 300);
    diagLog.push(entry);
    if (diagLog.length > 30) diagLog.shift();
    store.set('kum.diag', diagLog);
  }

  var S = {
    origin: null,
    quota: null,
    focusedSid: null,
    sessions: {},
    lastTotals: {},
    speedSamples: [],
    speed: 0,
    lastTurnMs: null,
    subagents: {},
    context: null,
    wsState: 'init',
    error: ''
  };

  /* ================= origin 解析 ================= */

  function resolveOrigin() {
    try {
      var o = new URLSearchParams(location.search).get('kimi_origin');
      if (o) {
        sessionStorage.setItem('kimi-desktop-server-origin', o);
        store.set('kum.origin', o);
        return o;
      }
      return sessionStorage.getItem('kimi-desktop-server-origin') || store.get('kum.origin', null);
    } catch (e) { return null; }
  }

  /* ================= 历史统计(自积累) ================= */

  var stats = store.get('kum.stats.v1', {});

  function accumulate(sid, total) {
    var prev = S.lastTotals[sid];
    S.lastTotals[sid] = total;
    if (!prev) return;
    var day = stats[todayStr()] || (stats[todayStr()] = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 });
    var changed = false;
    [['inputOther', 'input'], ['inputCacheRead', 'cacheRead'], ['inputCacheCreation', 'cacheCreation'], ['output', 'output']]
      .forEach(function (pair) {
        var diff = (total[pair[0]] || 0) - (prev[pair[0]] || 0);
        if (diff > 0) { day[pair[1]] += diff; changed = true; }
      });
    if (changed) store.set('kum.stats.v1', stats);
  }

  function last7Days() {
    var out = [];
    for (var i = 6; i >= 0; i--) {
      var d = new Date(Date.now() - i * 864e5);
      var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      var v = stats[key] || { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
      out.push({ date: key, total: v.input + v.cacheRead + v.cacheCreation + v.output });
    }
    return out;
  }

  /* ================= 告警 ================= */

  var alerted = store.get('kum.alerted', {});
  var ALERT_80 = 0.80, ALERT_95 = 0.95;
  try { if (localStorage.getItem('kum.alertTest') === '1') { ALERT_80 = 0.01; ALERT_95 = 0.01; } } catch (e) {}

  function notify(title, body) {
    try {
      if (Notification.permission === 'granted') new Notification(title, { body: body });
      else if (Notification.permission !== 'denied') Notification.requestPermission().then(function (p) {
        if (p === 'granted') new Notification(title, { body: body });
      });
    } catch (e) {}
  }

  function checkAlerts(usages) {
    [['limit5h', '5 小时额度'], ['limit7d', '本周额度'], ['limitMonthTotal', '本月额度']].forEach(function (pair) {
      var q = usages[pair[0]];
      if (!q || q.usedRatio == null) return;
      var key = pair[0];
      var st = alerted[key] || {};
      if (st.resetAt && st.resetAt !== q.resetAt) st = {};
      var pct = Math.round(q.usedRatio * 100);
      if (q.usedRatio >= ALERT_95 && st.level !== 95) {
        notify('Kimi 用量警告', pair[1] + '已达 ' + pct + '%，接近上限');
        st.level = 95;
      } else if (q.usedRatio >= ALERT_80 && !st.level) {
        notify('Kimi 用量提醒', pair[1] + '已用 ' + pct + '%');
        st.level = 80;
      }
      st.resetAt = q.resetAt;
      alerted[key] = st;
    });
    store.set('kum.alerted', alerted);
  }

  /* ================= REST 轮询 ================= */

  function pollQuota() {
    fetch(S.origin + '/api/v1/oauth/usage', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        var quota = r.data && r.data.quota;
        if (!quota) throw new Error('bad payload');
        if (!S.quota) diag('quota ok');
        S.quota = quota;
        S.error = '';
        checkAlerts(quota.usages || {});
        render();
      })
      .catch(function (e) { setError('额度接口失败: ' + e); });
  }

  function pollContext() {
    if (!S.focusedSid) return;
    fetch(S.origin + '/api/v1/sessions/' + S.focusedSid + '/status')
      .then(function (r) { return r.json(); })
      .then(function (r) {
        var d = r.data;
        if (d && d.max_context_tokens) {
          S.context = { tokens: d.context_tokens, max: d.max_context_tokens };
          render();
        }
      })
      .catch(function () {});
  }

  /* ================= WebSocket ================= */

  var ws = null, wsRetry = 0, seqCursors = store.get('kum.cursors', {});

  function wsUrl() {
    var u = new URL(S.origin);
    return (u.protocol === 'https:' ? 'wss://' : 'ws://') + u.host + '/api/v1/ws?client_id=kimi-usage-widget';
  }

  function wsSend(obj) { try { ws && ws.readyState === 1 && ws.send(JSON.stringify(obj)); } catch (e) {} }

  function subscribeAll() {
    fetch(S.origin + '/api/v1/sessions')
      .then(function (r) { return r.json(); })
      .then(function (r) {
        var d = r.data;
        var list = Array.isArray(d) ? d
          : Array.isArray(d && d.items) ? d.items
          : Array.isArray(d && d.sessions) ? d.sessions
          : [];
        var ids = list.map(function (s) { return s.id; }).filter(Boolean);
        diag('sessions fetched', ids.length + ' ids');
        wsSend({ type: 'client_hello', id: 'h1', payload: { client_id: 'kimi-usage-widget', subscriptions: ids, cursors: seqCursors } });
      })
      .catch(function (e) {
        diag('sessions fetch failed', e);
        wsSend({ type: 'client_hello', id: 'h1', payload: { client_id: 'kimi-usage-widget', subscriptions: S.focusedSid ? [S.focusedSid] : [] } });
      });
  }

  function wsConnect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    S.wsState = 'connecting'; render();
    try { ws = new WebSocket(wsUrl()); } catch (e) { diag('ws ctor failed', e); return wsScheduleReconnect(); }

    ws.onopen = function () { diag('ws open'); };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      handleEvent(m);
    };
    ws.onclose = function (e) {
      diag('ws close', 'code=' + e.code);
      ws = null; S.wsState = 'reconnecting'; render(); wsScheduleReconnect();
    };
    ws.onerror = function () {
      diag('ws error');
      try { ws.close(); } catch (e2) {}
    };
  }

  function wsScheduleReconnect() {
    var delay = Math.min(30000, 1000 * Math.pow(2, wsRetry++));
    setTimeout(wsConnect, delay);
  }

  function handleEvent(m) {
    if (m.type === 'server_hello') { subscribeAll(); return; }
    if (m.type === 'ping') { wsSend({ type: 'pong', payload: { nonce: m.payload && m.payload.nonce } }); return; }
    if (m.type === 'ack') {
      var p = m.payload || {};
      diag('ack', 'accepted=' + ((p.accepted_subscriptions || []).length));
      S.wsState = 'ok'; wsRetry = 0;
      (p.accepted_subscriptions || []).forEach(function (sid) {
        if (p.cursors && p.cursors[sid]) seqCursors[sid] = p.cursors[sid];
      });
      store.set('kum.cursors', seqCursors);
      render();
      if ((p.resync_required || []).length) {
        setTimeout(function () {
          wsSend({ type: 'subscribe', id: 's' + Date.now(), payload: { session_ids: p.resync_required } });
        }, 5000);
      }
      return;
    }
    if (m.type === 'session.meta.updated') {
      var sid0 = m.session_id || (m.payload && m.payload.sessionId);
      if (sid0 && !S.sessions[sid0]) {
        wsSend({ type: 'subscribe', id: 's' + Date.now(), payload: { session_ids: [sid0] } });
      }
      return;
    }

    var p2 = m.payload || {};
    var sessId = m.session_id || p2.sessionId;
    if (m.seq && sessId) { seqCursors[sessId] = { seq: m.seq, epoch: m.epoch }; }

    switch (m.type) {
      case 'agent.status.updated': {
        var u = p2.usage;
        if (u && sessId) {
          if (!S.sessions[sessId] || !S.sessions[sessId].total) diag('first usage event', sessId.slice(0, 24));
          var sess = S.sessions[sessId] || (S.sessions[sessId] = {});
          sess.total = u.total || null;
          sess.currentTurn = u.currentTurn || null;
          if (u.total) {
            accumulate(sessId, u.total);
            S.speedSamples.push({ t: Date.now(), output: u.total.output || 0 });
            var cutoff = Date.now() - 10000;
            S.speedSamples = S.speedSamples.filter(function (s) { return s.t >= cutoff; });
          }
          render();
        }
        break;
      }
      case 'turn.started':
        if (sessId) { (S.sessions[sessId] || (S.sessions[sessId] = {})).busy = true; render(); }
        break;
      case 'turn.ended':
        if (sessId) (S.sessions[sessId] || (S.sessions[sessId] = {})).busy = false;
        S.lastTurnMs = p2.durationMs != null ? p2.durationMs : (p2.duration_ms != null ? p2.duration_ms : S.lastTurnMs);
        render();
        break;
      case 'subagent.started': case 'subagent.start': {
        var id1 = p2.subagentId || p2.agentId || ('x' + Date.now());
        S.subagents[id1] = { label: p2.agentType || p2.description || 'subagent', since: Date.now() };
        render();
        break;
      }
      case 'subagent.stopped': case 'subagent.stop': case 'subagent.completed': {
        var id2 = p2.subagentId || p2.agentId;
        if (id2 && S.subagents[id2]) delete S.subagents[id2];
        render();
        break;
      }
    }
  }

  // 速率滑动窗口衰减
  setInterval(function () {
    var cutoff = Date.now() - 10000;
    var before = S.speed;
    S.speedSamples = S.speedSamples.filter(function (s) { return s.t >= cutoff; });
    if (S.speedSamples.length >= 2) {
      var first = S.speedSamples[0], last = S.speedSamples[S.speedSamples.length - 1];
      var dt = (last.t - first.t) / 1000;
      S.speed = dt > 0 ? Math.max(0, (last.output - first.output) / dt) : 0;
    } else {
      S.speed = 0;
    }
    if (Math.abs(before - S.speed) >= 1) render();
  }, 2000);

  function trackRoute() {
    var m = location.pathname.match(/^\/sessions\/([^/?#]+)/);
    var sid = m ? m[1] : null;
    if (sid !== S.focusedSid) {
      S.focusedSid = sid;
      if (sid && !S.sessions[sid] && S.wsState === 'ok') {
        wsSend({ type: 'subscribe', id: 's' + Date.now(), payload: { session_ids: [sid] } });
      }
      pollContext();
      render();
    }
  }

  /* ================= UI ================= */

  var MODULES = [
    { id: 'quota', title: '额度' },
    { id: 'realtime', title: '实时' },
    { id: 'meta', title: '状态' },
    { id: 'history', title: '近 7 天' }
  ];
  var DEFAULT_LAYOUT = MODULES.map(function (m) { return { id: m.id, zone: 'main' }; });
  var layout = store.get('kum.layout', null) || DEFAULT_LAYOUT.map(function (l) { return { id: l.id, zone: l.zone }; });
  MODULES.forEach(function (m) {
    if (!layout.some(function (l) { return l.id === m.id; })) layout.push({ id: m.id, zone: 'main' });
  });

  var panel = null;
  var collapsed = store.get('kum.collapsed', false);
  var density = store.get('kum.density', 'compact');
  var gearOpen = false;

  var css = [
    '#kum-panel{font:12px/1.45 "Segoe UI","Microsoft YaHei",sans-serif;margin:6px 10px;padding:8px 10px;',
    'border-radius:10px;background:var(--color-bg-secondary,#1c1f26);border:1px solid var(--color-border,#2a2e38);',
    'color:var(--color-text-primary,#e6e8eb);user-select:none;position:relative}',
    '#kum-panel *{box-sizing:border-box}',
    '.kum-head{display:flex;justify-content:space-between;align-items:center;cursor:pointer;height:18px}',
    '.kum-title{font-weight:600;font-size:12px}',
    '.kum-head-right{display:flex;gap:7px;align-items:center;color:#8b919c;font-size:11px}',
    '.kum-dot{width:6px;height:6px;border-radius:50%;background:#666;display:inline-block}',
    '.kum-dot.ok{background:#37b58c}.kum-dot.mid{background:#e8a33d}.kum-dot.bad{background:#e05555}',
    '.kum-icon-btn{background:none;border:none;color:#8b919c;cursor:pointer;font-size:12px;padding:0 2px;line-height:1}',
    '.kum-icon-btn:hover{color:#ccc}',
    /* 额度: 一行两条 */
    '.kum-quota-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px}',
    '.kum-q{min-width:0}',
    '.kum-q-top{display:flex;justify-content:space-between;font-size:10px;color:#8b919c;margin-bottom:2px}',
    '.kum-q-top b{color:var(--color-text-primary,#e6e8eb);font-variant-numeric:tabular-nums;font-weight:600}',
    '.kum-bar{height:5px;border-radius:3px;background:var(--color-bg-tertiary,#2a2e38);position:relative;overflow:hidden}',
    '.kum-bar>div{height:100%;border-radius:3px;background:#4f8cff;transition:width .5s}',
    '.kum-bar.kum-warn>div{background:#e8a33d}.kum-bar.kum-danger>div{background:#e05555}',
    '.kum-pace{position:absolute;top:-1px;bottom:-1px;width:1px;background:rgba(255,255,255,.5)}',
    '.kum-chip{display:inline-block;font-size:10px;color:#8b919c;border:1px solid var(--color-border,#2a2e38);',
    'border-radius:6px;padding:0 6px;margin-top:4px}',
    /* 实时: 一行四格 */
    '.kum-cells{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-top:6px}',
    '.kum-c{min-width:0;text-align:left}',
    '.kum-c .kum-k{font-size:10px;color:#8b919c;white-space:nowrap}',
    '.kum-c .kum-v{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}',
    /* 状态/历史 */
    '.kum-line{font-size:11px;color:#8b919c;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.kum-line b{color:var(--color-text-primary,#e6e8eb)}',
    '.kum-hist-row{display:flex;align-items:center;gap:8px;margin-top:6px}',
    '.kum-hist{display:flex;align-items:flex-end;gap:2px;height:16px;flex:1}',
    '.kum-hist div{flex:1;background:#4f8cff;border-radius:1px;min-height:1px;opacity:.85}',
    '.kum-hist div.kum-today{background:#37b58c}',
    '.kum-hist-today{font-size:11px;color:#8b919c;white-space:nowrap}',
    '.kum-hist-today b{color:var(--color-text-primary,#e6e8eb)}',
    /* 模块间距 */
    '.kum-mod{margin-top:6px;padding-top:6px;border-top:1px dashed var(--color-border,#2a2e38)}',
    '.kum-mod:first-of-type{border-top:none;padding-top:0;margin-top:4px}',
    /* Mini */
    '.kum-mini{font-size:11px;color:#8b919c;margin-top:5px}',
    '.kum-mini b{color:var(--color-text-primary,#e6e8eb);font-weight:600}',
    /* 齿轮菜单 */
    '.kum-gear-menu{position:absolute;top:24px;right:6px;z-index:10001;background:var(--color-bg-secondary,#23262e);',
    'border:1px solid var(--color-border,#3a3e48);border-radius:8px;padding:8px;min-width:190px;',
    'box-shadow:0 6px 20px rgba(0,0,0,.5);font-size:11px}',
    '.kum-gm-title{color:#8b919c;margin-bottom:4px}',
    '.kum-gm-row{display:flex;justify-content:space-between;align-items:center;padding:2px 0;gap:6px}',
    '.kum-gm-row .kum-gm-btns button{background:none;border:1px solid var(--color-border,#3a3e48);color:#8b919c;',
    'border-radius:4px;font-size:10px;padding:0 5px;margin-left:3px;cursor:pointer;line-height:16px}',
    '.kum-gm-row .kum-gm-btns button.kum-on{background:#4f8cff;border-color:#4f8cff;color:#fff}',
    '.kum-gm-foot{margin-top:6px;padding-top:6px;border-top:1px dashed var(--color-border,#3a3e48);display:flex;gap:8px}',
    '.kum-gm-foot a{color:#8b919c;cursor:pointer;text-decoration:underline dotted}',
    '.kum-gm-foot a:hover{color:#ccc}',
    /* 其他 */
    '.kum-error{margin-top:6px;font-size:11px;color:#e05555;word-break:break-all}',
    '#kum-panel.kum-floating{position:fixed;left:12px;bottom:12px;width:230px;z-index:9999;margin:0;box-shadow:0 4px 16px rgba(0,0,0,.4)}',
    '.kum-ghost{position:fixed;pointer-events:none;opacity:.85;z-index:10000;background:var(--color-bg-secondary,#1c1f26);',
    'border:1px solid #4f8cff;border-radius:8px;padding:3px 10px;font-size:11px;color:#e6e8eb}',
    '.kum-drop-indicator{height:2px;background:#4f8cff;margin:2px 0;border-radius:1px}',
    /* 宽松密度 */
    '#kum-panel.kum-cozy{padding:12px 14px}',
    '#kum-panel.kum-cozy .kum-bar{height:8px}',
    '#kum-panel.kum-cozy .kum-c .kum-v{font-size:15px}',
    '#kum-panel.kum-cozy .kum-mod{margin-top:10px;padding-top:10px}',
    '#kum-panel.kum-cozy .kum-hist{height:26px}',
    '#kum-panel.kum-cozy .kum-line,#kum-panel.kum-cozy .kum-mini{font-size:12px}'
  ].join('');

  function setError(msg) {
    S.error = msg || '';
    if (panel) {
      var e = $('.kum-error', panel);
      if (e) { e.style.display = msg ? '' : 'none'; e.textContent = msg || ''; }
    }
  }

  function wsDot() {
    var cls = S.wsState === 'ok' ? 'ok' : (S.wsState === 'connecting' || S.wsState === 'reconnecting') ? 'mid' : 'bad';
    var txt = S.wsState === 'ok' ? 'live' : S.wsState === 'connecting' ? '连接中' : S.wsState === 'reconnecting' ? '重连中' : '离线';
    return '<span class="kum-dot ' + cls + '"></span><span>' + txt + '</span>';
  }

  /* ---------- 模块渲染 ---------- */

  function quotaBlock(label, q, windowMs) {
    if (!q || q.usedRatio == null) return '';
    var pct = Math.round(q.usedRatio * 1000) / 10;
    var cls = pct >= 95 ? ' kum-danger' : pct >= 80 ? ' kum-warn' : '';
    var pace = '';
    var tip = '';
    if (q.resetAt) {
      var remain = new Date(q.resetAt) - Date.now();
      var elapsed = 1 - Math.max(0, Math.min(1, remain / windowMs));
      pace = '<div class="kum-pace" style="left:' + (elapsed * 100).toFixed(1) + '%"></div>';
      tip = fmtReset(q.resetAt);
    }
    return '<div class="kum-q" title="' + esc(tip) + '">' +
      '<div class="kum-q-top"><span>' + label + '</span><b>' + pct + '%</b></div>' +
      '<div class="kum-bar' + cls + '"><div style="width:' + Math.min(100, pct) + '%"></div>' + pace + '</div></div>';
  }

  function renderModuleBody(id) {
    switch (id) {
      case 'quota': {
        if (!S.quota) return '<div class="kum-line">等待额度数据…</div>';
        var u = S.quota.usages || {};
        var grid = quotaBlock('5 小时', u.limit5h, 5 * 36e5) +
                   quotaBlock('本周', u.limit7d, 7 * 864e5) +
                   quotaBlock('本月', u.limitMonthTotal, 30 * 864e5);
        var html = grid ? '<div class="kum-quota-grid">' + grid + '</div>' : '<div class="kum-line">无额度数据</div>';
        var ex = S.quota.extraUsage;
        if (ex && ex.balance && ex.balance.amountLeft != null) {
          html += '<span class="kum-chip">加油包 ¥' + (ex.balance.amountLeft / 1e8).toFixed(2) + '</span>';
        }
        return html;
      }
      case 'realtime': {
        var sess = S.focusedSid && S.sessions[S.focusedSid];
        var cur = (sess && sess.currentTurn) || {};
        var tot = (sess && sess.total) || {};
        var totalInput = (tot.inputOther || 0) + (tot.inputCacheRead || 0) + (tot.inputCacheCreation || 0);
        var hit = totalInput > 0 ? ((tot.inputCacheRead || 0) / totalInput * 100).toFixed(1) + '%' : '–';
        var cells = [
          ['入', fmtNum(cur.inputOther), '当前轮输入 tokens(不含缓存)'],
          ['出', fmtNum(cur.output), '当前轮输出 tokens'],
          ['缓存', hit, '缓存命中率 = 缓存读 / 总输入(会话累计)'],
          ['速率', S.speed > 0 ? S.speed.toFixed(0) + 't/s' : '–', '输出 tokens/秒(10 秒滑动窗口)']
        ];
        return '<div class="kum-cells">' + cells.map(function (c) {
          return '<div class="kum-c" title="' + esc(c[2]) + '"><div class="kum-k">' + c[0] + '</div><div class="kum-v">' + c[1] + '</div></div>';
        }).join('') + '</div>';
      }
      case 'meta': {
        var subs = Object.keys(S.subagents).length;
        var ctx = S.context ? (S.context.tokens / S.context.max * 100).toFixed(1) + '%' : '–';
        var busy = S.focusedSid && S.sessions[S.focusedSid] && S.sessions[S.focusedSid].busy;
        return '<div class="kum-line" title="上轮耗时 / 上下文占用 / 活跃子代理">上轮 <b>' + fmtDur(S.lastTurnMs) + '</b> · 上下文 <b>' + ctx + '</b> · 子代理 <b>' + subs + '</b>' +
          (busy ? ' · <b style="color:#37b58c">●</b>' : '') + '</div>';
      }
      case 'history': {
        var days = last7Days();
        var max = Math.max.apply(null, [1].concat(days.map(function (d) { return d.total; })));
        var today = days[days.length - 1];
        var bars = days.map(function (d) {
          var h = Math.max(1, Math.round(d.total / max * 16));
          return '<div style="height:' + h + 'px" class="' + (d.date === todayStr() ? 'kum-today' : '') + '" title="' + d.date + '  ' + fmtNum(d.total) + ' tokens"></div>';
        }).join('');
        return '<div class="kum-hist-row"><div class="kum-hist">' + bars + '</div>' +
          '<span class="kum-hist-today" title="自补丁启用起累计">今日 <b>' + fmtNum(today.total) + '</b></span></div>';
      }
    }
    return '';
  }

  function renderMini() {
    var bits = [];
    if (S.quota && S.quota.usages) {
      if (S.quota.usages.limit5h) bits.push('5h ' + Math.round(S.quota.usages.limit5h.usedRatio * 100) + '%');
      if (S.quota.usages.limit7d) bits.push('周 ' + Math.round(S.quota.usages.limit7d.usedRatio * 100) + '%');
    }
    if (S.speed > 0) bits.push(S.speed.toFixed(0) + 't/s');
    return bits.length ? '<div class="kum-mini">' + bits.map(function (b) { return '<b>' + b + '</b>'; }).join(' · ') + '</div>' : '';
  }

  function moduleTitle(id) {
    var m = MODULES.find(function (x) { return x.id === id; });
    return m ? m.title : id;
  }

  function renderGearMenu() {
    if (!gearOpen) return '';
    var zones = [['main', '展开'], ['mini', 'Mini'], ['hidden', '隐藏']];
    var rows = layout.map(function (l) {
      var btns = zones.map(function (z) {
        return '<button data-gm="' + l.id + ':' + z[0] + '"' + (l.zone === z[0] ? ' class="kum-on"' : '') + '>' + z[1] + '</button>';
      }).join('');
      return '<div class="kum-gm-row"><span>' + moduleTitle(l.id) + '</span><span class="kum-gm-btns">' + btns + '</span></div>';
    }).join('');
    return '<div class="kum-gear-menu"><div class="kum-gm-title">模块显示(长按模块可拖拽排序)</div>' + rows +
      '<div class="kum-gm-row"><span>密度</span><span class="kum-gm-btns">' +
      '<button data-density="compact"' + (density === 'compact' ? ' class="kum-on"' : '') + '>紧凑</button>' +
      '<button data-density="cozy"' + (density === 'cozy' ? ' class="kum-on"' : '') + '>宽松</button></span></div>' +
      '<div class="kum-gm-foot"><a data-gm-reset>恢复默认布局</a></div></div>';
  }

  function buildPanel() {
    var style = el('style'); style.textContent = css;
    document.head.appendChild(style);
    panel = el('div'); panel.id = 'kum-panel';
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { pollQuota(); pollContext(); }
    });
    document.addEventListener('click', function (e) {
      if (gearOpen && panel && !e.target.closest('.kum-gear-menu') && !e.target.closest('.kum-gear-btn')) {
        gearOpen = false; render();
      }
    });
    return panel;
  }

  function render() {
    if (!panel || !panel.isConnected) return;
    panel.className = (density === 'cozy' ? 'kum-cozy' : '') + (panel.classList.contains('kum-floating') ? ' kum-floating' : '');
    var mainMods = layout.filter(function (l) { return l.zone === 'main'; });
    var miniMods = layout.filter(function (l) { return l.zone === 'mini'; });

    var html = '<div class="kum-head"><span class="kum-title">Kimi 用量</span>' +
      '<span class="kum-head-right">' + wsDot() +
      '<button class="kum-icon-btn kum-gear-btn" title="设置">⚙</button>' +
      '<button class="kum-icon-btn kum-collapse-btn" title="折叠/展开">' + (collapsed ? '+' : '–') + '</button></span></div>';

    if (!collapsed) {
      html += '<div class="kum-body">' +
        '<div class="kum-error" style="display:' + (S.error ? '' : 'none') + '">' + esc(S.error) + '</div>';
      mainMods.forEach(function (l) {
        html += '<div class="kum-mod" data-mod="' + l.id + '">' + renderModuleBody(l.id) + '</div>';
      });
      if (miniMods.length) html += renderMini();
      html += '</div>';
    }
    html += renderGearMenu();
    panel.innerHTML = html;
    bindEvents();
  }

  function bindEvents() {
    $('.kum-collapse-btn', panel).addEventListener('click', function (e) {
      e.stopPropagation();
      collapsed = !collapsed;
      store.set('kum.collapsed', collapsed);
      render();
    });
    $('.kum-gear-btn', panel).addEventListener('click', function (e) {
      e.stopPropagation();
      gearOpen = !gearOpen;
      render();
    });
    $('.kum-head', panel).addEventListener('click', function (e) {
      if (e.target.closest('button')) return;
      collapsed = !collapsed;
      store.set('kum.collapsed', collapsed);
      render();
    });
    panel.querySelectorAll('[data-gm]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var parts = btn.dataset.gm.split(':');
        moveToZone(parts[0], parts[1]);
      });
    });
    panel.querySelectorAll('[data-density]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        density = btn.dataset.density;
        store.set('kum.density', density);
        render();
      });
    });
    var reset = $('[data-gm-reset]', panel);
    if (reset) reset.addEventListener('click', function (e) {
      e.stopPropagation();
      layout = DEFAULT_LAYOUT.map(function (l) { return { id: l.id, zone: l.zone }; });
      store.set('kum.layout', layout);
      gearOpen = false;
      render();
    });
    panel.querySelectorAll('.kum-mod[data-mod]').forEach(function (mod) {
      mod.addEventListener('mousedown', startDrag);
    });
  }

  function moveToZone(id, zone) {
    layout.forEach(function (l) { if (l.id === id) l.zone = zone; });
    store.set('kum.layout', layout);
    render();
  }

  /* ---------- 长按拖拽排序 ---------- */

  var dragState = null;

  function startDrag(e) {
    if (e.target.closest('button') || e.target.closest('a') || e.target.closest('.kum-gear-menu')) return;
    var mod = e.target.closest('.kum-mod');
    if (!mod) return;
    var id = mod.dataset.mod;
    var timer = setTimeout(function () {
      dragState = { id: id, ghost: null, beforeId: undefined };
      document.addEventListener('mousemove', onDragMove);
      document.addEventListener('mouseup', onDragEnd, { once: true });
    }, 300);
    var cancel = function () { clearTimeout(timer); document.removeEventListener('mouseup', cancel); };
    document.addEventListener('mouseup', cancel);
  }

  function onDragMove(e) {
    if (!dragState) return;
    if (!dragState.ghost) {
      dragState.ghost = el('div', 'kum-ghost', moduleTitle(dragState.id));
      document.body.appendChild(dragState.ghost);
    }
    dragState.ghost.style.left = (e.clientX + 10) + 'px';
    dragState.ghost.style.top = (e.clientY + 10) + 'px';
    clearIndicator();
    var mods = Array.from(panel.querySelectorAll('.kum-mod[data-mod]'));
    for (var i = 0; i < mods.length; i++) {
      var r = mods[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2 && mods[i].dataset.mod !== dragState.id) {
        dragState.beforeId = mods[i].dataset.mod;
        mods[i].parentElement.insertBefore(el('div', 'kum-drop-indicator'), mods[i]);
        return;
      }
    }
    dragState.beforeId = null;
    var last = mods[mods.length - 1];
    if (last && e.clientY > last.getBoundingClientRect().bottom) {
      last.parentElement.appendChild(el('div', 'kum-drop-indicator'));
    }
  }

  function clearIndicator() {
    panel.querySelectorAll('.kum-drop-indicator').forEach(function (n) { n.remove(); });
  }

  function onDragEnd() {
    document.removeEventListener('mousemove', onDragMove);
    if (!dragState) return;
    if (dragState.ghost) dragState.ghost.remove();
    clearIndicator();
    if (dragState.beforeId !== undefined) {
      var item = layout.find(function (l) { return l.id === dragState.id; });
      layout = layout.filter(function (l) { return l.id !== dragState.id; });
      if (dragState.beforeId) {
        var idx = layout.findIndex(function (l) { return l.id === dragState.beforeId; });
        layout.splice(idx, 0, item);
      } else {
        var lastMain = -1;
        layout.forEach(function (l, i) { if (l.zone === 'main') lastMain = i; });
        layout.splice(lastMain + 1, 0, item);
      }
      item.zone = 'main';
      store.set('kum.layout', layout);
    }
    dragState = null;
    render();
  }

  /* ---------- 挂载 ---------- */

  function mount() {
    if (!panel) buildPanel();
    if (panel.isConnected) return true;
    var footer = document.querySelector('.side-footer');
    if (footer && footer.parentElement) {
      footer.parentElement.insertBefore(panel, footer);
      return true;
    }
    var aside = document.querySelector('aside.side') || document.querySelector('aside');
    if (aside) { aside.appendChild(panel); return true; }
    return false;
  }

  /* ================= 启动 ================= */

  function boot() {
    render();
    pollQuota();
    trackRoute();
    setInterval(pollQuota, 60000);
    setInterval(pollContext, 60000);
    setInterval(trackRoute, 1000);
    setInterval(function () { if (panel && !panel.isConnected) mount(); }, 5000);
    wsConnect();
  }

  function start() {
    S.origin = resolveOrigin();
    diag('start', 'origin=' + (S.origin || '(null)'));
    if (!S.origin) {
      buildPanel();
      panel.classList.add('kum-floating');
      (document.body || document.documentElement).appendChild(panel);
      setError('未找到内嵌服务地址 (kimi_origin)');
      render();
      return;
    }
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (mount()) {
        clearInterval(timer);
        boot();
      } else if (tries > 100) {
        clearInterval(timer);
        buildPanel();
        panel.classList.add('kum-floating');
        document.body.appendChild(panel);
        boot();
      }
    }, 100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

(() => {
  const $ = (id) => document.getElementById(id);

  const I18N = {
    zh: {
      connecting: '连接中…',
      live: '在线',
      reconnecting: '重连中',
      disconnected: '已断联',
      idle: '空闲',
      running: '运行中',
      waiting: '等待确认',
      stalled: '疑似卡住',
      cancelling: '取消中',
      all: '全部',
      thinking: '思维链',
      tools: '工具调用',
      errors: '错误',
      autoThink: '∴ 思维链',
      jumpLive: '↓ 跳到最新',
      empty: '暂无步骤记录。发送指令后，这里将像 Claude Code 一样实时显示思维链、工具参数、耗时和连接心跳。',
      thoughtFor: '思考了',
      thinkingNow: '正在思考',
      turnPrefix: '回合',
      silenceLabel: '活动',
      ago: '前',
      now: '刚刚',
      inspectSub: '查看子代理 →',
      backParent: '← 返回主会话',
      argsLabel: '输入参数',
      outputLabel: '执行输出',
      copy: '复制',
      copied: '已复制',
    },
    en: {
      connecting: 'Connecting…',
      live: 'LIVE',
      reconnecting: 'RECONNECTING',
      disconnected: 'DISCONNECTED',
      idle: 'IDLE',
      running: 'RUNNING',
      waiting: 'WAITING',
      stalled: 'STALLED',
      cancelling: 'CANCELLING',
      all: 'All',
      thinking: 'Thinking',
      tools: 'Tools',
      errors: 'Errors',
      autoThink: '∴ Think',
      jumpLive: '↓ Jump to Live',
      empty: 'No steps recorded yet. Once the agent runs, live chain-of-thought, tool tree, timings, and heartbeat will stream here.',
      thoughtFor: 'Thought for',
      thinkingNow: 'Thinking',
      turnPrefix: 'Turn',
      silenceLabel: 'Activity',
      ago: 'ago',
      now: 'just now',
      inspectSub: 'Inspect →',
      backParent: '← Back to Parent',
      argsLabel: 'Arguments',
      outputLabel: 'Output',
      copy: 'Copy',
      copied: 'Copied',
    },
  };

  const state = {
    lang: 'zh',
    autoExpandThinking: true,
    filter: 'all',
    selectedConvId: '',
    parentConvStack: [],
    stickToBottom: true,
    snapshot: null,
    expandedTools: new Set(),
    toggledThink: new Map(), // stepIndex -> boolean override
    heartbeat: [], // [{ ok, ms }]
    lastRenderSig: '',
  };

  const params = new URLSearchParams(location.search);
  const hostConvId = () => window.sidecar?.conversationId || params.get('conversationId') || '';

  async function apiGet(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function apiPost(path, body) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ---------- Theme Sync ----------
  function syncTheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #111214)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
  }
  syncTheme();
  new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

  // ---------- Formatting ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  function fmtDur(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const sec = ms / 1000;
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}m${String(s).padStart(2, '0')}s`;
  }

  function fmtTokens(n) {
    if (!n) return '0';
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  function t(key) {
    return I18N[state.lang]?.[key] || I18N.en[key] || key;
  }

  // ---------- Header & Timers ----------
  function renderHeader(snap) {
    const diag = snap?.diagnostics || {};
    const conn = diag.connection || {};

    // Connection dot & badge
    const dot = $('conn-dot');
    const connBadge = $('conn-badge');
    dot.className = 'pulse-dot';
    connBadge.className = 'badge';

    if (conn.status === 'connected') {
      dot.classList.add(
        diag.healthState === 'stalled' ? 'is-stalled'
          : (diag.healthState === 'waiting' || diag.healthState === 'slow') ? 'is-waiting'
            : 'is-live'
      );
      connBadge.classList.add('badge-live');
      connBadge.textContent = `${t('live')} · ${conn.latencyMs ?? 0}ms`;
    } else if (conn.status === 'reconnecting') {
      dot.classList.add('is-slow');
      connBadge.classList.add('badge-waiting');
      connBadge.textContent = `${t('reconnecting')} #${conn.consecutiveFailures || 1}`;
    } else {
      dot.classList.add('is-disconnected');
      connBadge.classList.add('badge-disconnected');
      connBadge.textContent = t('disconnected');
    }

    // Run state badge
    const stateBadge = $('state-badge');
    stateBadge.className = 'badge';
    if (diag.healthState === 'disconnected') {
      stateBadge.classList.add('badge-disconnected');
      stateBadge.textContent = t('disconnected');
    } else if (diag.healthState === 'stalled') {
      stateBadge.classList.add('badge-stalled');
      stateBadge.textContent = t('stalled');
    } else if (diag.healthState === 'waiting') {
      stateBadge.classList.add('badge-waiting');
      stateBadge.textContent = t('waiting');
    } else if (diag.healthState === 'cancelling') {
      stateBadge.classList.add('badge-waiting');
      stateBadge.textContent = t('cancelling');
    } else if (diag.rawRunStatus === 'RUNNING') {
      stateBadge.classList.add('badge-running');
      stateBadge.textContent = t('running');
    } else {
      stateBadge.classList.add('badge-idle');
      stateBadge.textContent = t('idle');
    }

    // Now Happening banner
    const banner = $('now-banner');
    banner.className = 'now-banner';
    if (diag.healthState === 'stalled' || diag.healthState === 'disconnected') banner.classList.add('is-stalled');
    else if (diag.healthState === 'waiting' || diag.healthState === 'slow') banner.classList.add('is-waiting');
    else if (diag.rawRunStatus === 'RUNNING') banner.classList.add('is-live');
    else banner.classList.add('is-idle');

    $('now-icon').textContent = diag.healthState === 'disconnected' || diag.healthState === 'stalled'
      ? '⚠'
      : diag.healthState === 'waiting'
        ? '⏸'
        : diag.rawRunStatus === 'RUNNING' ? '●' : '○';
    $('now-text').textContent = state.lang === 'zh'
      ? (diag.activityZh || diag.activityEn || '')
      : (diag.activityEn || '');

    // Conversation selector
    const sel = $('conv-select');
    const convs = snap?.conversations || [];
    const activeId = snap?.conversationId || '';
    const optsHtml = convs.map((c) => {
      const icon = c.status === 'RUNNING' ? '● ' : '';
      const childTag = c.parentConversationId ? '↳ ' : '';
      return `<option value="${esc(c.id)}" ${c.id === activeId ? 'selected' : ''}>${esc(childTag + icon + c.title)}</option>`;
    }).join('');
    if (sel.innerHTML !== optsHtml) sel.innerHTML = optsHtml;

    // Subagents strip
    const strip = $('subagent-strip');
    const subs = snap?.subagents || [];
    if (state.parentConvStack.length > 0 || subs.length > 0) {
      strip.classList.remove('hidden');
      let html = '';
      if (state.parentConvStack.length > 0) {
        html += `<button class="link-btn" data-back-parent="1">${esc(t('backParent'))}</button>`;
      }
      for (const sa of subs) {
        const dotChar = sa.runStatus === 'RUNNING' ? '●' : '✓';
        html += `<button class="subagent-chip" data-subconv="${esc(sa.id)}" title="${esc(sa.latestAction)}"><span>${dotChar}</span><span>${esc(sa.title)}</span><span style="opacity:.65">(${sa.stepCount})</span></button>`;
      }
      strip.innerHTML = html;
    } else {
      strip.classList.add('hidden');
    }

    // Filter labels & stats
    for (const btn of $('filter-pills').querySelectorAll('.filter-pill')) {
      const key = btn.dataset.filter;
      btn.textContent = t(key);
      btn.classList.toggle('is-active', key === state.filter);
    }

    $('btn-expand-think').textContent = t('autoThink');
    $('btn-expand-think').classList.toggle('is-active', state.autoExpandThinking);
    $('btn-lang').textContent = state.lang === 'zh' ? '中文' : 'EN';
    $('jump-live').textContent = t('jumpLive');

    const turns = snap?.turns || [];
    const totalIn = turns.reduce((a, b) => a + b.stats.inputTokens, 0);
    const totalCache = turns.reduce((a, b) => a + b.stats.cacheReadTokens, 0);
    const totalOut = turns.reduce((a, b) => a + b.stats.outputTokens, 0);
    const totalThink = turns.reduce((a, b) => a + b.stats.thinkingSec, 0);
    $('summary-stats').innerHTML = [
      `<span>${snap?.totalSteps || 0} steps</span>`,
      totalThink > 0 ? `<span>∴ ${totalThink.toFixed(1)}s</span>` : '',
      (totalIn || totalOut) ? `<span>↓${fmtTokens(totalIn)} ⚡${fmtTokens(totalCache)} ↑${fmtTokens(totalOut)}</span>` : '',
    ].filter(Boolean).join('');

    // Heartbeat bars
    $('heartbeat-bars').innerHTML = state.heartbeat.slice(-16).map((h) => {
      const height = h.ok ? Math.max(4, Math.min(14, Math.round(4 + (h.ms / 40)))) : 12;
      const cls = !h.ok ? 'is-err' : h.ms > 400 ? 'is-slow' : '';
      return `<span class="hb-bar ${cls}" style="height:${height}px"></span>`;
    }).join('');

    updateLiveTimers();
  }

  function updateLiveTimers() {
    const diag = state.snapshot?.diagnostics;
    if (!diag) return;
    const now = Date.now();
    const silenceMs = diag.lastChangeAt ? Math.max(0, now - diag.lastChangeAt) : diag.silenceMs;
    const turnMs = diag.rawRunStatus === 'RUNNING' && diag.turnElapsedMs
      ? diag.turnElapsedMs + (now - (state.snapshot.now || now))
      : 0;

    $('timer-turn').textContent = turnMs > 0 ? `${t('turnPrefix')} ${fmtDur(turnMs)}` : `${t('idle')}`;

    const sPill = $('timer-silence');
    sPill.className = 'timer-pill';
    if (diag.rawRunStatus === 'RUNNING') {
      if (silenceMs >= 45000) sPill.classList.add('is-danger');
      else if (silenceMs >= 15000) sPill.classList.add('is-warn');
    }
    sPill.textContent = silenceMs < 1500
      ? `${t('silenceLabel')}: ${t('now')}`
      : `${t('silenceLabel')}: ${fmtDur(silenceMs)} ${t('ago')}`;
  }

  // ---------- Timeline Rendering ----------
  function shouldShowItem(item) {
    if (state.filter === 'all') return true;
    if (state.filter === 'thinking') return item.kind === 'planner' && (item.thinking || item.response);
    if (state.filter === 'tools') return item.kind === 'tool';
    if (state.filter === 'errors') return item.status === 'ERROR' || item.isError || item.status === 'WAITING';
    return true;
  }

  function renderChecklist(steps) {
    if (!Array.isArray(steps) || !steps.length) return '';
    return `<div class="tool-checklist">${steps.map((s) => {
      const icon = s.status === 'done' ? '✓' : s.status === 'in_progress' ? '●' : s.status === 'failed' ? '✕' : '○';
      return `<div class="check-row is-${esc(s.status)}"><span>${icon}</span><span>${esc(s.title)}</span></div>`;
    }).join('')}</div>`;
  }

  function isThinkExpanded(step, isLatestTurn) {
    if (state.toggledThink.has(step.index)) return state.toggledThink.get(step.index);
    if (state.autoExpandThinking) return true;
    return isLatestTurn && step.status === 'RUNNING';
  }

  function renderTimeline(snap) {
    const container = $('timeline');
    const turns = snap?.turns || [];
    if (!turns.length) {
      container.innerHTML = `<div class="empty-state">${esc(t('empty'))}</div>`;
      return;
    }

    const html = turns.map((turn, tIdx) => {
      const isLatestTurn = tIdx === turns.length - 1;
      const visibleItems = turn.items.filter(shouldShowItem);
      if (state.filter !== 'all' && visibleItems.length === 0) return '';

      const turnMeta = [
        turn.durationMs ? fmtDur(turn.durationMs) : '',
        turn.stats.thinkingSec > 0 ? `∴ ${turn.stats.thinkingSec.toFixed(1)}s` : '',
        turn.stats.tools > 0 ? `${turn.stats.tools} tools` : '',
        turn.stats.errors > 0 ? `${turn.stats.errors} err` : '',
      ].filter(Boolean).join(' · ');

      const itemsHtml = visibleItems.map((item) => {
        if (item.kind === 'planner') {
          let blocks = '';
          if (item.thinking) {
            const expanded = isThinkExpanded(item, isLatestTurn);
            const durLabel = item.thinkingDurationSec ? `${item.thinkingDurationSec.toFixed(1)}s` : '';
            const tokLabel = item.usage?.thinkingTokens ? `${fmtTokens(item.usage.thinkingTokens)} tok` : `${item.thinkingLen} chars`;
            const headLabel = item.status === 'RUNNING'
              ? `${t('thinkingNow')}… ${durLabel}`
              : `${t('thoughtFor')} ${durLabel || '—'}`;
            blocks += `
              <div class="think-block">
                <div class="think-head" data-toggle-think="${item.index}">
                  <span class="think-title"><span>${expanded ? '▾' : '▸'}</span><span>∴ ${esc(headLabel)}</span></span>
                  <span class="think-meta">${esc(tokLabel)}</span>
                </div>
                ${expanded ? `<div class="think-body">${esc(item.thinking)}</div>` : ''}
              </div>
            `;
          }
          if (item.response) {
            blocks += `<div class="assistant-msg">${esc(item.response)}</div>`;
          }
          return blocks;
        }

        if (item.kind === 'system') {
          return `<div class="system-msg ${item.status === 'ERROR' ? 'is-error' : ''}">[${esc(item.rawType)}] ${esc(item.text)}</div>`;
        }

        // Tool card
        const expanded = state.expandedTools.has(item.index);
        const bullet = item.status === 'DONE' ? '✓'
          : item.status === 'RUNNING' ? '●'
            : item.status === 'WAITING' ? '⏸'
              : item.status === 'ERROR' ? '✕' : '○';
        const statusCls = item.status.toLowerCase();
        const durStr = item.durationMs !== null ? fmtDur(item.durationMs) : '';

        let previewLine = '';
        if (item.checklist) {
          previewLine = renderChecklist(item.checklist);
        } else if (item.output || item.outputMeta || item.subtitle) {
          const firstLine = (item.output || '').split('\n').find((l) => l.trim()) || '';
          const summary = [item.subtitle, item.outputMeta, firstLine].filter(Boolean).join(' · ');
          if (summary) {
            previewLine = `<div class="tool-preview ${item.isError ? 'is-error' : ''}">⎿ ${esc(summary.slice(0, 140))}</div>`;
          }
        }

        let subagentInline = '';
        if (item.childConversationId) {
          const sub = (snap.subagents || []).find((s) => s.id === item.childConversationId);
          const subState = sub ? `${sub.runStatus} · ${sub.latestAction}` : `ID: ${item.childConversationId.slice(0, 8)}`;
          subagentInline = `
            <div class="subagent-inline">
              <span>↳ ${esc(subState)}</span>
              <button class="link-btn" data-subconv="${esc(item.childConversationId)}">${esc(t('inspectSub'))}</button>
            </div>
          `;
        }

        let detailHtml = '';
        if (expanded) {
          const argsJson = JSON.stringify(item.args || {}, null, 2);
          detailHtml = `
            <div class="tool-detail">
              <div class="detail-section-head"><span>${esc(t('argsLabel'))}</span></div>
              <pre class="detail-pre">${esc(argsJson)}</pre>
              ${item.output ? `
                <div class="detail-section-head"><span>${esc(t('outputLabel'))}</span></div>
                <pre class="detail-pre">${esc(item.output)}</pre>
              ` : ''}
            </div>
          `;
        }

        return `
          <div class="tool-node is-${esc(statusCls)}">
            <div class="tool-head" data-toggle-tool="${item.index}">
              <div class="tool-left">
                <span class="step-bullet is-${esc(statusCls)}">${bullet}</span>
                <span class="verb-tag cat-${esc(item.category)}">${esc(item.verb)}</span>
                <span class="tool-target" title="${esc(item.target)}">${esc(item.target)}</span>
              </div>
              <div class="tool-right">
                ${durStr ? `<span>${esc(durStr)}</span>` : ''}
                <span>${expanded ? '▾' : '▸'}</span>
              </div>
            </div>
            ${previewLine}
            ${subagentInline}
            ${detailHtml}
          </div>
        `;
      }).join('');

      return `
        <section class="turn-card">
          <div class="turn-header">
            <div class="turn-prompt">
              <span class="prompt-chevron">❯</span>
              <span class="prompt-text">${esc(turn.userText)}</span>
            </div>
            <div class="turn-meta">#${turn.turnIndex}${turnMeta ? ` · ${esc(turnMeta)}` : ''}</div>
          </div>
          <div class="turn-body">${itemsHtml}</div>
        </section>
      `;
    }).join('');

    const wasAtBottom = state.stickToBottom;
    container.innerHTML = html || `<div class="empty-state">${esc(t('empty'))}</div>`;
    if (wasAtBottom) {
      container.scrollTop = container.scrollHeight;
    }
  }

  // ---------- Polling Loop ----------
  let pollTimer = null;

  async function pollOnce() {
    const started = performance.now();
    const targetConv = state.selectedConvId || hostConvId();
    const qs = targetConv ? `?conversationId=${encodeURIComponent(targetConv)}` : '';
    try {
      const snap = await apiGet(`/api/trace${qs}`);
      const rtt = Math.round(performance.now() - started);
      state.heartbeat.push({ ok: snap.diagnostics?.connection?.status === 'connected', ms: snap.diagnostics?.connection?.latencyMs ?? rtt });
      if (state.heartbeat.length > 24) state.heartbeat.shift();

      state.snapshot = snap;
      renderHeader(snap);

      const sig = JSON.stringify([
        snap.conversationId,
        snap.totalSteps,
        snap.diagnostics?.rawRunStatus,
        snap.turns?.at(-1)?.items?.at(-1)?.thinkingLen,
        snap.turns?.at(-1)?.items?.at(-1)?.output?.length,
        snap.turns?.at(-1)?.items?.at(-1)?.status,
        state.filter,
        state.lang,
        state.autoExpandThinking,
      ]);
      if (sig !== state.lastRenderSig) {
        state.lastRenderSig = sig;
        renderTimeline(snap);
      }

      const nextMs = snap.diagnostics?.rawRunStatus === 'RUNNING' ? 750 : 2200;
      schedulePoll(nextMs);
    } catch (err) {
      state.heartbeat.push({ ok: false, ms: 0 });
      if (state.heartbeat.length > 24) state.heartbeat.shift();
      if (state.snapshot) {
        state.snapshot.diagnostics.connection.status = 'disconnected';
        state.snapshot.diagnostics.connection.lastError = err.message;
        state.snapshot.diagnostics.healthState = 'disconnected';
        state.snapshot.diagnostics.activityEn = `Sidecar connection error: ${err.message}`;
        state.snapshot.diagnostics.activityZh = `Sidecar 后端连接失败: ${err.message}`;
        renderHeader(state.snapshot);
      }
      schedulePoll(2000);
    }
  }

  function schedulePoll(ms) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(pollOnce, ms);
  }

  // ---------- Events ----------
  $('conv-select').addEventListener('change', (e) => {
    state.selectedConvId = e.target.value;
    state.parentConvStack = [];
    state.lastRenderSig = '';
    state.stickToBottom = true;
    pollOnce();
  });

  $('btn-expand-think').addEventListener('click', () => {
    state.autoExpandThinking = !state.autoExpandThinking;
    state.toggledThink.clear();
    state.lastRenderSig = '';
    renderHeader(state.snapshot);
    renderTimeline(state.snapshot);
    void apiPost('/api/prefs', { autoExpandThinking: state.autoExpandThinking }).catch(() => {});
  });

  $('btn-lang').addEventListener('click', () => {
    state.lang = state.lang === 'zh' ? 'en' : 'zh';
    state.lastRenderSig = '';
    renderHeader(state.snapshot);
    renderTimeline(state.snapshot);
    void apiPost('/api/prefs', { lang: state.lang }).catch(() => {});
  });

  $('filter-pills').addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-pill');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    state.lastRenderSig = '';
    renderHeader(state.snapshot);
    renderTimeline(state.snapshot);
  });

  $('timeline').addEventListener('click', (e) => {
    const thinkHead = e.target.closest('[data-toggle-think]');
    if (thinkHead) {
      const idx = Number(thinkHead.dataset.toggleThink);
      const curr = thinkHead.parentElement.querySelector('.think-body') !== null;
      state.toggledThink.set(idx, !curr);
      renderTimeline(state.snapshot);
      return;
    }
    const toolHead = e.target.closest('[data-toggle-tool]');
    if (toolHead) {
      const idx = Number(toolHead.dataset.toggleTool);
      if (state.expandedTools.has(idx)) state.expandedTools.delete(idx);
      else state.expandedTools.add(idx);
      renderTimeline(state.snapshot);
      return;
    }
    const subBtn = e.target.closest('[data-subconv]');
    if (subBtn) {
      const current = state.selectedConvId || state.snapshot?.conversationId || hostConvId();
      if (current) state.parentConvStack.push(current);
      state.selectedConvId = subBtn.dataset.subconv;
      state.lastRenderSig = '';
      state.stickToBottom = true;
      pollOnce();
    }
  });

  $('subagent-strip').addEventListener('click', (e) => {
    const back = e.target.closest('[data-back-parent]');
    if (back && state.parentConvStack.length) {
      state.selectedConvId = state.parentConvStack.pop() || '';
      state.lastRenderSig = '';
      pollOnce();
      return;
    }
    const subBtn = e.target.closest('[data-subconv]');
    if (subBtn) {
      const current = state.selectedConvId || state.snapshot?.conversationId || hostConvId();
      if (current) state.parentConvStack.push(current);
      state.selectedConvId = subBtn.dataset.subconv;
      state.lastRenderSig = '';
      pollOnce();
    }
  });

  $('timeline').addEventListener('scroll', () => {
    const el = $('timeline');
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    state.stickToBottom = nearBottom;
    $('jump-live').classList.toggle('hidden', nearBottom);
  });

  $('jump-live').addEventListener('click', () => {
    const el = $('timeline');
    state.stickToBottom = true;
    el.scrollTop = el.scrollHeight;
    $('jump-live').classList.add('hidden');
  });

  // Boot
  (async () => {
    try {
      const prefs = await apiGet('/api/prefs');
      if (prefs?.lang) state.lang = prefs.lang;
      if (typeof prefs?.autoExpandThinking === 'boolean') state.autoExpandThinking = prefs.autoExpandThinking;
    } catch {}
    setInterval(updateLiveTimers, 400);
    pollOnce();
  })();
})();

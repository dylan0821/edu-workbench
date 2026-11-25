import { esc, showToast } from '../utils.js';
import {
  app,
  api,
  persistNavState,
  updateNavCounts,
  switchView
} from '../state.js';

const TOOL_LABEL_MAP = {
  get_overview: '查询工作台概览',
  create_teacher: '创建教师',
  update_teacher: '更新教师信息',
  upsert_teacher_account: '配置教师账号',
  create_student: '创建学生',
  update_student: '更新学生信息',
  manage_account: '管理登录账号',
  create_course: '创建课程',
  update_course: '编辑课程信息',
  enroll_students: '批量报名课程',
  update_enrollment: '更新报名状态',
  create_course_node: '创建课程大纲节点',
  create_course_nodes_batch: '批量导入大纲',
  copy_course_outline: '复制课程大纲',
  list_lessons: '查询课表排课',
  schedule_lesson: '安排单节排课',
  schedule_lessons_batch: '周期批量排课',
  update_lesson_status: '更新课次状态',
  delete_lesson: '删除排课',
  create_trial_grant: '发放试听权限',
  add_student_followup: '添加学生跟进',
  delete_entity: '删除教务数据'
};

function renderAssistantMetricsBar(conv) {
  const bar = document.querySelector('#assistant-metrics-bar');
  if (!bar) return;
  const m = conv?.metrics || {};
  const totalTok = Number(m.totalTokens || 0).toLocaleString('en-US');
  const tokPerSec = Number(m.tokPerSec || 0);
  const cacheHit = Number(m.cacheHitPct || 0);
  const ctxPct = Number(m.contextPct || 0).toFixed(1);
  const dashOffset = (31.4 * (1 - Math.min(100, Number(m.contextPct || 0)) / 100)).toFixed(1);
  bar.innerHTML = `
    <span class="assistant-metric-item"><span class="assistant-metric-icon">#</span> ${totalTok} tok</span>
    <span class="assistant-metric-item">⏱ ${tokPerSec} tok/s</span>
    <span class="assistant-metric-item">缓存命中 ${cacheHit}%</span>
    <span class="assistant-context-pill" title="上下文占用 ${ctxPct}%">
      <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
        <circle cx="7" cy="7" r="5" fill="none" stroke="var(--line-strong)" stroke-width="2"/>
        <circle cx="7" cy="7" r="5" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="31.4" stroke-dashoffset="${dashOffset}" transform="rotate(-90 7 7)"/>
      </svg>
      <span>${ctxPct}%</span>
    </span>
  `;
}

function renderAssistantPendingAttachments() {
  const bar = document.querySelector('#assistant-pending-bar');
  if (!bar) return;
  const list = app.assistant.pendingAttachments || [];
  if (!list.length) {
    bar.innerHTML = '';
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.innerHTML = list.map((a, idx) => `
    <span class="assistant-att-chip">
      <span>${a.isImage ? '🖼' : '📎'} ${esc(a.name)}</span>
      <button type="button" data-rm-att="${idx}" aria-label="移除">×</button>
    </span>
  `).join('');
  bar.querySelectorAll('[data-rm-att]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = Number(btn.getAttribute('data-rm-att'));
      app.assistant.pendingAttachments.splice(i, 1);
      renderAssistantPendingAttachments();
    });
  });
}

async function uploadAssistantFiles(files) {
  for (const file of files) {
    if (file.size > 20 * 1024 * 1024) {
      showToast(`文件「${file.name}」超过 20 MB 上限`, true);
      continue;
    }
    try {
      const q = new URLSearchParams({ filename: file.name });
      const res = await api(`/api/assistant/upload?${q}`, {
        method: 'POST', rawBody: file, headers: { 'Content-Type': file.type || 'application/octet-stream' }
      });
      app.assistant.pendingAttachments.push(res);
      renderAssistantPendingAttachments();
    } catch (err) {
      showToast(err.message || `上传 ${file.name} 失败`, true);
    }
  }
}

function connectAssistantStream() {
  if (app.assistant.es) return;
  const es = new EventSource('/api/assistant/stream');
  app.assistant.es = es;
  es.onmessage = async (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (data.type === 'workbench_mutated') {
      app.assistant.mutated = true;
      try {
        app.state = await api('/api/state');
        updateNavCounts();
      } catch {}
      return;
    }
    if (data.type === 'assistant_conversation_updated' && data.conversation) {
      const idx = app.assistant.conversations.findIndex(c => c.id === data.conversation.id);
      if (idx >= 0) app.assistant.conversations[idx] = { ...app.assistant.conversations[idx], ...data.conversation };
      if (app.currentView === 'assistant') {
        renderAssistantSidebar();
        if (data.conversation.id === app.assistant.activeId) {
          const headTitle = document.querySelector('#assistant-head-title');
          if (headTitle) headTitle.textContent = data.conversation.title;
        }
      }
      return;
    }
    if (data.type === 'assistant_metrics') {
      const conv = app.assistant.conversations.find(c => c.id === data.conversationId);
      if (conv) conv.metrics = data.metrics || {};
      if (data.conversationId === app.assistant.activeId && app.currentView === 'assistant') renderAssistantMetricsBar(conv);
      return;
    }
    if (data.type === 'assistant_message_update' || data.type === 'assistant_message_done') {
      if (data.conversationId === app.assistant.activeId) {
        const idx = app.assistant.messages.findIndex(m => m.id === data.messageId);
        if (idx >= 0) {
          app.assistant.messages[idx] = {
            ...app.assistant.messages[idx],
            content: data.content ?? app.assistant.messages[idx].content,
            thinking: data.thinking ?? app.assistant.messages[idx].thinking,
            toolCalls: data.toolCalls ?? app.assistant.messages[idx].toolCalls,
            status: data.status ?? app.assistant.messages[idx].status
          };
        }
        if (data.type === 'assistant_message_done') app.assistant.sending = false;
        if (app.currentView === 'assistant') patchAssistantMessagesDom();
      }
      if (data.type === 'assistant_message_done') refreshAssistantConversations().catch(() => {});
    }
  };
  es.onerror = () => {
    if (app.assistant.es === es) {
      es.close();
      app.assistant.es = null;
    }
  };
}

async function refreshAssistantConversations() {
  const res = await api('/api/assistant/conversations');
  app.assistant.conversations = res.conversations || [];
  if (!app.assistant.activeId && app.assistant.conversations.length) {
    app.assistant.activeId = app.assistant.conversations[0].id;
  } else if (app.assistant.activeId && !app.assistant.conversations.some(c => c.id === app.assistant.activeId)) {
    app.assistant.activeId = app.assistant.conversations[0]?.id || '';
  }
  if (app.currentView === 'assistant') renderAssistantSidebar();
}

async function loadAssistantConversationMessages(convId) {
  if (!convId) { app.assistant.messages = []; return; }
  const res = await api(`/api/assistant/conversations/${encodeURIComponent(convId)}/messages`);
  app.assistant.messages = res.messages || [];
  app.assistant.sending = app.assistant.messages.some(m => m.status === 'streaming');
}

async function initAssistantData() {
  const [st, convRes] = await Promise.all([
    api('/api/assistant/status').catch(() => null),
    api('/api/assistant/conversations').catch(() => ({ conversations: [] }))
  ]);
  app.assistant.status = st;
  app.assistant.conversations = convRes.conversations || [];
  if (!app.assistant.conversations.length) {
    const created = await api('/api/assistant/conversations', { method: 'POST', body: { title: '新对话' } });
    if (created?.conversation) app.assistant.conversations = [created.conversation];
  }
  if (app.pendingAssistantConvId && app.assistant.conversations.some(c => c.id === app.pendingAssistantConvId)) {
    app.assistant.activeId = app.pendingAssistantConvId;
    app.pendingAssistantConvId = '';
  } else if (!app.assistant.activeId || !app.assistant.conversations.some(c => c.id === app.assistant.activeId)) {
    app.assistant.activeId = app.assistant.conversations[0]?.id || '';
  }
  await loadAssistantConversationMessages(app.assistant.activeId);
  app.assistant.loaded = true;
  connectAssistantStream();
}

function renderAssistantSidebar() {
  const listEl = document.querySelector('#assistant-conv-list');
  if (!listEl) return;
  if (!app.assistant.conversations.length) {
    listEl.innerHTML = '<div style="padding:16px;font-size:12px;color:var(--muted);text-align:center">暂无对话</div>';
    return;
  }
  listEl.innerHTML = app.assistant.conversations.map(c => {
    const isActive = c.id === app.assistant.activeId;
    const preview = String(c.last_message || '').replace(/\s+/g, ' ').slice(0, 24) || '点击开始对话';
    const timeText = (c.updated_at || '').slice(11, 16) || (c.updated_at || '').slice(5, 10);
    return `
      <div class="chat-group-item ${isActive ? 'active' : ''}" data-conv-id="${esc(c.id)}" role="button" tabindex="0">
        <div class="chat-group-item-top">
          <strong style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0">${esc(c.title)}</strong>
          <span class="chat-group-item-meta">
            <span class="chat-group-item-time">${esc(timeText)}</span>
            <button type="button" class="assistant-conv-del" data-del-conv="${esc(c.id)}" title="删除对话" aria-label="删除对话">×</button>
          </span>
        </div>
        <div class="chat-group-item-preview">${esc(preview)}</div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.chat-group-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      if (e.target.closest('[data-del-conv]')) return;
      const id = item.getAttribute('data-conv-id');
      if (!id || id === app.assistant.activeId) return;
      app.assistant.activeId = id;
      persistNavState();
      await loadAssistantConversationMessages(id);
      renderAssistant(document.querySelector('#page-shell'));
    });
  });

  listEl.querySelectorAll('[data-del-conv]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-del-conv');
      if (!confirm('确认删除该对话记录？')) return;
      await api(`/api/assistant/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (app.assistant.activeId === id) app.assistant.activeId = '';
      await refreshAssistantConversations();
      if (!app.assistant.conversations.length) {
        const created = await api('/api/assistant/conversations', { method: 'POST', body: { title: '新对话' } });
        app.assistant.conversations = [created.conversation];
        app.assistant.activeId = created.conversation.id;
      }
      await loadAssistantConversationMessages(app.assistant.activeId);
      renderAssistant(document.querySelector('#page-shell'));
    });
  });
}

function formatInlineMd(raw) {
  let s = esc(raw);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return s;
}

function renderAssistantMarkdown(rawText) {
  const lines = String(rawText || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { codeLines.push(esc(lines[i])); i++; }
      i++;
      out.push(`<pre class="assistant-md-pre"><code>${codeLines.join('\n')}</code></pre>`);
      continue;
    }
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|/.test(lines[i + 1])) {
      const parseCells = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => formatInlineMd(c.trim()));
      const headers = parseCells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(parseCells(lines[i])); i++; }
      out.push(`<div class="assistant-md-table-wrap"><table class="assistant-md-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      const level = Math.min(4, hMatch[1].length + 1);
      out.push(`<h${level} class="assistant-md-h">${formatInlineMd(hMatch[2])}</h${level}>`);
      i++; continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(`<li>${formatInlineMd(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`); i++; }
      out.push(`<ul class="assistant-md-ul">${items.join('')}</ul>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    out.push(`<p class="assistant-md-p">${formatInlineMd(line)}</p>`);
    i++;
  }
  return out.join('');
}

function renderAssistantMessageHtml(m) {
  const isUser = m.role === 'user';
  const tools = Array.isArray(m.toolCalls) ? m.toolCalls : [];
  const doneCount = tools.filter(t => t.status === 'done').length;
  const errCount = tools.filter(t => t.status === 'error').length;
  const runningCount = tools.filter(t => t.status === 'running').length;

  const taskCardHtml = tools.length ? `
    <div class="assistant-task-card">
      <div class="assistant-task-head">
        <span>${runningCount > 0 ? '任务执行中' : (errCount > 0 ? '任务部分失败' : '任务已完成')}</span>
        <span style="color:var(--subtle)">${doneCount}/${tools.length} 步</span>
      </div>
      <div class="assistant-tools-list">
        ${tools.map((t, idx) => {
          const shortKey = String(t.name || '').replace(/^mcp__workbench__/, '').replace(/^workbench_/, '');
          const label = TOOL_LABEL_MAP[shortKey] || shortKey;
          const stateIcon = t.status === 'running' ? '⏳' : (t.status === 'error' ? '✕' : '✓');
          const stateClass = t.status === 'running' ? 'is-running' : (t.status === 'error' ? 'is-err' : 'is-done');
          return `
            <details class="assistant-tool-chip ${stateClass}" data-detail-key="tool-${esc(m.id)}-${idx}">
              <summary>${stateIcon} <span>${esc(label)}</span></summary>
              <div class="assistant-tool-detail">
                <div><strong>参数：</strong><code>${esc(JSON.stringify(t.arguments || {}))}</code></div>
                ${t.result ? `<div style="margin-top:4px"><strong>结果：</strong><pre>${esc(t.result)}</pre></div>` : ''}
              </div>
            </details>
          `;
        }).join('')}
      </div>
    </div>
  ` : '';

  const thinkingHtml = m.thinking ? `
    <details class="assistant-thinking" data-detail-key="think-${esc(m.id)}">
      <summary>思考过程</summary>
      <div class="assistant-thinking-body">${esc(m.thinking).replace(/\n/g, '<br>')}</div>
    </details>
  ` : '';

  const bodyText = m.content
    ? renderAssistantMarkdown(m.content)
    : (m.status === 'streaming' ? '<span style="color:var(--muted)">正在分析任务并执行…</span>' : '');

  const jumpHints = !isUser && m.status !== 'streaming' && tools.some(t => t.status === 'done') ? `
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;padding-top:6px;border-top:1px dashed var(--line)">
      <button type="button" class="chat-tool-btn" data-ast-go="schedule">查看课表</button>
      <button type="button" class="chat-tool-btn" data-ast-go="catalog">查看课程</button>
      <button type="button" class="chat-tool-btn" data-ast-go="students">查看学生</button>
    </div>
  ` : '';

  return `
    <div class="chat-msg-row ${isUser ? 'is-self' : ''} ${m.status === 'error' ? 'is-error-msg' : ''}" data-msg-id="${esc(m.id)}">
      <div class="chat-msg-meta">
        <span>${isUser ? esc(app.state.currentUser?.name || '管理员') : '智能助手'}</span>
        <span>${esc((m.created_at || '').slice(11, 16))}</span>
      </div>
      <div class="chat-bubble ${isUser ? 'is-self' : ''}">
        ${thinkingHtml}
        ${taskCardHtml}
        ${bodyText ? `<div class="assistant-msg-text">${bodyText}</div>` : ''}
        ${jumpHints}
      </div>
    </div>
  `;
}

function patchAssistantMessagesDom() {
  const listEl = document.querySelector('#assistant-msg-list');
  if (!listEl) return;

  // 记录已展开的 <details> 状态，流式增量更新时不丢失用户展开状态
  const openDetailKeys = new Set();
  listEl.querySelectorAll('details[open][data-detail-key]').forEach(d => {
    openDetailKeys.add(d.getAttribute('data-detail-key'));
  });

  if (!app.assistant.messages.length) {
    listEl.innerHTML = `
      <div class="assistant-welcome">
        <div style="font-size:15px;font-weight:600;margin-bottom:6px">教务智能助手</div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:14px">可直接通过自然语言创建教师与学生账号、创建或编辑课程、编排大纲、批量排课与检测冲突。</div>
        <div class="assistant-quick-chips">
          <button type="button" class="chat-tool-btn" data-quick-prompt="查看当前工作台所有教师、课程和近期排课概览">查看工作台概览</button>
          <button type="button" class="chat-tool-btn" data-quick-prompt="帮我创建一个新教师账号和一门直播课程">创建教师与课程</button>
          <button type="button" class="chat-tool-btn" data-quick-prompt="帮我安排本周的周期排课并先检测冲突">排课与冲突检测</button>
        </div>
      </div>
    `;
    listEl.querySelectorAll('[data-quick-prompt]').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = document.querySelector('#assistant-input');
        if (input) { input.value = btn.getAttribute('data-quick-prompt') || ''; input.focus(); }
      });
    });
  } else {
    const nearBottom = (listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight) < 80;
    listEl.innerHTML = app.assistant.messages.map(renderAssistantMessageHtml).join('');
    openDetailKeys.forEach(k => {
      const el = listEl.querySelector(`details[data-detail-key="${k}"]`);
      if (el) el.open = true;
    });
    listEl.querySelectorAll('[data-ast-go]').forEach(btn => {
      btn.addEventListener('click', () => switchView(btn.getAttribute('data-ast-go')));
    });
    if (nearBottom) requestAnimationFrame(() => { listEl.scrollTop = listEl.scrollHeight; });
  }
  const sendBtn = document.querySelector('#assistant-send-btn');
  const stopBtn = document.querySelector('#assistant-stop-btn');
  if (sendBtn) {
    sendBtn.disabled = app.assistant.sending;
    sendBtn.hidden = app.assistant.sending;
  }
  if (stopBtn) {
    stopBtn.hidden = !app.assistant.sending;
  }
}

export function renderAssistant(shell) {
  if (!shell) return;
  const hasKey = Boolean(app.state.org?.has_deepseek_api_key);

  if (!app.assistant.loaded) {
    shell.innerHTML = '<div style="margin:auto;padding:40px;color:var(--muted);font-size:13px">正在加载智能助手…</div>';
    initAssistantData().then(() => {
      if (app.currentView === 'assistant') renderAssistant(shell);
    }).catch(err => {
      shell.innerHTML = `<div style="margin:auto;padding:40px;color:var(--danger);font-size:13px">加载失败：${esc(err.message)}</div>`;
    });
    return;
  }

  const activeConv = app.assistant.conversations.find(c => c.id === app.assistant.activeId) || app.assistant.conversations[0];
  const rawModel = activeConv?.model || 'deepseek-flash';
  const currentModel = rawModel === 'deepseek-chat' ? 'deepseek-flash' : rawModel;
  const currentEffort = ['off', 'low', 'high', 'max'].includes(activeConv?.reasoning_effort) ? activeConv.reasoning_effort : 'high';

  shell.innerHTML = `
    <div class="page-heading">
      <div>
        <span class="page-eyebrow">教务</span>
        <div class="page-title-row">
          <h1>智能助手</h1>
          <span class="page-badge">${app.assistant.conversations.length} 个对话</span>
        </div>
      </div>
    </div>

    <div class="chat-group-layout">
      <aside class="chat-group-sidebar">
        <div class="chat-group-sidebar-head">
          <span>对话列表</span>
          <button type="button" class="chat-tool-btn" id="assistant-new-conv-btn">＋ 新建</button>
        </div>
        <div class="chat-group-list" id="assistant-conv-list"></div>
      </aside>

      <section class="chat-group-main">
        <div class="chat-group-head">
          <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1">
            <strong id="assistant-head-title" style="font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(activeConv?.title || '新对话')}</strong>
            <span class="status-pill ${hasKey ? 'is-ok' : 'is-warn'}">${hasKey ? '已就绪' : '未配置 API Key'}</span>
          </div>
          <div class="row-actions" style="gap:6px;flex-shrink:0">
            <select id="assistant-model-select" style="padding:5px 8px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--control);color:var(--ink);font-size:12px">
              <option value="deepseek-flash" ${currentModel === 'deepseek-flash' ? 'selected' : ''}>DeepSeek V4.1 Flash</option>
              <option value="deepseek-v4-pro" ${currentModel === 'deepseek-v4-pro' ? 'selected' : ''}>DeepSeek V4 Pro</option>
            </select>
            <button type="button" class="chat-tool-btn" id="assistant-rename-btn">重命名</button>
            <button type="button" class="chat-tool-btn" id="assistant-settings-btn">${hasKey ? '设置' : '配置 Key'}</button>
          </div>
        </div>

        <div class="chat-msg-wrap">
          <div class="chat-msg-list" id="assistant-msg-list"></div>
        </div>

        <form class="chat-composer" id="assistant-composer-form">
          <div class="chat-composer-bar">
            <div style="display:flex;gap:8px;align-items:center">
              <select id="assistant-effort-select" class="assistant-effort-select" title="思考等级">
                <option value="off" ${currentEffort === 'off' ? 'selected' : ''}>思考：关</option>
                <option value="low" ${currentEffort === 'low' ? 'selected' : ''}>思考：低</option>
                <option value="high" ${currentEffort === 'high' ? 'selected' : ''}>思考：高</option>
                <option value="max" ${currentEffort === 'max' ? 'selected' : ''}>思考：最高</option>
              </select>
            </div>
            <div style="display:flex;gap:6px;align-items:center">
              <label class="chat-tool-btn" for="assistant-file-input" title="上传文件或图片（支持粘贴截图）">上传文件</label>
              <input type="file" id="assistant-file-input" multiple style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;pointer-events:none">
            </div>
          </div>
          <div id="assistant-pending-bar" class="chat-pending-bar" hidden></div>
          <div class="chat-composer-input-row">
            <textarea id="assistant-input" rows="1" placeholder="${hasKey ? '描述教务任务，如：创建数学老师张明并排周三晚7点的课…' : '请先在系统设置中配置 DeepSeek API Key'}" ${!hasKey ? 'disabled' : ''}></textarea>
            <button type="submit" class="primary-button" id="assistant-send-btn" style="height:40px;padding:0 18px" ${!hasKey || app.assistant.sending ? 'disabled' : ''} ${app.assistant.sending ? 'hidden' : ''}>发送</button>
            <button type="button" class="secondary-button danger-button" id="assistant-stop-btn" style="height:40px;padding:0 14px" ${app.assistant.sending ? '' : 'hidden'}>停止</button>
          </div>
          <div id="assistant-metrics-bar" class="assistant-metrics-bar"></div>
        </form>
      </section>
    </div>
  `;

  renderAssistantSidebar();
  patchAssistantMessagesDom();
  renderAssistantPendingAttachments();
  renderAssistantMetricsBar(activeConv);

  shell.querySelector('#assistant-new-conv-btn')?.addEventListener('click', async () => {
    const res = await api('/api/assistant/conversations', { method: 'POST', body: { title: '新对话', model: currentModel, reasoningEffort: currentEffort } });
    app.assistant.conversations.unshift(res.conversation);
    app.assistant.activeId = res.conversation.id;
    app.assistant.messages = [];
    app.assistant.pendingAttachments = [];
    renderAssistant(shell);
  });

  shell.querySelector('#assistant-stop-btn')?.addEventListener('click', async () => {
    try {
      await api('/api/assistant/stop', { method: 'POST', body: { conversationId: activeConv?.id } });
      app.assistant.sending = false;
      patchAssistantMessagesDom();
      showToast('已请求停止生成');
    } catch (err) { showToast(err.message, true); }
  });

  shell.querySelector('#assistant-rename-btn')?.addEventListener('click', async () => {
    if (!activeConv) return;
    const nextTitle = prompt('请输入对话名称', activeConv.title);
    if (!nextTitle || !nextTitle.trim()) return;
    const res = await api(`/api/assistant/conversations/${encodeURIComponent(activeConv.id)}`, { method: 'PATCH', body: { title: nextTitle.trim() } });
    const idx = app.assistant.conversations.findIndex(c => c.id === activeConv.id);
    if (idx >= 0) app.assistant.conversations[idx] = { ...app.assistant.conversations[idx], ...res.conversation };
    renderAssistant(shell);
  });

  shell.querySelector('#assistant-model-select')?.addEventListener('change', async (e) => {
    if (!activeConv) return;
    const model = e.target.value;
    const res = await api(`/api/assistant/conversations/${encodeURIComponent(activeConv.id)}`, { method: 'PATCH', body: { model } });
    const idx = app.assistant.conversations.findIndex(c => c.id === activeConv.id);
    if (idx >= 0) app.assistant.conversations[idx] = { ...app.assistant.conversations[idx], ...res.conversation };
    showToast(`已切换模型为 ${model}`);
  });

  shell.querySelector('#assistant-effort-select')?.addEventListener('change', async (e) => {
    if (!activeConv) return;
    const reasoningEffort = e.target.value;
    const res = await api(`/api/assistant/conversations/${encodeURIComponent(activeConv.id)}`, { method: 'PATCH', body: { reasoningEffort } });
    const idx = app.assistant.conversations.findIndex(c => c.id === activeConv.id);
    if (idx >= 0) app.assistant.conversations[idx] = { ...app.assistant.conversations[idx], ...res.conversation };
  });

  const fileInputEl = shell.querySelector('#assistant-file-input');
  fileInputEl?.addEventListener('change', async () => {
    const files = [...(fileInputEl.files || [])];
    fileInputEl.value = '';
    if (files.length) await uploadAssistantFiles(files);
  });

  shell.querySelector('#assistant-settings-btn')?.addEventListener('click', () => switchView('settings-ai'));

  const inputEl = shell.querySelector('#assistant-input');
  const formEl = shell.querySelector('#assistant-composer-form');

  inputEl?.addEventListener('paste', async (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const files = items.filter(it => it.kind === 'file').map(it => it.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); await uploadAssistantFiles(files); }
  });

  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      formEl?.requestSubmit();
    }
  });

  formEl?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!hasKey) { switchView('settings-ai'); return; }
    if (app.assistant.sending || !activeConv) return;
    const text = String(inputEl?.value || '').trim();
    const attachments = [...(app.assistant.pendingAttachments || [])];
    if (!text && !attachments.length) return;
    inputEl.value = '';
    app.assistant.pendingAttachments = [];
    renderAssistantPendingAttachments();
    app.assistant.sending = true;
    patchAssistantMessagesDom();
    try {
      const res = await api(`/api/assistant/conversations/${encodeURIComponent(activeConv.id)}/messages`, {
        method: 'POST',
        body: {
          text,
          model: shell.querySelector('#assistant-model-select')?.value || currentModel,
          reasoningEffort: shell.querySelector('#assistant-effort-select')?.value || currentEffort,
          attachments
        }
      });
      app.assistant.messages = res.messages || app.assistant.messages;
      if (res.conversation) {
        const idx = app.assistant.conversations.findIndex(c => c.id === res.conversation.id);
        if (idx >= 0) app.assistant.conversations[idx] = { ...app.assistant.conversations[idx], ...res.conversation };
      }
      renderAssistantSidebar();
      patchAssistantMessagesDom();
      const listEl = document.querySelector('#assistant-msg-list');
      if (listEl) listEl.scrollTop = listEl.scrollHeight;
    } catch (err) {
      app.assistant.sending = false;
      showToast(err.message || '发送失败', true);
      patchAssistantMessagesDom();
    }
  });
}

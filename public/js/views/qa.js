import { esc, formatSize, formatDuration, formatLessonTime, showToast, openModal } from '../utils.js';
import {
  app,
  api,
  isAdmin,
  isTeacher,
  roleLabel,
  getPostMs,
  isSelfPost,
  isMentioningMe,
  getCourseUnreadCount,
  getCourseUnreadMentionCount,
  markCourseQaRead,
  persistNavState,
  updateNavCounts,
  renderView,
  switchView,
  openLessonDetailModal
} from '../state.js';
import { openStudentSubmitModal } from './homework.js';

function qaCardTypeLabel(type) {
  if (type === 'lesson') return '课次';
  if (type === 'material') return '资料';
  if (type === 'homework') return '作业';
  if (type === 'recording') return '回放';
  return '录播';
}

function formatQaShortTime(ms, fallback = '') {
  if (!ms) return String(fallback || '').slice(5, 16);
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const isYest = d.getFullYear() === yest.getFullYear() && d.getMonth() === yest.getMonth() && d.getDate() === yest.getDate();
  if (isYest) return '昨天';
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatQaDateDivider(ms, fallback = '') {
  if (!ms) return String(fallback || '').slice(0, 10) || '历史消息';
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return '今天';
  const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const isYest = d.getFullYear() === yest.getFullYear() && d.getMonth() === yest.getMonth() && d.getDate() === yest.getDate();
  if (isYest) return '昨天';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatQaMsgClock(ms, fallback = '') {
  if (!ms) return fallback;
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function getQaPostPreview(post) {
  if (!post) return '';
  if (post.recall_kind === 'recall') return `${post.recalled_by_name || post.author_name || '成员'}撤回了一条消息`;
  if (post.recall_kind === 'delete') return `${post.recalled_by_name || '教师'}删除了一条消息`;
  const prefix = post.msg_type === 'announcement' ? '[公告] ' : post.msg_type === 'question' ? '[提问] ' : '';
  if (post.content) return `${prefix}${post.content}`;
  if (post.card) return `${prefix}[${qaCardTypeLabel(post.card.type)}] ${post.card.title}`;
  if (post.attachments?.length) {
    const hasImg = post.attachments.some(a => a.isImage);
    return `${prefix}${hasImg ? '[图片]' : '[附件]'} ${post.attachments[0].filename || ''}`;
  }
  return `${prefix}${post.title || ''}`;
}

function renderQaTextWithMentions(text) {
  let s = esc(text || '');
  // 轻量数学/公式片段渲染：$...$ 内支持上下标
  s = s.replace(/\$([^$\n]+)\$/g, (_, expr) => {
    const formatted = expr
      .replace(/\^\{([^}]+)\}/g, '<sup>$1</sup>')
      .replace(/\^([A-Za-z0-9+-]+)/g, '<sup>$1</sup>')
      .replace(/_\{([^}]+)\}/g, '<sub>$1</sub>')
      .replace(/_([A-Za-z0-9]+)/g, '<sub>$1</sub>');
    return `<span style="font-family:Georgia,serif;font-style:italic;padding:0 2px">${formatted}</span>`;
  });
  s = s.replace(/@([^\s@]+)/g, '<span class="chat-mention-tag">@$1</span>');
  return s;
}

export function disconnectQaStream() {
  if (app.qaEventSource) {
    try { app.qaEventSource.close(); } catch {}
    app.qaEventSource = null;
  }
}

export function upsertQaPost(post) {
  if (!post || !app.state?.qaPosts) return;
  const idx = app.state.qaPosts.findIndex(p => p.id === post.id);
  if (idx >= 0) app.state.qaPosts[idx] = post;
  else app.state.qaPosts.unshift(post);
  app.state.qaPosts.sort((a, b) => getPostMs(b) - getPostMs(a));
}

function handleQaLiveEvent(type, payload) {
  if (app.qaLiveHooks) app.qaLiveHooks(type, payload);
}

export function connectQaStream() {
  if (app.qaEventSource || !app.state?.authenticated) return;
  const es = new EventSource('/api/qa/stream');
  app.qaEventSource = es;

  es.addEventListener('qa_post', (ev) => {
    try {
      const { post } = JSON.parse(ev.data);
      if (!post) return;
      const existed = app.state.qaPosts.some(p => p.id === post.id);
      upsertQaPost(post);
      updateNavCounts();
      if (app.currentView === 'qa') {
        handleQaLiveEvent('post', { post, isNew: !existed });
      } else if (!existed && !isSelfPost(post) && isMentioningMe(post)) {
        showToast(`${post.author_name} 在课程群 @了你`);
      }
    } catch {}
  });

  es.addEventListener('qa_update', (ev) => {
    try {
      const { post } = JSON.parse(ev.data);
      if (!post) return;
      upsertQaPost(post);
      updateNavCounts();
      if (app.currentView === 'qa') handleQaLiveEvent('update', { post });
    } catch {}
  });

  es.addEventListener('qa_delete', (ev) => {
    try {
      const { postId } = JSON.parse(ev.data);
      app.state.qaPosts = app.state.qaPosts.filter(p => p.id !== postId);
      app.state.qaReplies = app.state.qaReplies.filter(r => r.post_id !== postId);
      updateNavCounts();
      if (app.currentView === 'qa') handleQaLiveEvent('delete', { postId });
    } catch {}
  });

  es.addEventListener('lesson_status', (ev) => {
    try {
      const { lessonId, status } = JSON.parse(ev.data);
      const target = (app.state?.lessons || []).find(l => l.id === lessonId);
      if (target && status) {
        target.status = status;
        updateNavCounts();
        if (app.currentView === 'overview') renderView();
      }
    } catch {}
  });

  es.addEventListener('qa_reply', (ev) => {
    try {
      const { reply } = JSON.parse(ev.data);
      if (!reply) return;
      if (!app.state.qaReplies.some(r => r.id === reply.id)) {
        app.state.qaReplies.push(reply);
      }
      if (app.currentView === 'qa') handleQaLiveEvent('reply', { reply });
    } catch {}
  });

  es.addEventListener('qa_reply_delete', (ev) => {
    try {
      const { replyId } = JSON.parse(ev.data);
      app.state.qaReplies = app.state.qaReplies.filter(r => r.id !== replyId);
      if (app.currentView === 'qa') handleQaLiveEvent('reply_delete', { replyId });
    } catch {}
  });
}

async function ensureQaMembers(courseId) {
  if (!courseId) return { teachers: [], students: [] };
  if (app.qaMembersCache.has(courseId)) return app.qaMembersCache.get(courseId);
  try {
    const data = await api(`/api/qa/members?courseId=${encodeURIComponent(courseId)}`);
    app.qaMembersCache.set(courseId, data);
    return data;
  } catch {
    return { teachers: [], students: [] };
  }
}

function openQaImagePreview(url, filename) {
  openModal(filename || '图片预览', `
    <div style="display:grid;gap:12px;justify-items:center">
      <img src="${esc(url)}" alt="${esc(filename)}" style="max-width:100%;max-height:70vh;border-radius:8px;border:1px solid var(--line)">
      <a href="${esc(url)}?download=1" class="secondary-button" download="${esc(filename)}">下载原图</a>
    </div>
  `);
}

async function openQaMembersModal(course) {
  const body = openModal(`${course.name} · 群成员`, `<div class="empty-state">加载群成员中…</div>`);
  if (!body) return;
  const data = await ensureQaMembers(course.id);
  const teachers = data.teachers || [];
  const students = data.students || [];
  body.innerHTML = `
    <div style="display:grid;gap:14px">
      <div>
        <div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:8px">授课教师 / 班主任（${teachers.length}）</div>
        ${teachers.length === 0 ? `<div style="font-size:12px;color:var(--subtle)">暂无关联教师</div>` : `
          <div style="display:grid;gap:6px">
            ${teachers.map(t => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border:1px solid var(--line);border-radius:var(--radius-sm)">
                <span><strong>${esc(t.name)}</strong>${t.subject ? ` <span style="font-size:12px;color:var(--subtle)">· ${esc(t.subject)}</span>` : ''}</span>
                <span class="page-badge is-accent">${esc(t.tag || '教师')}</span>
              </div>
            `).join('')}
          </div>
        `}
      </div>
      <div>
        <div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:8px">在读学员（${students.length}）</div>
        ${students.length === 0 ? `<div style="font-size:12px;color:var(--subtle)">暂无在读学员</div>` : `
          <div style="display:grid;gap:6px;max-height:300px;overflow-y:auto">
            ${students.map(s => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 10px;border:1px solid var(--line);border-radius:var(--radius-sm)">
                <span>${esc(s.name)}</span>
                <span class="page-badge">${esc(s.tag || '在读学员')}</span>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    </div>
  `;
}

function openQaCardPickerModal(course, onSelect) {
  const state = app.state;
  const courseLessons = state.lessons.filter(l => l.course_id === course.id);
  const lessonIds = new Set(courseLessons.map(l => l.id));
  const courseMats = state.materials.filter(
    m => (m.scope === 'course' && m.target_id === course.id) || (m.scope === 'lesson' && lessonIds.has(m.target_id))
  );
  const courseRecs = state.recordings.filter(r => lessonIds.has(r.lesson_id));
  const courseVods = state.vodLessons.filter(v => v.course_id === course.id);
  const courseHomeworks = (state.homeworks || []).filter(h => h.course_id === course.id);
  const body = openModal(`发送资源卡片 · ${course.name}`, `
    <div style="display:grid;gap:14px;max-height:62vh;overflow-y:auto">
      <div>
        <div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px">本课程课次（${courseLessons.length}）</div>
        ${courseLessons.length === 0 ? `<div style="font-size:12px;color:var(--subtle)">暂无课次</div>` : `
          <div style="display:grid;gap:6px">
            ${courseLessons.slice(0, 15).map(l => `
              <button type="button" class="chat-res-card" data-pick-card="lesson" data-id="${l.id}" data-title="${esc(l.title)}" data-sub="${esc(`${formatLessonTime(l.start_ms, l.end_ms)} · ${l.teacher_name || ''}`)}">
                <div>
                  <div style="font-weight:600;font-size:13px">${esc(l.title)}</div>
                  <div style="font-size:11px;color:var(--subtle)">${esc(formatLessonTime(l.start_ms, l.end_ms))} · ${esc(l.teacher_name || '')}</div>
                </div>
                <span class="page-badge">课次</span>
              </button>
            `).join('')}
          </div>
        `}
      </div>
      <div>
        <div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px">课程资料（${courseMats.length}）</div>
        ${courseMats.length === 0 ? `<div style="font-size:12px;color:var(--subtle)">暂无资料</div>` : `
          <div style="display:grid;gap:6px">
            ${courseMats.slice(0, 15).map(m => `
              <button type="button" class="chat-res-card" data-pick-card="material" data-id="${m.id}" data-title="${esc(m.filename)}" data-sub="${esc(`${m.category || '资料'} · ${formatSize(m.size_bytes)}`)}">
                <div>
                  <div style="font-weight:600;font-size:13px">${esc(m.filename)}</div>
                  <div style="font-size:11px;color:var(--subtle)">${esc(m.category || '资料')} · ${formatSize(m.size_bytes)}</div>
                </div>
                <span class="page-badge">资料</span>
              </button>
            `).join('')}
          </div>
        `}
      </div>
      <div>
        <div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px">课堂回放 / 录播（${courseRecs.length + courseVods.length}）</div>
        ${(courseRecs.length + courseVods.length) === 0 ? `<div style="font-size:12px;color:var(--subtle)">暂无回放或录播</div>` : `
          <div style="display:grid;gap:6px">
            ${courseRecs.slice(0, 10).map(r => `
              <button type="button" class="chat-res-card" data-pick-card="recording" data-id="${r.id}" data-title="${esc(r.title)}" data-sub="${esc(`课堂回放 · ${formatDuration(r.duration_sec)}`)}">
                <div>
                  <div style="font-weight:600;font-size:13px">${esc(r.title)}</div>
                  <div style="font-size:11px;color:var(--subtle)">课堂回放 · ${formatDuration(r.duration_sec)}</div>
                </div>
                <span class="page-badge is-accent">回放</span>
              </button>
            `).join('')}
            ${courseVods.slice(0, 10).map(v => `
              <button type="button" class="chat-res-card" data-pick-card="vod" data-id="${v.id}" data-title="${esc(v.title)}" data-sub="${esc(`${v.chapter_name || '录播课'} · ${formatDuration(v.duration_sec)}`)}">
                <div>
                  <div style="font-weight:600;font-size:13px">${esc(v.title)}</div>
                  <div style="font-size:11px;color:var(--subtle)">${esc(v.chapter_name || '录播课')} · ${formatDuration(v.duration_sec)}</div>
                </div>
                <span class="page-badge is-accent">录播</span>
              </button>
            `).join('')}
          </div>
        `}
      </div>
      <div>
        <div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px">课程作业（${courseHomeworks.length}）</div>
        ${courseHomeworks.length === 0 ? `<div style="font-size:12px;color:var(--subtle)">暂无作业</div>` : `
          <div style="display:grid;gap:6px">
            ${courseHomeworks.slice(0, 15).map(hw => {
              const sub = `${hw.due_date ? `截止 ${hw.due_date}` : '不限截止'} · ${hw.creator_name || '老师'}`;
              return `
                <button type="button" class="chat-res-card" data-pick-card="homework" data-id="${hw.id}" data-title="${esc(hw.title)}" data-sub="${esc(sub)}">
                  <div>
                    <div style="font-weight:600;font-size:13px">${esc(hw.title)}</div>
                    <div style="font-size:11px;color:var(--subtle)">${esc(sub)}</div>
                  </div>
                  <span class="page-badge is-accent">作业</span>
                </button>
              `;
            }).join('')}
          </div>
        `}
      </div>
    </div>
  `);
  body?.querySelectorAll('[data-pick-card]').forEach(btn => {
    btn.addEventListener('click', () => {
      onSelect({
        type: btn.getAttribute('data-pick-card'),
        id: btn.getAttribute('data-id'),
        title: btn.getAttribute('data-title'),
        subtitle: btn.getAttribute('data-sub')
      });
      document.querySelector('#modal')?.close();
    });
  });
}

export function renderQa(shell) {
  const state = app.state;
  const qaDraft = app.pendingQaDraft;
  if (qaDraft) {
    app.pendingQaDraft = null;
    if (qaDraft.courseId) app.qaCourseFilter = qaDraft.courseId;
    if (qaDraft.lessonId || qaDraft.refTag) app.qaMsgType = 'question';
  }
  const focusPostIdInit = app.pendingQaFocusPostId;
  app.pendingQaFocusPostId = '';

  function getSortedCourses() {
    return app.state.courses.slice().sort((a, b) => {
      const aPosts = app.state.qaPosts.filter(p => p.course_id === a.id);
      const bPosts = app.state.qaPosts.filter(p => p.course_id === b.id);
      const aMs = aPosts.length ? getPostMs(aPosts[0]) : 0;
      const bMs = bPosts.length ? getPostMs(bPosts[0]) : 0;
      if (bMs !== aMs) return bMs - aMs;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
  }

  const sortedCoursesInit = getSortedCourses();
  if (!app.qaCourseFilter || !state.courses.some(c => c.id === app.qaCourseFilter)) {
    app.qaCourseFilter = sortedCoursesInit[0]?.id || '';
  }
  persistNavState();
  const activeCourse = state.courses.find(c => c.id === app.qaCourseFilter) || null;
  const courseLessons = activeCourse ? state.lessons.filter(l => l.course_id === activeCourse.id) : [];

  if (activeCourse) {
    markCourseQaRead(activeCourse.id);
    app.qaUnseenInActive = 0;
  }
  if (!isTeacher() && app.qaMsgType === 'announcement') app.qaMsgType = 'chat';

  let activeThreadReplyPostId = '';

  shell.innerHTML = `
    <div class="page-heading">
      <div>
        <span class="page-eyebrow">教学</span>
        <div class="page-title-row">
          <h1>课程群</h1>
          <span class="page-badge">${state.courses.length} 个群</span>
        </div>
      </div>
    </div>

    ${state.courses.length === 0 ? `<div class="empty-state">暂无课程群，请先创建或加入课程</div>` : `
      <div class="chat-group-layout">
        <aside class="chat-group-sidebar">
          <div class="chat-group-sidebar-head">
            <span>课程群列表</span>
            <span>${state.courses.length}</span>
          </div>
          <div class="chat-group-list" id="qa-group-list"></div>
        </aside>

        <section class="chat-group-main">
          <div class="chat-group-head">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:1;min-width:0">
              <strong style="font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(activeCourse?.name || '')}</strong>
              ${activeCourse?.subject ? `<span class="page-badge">${esc(activeCourse.subject)}</span>` : ''}
              <button type="button" class="chat-tool-btn" id="qa-members-btn">群成员</button>
              ${isTeacher() ? `<button type="button" class="chat-tool-btn ${app.qaSelectMode ? 'active' : ''}" id="qa-select-mode-btn">${app.qaSelectMode ? '退出多选' : '多选'}</button>` : ''}
              <button type="button" class="chat-tool-btn chat-mobile-filter-toggle" id="qa-mobile-filter-btn">${app.qaMobileFiltersOpen ? '收起筛选' : '筛选'}</button>
              <span id="qa-msg-count" style="font-size:12px;color:var(--subtle)"></span>
            </div>
            <div class="chat-head-filters ${app.qaMobileFiltersOpen ? 'is-open' : ''}" id="qa-head-filters" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
              <select id="qa-lesson-filter" style="padding:5px 8px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--control);color:var(--ink);font-size:12px;max-width:140px">
                <option value="">全部课次</option>
                ${courseLessons.map(l => `<option value="${l.id}" ${app.qaLessonFilter === l.id ? 'selected' : ''}>${esc(l.title)}</option>`).join('')}
              </select>
              <select id="qa-status-select" style="padding:5px 8px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--control);color:var(--ink);font-size:12px">
                <option value="" ${app.qaStatusFilter === '' ? 'selected' : ''}>全部消息</option>
                <option value="question" ${app.qaStatusFilter === 'question' ? 'selected' : ''}>仅看提问</option>
                <option value="open" ${app.qaStatusFilter === 'open' ? 'selected' : ''}>待解答</option>
                <option value="resolved" ${app.qaStatusFilter === 'resolved' ? 'selected' : ''}>已解答</option>
                <option value="announcement" ${app.qaStatusFilter === 'announcement' ? 'selected' : ''}>群公告</option>
                <option value="media" ${app.qaStatusFilter === 'media' ? 'selected' : ''}>图片/附件/卡片</option>
              </select>
              <input id="qa-search-input" type="search" value="${esc(app.qaSearch)}" placeholder="搜群消息…" style="width:140px;padding:5px 9px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--control);color:var(--ink);font-size:12px">
            </div>
          </div>

          <div id="qa-pinned-bar"></div>

          <div class="chat-msg-wrap">
            <div class="chat-msg-list" id="qa-msg-list"></div>
            <button type="button" class="chat-new-pill" id="qa-new-pill" hidden></button>
          </div>
          <div id="qa-batch-bar" class="chat-batch-bar" ${isTeacher() && app.qaSelectMode ? '' : 'hidden'}>
            <span id="qa-batch-count">已选 <strong>0</strong> 条消息</span>
            <div class="row-actions">
              <button type="button" class="secondary-button btn-sm" id="qa-batch-all">全选当前</button>
              <button type="button" class="secondary-button btn-sm" id="qa-batch-cancel">取消</button>
              <button type="button" class="secondary-button btn-sm danger-button" id="qa-batch-delete" disabled>删除所选</button>
            </div>
          </div>

          <form class="chat-composer" id="qa-chat-form">
            <div id="qa-mention-pop" class="chat-mention-pop" hidden></div>
            <div id="qa-reply-banner"></div>
            <div class="chat-composer-bar">
              <div class="chat-type-pills">
                <button type="button" class="chat-type-pill ${app.qaMsgType === 'chat' ? 'active' : ''}" data-qa-type="chat">讨论</button>
                <button type="button" class="chat-type-pill ${app.qaMsgType === 'question' ? 'active' : ''}" data-qa-type="question">${isTeacher() ? '问答沉淀' : '提问'}</button>
                ${isTeacher() ? `<button type="button" class="chat-type-pill ${app.qaMsgType === 'announcement' ? 'active' : ''}" data-qa-type="announcement">群公告</button>` : ''}
              </div>
              <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;position:relative">
                <label class="chat-tool-btn" id="qa-upload-btn" for="qa-file-input" title="上传图片或文件（也支持直接粘贴截图）">图片/文件</label>
                ${isTeacher() ? `<button type="button" class="chat-tool-btn" id="qa-card-btn" title="发送本课程的课次、资料或回放卡片">资源卡片</button>` : ''}
                <button type="button" class="chat-tool-btn" id="qa-at-btn" title="提醒群成员">@成员</button>
                <input type="file" id="qa-file-input" multiple style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;pointer-events:none">
              </div>
            </div>
            <div id="qa-question-meta" style="display:${app.qaMsgType === 'question' ? 'flex' : 'none'};gap:8px;align-items:center;flex-wrap:wrap">
              <select name="lessonId" id="qa-lesson-select" style="padding:4px 8px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--control);color:var(--ink);font-size:12px;max-width:220px">
                <option value="">关联课次（选填）</option>
                ${courseLessons.map(l => `<option value="${l.id}" ${qaDraft?.lessonId === l.id ? 'selected' : ''}>${esc(l.title)}</option>`).join('')}
              </select>
              <input name="refTag" id="qa-ref-input" value="${esc(qaDraft?.refTag || '')}" placeholder="题号 / 页码（选填）" style="width:150px;padding:4px 8px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--control);color:var(--ink);font-size:12px">
            </div>
            <div id="qa-pending-bar" class="chat-pending-bar"></div>
            <div class="chat-composer-input-row">
              <textarea name="content" id="qa-chat-input" rows="1" placeholder="${app.qaMsgType === 'announcement' ? '发布群公告…' : app.qaMsgType === 'question' ? (isTeacher() ? '录入典型例题或常见问答…' : '向老师提问…') : '发消息…（支持 $x^2$ 上下标）'}"></textarea>
              <button type="submit" class="primary-button" style="height:40px;padding:0 18px">发送</button>
            </div>
          </form>
        </section>
      </div>
    `}
  `;

  if (!activeCourse) {
    app.qaLiveHooks = null;
    return;
  }

  const groupListEl = shell.querySelector('#qa-group-list');
  const pinnedBarEl = shell.querySelector('#qa-pinned-bar');
  const msgListEl = shell.querySelector('#qa-msg-list');
  const msgCountEl = shell.querySelector('#qa-msg-count');
  const newPillEl = shell.querySelector('#qa-new-pill');
  const replyBannerEl = shell.querySelector('#qa-reply-banner');
  const pendingBarEl = shell.querySelector('#qa-pending-bar');
  const mentionPopEl = shell.querySelector('#qa-mention-pop');
  const chatInput = shell.querySelector('#qa-chat-input');
  const chatForm = shell.querySelector('#qa-chat-form');
  const membersBtn = shell.querySelector('#qa-members-btn');

  const mobileFilterBtn = shell.querySelector('#qa-mobile-filter-btn');
  const headFiltersEl = shell.querySelector('#qa-head-filters');
  if (mobileFilterBtn && headFiltersEl) {
    mobileFilterBtn.addEventListener('click', () => {
      app.qaMobileFiltersOpen = !app.qaMobileFiltersOpen;
      headFiltersEl.classList.toggle('is-open', app.qaMobileFiltersOpen);
      mobileFilterBtn.textContent = app.qaMobileFiltersOpen ? '收起筛选' : '筛选';
    });
  }

  chatInput.addEventListener('focus', () => {
    if (window.innerWidth <= 768) {
      setTimeout(() => {
        window.scrollTo(0, 0);
        if (msgListEl) msgListEl.scrollTop = msgListEl.scrollHeight;
      }, 180);
    }
  });

  if (qaDraft?.content) {
    chatInput.value = qaDraft.content;
  } else {
    const savedDraft = app.qaDraftByCourse.get(activeCourse.id);
    if (savedDraft) chatInput.value = savedDraft;
  }

  function autoResizeInput() {
    chatInput.style.height = 'auto';
    chatInput.style.height = `${Math.min(120, Math.max(40, chatInput.scrollHeight))}px`;
  }
  autoResizeInput();

  ensureQaMembers(activeCourse.id).then(data => {
    const total = (data.teachers?.length || 0) + (data.students?.length || 0);
    if (membersBtn && total > 0) membersBtn.textContent = `群成员 (${total})`;
  });

  function renderQaSidebar() {
    const sorted = getSortedCourses();
    groupListEl.innerHTML = sorted.map(c => {
      const posts = app.state.qaPosts.filter(p => p.course_id === c.id);
      const latest = posts[0];
      const unread = c.id === activeCourse.id ? 0 : getCourseUnreadCount(c.id);
      const unreadMentions = c.id === activeCourse.id ? 0 : getCourseUnreadMentionCount(c.id);
      const openQ = posts.filter(p => !p.recall_kind && (p.msg_type || 'chat') === 'question' && !p.resolved).length;
      return `
        <button type="button" class="chat-group-item ${c.id === activeCourse.id ? 'active' : ''}" data-qa-group="${c.id}">
          <div class="chat-group-item-top">
            <strong style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</strong>
            <span class="chat-group-item-meta">
              ${latest ? `<span class="chat-group-item-time">${esc(formatQaShortTime(getPostMs(latest), latest.created_at))}</span>` : ''}
              ${unread > 0
                ? `<span class="chat-unread-badge">${unread > 99 ? '99+' : unread}</span>`
                : (openQ > 0 ? `<span class="page-badge is-accent" title="待解答提问">${openQ}</span>` : '')}
            </span>
          </div>
          <div class="chat-group-item-preview">
            ${unreadMentions > 0 ? `<span class="chat-mention-tag">[有人@我]</span>` : ''}${latest ? `${esc(latest.author_name)}: ${esc(getQaPostPreview(latest))}` : (c.subject ? `${esc(c.subject)} · 暂无消息` : '暂无消息')}
          </div>
        </button>
      `;
    }).join('');

    groupListEl.querySelectorAll('[data-qa-group]').forEach(btn => {
      btn.addEventListener('click', () => {
        app.qaDraftByCourse.set(activeCourse.id, chatInput.value);
        app.qaCourseFilter = btn.getAttribute('data-qa-group');
        app.qaLessonFilter = '';
        app.qaReplyTargetId = '';
        app.qaPendingAttachments = [];
        app.qaPendingCard = null;
        app.qaPendingMentions = [];
        app.qaPageLimit = 40;
        app.qaPinnedExpanded = false;
        renderQa(shell);
      });
    });
  }

  function renderQaPinnedBar() {
    const pinned = app.state.qaPosts.filter(p => p.course_id === activeCourse.id && p.pinned && !p.recall_kind);
    if (!pinned.length) {
      pinnedBarEl.innerHTML = '';
      return;
    }
    const shown = app.qaPinnedExpanded ? pinned : pinned.slice(0, 1);
    pinnedBarEl.innerHTML = `
      <div class="chat-pinned-bar">
        ${shown.map(p => `
          <div class="chat-pinned-item">
            <button type="button" class="chat-pinned-link" data-jump-post="${p.id}">
              <span class="page-badge is-accent">${p.msg_type === 'announcement' ? '群公告' : '置顶'}</span>
              <span>${esc(getQaPostPreview(p))}</span>
            </button>
            <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
              ${pinned.length > 1 && shown[0].id === p.id ? `<button type="button" class="text-button" id="qa-toggle-pinned" style="font-size:11px;padding:0">${app.qaPinnedExpanded ? '收起' : `全部 ${pinned.length} 条`}</button>` : ''}
              ${isTeacher() ? `<button type="button" class="text-button" data-unpin-qa="${p.id}" style="font-size:11px;padding:0;color:var(--subtle)">取消置顶</button>` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    `;
    pinnedBarEl.querySelectorAll('[data-jump-post]').forEach(btn => {
      btn.addEventListener('click', () => focusMessageRow(btn.getAttribute('data-jump-post')));
    });
    pinnedBarEl.querySelector('#qa-toggle-pinned')?.addEventListener('click', () => {
      app.qaPinnedExpanded = !app.qaPinnedExpanded;
      renderQaPinnedBar();
    });
    pinnedBarEl.querySelectorAll('[data-unpin-qa]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          const res = await api(`/api/qa/${btn.getAttribute('data-unpin-qa')}/pin?lite=1`, { method: 'PATCH', body: { pinned: false } });
          if (res.post) upsertQaPost(res.post);
          renderQaPinnedBar();
          renderQaMessages({ keepScroll: true });
        } catch (err) { showToast(err.message, true); }
      });
    });
  }

  function renderQaReplyBanner() {
    const replyTarget = app.qaReplyTargetId ? app.state.qaPosts.find(p => p.id === app.qaReplyTargetId && p.course_id === activeCourse.id) : null;
    if (app.qaReplyTargetId && !replyTarget) app.qaReplyTargetId = '';
    if (!replyTarget) {
      replyBannerEl.innerHTML = '';
      return;
    }
    replyBannerEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 10px;border-radius:var(--radius-sm);background:var(--list-surface);font-size:12px;color:var(--muted)">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">引用回复 <strong>${esc(replyTarget.author_name)}</strong>：${esc(getQaPostPreview(replyTarget))}</span>
        <button type="button" class="text-button" id="cancel-qa-reply" style="font-size:12px;padding:0;flex-shrink:0">取消</button>
      </div>
    `;
    replyBannerEl.querySelector('#cancel-qa-reply')?.addEventListener('click', () => {
      app.qaReplyTargetId = '';
      renderQaReplyBanner();
    });
  }

  function renderQaPendingBar() {
    const parts = [];
    for (const att of app.qaPendingAttachments) {
      parts.push(`
        <span class="chat-pending-chip">
          ${att.previewUrl ? `<img src="${att.previewUrl}" alt="">` : ''}
          <span style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(att.filename)}</span>
          <button type="button" data-rm-att="${att.id}" style="background:none;border:none;color:var(--subtle);cursor:pointer;padding:0">×</button>
        </span>
      `);
    }
    if (app.qaPendingCard) {
      parts.push(`
        <span class="chat-pending-chip">
          <span class="page-badge is-accent">${qaCardTypeLabel(app.qaPendingCard.type)}</span>
          <span style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(app.qaPendingCard.title)}</span>
          <button type="button" id="qa-rm-card" style="background:none;border:none;color:var(--subtle);cursor:pointer;padding:0">×</button>
        </span>
      `);
    }
    pendingBarEl.innerHTML = parts.join('');
    pendingBarEl.querySelectorAll('[data-rm-att]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-rm-att');
        app.qaPendingAttachments = app.qaPendingAttachments.filter(a => a.id !== id);
        renderQaPendingBar();
      });
    });
    pendingBarEl.querySelector('#qa-rm-card')?.addEventListener('click', () => {
      app.qaPendingCard = null;
      renderQaPendingBar();
    });
  }

  function focusMessageRow(postId) {
    if (!postId) return;
    let row = msgListEl.querySelector(`[data-post-id="${postId}"]`);
    if (!row) {
      app.qaPageLimit = Math.max(app.qaPageLimit, app.state.qaPosts.filter(p => p.course_id === activeCourse.id).length);
      renderQaMessages({ scrollToBottom: false });
      row = msgListEl.querySelector(`[data-post-id="${postId}"]`);
    }
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('is-highlight');
    setTimeout(() => row.classList.remove('is-highlight'), 1800);
  }

  function renderQaMessages({ keepScroll = false, scrollToBottom = false, focusPostId = '' } = {}) {
    const prevScrollTop = msgListEl.scrollTop;
    const prevScrollHeight = msgListEl.scrollHeight;

    const coursePostsAll = app.state.qaPosts.filter(p => p.course_id === activeCourse.id);
    msgCountEl.textContent = `${coursePostsAll.length} 条消息`;
    const postMap = new Map(coursePostsAll.map(p => [p.id, p]));

    const kw = app.qaSearch.trim().toLowerCase();
    const filteredNewestFirst = coursePostsAll.filter(p => {
      const mType = p.msg_type || 'chat';
      if (p.recall_kind && (app.qaLessonFilter || app.qaStatusFilter || kw)) return false;
      if (app.qaLessonFilter && p.lesson_id !== app.qaLessonFilter) return false;
      if (app.qaStatusFilter === 'question' && mType !== 'question') return false;
      if (app.qaStatusFilter === 'open' && !(mType === 'question' && !p.resolved)) return false;
      if (app.qaStatusFilter === 'resolved' && !(mType === 'question' && p.resolved)) return false;
      if (app.qaStatusFilter === 'announcement' && mType !== 'announcement') return false;
      if (app.qaStatusFilter === 'media' && !(p.attachments?.length || p.card)) return false;
      if (kw) {
        const repText = app.state.qaReplies.filter(r => r.post_id === p.id).map(r => r.content).join(' ');
        const hay = `${p.author_name} ${p.title} ${p.content} ${p.ref_tag} ${p.card?.title || ''} ${repText}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });

    const hasMoreLocal = filteredNewestFirst.length > app.qaPageLimit;
    const visiblePosts = filteredNewestFirst.slice(0, app.qaPageLimit).reverse();

    if (visiblePosts.length === 0) {
      msgListEl.innerHTML = `<div class="empty-state" style="margin:auto">${kw || app.qaStatusFilter || app.qaLessonFilter ? '没有匹配的消息，试试切换筛选条件' : '群里还没有消息，在下方直接发一句话开始交流吧'}</div>`;
      return;
    }

    const chunks = [];
    if (hasMoreLocal) {
      chunks.push(`<button type="button" class="chat-load-more" id="qa-load-more">加载更早消息（还有 ${filteredNewestFirst.length - visiblePosts.length} 条）</button>`);
    }

    let lastDateLabel = '';
    for (const post of visiblePosts) {
      const ms = getPostMs(post);
      const dateLabel = formatQaDateDivider(ms, post.created_at);
      if (dateLabel !== lastDateLabel) {
        lastDateLabel = dateLabel;
        chunks.push(`<div class="chat-date-divider"><span>${esc(dateLabel)}</span></div>`);
      }

      const isSelf = isSelfPost(post);
      if (post.recall_kind) {
        const actorText = post.recall_kind === 'recall'
          ? (isSelf ? '你' : esc(post.recalled_by_name || post.author_name))
          : esc(post.recalled_by_name || '教师');
        const actionText = post.recall_kind === 'recall' ? '撤回了一条消息' : '删除了一条消息';
        const canReedit = post.recall_kind === 'recall' && isSelf && app.qaRecalledDrafts.has(post.id);
        chunks.push(`
          <div class="chat-system-notice" data-post-id="${post.id}">
            <span>${actorText}${actionText}</span>
            ${canReedit ? `<button type="button" class="qa-reedit-btn" data-reedit-qa="${post.id}">重新编辑</button>` : ''}
          </div>
        `);
        continue;
      }

      const mType = post.msg_type || 'chat';
      const replies = app.state.qaReplies.filter(r => r.post_id === post.id);
      const lesson = app.state.lessons.find(l => l.id === post.lesson_id);
      const quoted = post.reply_to_id ? postMap.get(post.reply_to_id) : null;
      const showSeparateTitle = post.title && post.content && post.title !== post.content && !post.content.startsWith(post.title);
      const canResolve = mType === 'question' && isTeacher();
      const withinRecallWindow = (Date.now() - ms) <= 2 * 60 * 1000;
      const canRecallSelf = isSelf && !isAdmin() && (app.state.currentUser.role === 'teacher' || withinRecallWindow);
      const canDeleteMsg = isAdmin() || (app.state.currentUser.role === 'teacher' && post.author_role === 'student');
      const canDelete = canRecallSelf || canDeleteMsg;
      const canBatchSelect = isTeacher() && app.qaSelectMode && canDeleteMsg;
      const images = (post.attachments || []).filter(a => a.isImage);
      const files = (post.attachments || []).filter(a => !a.isImage);
      const showInlineForm = activeThreadReplyPostId === post.id;

      chunks.push(`
        <div class="chat-msg-row ${isSelf ? 'is-self' : ''} ${mType === 'announcement' ? 'is-announcement' : ''} ${canBatchSelect ? 'is-selectable' : ''}" data-post-id="${post.id}">
          ${canBatchSelect ? `<input type="checkbox" class="chat-select-cb" data-qa-select="${post.id}" ${app.qaSelectedIds.has(post.id) ? 'checked' : ''}>` : ''}
          <div class="chat-msg-meta">
            <strong style="color:var(--ink)">${esc(post.author_name)}</strong>
            ${post.author_role !== 'student' ? `<span class="page-badge is-accent">${roleLabel(post.author_role)}</span>` : ''}
            ${mType === 'announcement' ? `<span class="status-pill is-warn">群公告</span>` : ''}
            ${mType === 'question' ? `<span class="page-badge">提问</span>` : ''}
            ${post.pinned && mType !== 'announcement' ? `<span class="page-badge">置顶</span>` : ''}
            ${lesson ? `<a href="#lesson" data-qa-open-les="${lesson.id}" class="page-badge" style="text-decoration:none">${esc(lesson.title)}</a>` : ''}
            ${post.ref_tag ? `<span class="page-badge">${esc(post.ref_tag)}</span>` : ''}
            ${mType === 'question' && post.resolved ? `<span class="status-pill is-ok">已解答</span>` : ''}
            ${mType === 'question' && !post.resolved ? `<span class="status-pill is-warn">待解答</span>` : ''}
            <span title="${esc(post.created_at)}">${esc(formatQaMsgClock(ms, post.created_at))}</span>
          </div>
          <div class="chat-bubble">
            ${quoted ? `
              <button type="button" class="chat-quote-box" data-jump-quote="${quoted.id}">
                <div style="font-weight:600;margin-bottom:2px">回复 ${esc(quoted.author_name)}</div>
                <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(getQaPostPreview(quoted))}</div>
              </button>
            ` : (post.reply_to_id ? `<div class="chat-quote-box" style="cursor:default">引用的消息已删除</div>` : '')}
            ${showSeparateTitle ? `<div style="font-weight:600;margin-bottom:4px">${esc(post.title)}</div>` : ''}
            ${post.content ? `<div class="chat-bubble-text">${renderQaTextWithMentions(post.content)}</div>` : ''}
            ${images.length ? `
              <div class="chat-att-grid">
                ${images.map(img => {
                  const url = `/api/qa/${post.id}/attachments/${img.id}`;
                  return `<img class="chat-att-img" src="${url}" alt="${esc(img.filename)}" data-preview-img="${url}" data-preview-name="${esc(img.filename)}">`;
                }).join('')}
              </div>
            ` : ''}
            ${files.map(f => {
              const url = `/api/qa/${post.id}/attachments/${f.id}?download=1`;
              return `<a class="chat-att-file" href="${url}" download="${esc(f.filename)}"><span>📎 ${esc(f.filename)}</span><span style="color:var(--subtle)">${formatSize(f.sizeBytes)}</span></a>`;
            }).join('')}
            ${post.card ? `
              <button type="button" class="chat-res-card" data-open-card-type="${esc(post.card.type)}" data-open-card-id="${esc(post.card.id)}">
                <div>
                  <div style="font-weight:600;font-size:13px">${esc(post.card.title)}</div>
                  <div style="font-size:11px;color:var(--subtle)">${esc(post.card.subtitle || '')}</div>
                </div>
                <span class="page-badge is-accent">${qaCardTypeLabel(post.card.type)}</span>
              </button>
            ` : ''}
          </div>
          ${replies.length ? `
            <div class="chat-replies">
              ${replies.map(rep => {
                const isSelfRep = Boolean(rep.author_id && rep.author_id === app.state.currentUser.linkedId && rep.author_role === app.state.currentUser.role);
                const canDelRep = isAdmin() || isSelfRep || (app.state.currentUser.role === 'teacher' && rep.author_role === 'student');
                return `
                  <div class="chat-reply-item">
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:2px">
                      <div style="display:flex;align-items:center;gap:6px">
                        <strong>${esc(rep.author_name)}</strong>
                        ${rep.author_role !== 'student' ? `<span class="page-badge is-accent">${roleLabel(rep.author_role)}</span>` : ''}
                        <span style="font-size:10px;color:var(--subtle)">${esc(rep.created_at)}</span>
                      </div>
                      ${canDelRep ? `<button type="button" data-del-rep="${rep.id}" style="background:none;border:none;color:var(--subtle);cursor:pointer;font-size:11px;padding:0">${isSelfRep && !isAdmin() ? '撤回' : '删除'}</button>` : ''}
                    </div>
                    <div class="chat-bubble-text">${renderQaTextWithMentions(rep.content)}</div>
                  </div>
                `;
              }).join('')}
            </div>
          ` : ''}
          ${showInlineForm ? `
            <form class="qa-inline-reply-form" data-inline-reply-form="${post.id}">
              <input type="text" name="content" placeholder="输入楼中楼解答/回复…" required>
              ${canResolve && !post.resolved ? `<label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--muted)"><input type="checkbox" name="markResolved" checked>标为已解答</label>` : ''}
              <button type="submit" class="primary-button btn-sm">回复</button>
              <button type="button" class="secondary-button btn-sm" data-cancel-inline-reply>取消</button>
            </form>
          ` : ''}
          <div class="chat-msg-actions">
            <button type="button" data-thread-reply="${post.id}">${mType === 'question' ? '解答此题' : '楼中楼回复'}</button>
            <button type="button" data-reply-qa="${post.id}">引用</button>
            ${canResolve ? `<button type="button" data-resolve-qa="${post.id}" data-next="${!post.resolved}">${post.resolved ? '标为待解' : '标为已解'}</button>` : ''}
            ${isTeacher() ? `<button type="button" data-pin-qa="${post.id}" data-next="${!post.pinned}">${post.pinned ? '取消置顶' : '置顶'}</button>` : ''}
            ${canDelete ? `<button type="button" data-del-qa="${post.id}" style="color:var(--danger, #dc2626)">${canRecallSelf ? '撤回' : '删除'}</button>` : ''}
          </div>
        </div>
      `);
    }

    msgListEl.innerHTML = chunks.join('');

    msgListEl.querySelector('#qa-load-more')?.addEventListener('click', () => {
      const oldH = msgListEl.scrollHeight;
      app.qaPageLimit += 40;
      renderQaMessages({ scrollToBottom: false });
      msgListEl.scrollTop = msgListEl.scrollHeight - oldH;
    });

    msgListEl.querySelectorAll('[data-qa-open-les]').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        openLessonDetailModal(a.getAttribute('data-qa-open-les'));
      });
    });

    msgListEl.querySelectorAll('[data-jump-quote]').forEach(btn => {
      btn.addEventListener('click', () => focusMessageRow(btn.getAttribute('data-jump-quote')));
    });

    msgListEl.querySelectorAll('[data-preview-img]').forEach(img => {
      img.addEventListener('click', () => openQaImagePreview(img.getAttribute('data-preview-img'), img.getAttribute('data-preview-name')));
    });

    msgListEl.querySelectorAll('[data-open-card-type]').forEach(btn => {
      btn.addEventListener('click', () => {
        const cType = btn.getAttribute('data-open-card-type');
        const cId = btn.getAttribute('data-open-card-id');
        if (cType === 'lesson') openLessonDetailModal(cId);
        else if (cType === 'material') window.open(`/api/materials/${cId}/file?download=1`, '_blank');
        else if (cType === 'recording') switchView('player', { playRecId: cId, courseId: activeCourse.id });
        else if (cType === 'vod') switchView('player', { playVodId: cId, courseId: activeCourse.id });
        else if (cType === 'homework') {
          if (isTeacher()) {
            switchView('homework', { hwCourseFilter: activeCourse.id, hwActiveId: cId });
          } else {
            const hw = (app.state.homeworks || []).find(h => h.id === cId);
            if (hw) {
              const mySub = (app.state.homeworkSubmissions || []).find(s => s.homework_id === hw.id) || null;
              openStudentSubmitModal(hw, mySub, () => updateNavCounts());
            } else {
              switchView('homework', { hwCourseFilter: activeCourse.id });
            }
          }
        }
      });
    });

    msgListEl.querySelectorAll('[data-thread-reply]').forEach(btn => {
      btn.addEventListener('click', () => {
        const pid = btn.getAttribute('data-thread-reply');
        activeThreadReplyPostId = activeThreadReplyPostId === pid ? '' : pid;
        renderQaMessages({ keepScroll: true });
        msgListEl.querySelector(`[data-inline-reply-form="${pid}"] input[name="content"]`)?.focus();
      });
    });

    msgListEl.querySelectorAll('[data-cancel-inline-reply]').forEach(btn => {
      btn.addEventListener('click', () => {
        activeThreadReplyPostId = '';
        renderQaMessages({ keepScroll: true });
      });
    });

    msgListEl.querySelectorAll('[data-inline-reply-form]').forEach(form => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pid = form.getAttribute('data-inline-reply-form');
        const fd = new FormData(form);
        const content = String(fd.get('content') || '').trim();
        const markResolved = fd.get('markResolved') === 'on';
        if (!content) return;
        try {
          const res = await api(`/api/qa/${pid}/replies?lite=1`, { method: 'POST', body: { content } });
          if (res.reply && !app.state.qaReplies.some(r => r.id === res.reply.id)) {
            app.state.qaReplies.push(res.reply);
          }
          if (markResolved) {
            const rRes = await api(`/api/qa/${pid}/resolve?lite=1`, { method: 'PATCH', body: { resolved: true } });
            if (rRes.post) upsertQaPost(rRes.post);
            updateNavCounts();
            renderQaSidebar();
          }
          activeThreadReplyPostId = '';
          renderQaMessages({ keepScroll: true });
        } catch (err) { showToast(err.message, true); }
      });
    });

    msgListEl.querySelectorAll('[data-reply-qa]').forEach(btn => {
      btn.addEventListener('click', () => {
        app.qaReplyTargetId = btn.getAttribute('data-reply-qa');
        if (app.qaMsgType !== 'chat') {
          app.qaMsgType = 'chat';
          shell.querySelectorAll('[data-qa-type]').forEach(b => b.classList.toggle('active', b.getAttribute('data-qa-type') === 'chat'));
          const qMeta = shell.querySelector('#qa-question-meta');
          if (qMeta) qMeta.style.display = 'none';
          chatInput.placeholder = '发消息…';
        }
        renderQaReplyBanner();
        chatInput.focus();
      });
    });

    msgListEl.querySelectorAll('[data-resolve-qa]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          const res = await api(`/api/qa/${btn.getAttribute('data-resolve-qa')}/resolve?lite=1`, {
            method: 'PATCH',
            body: { resolved: btn.getAttribute('data-next') === 'true' }
          });
          if (res.post) upsertQaPost(res.post);
          updateNavCounts();
          renderQaSidebar();
          renderQaMessages({ keepScroll: true });
        } catch (err) { showToast(err.message, true); }
      });
    });

    msgListEl.querySelectorAll('[data-pin-qa]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          const res = await api(`/api/qa/${btn.getAttribute('data-pin-qa')}/pin?lite=1`, {
            method: 'PATCH',
            body: { pinned: btn.getAttribute('data-next') === 'true' }
          });
          if (res.post) upsertQaPost(res.post);
          renderQaPinnedBar();
          renderQaMessages({ keepScroll: true });
        } catch (err) { showToast(err.message, true); }
      });
    });

    function syncQaBatchBar() {
      const bar = shell.querySelector('#qa-batch-bar');
      if (!bar) return;
      bar.hidden = !(isTeacher() && app.qaSelectMode);
      const cntEl = shell.querySelector('#qa-batch-count');
      if (cntEl) cntEl.innerHTML = `已选 <strong>${app.qaSelectedIds.size}</strong> 条消息`;
      const delBtn = shell.querySelector('#qa-batch-delete');
      if (delBtn) delBtn.disabled = app.qaSelectedIds.size === 0;
    }
    syncQaBatchBar();

    msgListEl.querySelectorAll('[data-qa-select]').forEach(cb => {
      cb.addEventListener('change', () => {
        const pid = cb.getAttribute('data-qa-select');
        if (cb.checked) app.qaSelectedIds.add(pid);
        else app.qaSelectedIds.delete(pid);
        syncQaBatchBar();
      });
    });

    msgListEl.querySelectorAll('[data-reedit-qa]').forEach(btn => {
      btn.addEventListener('click', () => {
        const pid = btn.getAttribute('data-reedit-qa');
        const draft = app.qaRecalledDrafts.get(pid);
        if (!draft) return;
        app.qaRecalledDrafts.delete(pid);
        if (draft.msgType === 'question') {
          app.qaMsgType = 'question';
          shell.querySelectorAll('[data-qa-type]').forEach(b => b.classList.toggle('active', b.getAttribute('data-qa-type') === 'question'));
          const qMeta = shell.querySelector('#qa-question-meta');
          if (qMeta) qMeta.style.display = 'flex';
          const lSel = shell.querySelector('#qa-lesson-select');
          if (lSel && draft.lessonId) lSel.value = draft.lessonId;
          const rInp = shell.querySelector('#qa-ref-input');
          if (rInp && draft.refTag) rInp.value = draft.refTag;
          chatInput.placeholder = '向老师提问…';
        }
        chatInput.value = draft.content || '';
        app.qaDraftByCourse.set(activeCourse.id, chatInput.value);
        autoResizeInput();
        chatInput.focus();
        renderQaMessages({ keepScroll: true });
      });
    });

    msgListEl.querySelectorAll('[data-del-qa]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-del-qa');
        const targetPost = app.state.qaPosts.find(p => p.id === id);
        const isRecallAction = Boolean(targetPost && isSelfPost(targetPost) && !isAdmin());
        if (!isRecallAction && !confirm('确认删除该条消息？')) return;
        try {
          if (isRecallAction && targetPost) {
            app.qaRecalledDrafts.set(id, {
              content: targetPost.content || '',
              msgType: targetPost.msg_type || 'chat',
              lessonId: targetPost.lesson_id || '',
              refTag: targetPost.ref_tag || ''
            });
          }
          const res = await api(`/api/qa/${id}?lite=1`, { method: 'DELETE' });
          if (res.post) upsertQaPost(res.post);
          else app.state.qaPosts = app.state.qaPosts.filter(p => p.id !== id);
          app.state.qaReplies = app.state.qaReplies.filter(r => r.post_id !== id);
          updateNavCounts();
          renderQaSidebar();
          renderQaPinnedBar();
          renderQaMessages({ keepScroll: true });
          showToast(isRecallAction ? '已撤回' : '已删除');
        } catch (err) {
          app.qaRecalledDrafts.delete(id);
          showToast(err.message, true);
        }
      });
    });

    msgListEl.querySelectorAll('[data-del-rep]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('确认删除/撤回该条回复？')) return;
        const repId = btn.getAttribute('data-del-rep');
        try {
          await api(`/api/qa/replies/${repId}?lite=1`, { method: 'DELETE' });
          app.state.qaReplies = app.state.qaReplies.filter(r => r.id !== repId);
          renderQaMessages({ keepScroll: true });
          showToast('已删除');
        } catch (err) { showToast(err.message, true); }
      });
    });

    if (focusPostId) {
      focusMessageRow(focusPostId);
    } else if (scrollToBottom) {
      msgListEl.scrollTop = msgListEl.scrollHeight;
    } else if (keepScroll) {
      const delta = msgListEl.scrollHeight - prevScrollHeight;
      msgListEl.scrollTop = Math.max(0, prevScrollTop + (prevScrollTop > 40 ? 0 : delta));
    }
  }

  app.qaLiveHooks = (type, payload) => {
    if (!document.body.contains(msgListEl)) {
      app.qaLiveHooks = null;
      return;
    }
    renderQaSidebar();
    if (type === 'post' && payload.post?.course_id === activeCourse.id) {
      const nearBottom = (msgListEl.scrollHeight - msgListEl.scrollTop - msgListEl.clientHeight) < 90;
      if (nearBottom || isSelfPost(payload.post)) {
        markCourseQaRead(activeCourse.id);
        app.qaUnseenInActive = 0;
        newPillEl.hidden = true;
        renderQaPinnedBar();
        renderQaMessages({ scrollToBottom: true });
      } else {
        app.qaUnseenInActive += 1;
        newPillEl.textContent = `有 ${app.qaUnseenInActive} 条新消息 ↓`;
        newPillEl.hidden = false;
        renderQaPinnedBar();
        renderQaMessages({ keepScroll: true });
      }
    } else if (['update', 'delete', 'reply', 'reply_delete'].includes(type)) {
      renderQaPinnedBar();
      renderQaMessages({ keepScroll: true });
    }
  };

  newPillEl.addEventListener('click', () => {
    app.qaUnseenInActive = 0;
    newPillEl.hidden = true;
    markCourseQaRead(activeCourse.id);
    renderQaSidebar();
    msgListEl.scrollTo({ top: msgListEl.scrollHeight, behavior: 'smooth' });
  });

  msgListEl.addEventListener('scroll', () => {
    if (app.qaUnseenInActive > 0 && (msgListEl.scrollHeight - msgListEl.scrollTop - msgListEl.clientHeight) < 60) {
      app.qaUnseenInActive = 0;
      newPillEl.hidden = true;
      markCourseQaRead(activeCourse.id);
      renderQaSidebar();
    }
  });

  renderQaSidebar();
  renderQaPinnedBar();
  renderQaReplyBanner();
  renderQaPendingBar();
  renderQaMessages({ scrollToBottom: !focusPostIdInit, focusPostId: focusPostIdInit });

  membersBtn.addEventListener('click', () => openQaMembersModal(activeCourse));
  shell.querySelector('#qa-select-mode-btn')?.addEventListener('click', () => {
    app.qaSelectMode = !app.qaSelectMode;
    app.qaSelectedIds.clear();
    renderQa(shell);
  });
  shell.querySelector('#qa-batch-all')?.addEventListener('click', () => {
    msgListEl.querySelectorAll('[data-qa-select]').forEach(cb => {
      cb.checked = true;
      app.qaSelectedIds.add(cb.getAttribute('data-qa-select'));
    });
    const cntEl = shell.querySelector('#qa-batch-count');
    if (cntEl) cntEl.innerHTML = `已选 <strong>${app.qaSelectedIds.size}</strong> 条消息`;
    const delBtn = shell.querySelector('#qa-batch-delete');
    if (delBtn) delBtn.disabled = app.qaSelectedIds.size === 0;
  });
  shell.querySelector('#qa-batch-cancel')?.addEventListener('click', () => {
    app.qaSelectMode = false;
    app.qaSelectedIds.clear();
    renderQa(shell);
  });
  shell.querySelector('#qa-batch-delete')?.addEventListener('click', async () => {
    if (!app.qaSelectedIds.size) return;
    if (!confirm(`确认删除选中的 ${app.qaSelectedIds.size} 条消息？`)) return;
    try {
      const ids = [...app.qaSelectedIds];
      const res = await api('/api/qa/batch-delete', {
        method: 'POST',
        body: { courseId: activeCourse.id, postIds: ids }
      });
      for (const p of (res.posts || [])) {
        upsertQaPost(p);
        app.state.qaReplies = app.state.qaReplies.filter(r => r.post_id !== p.id);
      }
      app.qaSelectedIds.clear();
      app.qaSelectMode = false;
      updateNavCounts();
      renderQa(shell);
      showToast(`已删除 ${res.count || ids.length} 条消息`);
    } catch (err) { showToast(err.message, true); }
  });

  shell.querySelector('#qa-lesson-filter').addEventListener('change', (e) => {
    app.qaLessonFilter = e.target.value;
    renderQaMessages({ scrollToBottom: true });
  });
  shell.querySelector('#qa-status-select').addEventListener('change', (e) => {
    app.qaStatusFilter = e.target.value;
    renderQaMessages({ scrollToBottom: true });
  });

  const searchInput = shell.querySelector('#qa-search-input');
  let searchComposing = false;
  let searchTimer = null;
  searchInput.addEventListener('compositionstart', () => { searchComposing = true; });
  searchInput.addEventListener('compositionend', () => {
    searchComposing = false;
    app.qaSearch = searchInput.value;
    renderQaMessages({ scrollToBottom: false });
  });
  searchInput.addEventListener('input', () => {
    if (searchComposing) return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      app.qaSearch = searchInput.value;
      renderQaMessages({ scrollToBottom: false });
    }, 150);
  });

  shell.querySelectorAll('[data-qa-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      app.qaMsgType = btn.getAttribute('data-qa-type');
      shell.querySelectorAll('[data-qa-type]').forEach(b => b.classList.toggle('active', b === btn));
      shell.querySelector('#qa-question-meta').style.display = app.qaMsgType === 'question' ? 'flex' : 'none';
      chatInput.placeholder = app.qaMsgType === 'announcement'
        ? '发布群公告…'
        : app.qaMsgType === 'question'
          ? (isTeacher() ? '录入典型例题或常见问答…' : '向老师提问…')
          : '发消息…（支持 $x^2$ 上下标）';
      chatInput.focus();
    });
  });

  const fileInput = shell.querySelector('#qa-file-input');
  const uploadBtnEl = shell.querySelector('#qa-upload-btn');
  async function uploadQaFiles(fileList) {
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return;
    if (uploadBtnEl) uploadBtnEl.textContent = '上传中…';
    try {
      for (const file of files) {
        if (app.qaPendingAttachments.length >= 9) {
          showToast('单条消息最多附加 9 个文件', true);
          break;
        }
        try {
          const filename = file.name || `screenshot_${Date.now()}.png`;
          const res = await fetch(`/api/qa/upload?courseId=${encodeURIComponent(activeCourse.id)}&filename=${encodeURIComponent(filename)}`, {
            method: 'POST',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file
          });
          const rawText = await res.text();
          let data = {};
          try { data = JSON.parse(rawText); } catch { data = { error: rawText || '上传失败' }; }
          if (!res.ok) throw new Error(data.error || '上传失败');
          if (data.isImage) data.previewUrl = URL.createObjectURL(file);
          app.qaPendingAttachments.push(data);
          renderQaPendingBar();
        } catch (err) {
          showToast(`上传失败：${err.message}`, true);
        }
      }
    } finally {
      if (uploadBtnEl) uploadBtnEl.textContent = '图片/文件';
    }
  }

  fileInput.addEventListener('change', async () => {
    await uploadQaFiles(fileInput.files);
    fileInput.value = '';
  });

  chatInput.addEventListener('paste', async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imgFiles = items.filter(it => it.type.startsWith('image/')).map(it => it.getAsFile()).filter(Boolean);
    if (imgFiles.length) {
      e.preventDefault();
      await uploadQaFiles(imgFiles);
    }
  });

  shell.querySelector('#qa-card-btn')?.addEventListener('click', () => {
    openQaCardPickerModal(activeCourse, (card) => {
      app.qaPendingCard = card;
      renderQaPendingBar();
      chatInput.focus();
    });
  });

  let mentionActiveIdx = 0;
  let mentionOptions = [];

  function closeMentionPop() {
    mentionPopEl.hidden = true;
    mentionOptions = [];
    mentionActiveIdx = 0;
  }

  async function showMentionPop(keyword = '') {
    const members = await ensureQaMembers(activeCourse.id);
    const list = [];
    if (isTeacher()) list.push({ id: 'all', name: '全体成员', role: 'all', tag: '通知全群' });
    for (const t of members.teachers || []) list.push(t);
    for (const s of members.students || []) list.push(s);
    const kw2 = keyword.trim().toLowerCase();
    mentionOptions = kw2 ? list.filter(m => m.name.toLowerCase().includes(kw2)) : list;
    if (!mentionOptions.length) {
      closeMentionPop();
      return;
    }
    mentionActiveIdx = 0;
    renderMentionPop();
  }

  function renderMentionPop() {
    mentionPopEl.innerHTML = mentionOptions.slice(0, 12).map((m, idx) => `
      <button type="button" class="chat-mention-opt ${idx === mentionActiveIdx ? 'active' : ''}" data-mention-idx="${idx}">
        <span>@${esc(m.name)}</span>
        <span style="font-size:11px;color:var(--subtle)">${esc(m.tag || '')}</span>
      </button>
    `).join('');
    mentionPopEl.hidden = false;
    mentionPopEl.querySelectorAll('[data-mention-idx]').forEach(btn => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        applyMention(mentionOptions[Number(btn.getAttribute('data-mention-idx'))]);
      });
    });
  }

  function applyMention(member) {
    if (!member) return;
    const pos = chatInput.selectionStart || chatInput.value.length;
    const before = chatInput.value.slice(0, pos);
    const after = chatInput.value.slice(pos);
    const atIdx = before.lastIndexOf('@');
    const nextBefore = atIdx >= 0 ? before.slice(0, atIdx) + `@${member.name} ` : `${before}@${member.name} `;
    chatInput.value = nextBefore + after;
    chatInput.focus();
    chatInput.setSelectionRange(nextBefore.length, nextBefore.length);
    if (!app.qaPendingMentions.some(m => m.id === member.id && m.name === member.name)) {
      app.qaPendingMentions.push({ id: member.id, name: member.name, role: member.role });
    }
    app.qaDraftByCourse.set(activeCourse.id, chatInput.value);
    autoResizeInput();
    closeMentionPop();
  }

  shell.querySelector('#qa-at-btn').addEventListener('click', () => {
    const pos = chatInput.selectionStart ?? chatInput.value.length;
    chatInput.value = `${chatInput.value.slice(0, pos)}@${chatInput.value.slice(pos)}`;
    chatInput.focus();
    chatInput.setSelectionRange(pos + 1, pos + 1);
    showMentionPop('');
  });

  chatInput.addEventListener('input', () => {
    app.qaDraftByCourse.set(activeCourse.id, chatInput.value);
    autoResizeInput();
    const pos = chatInput.selectionStart || 0;
    const before = chatInput.value.slice(0, pos);
    const match = before.match(/@([^\s@]{0,16})$/);
    if (match) showMentionPop(match[1]);
    else closeMentionPop();
  });

  chatInput.addEventListener('keydown', (e) => {
    if (!mentionPopEl.hidden && mentionOptions.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionActiveIdx = (mentionActiveIdx + 1) % Math.min(12, mentionOptions.length);
        renderMentionPop();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const len = Math.min(12, mentionOptions.length);
        mentionActiveIdx = (mentionActiveIdx - 1 + len) % len;
        renderMentionPop();
        return;
      }
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        applyMention(mentionOptions[mentionActiveIdx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMentionPop();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      chatForm.requestSubmit();
    }
  });

  if (qaDraft && chatInput) chatInput.focus();

  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = chatInput.value.trim();
    if (!content && app.qaPendingAttachments.length === 0 && !app.qaPendingCard) return;
    const lessonSelect = shell.querySelector('#qa-lesson-select');
    const refInput = shell.querySelector('#qa-ref-input');
    const lessonId = app.qaMsgType === 'question' ? String(lessonSelect?.value || '') : '';
    const refTag = app.qaMsgType === 'question' ? String(refInput?.value || '').trim() : '';
    try {
      const res = await api('/api/qa?lite=1', {
        method: 'POST',
        body: {
          courseId: activeCourse.id,
          msgType: app.qaMsgType,
          pinned: app.qaMsgType === 'announcement',
          replyToId: app.qaReplyTargetId || '',
          lessonId,
          refTag,
          mentions: app.qaPendingMentions.filter(m => content.includes(`@${m.name}`)),
          attachments: app.qaPendingAttachments.map(({ previewUrl, ...rest }) => rest),
          card: app.qaPendingCard,
          content
        }
      });
      if (res.post) upsertQaPost(res.post);
      chatInput.value = '';
      app.qaDraftByCourse.delete(activeCourse.id);
      if (refInput) refInput.value = '';
      app.qaReplyTargetId = '';
      app.qaPendingAttachments = [];
      app.qaPendingCard = null;
      app.qaPendingMentions = [];
      if (app.qaMsgType === 'announcement' || app.qaMsgType === 'question') {
        app.qaMsgType = 'chat';
        shell.querySelectorAll('[data-qa-type]').forEach(b => b.classList.toggle('active', b.getAttribute('data-qa-type') === 'chat'));
        const qMeta = shell.querySelector('#qa-question-meta');
        if (qMeta) qMeta.style.display = 'none';
        if (lessonSelect) lessonSelect.value = '';
        chatInput.placeholder = '发消息…（支持 $x^2$ 上下标）';
      }
      autoResizeInput();
      closeMentionPop();
      markCourseQaRead(activeCourse.id);
      updateNavCounts();
      renderQaSidebar();
      renderQaPinnedBar();
      renderQaReplyBanner();
      renderQaPendingBar();
      renderQaMessages({ scrollToBottom: true });
      chatInput.focus();
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

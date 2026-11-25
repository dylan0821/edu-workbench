import { esc, formatLessonTime, showToast } from './utils.js';
import {
  THEME_KEY,
  NAV_STATE_KEY,
  instanceStorageKey,
  app,
  api,
  loadState,
  isAdmin,
  isTeacher,
  roleLabel,
  stopVodWatermark,
  persistNavState,
  restoreNavState,
  applyOrgBranding,
  bindPasswordToggles,
  getTotalQaUnreadCount,
  getTotalQaUnreadMentionCount,
  openChangeOwnPasswordModal,
  registerAppHooks
} from './state.js';
import { renderOverview } from './views/overview.js';
import { renderClassroom } from './views/classroom.js';
import { renderFocusPlayer } from './views/player.js';
import { renderVod } from './views/vod.js';
import { renderQa, connectQaStream, disconnectQaStream } from './views/qa.js';
import { renderCourses, openLessonDetailModal } from './views/courses.js';
import { renderHomework } from './views/homework.js';
import {
  renderStudents,
  renderTeachers,
  renderAccounts,
  openStudentArchiveModal,
  openEditTeacherModal,
  openCourseStudentsModal
} from './views/people.js';
import { renderSettings } from './views/settings.js';
import { renderAssistant } from './views/assistant.js';

// --- 主题切换 ---
const themeSelect = document.querySelector('#theme-select');
const themeColorMeta = document.querySelector('meta[name="theme-color"]');
const darkMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme(mode) {
  const resolved = mode === 'system' ? (darkMediaQuery.matches ? 'dark' : 'light') : mode;
  document.documentElement.setAttribute('data-theme', resolved);
  if (themeColorMeta) {
    themeColorMeta.setAttribute('content', resolved === 'dark' ? '#14171f' : '#f5f7fa');
  }
}
themeSelect.addEventListener('change', () => {
  localStorage.setItem(instanceStorageKey(THEME_KEY), themeSelect.value);
  applyTheme(themeSelect.value);
});
darkMediaQuery.addEventListener('change', () => {
  if (themeSelect.value === 'system') applyTheme('system');
});

window.addEventListener('beforeunload', (e) => {
  if (app.liveIsRecording) {
    e.preventDefault();
    e.returnValue = '当前正在录制课程，离开页面将中断录制。';
  }
});

function closeMobileNav() {
  document.querySelector('#workspace')?.classList.remove('mobile-nav-open');
}

function renderStudentSidebarCourses() {
  const listEl = document.querySelector('#student-course-nav-list');
  if (!listEl || !app.state?.authenticated || isTeacher()) return;
  const courses = app.state.courses || [];
  if (!courses.length) {
    listEl.innerHTML = `<div style="padding:6px 12px;font-size:12px;color:var(--subtle)">暂无课程</div>`;
    return;
  }
  const activeCid = (app.currentView === 'courses' && app.courseTab === 'catalog' && app.outlineCourseId)
    ? app.outlineCourseId
    : (app.currentView === 'player' ? (app.activePlayerTarget?.courseId || '') : '');
  listEl.innerHTML = courses.map(c => {
    const isAct = c.id === activeCid;
    return `
      <button type="button" class="nav-link ${isAct ? 'active' : ''}" data-stu-course="${c.id}" title="${esc(c.name)}">
        <span class="nav-link-main" style="min-width:0;flex:1">
          <svg class="icon" style="flex-shrink:0"><use href="#i-book"/></svg>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</span>
        </span>
      </button>
    `;
  }).join('');
  listEl.querySelectorAll('[data-stu-course]').forEach(btn => {
    btn.addEventListener('click', () => {
      closeMobileNav();
      app.outlineSearch = '';
      app.outlineTypeFilter = '';
      switchView('courses', { tab: 'catalog', outlineCourseId: btn.getAttribute('data-stu-course') });
    });
  });
}

function updateNavCounts() {
  const state = app.state;
  if (!state?.authenticated) return;
  applyOrgBranding();
  document.querySelector('#nav-count-lessons').textContent = state.lessons.length;
  const stuLesBadge = document.querySelector('#nav-count-stu-lessons');
  if (stuLesBadge) stuLesBadge.textContent = state.lessons.length;
  const liveDot = document.querySelector('#nav-live-dot');
  if (liveDot) {
    const liveLessons = (state.lessons || []).filter(l => l.status === 'in_progress');
    liveDot.hidden = isTeacher() || liveLessons.length === 0;
    if (liveLessons.length > 0) {
      liveDot.title = `正在上课：${liveLessons.map(l => l.title).join('、')}`;
    }
  }
  document.querySelector('#nav-count-materials').textContent = state.materials.length;
  document.querySelector('#nav-count-courses').textContent = state.courses.length;
  const hwCount = (state.homeworks || []).length;
  const hwBadge = document.querySelector('#nav-count-homework');
  if (hwBadge) hwBadge.textContent = hwCount;
  const stuHwBadge = document.querySelector('#nav-count-stu-homework');
  if (stuHwBadge) {
    const subHwIds = new Set((state.homeworkSubmissions || []).map(s => s.homework_id));
    const pendingCnt = (state.homeworks || []).filter(h => !subHwIds.has(h.id)).length;
    stuHwBadge.textContent = pendingCnt > 0 ? pendingCnt : hwCount;
  }
  document.querySelector('#nav-count-students').textContent = state.students.length;
  const tchBadge = document.querySelector('#nav-count-teachers');
  if (tchBadge) tchBadge.textContent = state.teachers.length;
  const accBadge = document.querySelector('#nav-count-accounts');
  if (accBadge) accBadge.textContent = state.accounts.length;
  document.querySelector('#nav-count-vod').textContent = state.recordings.length + state.vodLessons.length;
  const totalQaUnread = getTotalQaUnreadCount();
  const totalQaMentions = getTotalQaUnreadMentionCount();
  const openQaQuestions = state.qaPosts.filter(p => !p.recall_kind && (p.msg_type || 'chat') === 'question' && !p.resolved).length;
  const qaBadge = document.querySelector('#nav-count-qa');
  if (qaBadge) {
    if (totalQaMentions > 0) {
      qaBadge.textContent = `@${totalQaMentions > 9 ? '9+' : totalQaMentions}`;
      qaBadge.classList.add('is-unread');
      qaBadge.title = `有 ${totalQaMentions} 条消息 @了你，共 ${totalQaUnread} 条未读`;
    } else if (totalQaUnread > 0) {
      qaBadge.textContent = totalQaUnread > 99 ? '99+' : String(totalQaUnread);
      qaBadge.classList.add('is-unread');
      qaBadge.title = `有 ${totalQaUnread} 条未读消息`;
    } else {
      qaBadge.textContent = String(openQaQuestions);
      qaBadge.classList.remove('is-unread');
      qaBadge.title = '';
    }
  }
  const toggleBtn = document.querySelector('#sidebar-toggle');
  if (toggleBtn) toggleBtn.classList.toggle('has-unread-dot', totalQaUnread > 0 || totalQaMentions > 0);
  renderStudentSidebarCourses();
}

function syncSidebarActive() {
  const activeKey = app.currentView === 'courses'
    ? app.courseTab
    : app.currentView === 'settings'
      ? `settings-${app.settingsTab || 'org'}`
      : app.currentView;
  const inCourses = app.currentView === 'courses' || (app.currentView === 'homework' && isTeacher());
  const inAccounts = app.currentView === 'students' || app.currentView === 'teachers' || app.currentView === 'accounts';
  const inSettings = app.currentView === 'settings';
  document.querySelectorAll('.nav-link[data-view], .nav-sublink[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-view') === activeKey);
  });
  const accordions = [
    { active: inCourses, toggle: '#nav-courses-toggle', menu: '#nav-courses-submenu' },
    { active: inAccounts, toggle: '#nav-accounts-toggle', menu: '#nav-accounts-submenu' },
    { active: inSettings, toggle: '#nav-settings-toggle', menu: '#nav-settings-submenu' }
  ];
  for (const acc of accordions) {
    const parentBtn = document.querySelector(acc.toggle);
    const subMenu = document.querySelector(acc.menu);
    if (parentBtn) parentBtn.classList.toggle('has-active', acc.active);
    if (acc.active && parentBtn && subMenu) {
      parentBtn.classList.add('is-open');
      parentBtn.setAttribute('aria-expanded', 'true');
      subMenu.hidden = false;
    }
  }
  renderStudentSidebarCourses();
}

function switchView(view, opts = {}) {
  if (view === 'schedule' || view === 'materials' || view === 'catalog') {
    opts = { ...opts, tab: view };
    view = 'courses';
  } else if (view === 'settings-org' || view === 'settings-defaults' || view === 'settings-data' || view === 'settings-ai') {
    app.settingsTab = view.slice('settings-'.length);
    view = 'settings';
  }
  if (app.state?.authenticated && !isTeacher()) {
    if (view === 'vod') {
      if (opts.playVodId || opts.playRecId) view = 'player';
      else { view = 'courses'; opts = { ...opts, tab: 'catalog' }; }
    } else if (view === 'courses' && opts.tab === 'materials') {
      opts = { ...opts, tab: 'catalog' };
    }
  }
  if (app.liveIsRecording && (view !== 'classroom' || (opts.lessonId && opts.lessonId !== app.activeClassroomLessonId))) {
    if (!confirm('当前正在录制课程，离开课堂将立即结束并保存录制，确认离开？')) return;
  }
  if (app.liveCleanup && view !== 'classroom') {
    app.liveCleanup();
    app.liveCleanup = null;
  }
  if (view !== 'vod' && view !== 'player') stopVodWatermark();

  const ws = document.querySelector('#workspace');
  if (ws && app.state?.authenticated && !isTeacher() && window.innerWidth > 768) {
    const isFocus = view === 'player' || view === 'classroom';
    if (isFocus) {
      if (app.sidebarCollapsedBeforeFocus === null) {
        app.sidebarCollapsedBeforeFocus = ws.classList.contains('nav-collapsed');
      }
      ws.classList.add('nav-collapsed');
    } else if (app.sidebarCollapsedBeforeFocus !== null) {
      ws.classList.toggle('nav-collapsed', app.sidebarCollapsedBeforeFocus);
      app.sidebarCollapsedBeforeFocus = null;
    }
  }

  app.currentView = view;
  if (view === 'classroom' && app.state?.authenticated && !isTeacher()) {
    app.liveSideTab = 'outline';
  }
  if (opts.tab) app.courseTab = opts.tab;
  if (opts.outlineCourseId !== undefined) app.outlineCourseId = opts.outlineCourseId;
  else if (opts.tab === 'catalog') app.outlineCourseId = '';
  app.showCreatePanel = false;
  app.showBatchPanel = false;
  app.editingLessonId = null;
  app.editingCourseId = null;
  app.editingClassId = null;
  if (opts.lessonId) app.activeClassroomLessonId = opts.lessonId;
  if (opts.playRecId) {
    app.pendingVodPlay = { type: 'recording', id: opts.playRecId };
    app.activePlayerTarget = { type: 'recording', id: opts.playRecId, courseId: opts.courseId || '' };
  }
  if (opts.playVodId) {
    app.pendingVodPlay = { type: 'vod', id: opts.playVodId };
    app.activePlayerTarget = { type: 'vod', id: opts.playVodId, courseId: opts.courseId || '' };
  }
  if (opts.qaDraft) app.pendingQaDraft = opts.qaDraft;
  if (opts.qaFocusPostId) app.pendingQaFocusPostId = opts.qaFocusPostId;
  if (opts.openCreate) app.showCreatePanel = true;
  if (opts.preselectClassCourseId !== undefined) app.preselectClassCourseId = opts.preselectClassCourseId;
  if (opts.preselectLessonClassId !== undefined) app.preselectLessonClassId = opts.preselectLessonClassId;
  if (opts.hwCourseFilter !== undefined) app.hwCourseFilter = opts.hwCourseFilter;
  if (opts.hwActiveId !== undefined) app.hwActiveId = opts.hwActiveId;
  if (opts.hwStatusFilter !== undefined) app.hwStatusFilter = opts.hwStatusFilter;
  if (opts.hwSearch !== undefined) app.hwSearch = opts.hwSearch;
  if (opts.pendingRecordingId) app.pendingRecordingFocusId = opts.pendingRecordingId;
  syncSidebarActive();
  const shell = document.querySelector('#page-shell');
  if (shell) {
    shell.classList.remove('is-view-entering');
    void shell.offsetWidth;
    shell.classList.add('is-view-entering');
  }
  renderView();
}

function renderView() {
  if (!app.state?.authenticated) return;
  persistNavState();
  syncSidebarActive();
  updateNavCounts();
  const shell = document.querySelector('#page-shell');
  const ws = document.querySelector('.workspace');
  const isQa = app.currentView === 'qa';
  const isPlayer = app.currentView === 'player';
  const isAssistant = app.currentView === 'assistant';
  if (shell) {
    shell.classList.toggle('is-qa-view', isQa);
    shell.classList.toggle('is-player-view', isPlayer);
    shell.classList.toggle('is-assistant-view', isAssistant);
  }
  if (ws) {
    ws.classList.toggle('is-qa-view', isQa);
    ws.classList.toggle('is-assistant-view', isAssistant);
  }
  if (app.currentView === 'overview') return renderOverview(shell);
  if (app.currentView === 'classroom') return renderClassroom(shell);
  if (app.currentView === 'player') return renderFocusPlayer(shell);
  if (app.currentView === 'vod') return isTeacher() ? renderVod(shell) : renderCourses(shell);
  if (app.currentView === 'qa') return renderQa(shell);
  if (app.currentView === 'courses') return renderCourses(shell);
  if (app.currentView === 'homework') return renderHomework(shell);
  if (app.currentView === 'students') return renderStudents(shell);
  if (app.currentView === 'teachers') return renderTeachers(shell);
  if (app.currentView === 'accounts') return renderAccounts(shell);
  if (app.currentView === 'assistant') return isAdmin() ? renderAssistant(shell) : renderOverview(shell);
  if (app.currentView === 'settings') return renderSettings(shell);
}

let renderedInstanceKey;
function renderAuthOrApp() {
  const themeKey = instanceStorageKey(THEME_KEY);
  if (renderedInstanceKey !== themeKey) {
    const switchedInstance = renderedInstanceKey !== undefined;
    renderedInstanceKey = themeKey;
    themeSelect.value = localStorage.getItem(themeKey) || 'light';
    applyTheme(themeSelect.value);
    if (switchedInstance || app.state?.needsSetup) {
      app.currentView = 'overview';
      history.replaceState(null, '', '#overview');
    } else {
      restoreNavState();
    }
  }
  const authScreen = document.querySelector('#auth-screen');
  const appShell = document.querySelector('#app-shell');
  applyOrgBranding();

  if (!app.state?.authenticated) {
    stopVodWatermark();
    if (app.liveCleanup) { app.liveCleanup(); app.liveCleanup = null; }
    disconnectQaStream();
    authScreen.hidden = false;
    appShell.hidden = true;
    document.querySelector('#setup-panel').hidden = !app.state?.needsSetup;
    document.querySelector('#login-panel').hidden = Boolean(app.state?.needsSetup);
    bindPasswordToggles(authScreen);
    return;
  }

  connectQaStream();
  authScreen.hidden = true;
  appShell.hidden = false;

  document.querySelectorAll('.teacher-only').forEach(el => { el.hidden = !isAdmin(); });
  document.querySelectorAll('.staff-only').forEach(el => { el.hidden = !isTeacher(); });
  document.querySelectorAll('.student-only').forEach(el => { el.hidden = isTeacher(); });
  document.querySelector('#nav-label-courses').textContent = isAdmin() ? '课程管理' : '我的课程';
  const catLbl = document.querySelector('#nav-label-catalog');
  if (catLbl) catLbl.textContent = isTeacher() ? '课程列表' : '课程内容';
  document.querySelector('#nav-label-schedule').textContent = isAdmin() ? '课表排课' : '我的课表';
  document.querySelector('#current-user-pill').innerHTML =
    `<span class="account-role">${roleLabel(app.state.currentUser.role)}</span><span>${esc(app.state.currentUser.name)}</span>`;

  if (!isAdmin() && ['students', 'teachers', 'accounts', 'settings'].includes(app.currentView)) {
    app.currentView = 'overview';
  }
  updateNavCounts();
  renderView();
}

registerAppHooks({
  renderView,
  updateNavCounts,
  switchView,
  renderAuthOrApp,
  openLessonDetailModal,
  openStudentArchiveModal,
  openEditTeacherModal,
  openCourseStudentsModal
});

// --- 全局顶栏搜索 (⌘K / Ctrl+K) ---
(function setupGlobalSearch() {
  const box = document.querySelector('#global-search-box');
  const input = document.querySelector('#global-search-input');
  const pop = document.querySelector('#global-search-suggestions');
  if (!box || !input || !pop) return;

  function buildSuggestions(q) {
    const st = app.state;
    if (!st?.authenticated || !q) return [];
    const kw = q.toLowerCase();
    const out = [];
    for (const c of (st.courses || [])) {
      if (`${c.name} ${c.subject || ''}`.toLowerCase().includes(kw)) {
        out.push({ title: c.name, badge: '课程', action: () => switchView('courses', { tab: 'catalog', outlineCourseId: c.id }) });
      }
    }
    for (const l of (st.lessons || [])) {
      if (`${l.title} ${l.course_name || ''}`.toLowerCase().includes(kw)) {
        out.push({ title: `${l.title} (${formatLessonTime(l.start_ms, l.end_ms)})`, badge: '课次', action: () => openLessonDetailModal(l.id) });
      }
    }
    if (isAdmin()) {
      for (const s of (st.students || [])) {
        if (`${s.name} ${s.phone || ''} ${s.grade || ''}`.toLowerCase().includes(kw)) {
          out.push({ title: `${s.name}${s.grade ? ` · ${s.grade}` : ''}`, badge: '学生', action: () => openStudentArchiveModal(s.id, 'profile') });
        }
      }
    }
    for (const m of (st.materials || [])) {
      if (`${m.filename} ${m.category || ''}`.toLowerCase().includes(kw)) {
        out.push({ title: m.filename, badge: '资料', action: () => window.open(`/api/materials/${m.id}/file`, '_blank') });
      }
    }
    for (const v of (st.vodLessons || [])) {
      if (`${v.title} ${v.chapter_name || ''}`.toLowerCase().includes(kw)) {
        out.push({ title: v.title, badge: '录播', action: () => switchView('player', { playVodId: v.id, courseId: v.course_id }) });
      }
    }
    for (const r of (st.recordings || [])) {
      if (`${r.title} ${r.lesson_title || ''}`.toLowerCase().includes(kw)) {
        out.push({ title: `${r.lesson_title} · ${r.title}`, badge: '回放', action: () => switchView('player', { playRecId: r.id }) });
      }
    }
    return out.slice(0, 10);
  }

  let items = [];
  function renderPop() {
    const q = input.value.trim();
    if (!q) { pop.hidden = true; return; }
    items = buildSuggestions(q);
    if (!items.length) {
      pop.innerHTML = `<div style="padding:10px;font-size:12px;color:var(--subtle);text-align:center">无匹配结果</div>`;
      pop.hidden = false;
      return;
    }
    pop.innerHTML = items.map((it, idx) => `
      <button type="button" class="search-suggestion" data-gs-idx="${idx}">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.title)}</span>
        <small>${esc(it.badge)}</small>
      </button>
    `).join('');
    pop.hidden = false;
    pop.querySelectorAll('[data-gs-idx]').forEach(btn => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const item = items[Number(btn.getAttribute('data-gs-idx'))];
        pop.hidden = true;
        input.value = '';
        item?.action();
      });
    });
  }

  input.addEventListener('input', renderPop);
  input.addEventListener('focus', () => { if (input.value.trim()) renderPop(); });
  input.addEventListener('blur', () => { setTimeout(() => { pop.hidden = true; }, 140); });
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      if (!app.state?.authenticated) return;
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
})();

// --- 认证表单 ---
document.querySelector('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.querySelector('#auth-error');
  errEl.hidden = true;
  try {
    app.state = await api('/api/setup', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    renderAuthOrApp();
    showToast('管理员账号已创建');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

document.querySelector('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.querySelector('#auth-error');
  errEl.hidden = true;
  try {
    app.state = await api('/api/login', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset();
    renderAuthOrApp();
    showToast(`欢迎，${app.state.currentUser.name}`);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

document.querySelector('#logout-btn').addEventListener('click', async () => {
  if (app.liveCleanup) { app.liveCleanup(); app.liveCleanup = null; }
  try {
    sessionStorage.removeItem(instanceStorageKey(NAV_STATE_KEY));
    history.replaceState(null, '', '#overview');
  } catch {}
  app.currentView = 'overview';
  app.outlineCourseId = '';
  app.matCourseFilter = '';
  app.qaCourseFilter = '';
  app.state = await api('/api/logout', { method: 'POST' });
  renderAuthOrApp();
  showToast('已退出登录');
});

document.querySelector('#current-user-pill').addEventListener('click', () => {
  if (app.state?.authenticated) openChangeOwnPasswordModal();
});

document.querySelectorAll('.nav-link[data-view], .nav-sublink[data-view]').forEach(btn => {
  btn.addEventListener('click', () => {
    closeMobileNav();
    switchView(btn.getAttribute('data-view'));
  });
});

for (const [toggleSel, menuSel] of [
  ['#nav-courses-toggle', '#nav-courses-submenu'],
  ['#nav-accounts-toggle', '#nav-accounts-submenu'],
  ['#nav-settings-toggle', '#nav-settings-submenu']
]) {
  const toggleBtn = document.querySelector(toggleSel);
  const submenu = document.querySelector(menuSel);
  if (toggleBtn && submenu) {
    toggleBtn.addEventListener('click', () => {
      const nextOpen = submenu.hidden;
      submenu.hidden = !nextOpen;
      toggleBtn.classList.toggle('is-open', nextOpen);
      toggleBtn.setAttribute('aria-expanded', String(nextOpen));
    });
  }
}

document.querySelector('#mobile-nav-backdrop').addEventListener('click', closeMobileNav);
document.querySelector('#brand-home').addEventListener('click', (e) => { e.preventDefault(); closeMobileNav(); switchView('overview'); });
document.querySelector('#sidebar-toggle').addEventListener('click', () => {
  const ws = document.querySelector('#workspace');
  if (window.innerWidth <= 768) ws.classList.toggle('mobile-nav-open');
  else ws.classList.toggle('nav-collapsed');
});
document.querySelector('#refresh-btn').addEventListener('click', () => { loadState(); showToast('已刷新'); });

const modalEl = document.querySelector('#modal');
document.querySelector('#modal-close').addEventListener('click', () => modalEl.close());
modalEl.addEventListener('click', (e) => { if (e.target === modalEl) modalEl.close(); });

// 手机端 visualViewport 适配
(function setupMobileViewportSync() {
  const vv = window.visualViewport;
  if (!vv) return;
  let baseHeight = Math.max(window.innerHeight, vv.height);
  function syncViewport() {
    if (window.innerWidth > 768) {
      document.documentElement.style.removeProperty('--vv-height');
      document.body.classList.remove('is-kbd-open');
      return;
    }
    if (vv.height > baseHeight) baseHeight = vv.height;
    const kbdOpen = (baseHeight - vv.height) > 120;
    document.documentElement.style.setProperty('--vv-height', `${Math.round(vv.height)}px`);
    document.body.classList.toggle('is-kbd-open', kbdOpen);
    if (app.currentView === 'qa' || app.currentView === 'assistant') {
      if (vv.offsetTop > 0) window.scrollTo(0, 0);
      const list = document.querySelector(app.currentView === 'qa' ? '#qa-msg-list' : '#assistant-msg-list');
      if (kbdOpen && list) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
    }
  }
  vv.addEventListener('resize', syncViewport);
  vv.addEventListener('scroll', syncViewport);
  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      baseHeight = Math.max(window.innerHeight, vv.height);
      syncViewport();
    }, 200);
  });
  syncViewport();
})();

loadState();

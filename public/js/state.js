import { esc, formatDuration, showToast, openModal } from './utils.js';

export const THEME_KEY = 'workbench-theme';
export const NAV_STATE_KEY = 'workbench-nav-state';
export const PLAYBACK_RATE_KEY = 'workbench-playback-rate';
let dataInstance = 'original';

export function instanceStorageKey(key) {
  return dataInstance === 'original' ? key : `${key}:${dataInstance}`;
}
export const VALID_VIEWS = new Set([
  'overview', 'classroom', 'vod', 'player', 'qa',
  'courses', 'homework', 'students', 'teachers', 'accounts', 'assistant', 'settings'
]);
export const VALID_COURSE_TABS = new Set(['schedule', 'materials', 'catalog']);

// 集中管理前端状态，避免模块间循环赋值问题
export const app = {
  state: null,
  currentView: 'overview',
  showCreatePanel: false,
  showBatchPanel: false,
  editingLessonId: null,
  editingCourseId: null,
  editingClassId: null,
  preselectClassCourseId: '',
  preselectLessonClassId: '',
  expandedWithdrawnClasses: new Set(),
  activeClassroomLessonId: null,
  liveCleanup: null,
  liveIsRecording: false,
  vodKeydownCleanup: null,
  pendingQaDraft: null,
  vodSearch: '',
  vodCourseFilter: '',
  vodStatusFilter: '',
  pendingRecordingFocusId: '',
  collapsedVodGroups: new Set(),

  stuSearch: '',
  stuStatus: '',
  courseSearch: '',
  courseModeFilter: '',
  courseSubjectFilter: '',
  outlineCourseId: '',
  outlineSearch: '',
  outlineTypeFilter: '',
  collapsedOutlineNodes: new Set(),
  preselectLessonDate: '',
  qaMobileFiltersOpen: false,
  clsSearch: '',
  clsCourseFilter: '',
  clsTeacherFilter: '',
  lesFilterType: 'all',
  lesFilterTarget: '',
  lesFilterStatus: '',
  lesCourseFilter: '',
  lesTimeFilter: 'upcoming',
  lesSearch: '',
  lesViewMode: 'list',
  lesWeekOffset: 0,
  matFilterScope: '',
  matCourseFilter: '',
  matCatFilter: '',
  matSearch: '',
  matSelectedIds: new Set(),
  uploadScope: 'lesson',

  qaCourseFilter: '',
  qaStatusFilter: '',
  qaLessonFilter: '',
  qaReplyTargetId: '',
  qaSearch: '',
  qaMsgType: 'chat',
  qaPendingAttachments: [],
  qaPendingCard: null,
  qaPendingMentions: [],
  qaPageLimit: 40,
  qaPinnedExpanded: false,
  qaUnseenInActive: 0,
  pendingQaFocusPostId: '',
  qaDraftByCourse: new Map(),
  qaRecalledDrafts: new Map(),
  qaSelectMode: false,
  qaSelectedIds: new Set(),
  qaMembersCache: new Map(),
  qaEventSource: null,
  qaLiveHooks: null,

  vodUploadTab: 'vod',
  vodViewTab: 'all',
  pendingVodPlay: null,
  activePlayerTarget: null,
  playerOutlineCollapsed: false,
  sidebarCollapsedBeforeFocus: null,
  liveSideTab: 'roster',
  courseTab: 'schedule',
  hwCourseFilter: '',
  hwStatusFilter: '',
  hwSearch: '',
  hwActiveId: '',
  tchSearch: '',
  tchRoleFilter: '',
  settingsTab: 'org',
  settingsAccRoleFilter: '',
  settingsAccSearch: '',
  settingsStorageStats: null,
  settingsBackups: null,
  settingsIceAdvanced: false,
  pendingAssistantConvId: '',

  vodWatermarkTimer: null,
  vodWatermarkObserver: null,
  vodPlaybackCleanup: null,

  assistant: {
    conversations: [],
    activeId: '',
    messages: [],
    pendingAttachments: [],
    loaded: false,
    sending: false,
    mode: 'task',
    status: null,
    es: null,
    mutated: false
  }
};

// 回调注册表，解除视图模块与主入口的循环依赖
const hooks = {
  renderView: () => {},
  updateNavCounts: () => {},
  switchView: () => {},
  renderAuthOrApp: () => {},
  openLessonDetailModal: () => {},
  openStudentArchiveModal: () => {},
  openEditTeacherModal: () => {},
  openCourseStudentsModal: () => {}
};

export function registerAppHooks(partial) {
  Object.assign(hooks, partial);
}
export function renderView() { return hooks.renderView(); }
export function updateNavCounts() { return hooks.updateNavCounts(); }
export function switchView(view, opts = {}) { return hooks.switchView(view, opts); }
export function renderAuthOrApp() { return hooks.renderAuthOrApp(); }
export function openLessonDetailModal(lessonId, tab, recordingOutcome) {
  return hooks.openLessonDetailModal(lessonId, tab, recordingOutcome);
}
export function openStudentArchiveModal(studentId, tab) { return hooks.openStudentArchiveModal(studentId, tab); }
export function openEditTeacherModal(teacher) { return hooks.openEditTeacherModal(teacher); }
export function openCourseStudentsModal(courseId) { return hooks.openCourseStudentsModal(courseId); }

export function isAdmin() {
  return app.state?.currentUser?.role === 'admin';
}
export function isTeacher() {
  return app.state?.currentUser?.role === 'admin' || app.state?.currentUser?.role === 'teacher';
}
export function roleLabel(role) {
  if (role === 'admin') return '管理员';
  if (role === 'teacher') return '教师';
  return '学生';
}
export function roleBadgeClass(role) {
  if (role === 'admin') return 'is-role-admin';
  if (role === 'teacher') return 'is-role-teacher';
  return 'is-role-student';
}

export function stopVodWatermark() {
  if (app.vodPlaybackCleanup) { app.vodPlaybackCleanup(); app.vodPlaybackCleanup = null; }
  if (app.vodWatermarkTimer) { clearInterval(app.vodWatermarkTimer); app.vodWatermarkTimer = null; }
  if (app.vodWatermarkObserver) { app.vodWatermarkObserver.disconnect(); app.vodWatermarkObserver = null; }
  if (app.vodKeydownCleanup) { app.vodKeydownCleanup(); app.vodKeydownCleanup = null; }
}

export function probeVideoDuration(file) {
  return new Promise((resolve) => {
    if (!file) return resolve(0);
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    let settled = false;
    const done = (sec) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(sec) && sec > 0 ? Math.round(sec) : 0);
    };
    v.onloadedmetadata = () => done(v.duration);
    v.onerror = () => done(0);
    setTimeout(() => done(0), 5000);
    v.src = url;
  });
}

export function uploadMediaWithProgress(url, file, { contentType, onProgress } = {}) {
  let xhr = null;
  const promise = new Promise((resolve, reject) => {
    xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', contentType || file.type || 'application/octet-stream');
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && typeof onProgress === 'function') {
        onProgress(Math.min(100, Math.round((ev.loaded / ev.total) * 100)), ev.loaded, ev.total);
      }
    };
    xhr.onload = () => {
      let json = null;
      try { json = JSON.parse(xhr.responseText || '{}'); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(json);
      else reject(new Error(json?.error || `上传失败 (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('网络异常，上传中断'));
    xhr.onabort = () => reject(new Error('已取消上传'));
    xhr.send(file);
  });
  return { promise, abort: () => xhr?.abort() };
}

export function parseOrgIceServers() {
  const defaults = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'stun:stun.qq.com:3478' }
  ];
  const raw = app.state?.org?.ice_servers_json;
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {}
  return defaults;
}

export function buildNavHash() {
  const params = new URLSearchParams();
  if (app.currentView === 'courses') {
    params.set('tab', app.courseTab || 'schedule');
    if (app.courseTab === 'catalog' && app.outlineCourseId) params.set('course', app.outlineCourseId);
    if (app.courseTab === 'materials' && app.matCourseFilter) params.set('course', app.matCourseFilter);
  } else if (app.currentView === 'qa' && app.qaCourseFilter) {
    params.set('course', app.qaCourseFilter);
  } else if (app.currentView === 'classroom' && app.activeClassroomLessonId) {
    params.set('lesson', app.activeClassroomLessonId);
  } else if (app.currentView === 'player' && app.activePlayerTarget) {
    params.set('type', app.activePlayerTarget.type);
    params.set('id', app.activePlayerTarget.id);
    if (app.activePlayerTarget.courseId) params.set('course', app.activePlayerTarget.courseId);
  } else if (app.currentView === 'settings' && app.settingsTab && app.settingsTab !== 'org') {
    params.set('tab', app.settingsTab);
  } else if (app.currentView === 'vod' && app.vodViewTab && app.vodViewTab !== 'all') {
    params.set('tab', app.vodViewTab);
  } else if (app.currentView === 'assistant' && app.assistant?.activeId) {
    params.set('conv', app.assistant.activeId);
  }
  const q = params.toString();
  return `#${app.currentView}${q ? `?${q}` : ''}`;
}

export function persistNavState() {
  if (!app.state?.authenticated) return;
  const hash = buildNavHash();
  if (location.hash !== hash) {
    try { history.replaceState(null, '', hash); } catch {}
  }
  try {
    sessionStorage.setItem(instanceStorageKey(NAV_STATE_KEY), hash);
  } catch {}
}

export function restoreNavState() {
  let raw = (location.hash || '').trim();
  if (!raw || raw === '#') {
    try { raw = sessionStorage.getItem(instanceStorageKey(NAV_STATE_KEY)) || ''; } catch {}
  }
  if (!raw || !raw.startsWith('#')) return;
  const body = raw.slice(1);
  const qIdx = body.indexOf('?');
  const view = qIdx >= 0 ? body.slice(0, qIdx) : body;
  const params = new URLSearchParams(qIdx >= 0 ? body.slice(qIdx + 1) : '');
  if (!VALID_VIEWS.has(view)) return;
  app.currentView = view;
  if (view === 'classroom' && app.state?.authenticated && !isTeacher()) {
    app.liveSideTab = 'outline';
  }
  if (view === 'courses') {
    const tab = params.get('tab');
    if (VALID_COURSE_TABS.has(tab)) app.courseTab = tab;
    const cid = params.get('course') || '';
    if (app.courseTab === 'catalog') app.outlineCourseId = cid;
    else if (app.courseTab === 'materials') app.matCourseFilter = cid;
  } else if (view === 'qa') {
    app.qaCourseFilter = params.get('course') || '';
  } else if (view === 'classroom') {
    const lid = params.get('lesson') || '';
    if (lid) app.activeClassroomLessonId = lid;
  } else if (view === 'player') {
    const type = params.get('type') || '';
    const id = params.get('id') || '';
    const courseId = params.get('course') || '';
    if ((type === 'vod' || type === 'recording') && id) {
      app.activePlayerTarget = { type, id, courseId };
    }
  } else if (view === 'settings') {
    const tab = params.get('tab') || '';
    if (tab === 'people') app.currentView = 'teachers';
    else if (['org', 'defaults', 'data', 'ai'].includes(tab)) app.settingsTab = tab;
  } else if (view === 'vod') {
    const tab = params.get('tab') || '';
    if (['all', 'vod', 'rec'].includes(tab)) app.vodViewTab = tab;
  } else if (view === 'assistant') {
    const convId = params.get('conv') || '';
    if (convId) app.pendingAssistantConvId = convId;
  }
}

export async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: options.rawBody ? (options.headers || {}) : { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.rawBody ? options.rawBody : (options.body ? JSON.stringify(options.body) : undefined)
  });
  const json = await res.json();
  if (res.status === 401 && app.state?.authenticated && url !== '/api/login' && url !== '/api/setup') {
    stopVodWatermark();
    const player = document.querySelector('#main-vod-player');
    if (player) player.pause();
    app.state = { authenticated: false, needsSetup: false, org: app.state.org };
    renderAuthOrApp();
    showToast('账号已在其他设备登录，请重新登录', true);
    throw new Error('登录已失效');
  }
  if (!res.ok) throw Object.assign(new Error(json.error || '操作失败'), { status: res.status });
  return json;
}

export async function loadState() {
  try {
    app.state = await api('/api/state');
    dataInstance = app.state.dataInstance || 'original';
    renderAuthOrApp();
  } catch {
    document.querySelector('#auth-screen').hidden = false;
    document.querySelector('#app-shell').hidden = true;
    const errEl = document.querySelector('#auth-error');
    errEl.textContent = '无法连接本地服务，请先运行 npm start 启动服务。';
    errEl.hidden = false;
  }
}

export function applyOrgBranding() {
  const orgName = app.state?.org?.name || '教培工作台';
  const logoName = app.state?.org?.logo_stored_name || '';
  const logoSrc = logoName ? `/api/org/logo?v=${encodeURIComponent(logoName)}` : '/public/logo.jpg';
  document.title = orgName;
  const authNameEl = document.querySelector('#auth-org-name');
  const topNameEl = document.querySelector('#org-brand-name');
  if (authNameEl) authNameEl.textContent = orgName;
  if (topNameEl) topNameEl.textContent = orgName;

  for (const id of ['#auth-brand-mark', '#top-brand-mark']) {
    const el = document.querySelector(id);
    if (!el) continue;
    el.classList.add('has-logo');
    el.innerHTML = `<img src="${logoSrc}" alt="${esc(orgName)}">`;
  }
}

// 密码显隐切换统一绑定
export function bindPasswordToggles(root = document) {
  root.querySelectorAll('[data-toggle-pw]').forEach(btn => {
    if (btn.dataset.pwBound) return;
    btn.dataset.pwBound = '1';
    btn.addEventListener('click', () => {
      const inp = btn.parentElement?.querySelector('input');
      if (!inp) return;
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      btn.textContent = show ? '隐藏' : '显示';
    });
  });
}

// 进度条单元格
export function renderProgressCell(prog) {
  if (!prog) return `<span style="font-size:12px;color:var(--subtle)">未观看</span>`;
  const pct = prog.duration_sec > 0 ? Math.min(100, Math.round((prog.watched_sec / prog.duration_sec) * 100)) : 0;
  return `
    <div class="prog-cell">
      <div class="prog-track"><div class="prog-fill ${prog.completed ? 'is-done' : ''}" style="width:${pct}%"></div></div>
      <div class="prog-text">${formatDuration(prog.watched_sec)} · ${pct}%${prog.completed ? ' · 已完课' : ''}</div>
    </div>
  `;
}

// 课程群未读/时间/工具函数
export function getPostMs(post) {
  if (!post) return 0;
  const ms = Number(post.created_ms || 0);
  if (Number.isFinite(ms) && ms > 0) return ms;
  const raw = String(post.created_at || '').trim();
  if (!raw) return 0;
  const parsed = Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T') + ':00Z');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isSelfPost(post) {
  return Boolean(app.state?.currentUser && post.author_id === app.state.currentUser.linkedId && post.author_role === app.state.currentUser.role);
}

export function isMentioningMe(post) {
  if (!app.state?.currentUser || !post || isSelfPost(post)) return false;
  const meId = app.state.currentUser.linkedId;
  const meName = String(app.state.currentUser.name || '').trim();
  const mentions = Array.isArray(post.mentions) ? post.mentions : [];
  if (mentions.some(m => m && (m.id === 'all' || (meId && m.id === meId) || (meName && m.name === meName)))) {
    return true;
  }
  const text = String(post.content || '');
  if (text.includes('@所有人')) return true;
  if (meName && text.includes(`@${meName}`)) return true;
  return false;
}

export function getCourseUnreadCount(courseId) {
  if (!app.state?.qaPosts || !courseId) return 0;
  const cursor = Number(app.state.qaReadCursors?.[courseId] || 0);
  return app.state.qaPosts.filter(p => p.course_id === courseId && !isSelfPost(p) && getPostMs(p) > cursor).length;
}

export function getCourseUnreadMentionCount(courseId) {
  if (!app.state?.qaPosts || !courseId) return 0;
  const cursor = Number(app.state.qaReadCursors?.[courseId] || 0);
  return app.state.qaPosts.filter(p => p.course_id === courseId && !isSelfPost(p) && getPostMs(p) > cursor && isMentioningMe(p)).length;
}

export function getTotalQaUnreadCount() {
  if (!app.state?.courses) return 0;
  return app.state.courses.reduce((sum, c) => sum + getCourseUnreadCount(c.id), 0);
}

export function getTotalQaUnreadMentionCount() {
  if (!app.state?.courses) return 0;
  return app.state.courses.reduce((sum, c) => sum + getCourseUnreadMentionCount(c.id), 0);
}

export function markCourseQaRead(courseId) {
  if (!courseId || !app.state?.authenticated) return;
  const posts = app.state.qaPosts.filter(p => p.course_id === courseId);
  const latestMs = posts.reduce((m, p) => Math.max(m, getPostMs(p)), Date.now());
  if (!app.state.qaReadCursors) app.state.qaReadCursors = {};
  const prev = Number(app.state.qaReadCursors[courseId] || 0);
  if (latestMs <= prev) return;
  app.state.qaReadCursors[courseId] = latestMs;
  updateNavCounts();
  api('/api/qa/read', { method: 'POST', body: { courseId, lastReadMs: latestMs } }).catch(() => {});
}

export function startStudentVodPlayback(player, vodId) {
  const controller = new AbortController();
  let url = '';
  let inFlight;
  let lastRetryAt = 0;
  let position = 0;
  let resumeAfterReload = false;
  let restoring = false;
  let wasPlaying = false;

  function refresh({ reload = false } = {}) {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const ticket = await api(`/api/vod/${encodeURIComponent(vodId)}/playback`, {
          method: 'POST', signal: controller.signal
        });
        if (controller.signal.aborted || !player.isConnected) return;
        if (ticket.url === url && !reload && !player.error) return;
        if (url) {
          if (!player.error) position = player.currentTime;
          resumeAfterReload = wasPlaying;
          restoring = true;
        }
        url = ticket.url;
        player.src = url;
      } catch (err) {
        if (controller.signal.aborted || !player.isConnected) return;
        if (err.status === 403) {
          stopVodWatermark();
        }
        if (!url || reload || err.status === 403) showToast(err.message, true);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  const savePosition = () => { if (!restoring && !player.error) position = player.currentTime; };
  const onPlay = () => { wasPlaying = true; };
  const onPause = () => { if (!restoring && !player.error) wasPlaying = false; };
  const onMetadata = () => {
    if (!restoring) return;
    restoring = false;
    player.currentTime = Number.isFinite(player.duration) ? Math.min(position, player.duration) : position;
    if (resumeAfterReload) player.play().catch(() => {});
  };
  const onError = () => {
    if (Date.now() - lastRetryAt < 15000) {
      showToast('录播暂时无法播放，请重新打开本节课', true);
      return;
    }
    lastRetryAt = Date.now();
    refresh({ reload: true });
  };
  const onVisible = () => { if (!document.hidden) refresh(); };
  const listeners = { timeupdate: savePosition, play: onPlay, pause: onPause, loadedmetadata: onMetadata, error: onError };
  for (const [event, listener] of Object.entries(listeners)) player.addEventListener(event, listener);
  document.addEventListener('visibilitychange', onVisible);
  const timer = setInterval(() => { if (!document.hidden) refresh(); }, 4 * 60 * 1000);
  app.vodPlaybackCleanup = () => {
    controller.abort();
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    for (const [event, listener] of Object.entries(listeners)) player.removeEventListener(event, listener);
    player.pause();
    player.removeAttribute('src');
    player.load();
  };
  refresh();
}

export function accountPlaybackCode(accountId) {
  return String(accountId || '').replace(/^acc_/, '').toUpperCase();
}

// 录屏追溯水印（专注播放页与录播回放页共用）
export function startWatermarkOnStage(stage, player, { onKeydownExtra, protectedVod = false } = {}) {
  stopVodWatermark();
  if (typeof onKeydownExtra === 'function') {
    window.addEventListener('keydown', onKeydownExtra);
    app.vodKeydownCleanup = () => window.removeEventListener('keydown', onKeydownExtra);
  }
  if (!protectedVod && app.state?.org?.default_watermark === 0) {
    const oldWm = stage?.querySelector('#video-watermark');
    if (oldWm) oldWm.hidden = true;
    return;
  }
  if (!stage || !app.state?.currentUser) return;
  const wmText = protectedVod ? `播放编号 ${accountPlaybackCode(app.state.currentUser.id)}`
    : `${app.state.currentUser.name} · ${app.state.currentUser.username}`;
  const timeFormat = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  let expectedText = wmText;
  const watermarkClass = protectedVod ? 'video-watermark is-protected' : 'video-watermark';

  function ensureWmEl() {
    let wm = stage.querySelector('#video-watermark');
    if (!wm) {
      wm = document.createElement('div');
      wm.id = 'video-watermark';
      stage.append(wm);
    }
    wm.className = watermarkClass;
    wm.setAttribute('aria-hidden', 'true');
    if (protectedVod) {
      if (wm.children.length !== 2 || [...wm.children].some(child => child.tagName !== 'SPAN')) {
        wm.replaceChildren(document.createElement('span'), document.createElement('span'));
      }
      for (const child of wm.children) {
        child.textContent = expectedText;
        child.hidden = false;
        child.removeAttribute('style');
      }
    } else wm.textContent = expectedText;
    wm.hidden = false;
    wm.style.display = 'block';
    wm.style.visibility = 'visible';
    wm.style.opacity = '1';
    return wm;
  }

  function moveWm() {
    if (protectedVod) expectedText = `${wmText} · ${timeFormat.format(new Date())}`;
    const wm = ensureWmEl();
    if (protectedVod) {
      wm.lastElementChild.style.top = `${27 + Math.floor(Math.random() * 38)}%`;
      wm.lastElementChild.style.left = `${31 + Math.floor(Math.random() * 38)}%`;
    } else {
      wm.style.top = `${10 + Math.floor(Math.random() * 68)}%`;
      wm.style.left = `${6 + Math.floor(Math.random() * 58)}%`;
    }
  }

  moveWm();
  app.vodWatermarkTimer = setInterval(moveWm, 7000);
  app.vodWatermarkObserver = new MutationObserver(() => {
    const wm = stage.querySelector('#video-watermark');
    const marks = protectedVod ? [...(wm?.children || [])] : (wm ? [wm] : []);
    if (wm?.className !== watermarkClass || marks.length !== (protectedVod ? 2 : 1)
      || marks.some(mark => mark.textContent !== expectedText || mark.hidden
        || mark.style.display === 'none' || mark.style.visibility === 'hidden' || Number.parseFloat(mark.style.opacity) === 0)
      || wm.hidden
      || wm.style.display === 'none' || wm.style.visibility === 'hidden' || wm.style.opacity === '0') {
      if (player && !player.paused) player.pause();
      moveWm();
    }
  });
  app.vodWatermarkObserver.observe(stage, { childList: true, subtree: true, attributes: true, characterData: true });
}

export function openChangeOwnPasswordModal() {
  const state = app.state;
  const isStu = state.currentUser.role === 'student';
  const selfStu = isStu ? state.students.find(s => s.id === state.currentUser.linkedId) : null;
  const selfCourses = isStu ? state.courses.map(c => c.name) : [];
  const validUntil = selfStu?.valid_until || '';
  const body = openModal('个人资料与密码', `
    <form id="self-profile-form" style="display:grid;gap:10px;padding-bottom:16px;border-bottom:1px solid var(--line);margin-bottom:16px">
      <div style="font-size:13px;font-weight:600">个人资料</div>
      <div style="font-size:12px;color:var(--muted);display:grid;gap:4px">
        <div>登录用户名：<strong>${esc(state.currentUser.username)}</strong></div>
        ${isStu ? `
          <div>在读课程：<strong>${selfCourses.length ? esc(selfCourses.join('、')) : '未报课'}</strong> <span style="color:var(--subtle)">（仅管理员可修改）</span></div>
          <div>账号有效期：<strong>${validUntil ? esc(validUntil) : '长期有效'}</strong> <span style="color:var(--subtle)">（仅管理员可修改）</span></div>
        ` : ''}
      </div>
      <label class="form-field"><span>姓名 / 昵称 *</span><input name="name" value="${esc(state.currentUser.name)}" required></label>
      ${isStu ? `
        <label class="form-field"><span>手机号（选填，设置后可用手机号登录）</span><input name="phone" type="tel" inputmode="numeric" maxlength="11" pattern="1[0-9]{10}" title="选填，11 位手机号" value="${esc(selfStu?.phone || '')}" placeholder="选填，留空则仅用用户名登录"></label>
      ` : ''}
      <div class="form-actions">
        <button type="submit" class="primary-button btn-sm">保存资料</button>
      </div>
    </form>

    <form id="change-own-pw-form" style="display:grid;gap:10px">
      <div style="font-size:13px;font-weight:600">修改登录密码</div>
      <label class="form-field"><span>当前密码 *</span><div class="pw-field-wrap"><input name="oldPassword" type="password" autocomplete="current-password" required><button type="button" class="pw-toggle-btn" data-toggle-pw>显示</button></div></label>
      <label class="form-field"><span>新密码（至少 4 位）*</span><div class="pw-field-wrap"><input name="newPassword" type="password" minlength="4" autocomplete="new-password" required><button type="button" class="pw-toggle-btn" data-toggle-pw>显示</button></div></label>
      <label class="form-field"><span>确认新密码 *</span><div class="pw-field-wrap"><input name="confirmPassword" type="password" minlength="4" autocomplete="new-password" required><button type="button" class="pw-toggle-btn" data-toggle-pw>显示</button></div></label>
      <div class="form-actions">
        <button type="button" class="secondary-button" id="cancel-own-pw-btn">关闭</button>
        <button type="submit" class="primary-button">确认修改密码</button>
      </div>
    </form>
  `);
  if (!body) return;
  bindPasswordToggles(body);
  const modal = document.querySelector('#modal');
  body.querySelector('#cancel-own-pw-btn').addEventListener('click', () => modal.close());
  body.querySelector('#self-profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const fd = new FormData(e.target);
      app.state = await api('/api/auth/profile', {
        method: 'PUT',
        body: {
          name: String(fd.get('name') || '').trim(),
          phone: isStu ? String(fd.get('phone') || '').trim() : undefined
        }
      });
      renderAuthOrApp();
      showToast('个人资料已更新');
      openChangeOwnPasswordModal();
    } catch (err) { showToast(err.message, true); }
  });
  body.querySelector('#change-own-pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const oldPassword = String(fd.get('oldPassword') || '');
    const newPassword = String(fd.get('newPassword') || '').trim();
    const confirmPassword = String(fd.get('confirmPassword') || '').trim();
    if (newPassword !== confirmPassword) {
      showToast('两次输入的新密码不一致', true);
      return;
    }
    try {
      await api('/api/auth/password', { method: 'POST', body: { oldPassword, newPassword } });
      modal.close();
      showToast('密码已更新，其他设备登录已下线');
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

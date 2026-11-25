import { esc, formatSize, formatDuration, showToast } from '../utils.js';
import {
  app,
  api,
  isTeacher,
  roleLabel,
  parseOrgIceServers,
  switchView,
  updateNavCounts,
  openLessonDetailModal
} from '../state.js';
import { buildCourseOutlinePanelData, bindOutlinePanelEvents } from './outline-panel.js';

const CHALK_COLORS = [
  { hex: '#f8fafc', label: '粉笔白' },
  { hex: '#fde047', label: '粉笔黄' },
  { hex: '#60a5fa', label: '天蓝' },
  { hex: '#f87171', label: '粉红' },
  { hex: '#4ade80', label: '浅绿' }
];

const BG_PRESETS = {
  '': { label: '黑板绿（默认）', bg: '#162921', grid: false, dots: false },
  'preset:chalkboard': { label: '黑板绿', bg: '#162921', grid: false, dots: false },
  'preset:grid': { label: '黑板方格', bg: '#162921', grid: true, dots: false },
  'preset:dot': { label: '黑板点格', bg: '#162921', grid: false, dots: true }
};

const MATH_SYMBOLS = [
  '∈', '∉', '⊂', '∪', '∩', '∀', '∃', '√', '∑', '∫',
  'π', 'α', 'β', 'θ', 'Δ', '≤', '≥', '≠', '≈', '∞',
  '→', '±', '×', '÷', '²', '³', '⁻¹'
];

const SUPERSCRIPT_MAP = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', 'n': 'ⁿ', 'i': 'ⁱ'
};
const SUBSCRIPT_MAP = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
  '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', 'n': 'ₙ', 'i': 'ᵢ', 'k': 'ₖ'
};

function formatMathShortcuts(raw) {
  return String(raw || '')
    .replace(/\^([0-9+\-ni])/g, (_, ch) => SUPERSCRIPT_MAP[ch] || `^${ch}`)
    .replace(/_([0-9+\-nik])/g, (_, ch) => SUBSCRIPT_MAP[ch] || `_${ch}`);
}

export function renderClassroom(shell) {
  const state = app.state;
  if (app.liveCleanup) { app.liveCleanup(); app.liveCleanup = null; }

  if (state.lessons.length === 0) {
    shell.innerHTML = `
      <div class="page-heading">
        <div><span class="page-eyebrow">教学</span><div class="page-title-row"><h1>实时课堂</h1></div></div>
      </div>
      <div class="empty-state">${isTeacher() ? '暂无课次，请先前往「课程管理」创建。' : '暂无可进入的课次。'}</div>
    `;
    return;
  }

  const lesson = state.lessons.find(l => l.id === app.activeClassroomLessonId)
    || state.lessons.find(l => l.status === 'in_progress')
    || state.lessons[0];
  app.activeClassroomLessonId = lesson.id;

  function getLessonMaterials() {
    return app.state.materials.filter(
      m => (m.scope === 'lesson' && m.target_id === lesson.id) || (m.scope === 'course' && m.target_id === lesson.course_id)
    );
  }

  const lessonMaterials = getLessonMaterials();
  const liveOutlineData = buildCourseOutlinePanelData(lesson.course_id, { type: 'lesson', id: lesson.id });
  const liveOutlineCrumb = liveOutlineData.activePath.length ? liveOutlineData.activePath.join(' › ') : '';

  shell.innerHTML = `
    <div id="classroom-root">
      <div class="page-heading classroom-heading" style="margin-bottom:10px">
        <div class="classroom-heading-meta">
          <span class="page-eyebrow">${esc(lesson.course_name)} · ${esc(lesson.teacher_name)}${liveOutlineCrumb ? ` · 大纲位置：${esc(liveOutlineCrumb)}` : ''}</span>
          <div class="page-title-row">
            <h1>${esc(lesson.title)}</h1>
            <span class="status-pill" id="class-status-pill">待开课</span>
            <span class="page-badge" id="share-status-pill">未共享</span>
            <span class="page-badge" id="rec-progress-badge">未录制</span>
            ${isTeacher() ? '<button type="button" class="secondary-button btn-sm" id="rec-recover-btn" hidden>查看录制</button>' : ''}
            <span class="conn-pill is-warn" id="sse-conn-pill">连接中…</span>
          </div>
        </div>
        <div class="page-actions classroom-actions">
          ${isTeacher() ? `
            <div class="classroom-pill-group">
              <button type="button" class="pill-btn" id="teacher-mic-btn" title="开启/关闭教师语音">语音</button>
              <button type="button" class="pill-btn" id="teacher-mic-mute-btn" hidden>静音</button>
              <span class="mic-level-meter" id="mic-level-meter" hidden title="麦克风输入音量">
                <span class="mic-level-bar"></span><span class="mic-level-bar"></span><span class="mic-level-bar"></span><span class="mic-level-bar"></span>
              </span>
              <span class="pill-sep"></span>
              <button type="button" class="pill-btn" id="teacher-cam-btn" title="开启/关闭教师摄像头">摄像头</button>
              <span class="pill-sep"></span>
              <button type="button" class="pill-btn" id="share-screen-btn" title="共享屏幕">共享屏幕</button>
            </div>
            <button type="button" class="primary-button" id="class-session-btn">上课</button>
            <button type="button" class="secondary-button" id="record-class-btn" disabled title="请先点击「上课」后再开始录制">开始录制</button>
            <button type="button" class="secondary-button" id="pause-record-btn" hidden>暂停录制</button>
            <div class="classroom-pill-group">
              <button type="button" class="pill-btn" id="toggle-side-btn" title="收起/展开右侧边栏">侧栏</button>
              <span class="pill-sep"></span>
              <button type="button" class="pill-btn" id="toggle-fullscreen-btn" title="切换全屏上课 (Esc退出)">全屏</button>
              <span class="pill-sep"></span>
              <div class="board-dropdown-wrap" id="classroom-more-wrap">
                <button type="button" class="pill-btn" id="classroom-more-btn" title="更多课堂操作">更多 ▾</button>
                <div class="board-dropdown-menu is-right" id="classroom-more-menu" hidden style="min-width:200px">
                  <button type="button" class="board-menu-item" id="teacher-hud-btn"><span>互动小窗</span><span id="teacher-hud-hint" style="color:var(--muted);font-size:11px">悬浮</span></button>
                  <div id="mic-device-wrap" hidden>
                    <div class="board-menu-label">麦克风设备</div>
                    <div style="padding:0 6px 4px">
                      <select id="mic-device-select" class="secondary-button btn-sm" style="width:100%;height:28px" title="选择麦克风设备"></select>
                    </div>
                  </div>
                  ${lesson.external_room_url ? `<a class="board-menu-item" href="${esc(lesson.external_room_url)}" target="_blank" rel="noopener"><span>外接课堂</span><span style="color:var(--muted);font-size:11px">↗</span></a>` : ''}
                  ${state.lessons.length > 1 ? `
                    <div class="board-menu-label">切换课次</div>
                    <div style="padding:0 6px 4px">
                      <select id="live-lesson-picker" class="secondary-button btn-sm" style="width:100%;height:28px">
                        ${state.lessons.map(l => `<option value="${l.id}" ${l.id === lesson.id ? 'selected' : ''}>${esc(l.title)}</option>`).join('')}
                      </select>
                    </div>
                  ` : ''}
                </div>
              </div>
            </div>
          ` : `
            ${state.lessons.length > 1 ? `
              <select id="live-lesson-picker" class="secondary-button" style="height:33px;max-width:170px">
                ${state.lessons.map(l => `<option value="${l.id}" ${l.id === lesson.id ? 'selected' : ''}>${esc(l.title)}</option>`).join('')}
              </select>
            ` : ''}
            ${lesson.external_room_url ? `<a class="secondary-button" href="${esc(lesson.external_room_url)}" target="_blank" rel="noopener">外接课堂</a>` : ''}
            <button type="button" class="primary-button" id="raise-hand-btn">举手连线</button>
            <button type="button" class="secondary-button" id="student-mic-mute-btn" hidden>静音</button>
            <button type="button" class="secondary-button" id="student-cam-btn" hidden>开启摄像头</button>
            <button type="button" class="danger-button" id="student-hangup-btn" hidden>结束连线</button>
            <span id="student-mic-status" class="status-pill is-ok" hidden>连线中</span>
            <div class="classroom-pill-group">
              <button type="button" class="pill-btn" id="live-back-course" title="返回课程详情">返回</button>
              <span class="pill-sep"></span>
              <button type="button" class="pill-btn" id="toggle-side-btn" title="收起/展开右侧边栏">侧栏</button>
              <span class="pill-sep"></span>
              <button type="button" class="pill-btn" id="toggle-fullscreen-btn" title="切换全屏上课 (Esc退出)">全屏</button>
            </div>
          `}
        </div>
      </div>

      <div id="hand-alert-bar" class="hand-alert-bar" hidden>
        <span id="hand-alert-text"></span>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button type="button" class="primary-button btn-sm" id="hand-alert-allow-btn">语音连线</button>
          <button type="button" class="secondary-button btn-sm" id="hand-alert-av-btn">视频连线</button>
          <button type="button" class="secondary-button btn-sm" id="hand-alert-reject-btn">暂不连线</button>
          <button type="button" class="secondary-button btn-sm" id="hand-alert-dismiss-btn">忽略</button>
        </div>
      </div>

      <div id="student-waiting-card" class="section-card" hidden style="padding:36px 24px;text-align:center;margin-bottom:12px">
        <div style="font-size:16px;font-weight:700;margin-bottom:8px">课程尚未开始，等待老师点击「上课」</div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:14px">
          ${esc(lesson.course_name)} · ${esc(lesson.teacher_name)} · 约定时间：${new Date(lesson.start_ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
        </div>
        <div style="font-size:12px;color:var(--subtle)">老师点击上课后将自动进入实时课堂，届时可以开始发言与举手连线。</div>
      </div>

      <div class="classroom-grid" id="classroom-grid">
        <div>
          <div id="live-link-stage" class="board-stage link-stage" style="margin-bottom:12px" hidden>
            <div class="board-toolbar">
              <strong style="font-size:13px">实时连线席</strong>
              <span style="font-size:12px;color:var(--muted)" id="link-stage-hint">互动中</span>
            </div>
            <div class="link-stage-grid" id="link-stage-grid"></div>
          </div>

          <div id="screen-stage" class="board-stage" style="margin-bottom:12px" hidden>
            <div class="board-toolbar">
              <strong style="font-size:13px">屏幕共享</strong>
              <div style="display:flex;align-items:center;gap:8px">
                <span style="font-size:12px;color:var(--muted)" id="share-hint">传输中</span>
                ${isTeacher() ? `<button type="button" class="secondary-button btn-sm" id="screen-hud-btn">打开互动小窗</button>` : ''}
              </div>
            </div>
            <div class="screen-video-wrap">
              <video id="remote-screen-video" autoplay playsinline controls></video>
            </div>
          </div>

          <div class="board-stage">
            <div class="board-toolbar">
              <div class="board-tools">
                ${CHALK_COLORS.map((c, idx) => `
                  <button type="button" class="color-dot ${idx === 0 ? 'active' : ''}" data-color="${c.hex}" style="background:${c.hex}" title="${c.label}"></button>
                `).join('')}
                <span class="board-tool-divider"></span>
                <button type="button" class="secondary-button board-tool-btn is-active" data-tool="pen" title="画笔 (平滑压感)">画笔</button>
                <button type="button" class="secondary-button board-tool-btn" data-tool="eraser" title="橡皮擦">橡皮</button>
                <select id="pen-width" class="secondary-button btn-sm" title="线条粗细" style="height:28px">
                  <option value="2.5">细</option>
                  <option value="4.5">中</option>
                  <option value="8">粗</option>
                </select>
                <div class="board-dropdown-wrap" id="toolbox-wrap">
                  <button type="button" class="secondary-button board-tool-btn" id="toolbox-trigger-btn" title="图形、公式文字、激光笔、虚线">工具箱 ▾</button>
                  <div class="board-dropdown-menu" id="toolbox-menu" hidden>
                    <button type="button" class="board-menu-item" data-tool="line" data-tool-label="直线"><span>直线</span><span style="color:var(--muted);font-size:11px">Shift正交</span></button>
                    <button type="button" class="board-menu-item" data-tool="arrow" data-tool-label="箭头"><span>箭头</span><span style="color:var(--muted);font-size:11px">标注方向</span></button>
                    <button type="button" class="board-menu-item" data-tool="rect" data-tool-label="矩形"><span>矩形</span><span style="color:var(--muted);font-size:11px">Shift正方形</span></button>
                    <button type="button" class="board-menu-item" data-tool="circle" data-tool-label="圆形"><span>圆形</span><span style="color:var(--muted);font-size:11px">Shift正圆</span></button>
                    <button type="button" class="board-menu-item" data-tool="text" data-tool-label="公式文字"><span>公式文字</span><span style="color:var(--muted);font-size:11px">数学符号</span></button>
                    <button type="button" class="board-menu-item" data-tool="laser" data-tool-label="激光笔"><span>激光笔</span><span style="color:var(--muted);font-size:11px">自动淡出</span></button>
                    <div style="border-top:1px solid var(--line);margin:2px 0"></div>
                    <button type="button" class="board-menu-item" id="board-dash-btn"><span>虚线模式</span><span id="dash-state-hint" style="color:var(--muted);font-size:11px">关</span></button>
                  </div>
                </div>
                ${isTeacher() ? `
                  <span class="board-tool-divider"></span>
                  <button type="button" class="secondary-button btn-sm" id="board-undo-btn" title="撤销 (⌘/Ctrl+Z)">↩</button>
                  <button type="button" class="secondary-button btn-sm" id="board-redo-btn" disabled title="重做 (⌘/Ctrl+Shift+Z)">↪</button>
                ` : `
                  <span id="student-draw-badge" class="page-badge">仅观看</span>
                `}
              </div>
              <div class="board-tools">
                <div class="board-page-pill">
                  <button type="button" class="pill-btn" id="board-prev-page" title="上一页 (←)">‹</button>
                  <span id="board-page-indicator" class="board-page-num">1 / 1</span>
                  <button type="button" class="pill-btn" id="board-next-page" title="下一页 (→)">›</button>
                  ${isTeacher() ? `<span class="pill-sep"></span><button type="button" class="pill-btn" id="board-add-page" title="新增一页黑板">＋</button>` : ''}
                </div>
                ${isTeacher() ? `
                  <div class="board-dropdown-wrap" id="board-more-wrap">
                    <button type="button" class="secondary-button btn-sm" id="board-more-btn" title="板书保存、底纹与页面管理">更多 ▾</button>
                    <div class="board-dropdown-menu is-right" id="board-more-menu" hidden style="min-width:196px">
                      <button type="button" class="board-menu-item" id="save-board-btn"><span>保存当前板书</span><span style="color:var(--muted);font-size:11px">存资料</span></button>
                      <button type="button" class="board-menu-item" id="export-all-board-btn"><span>导出全部板书</span><span style="color:var(--muted);font-size:11px">长图</span></button>
                      <div style="border-top:1px solid var(--line);margin:2px 0"></div>
                      <button type="button" class="board-menu-item" id="student-draw-btn"><span>学生书写</span><span id="student-draw-state-hint" style="color:var(--muted);font-size:11px">关</span></button>
                      <div class="board-menu-label">黑板底纹</div>
                      <div style="padding:0 6px 4px">
                        <select id="board-bg-select" class="secondary-button btn-sm" style="width:100%;height:28px" title="切换黑板底纹">
                          <option value="">黑板绿（默认）</option>
                          <option value="preset:grid">黑板方格</option>
                          <option value="preset:dot">黑板点格</option>
                        </select>
                      </div>
                      <div style="border-top:1px solid var(--line);margin:2px 0"></div>
                      <button type="button" class="board-menu-item is-danger" id="board-clear-btn"><span>清屏当前页</span></button>
                      <button type="button" class="board-menu-item is-danger" id="board-del-page"><span>删除当前页</span></button>
                    </div>
                  </div>
                ` : `
                  <button type="button" class="secondary-button btn-sm" id="student-follow-page-btn" hidden>回到老师页</button>
                `}
              </div>
            </div>
            <div class="canvas-wrap" id="wb-canvas-wrap">
              <canvas id="whiteboard-canvas" width="1280" height="800"></canvas>
            </div>
          </div>
        </div>

        <section class="section-card classroom-side-panel" style="padding:14px">
          <div class="tab-bar" style="width:100%;display:grid;grid-template-columns:repeat(4,1fr)">
            <button type="button" class="tab-btn ${app.liveSideTab === 'outline' ? 'active' : ''}" data-live-tab="outline">大纲</button>
            <button type="button" class="tab-btn ${app.liveSideTab === 'roster' ? 'active' : ''}" data-live-tab="roster">成员(<span id="roster-count">1</span>)<span class="tab-badge" id="tab-badge-roster" hidden>0</span></button>
            <button type="button" class="tab-btn ${app.liveSideTab === 'chat' ? 'active' : ''}" data-live-tab="chat">讨论<span class="tab-badge" id="tab-badge-chat" hidden>0</span></button>
            <button type="button" class="tab-btn ${app.liveSideTab === 'mat' ? 'active' : ''}" data-live-tab="mat">资料(<span id="live-mat-count">${lessonMaterials.length}</span>)</button>
          </div>

          <div data-live-pane="outline" id="live-outline-pane" ${app.liveSideTab === 'outline' ? '' : 'hidden'} style="max-height:520px;overflow-y:auto">
            ${liveOutlineData.html}
          </div>

          <div data-live-pane="roster" ${app.liveSideTab === 'roster' ? '' : 'hidden'}>
            <div id="live-roster" class="item-list"></div>
          </div>

          <div data-live-pane="chat" ${app.liveSideTab === 'chat' ? '' : 'hidden'} style="display:grid;gap:10px">
            <div id="live-chat-list" class="chat-list"></div>
            <form id="live-chat-form" style="display:flex;gap:6px">
              <input name="text" placeholder="发送消息…" style="flex:1;padding:6px 9px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--control);color:var(--ink);font-size:12px" required>
              <button type="submit" class="primary-button btn-sm">发送</button>
            </form>
            ${isTeacher() ? `<button type="button" class="secondary-button btn-sm" id="archive-chat-qa-btn">归档讨论到课程群</button>` : ''}
          </div>

          <div data-live-pane="mat" id="live-mat-pane" ${app.liveSideTab === 'mat' ? '' : 'hidden'}></div>
        </section>
      </div>
    </div>
  `;

  // --- 布局控制：侧栏折叠 & 全屏模式 ---
  const classroomRoot = shell.querySelector('#classroom-root');
  const classroomGrid = shell.querySelector('#classroom-grid');
  const toggleSideBtn = shell.querySelector('#toggle-side-btn');
  const toggleFullBtn = shell.querySelector('#toggle-fullscreen-btn');
  let sideCollapsed = false;
  let isFullscreenMode = false;

  toggleSideBtn?.addEventListener('click', () => {
    sideCollapsed = !sideCollapsed;
    classroomGrid.classList.toggle('is-side-collapsed', sideCollapsed);
    toggleSideBtn.textContent = sideCollapsed ? '展开' : '侧栏';
    toggleSideBtn.classList.toggle('is-active', sideCollapsed);
  });

  function setFullscreenState(next) {
    isFullscreenMode = Boolean(next);
    classroomRoot.classList.toggle('classroom-shell-fullscreen', isFullscreenMode);
    document.body.style.overflow = isFullscreenMode ? 'hidden' : '';
    if (toggleFullBtn) {
      toggleFullBtn.textContent = isFullscreenMode ? '退出' : '全屏';
      toggleFullBtn.classList.toggle('is-active', isFullscreenMode);
    }
  }

  toggleFullBtn?.addEventListener('click', () => {
    setFullscreenState(!isFullscreenMode);
  });

  function renderLiveMaterialsPane() {
    const mats = getLessonMaterials();
    const countEl = shell.querySelector('#live-mat-count');
    if (countEl) countEl.textContent = mats.length;
    const pane = shell.querySelector('#live-mat-pane');
    if (pane) {
      pane.innerHTML = mats.length === 0
        ? `<div class="empty-state" style="padding:20px">暂无资料</div>`
        : `<div class="item-list">${mats.map(m => `
            <div class="item-row" style="padding:8px 10px;gap:6px;min-width:0">
              <span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0" title="${esc(m.filename)}">${esc(m.filename)}</span>
              <a class="secondary-button btn-sm" style="flex-shrink:0" href="/api/materials/${m.id}/file" target="_blank" rel="noopener">打开</a>
            </div>
          `).join('')}</div>`;
    }
  }
  renderLiveMaterialsPane();
  bindOutlinePanelEvents(shell.querySelector('#live-outline-pane'), lesson.course_id);
  shell.querySelector('#live-back-course')?.addEventListener('click', () => {
    switchView('courses', { tab: 'catalog', outlineCourseId: lesson.course_id });
  });

  shell.querySelector('#live-lesson-picker')?.addEventListener('change', (e) => {
    const nextId = e.target.value;
    if (app.liveIsRecording && !confirm('当前正在录制课程，切换课次将结束并保存当前录制，确认切换？')) {
      e.target.value = lesson.id;
      return;
    }
    switchView('classroom', { lessonId: nextId });
  });

  let unreadChatCount = 0;
  function updateChatBadge() {
    const el = shell.querySelector('#tab-badge-chat');
    if (!el) return;
    el.textContent = unreadChatCount > 99 ? '99+' : String(unreadChatCount);
    el.hidden = unreadChatCount <= 0;
  }

  shell.querySelectorAll('[data-live-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      app.liveSideTab = btn.getAttribute('data-live-tab');
      if (app.liveSideTab === 'chat') {
        unreadChatCount = 0;
        updateChatBadge();
      }
      shell.querySelectorAll('[data-live-tab]').forEach(b => b.classList.toggle('active', b === btn));
      shell.querySelectorAll('[data-live-pane]').forEach(p => {
        p.hidden = p.getAttribute('data-live-pane') !== app.liveSideTab;
      });
    });
  });

  // --- 双层 Canvas 多页白板 ---
  const canvasWrap = shell.querySelector('#wb-canvas-wrap');
  const canvas = shell.querySelector('#whiteboard-canvas');
  const ctx = canvas.getContext('2d');
  const inkCanvas = document.createElement('canvas');
  inkCanvas.width = canvas.width;
  inkCanvas.height = canvas.height;
  const inkCtx = inkCanvas.getContext('2d');

  let wbPages = [{ strokes: [], bgUrl: '' }];
  let currentPageIdx = 0;
  let teacherPageIdx = 0;
  let redoStacks = new Map();
  let allowStudentDraw = false;
  let myDrawAllowed = isTeacher();
  let bgImage = null;
  let loadedBgUrl = '';
  let penColor = CHALK_COLORS[0].hex;
  let penWidth = 2.5;
  let activeTool = 'pen';
  let isDashed = false;
  let drawingStroke = null;
  let lastLiveSendMs = 0;
  let lastSentPointIdx = 0;
  const remoteLiveStrokes = new Map(); // clientId -> { name, stroke }
  const laserTrails = new Map(); // clientId -> { name, points: [{x, y, t}] }
  const strokeImageCache = new Map();
  const myClientId = Math.random().toString(36).slice(2, 10);
  let myHandRaised = false;
  let currentRoster = [];
  let laserRafId = null;

  function setActivePenColor(hex) {
    penColor = hex;
    shell.querySelectorAll('.color-dot').forEach(d => {
      d.classList.toggle('active', d.getAttribute('data-color') === hex);
    });
  }

  function getCurrentPage() {
    if (!wbPages[currentPageIdx]) wbPages[currentPageIdx] = { strokes: [], bgUrl: '' };
    return wbPages[currentPageIdx];
  }
  function getRedoStack() {
    if (!redoStacks.has(currentPageIdx)) redoStacks.set(currentPageIdx, []);
    return redoStacks.get(currentPageIdx);
  }
  function canDrawNow() {
    return isTeacher() || (myDrawAllowed && currentPageIdx === teacherPageIdx);
  }

  function syncDrawPermissionUi() {
    canvas.classList.toggle('is-readonly', !canDrawNow());
    const toggleBtn = shell.querySelector('#student-draw-btn');
    const drawHint = shell.querySelector('#student-draw-state-hint');
    if (toggleBtn) {
      toggleBtn.classList.toggle('is-active', allowStudentDraw);
    }
    if (drawHint) {
      drawHint.textContent = allowStudentDraw ? '开' : '关';
    }
    const badge = shell.querySelector('#student-draw-badge');
    if (badge) {
      badge.textContent = myDrawAllowed ? '可协同书写' : '仅观看';
      badge.className = myDrawAllowed ? 'page-badge is-accent' : 'page-badge';
    }
  }

  function syncPageControlsUi() {
    const indicator = shell.querySelector('#board-page-indicator');
    if (indicator) indicator.textContent = `${currentPageIdx + 1} / ${wbPages.length}`;
    const prevBtn = shell.querySelector('#board-prev-page');
    const nextBtn = shell.querySelector('#board-next-page');
    const delBtn = shell.querySelector('#board-del-page');
    const redoBtn = shell.querySelector('#board-redo-btn');
    const followBtn = shell.querySelector('#student-follow-page-btn');
    if (prevBtn) prevBtn.disabled = currentPageIdx <= 0;
    if (nextBtn) nextBtn.disabled = currentPageIdx >= wbPages.length - 1;
    if (delBtn) delBtn.disabled = wbPages.length <= 1;
    if (redoBtn) redoBtn.disabled = getRedoStack().length === 0;
    if (followBtn) followBtn.hidden = currentPageIdx === teacherPageIdx;
    const bgSelEl = shell.querySelector('#board-bg-select');
    if (bgSelEl) bgSelEl.value = getCurrentPage().bgUrl || '';
    syncDrawPermissionUi();
  }

  function drawContain(targetCtx, source, sw, sh, dw, dh) {
    if (!sw || !sh) return;
    const scale = Math.min(dw / sw, dh / sh);
    const rw = sw * scale;
    const rh = sh * scale;
    const dx = (dw - rw) / 2;
    const dy = (dh - rh) / 2;
    targetCtx.drawImage(source, dx, dy, rw, rh);
  }

  function drawBackgroundPreset(targetCtx, bgUrl, w, h) {
    const preset = BG_PRESETS[bgUrl || ''] || BG_PRESETS[''];
    targetCtx.save();
    targetCtx.fillStyle = preset.bg;
    targetCtx.fillRect(0, 0, w, h);

    if (preset.grid) {
      const step = 40;
      targetCtx.strokeStyle = 'rgba(255,255,255,0.08)';
      targetCtx.lineWidth = 1;
      targetCtx.beginPath();
      for (let x = step; x < w; x += step) {
        targetCtx.moveTo(x, 0);
        targetCtx.lineTo(x, h);
      }
      for (let y = step; y < h; y += step) {
        targetCtx.moveTo(0, y);
        targetCtx.lineTo(w, y);
      }
      targetCtx.stroke();
    }

    if (preset.dots) {
      const step = 32;
      targetCtx.fillStyle = 'rgba(255,255,255,0.22)';
      for (let x = step; x < w; x += step) {
        for (let y = step; y < h; y += step) {
          targetCtx.beginPath();
          targetCtx.arc(x, y, 1.4, 0, Math.PI * 2);
          targetCtx.fill();
        }
      }
    }
    targetCtx.restore();
  }

  function getCachedStrokeImage(url) {
    if (!url) return null;
    if (strokeImageCache.has(url)) return strokeImageCache.get(url);
    const img = new Image();
    img.onload = () => {
      rebuildInkCache();
      renderBoardFrame();
    };
    img.src = url;
    strokeImageCache.set(url, img);
    return img;
  }

  function drawStrokeOn(targetCtx, s, allowDestinationOut = false) {
    if (!s) return;
    targetCtx.save();
    targetCtx.lineCap = 'round';
    targetCtx.lineJoin = 'round';
    const isErasing = Boolean(s.eraser || s.kind === 'eraser');
    if (isErasing && allowDestinationOut) {
      targetCtx.globalCompositeOperation = 'destination-out';
      targetCtx.strokeStyle = 'rgba(0,0,0,1)';
      targetCtx.lineWidth = Number(s.width) || 24;
    } else {
      targetCtx.strokeStyle = isErasing ? 'rgba(22,41,33,0.9)' : (s.color || '#f8fafc');
      targetCtx.fillStyle = s.color || '#f8fafc';
      targetCtx.lineWidth = Number(s.width) || 2.5;
    }
    if (s.dashed && !isErasing) {
      targetCtx.setLineDash([10, 8]);
    }

    if (s.kind === 'image' && s.url) {
      const img = getCachedStrokeImage(s.url);
      if (img && img.complete && img.naturalWidth > 0) {
        targetCtx.drawImage(
          img,
          (s.x || 0) * canvas.width,
          (s.y || 0) * canvas.height,
          (s.w || 0.4) * canvas.width,
          (s.h || 0.4) * canvas.height
        );
      }
    } else if (s.kind === 'text' && s.text) {
      const fontSize = Math.max(14, Number(s.fontSize) || 24);
      targetCtx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
      targetCtx.textBaseline = 'top';
      targetCtx.fillText(String(s.text), (s.x || 0) * canvas.width, (s.y || 0) * canvas.height);
    } else if (s.kind === 'line' && Array.isArray(s.points) && s.points.length >= 2) {
      const p0 = s.points[0];
      const p1 = s.points[s.points.length - 1];
      targetCtx.beginPath();
      targetCtx.moveTo(p0[0] * canvas.width, p0[1] * canvas.height);
      targetCtx.lineTo(p1[0] * canvas.width, p1[1] * canvas.height);
      targetCtx.stroke();
    } else if (s.kind === 'arrow' && Array.isArray(s.points) && s.points.length >= 2) {
      const p0 = s.points[0];
      const p1 = s.points[s.points.length - 1];
      const x0 = p0[0] * canvas.width;
      const y0 = p0[1] * canvas.height;
      const x1 = p1[0] * canvas.width;
      const y1 = p1[1] * canvas.height;
      targetCtx.beginPath();
      targetCtx.moveTo(x0, y0);
      targetCtx.lineTo(x1, y1);
      targetCtx.stroke();
      const angle = Math.atan2(y1 - y0, x1 - x0);
      const headLen = Math.max(12, (Number(s.width) || 3) * 3.5);
      targetCtx.setLineDash([]);
      targetCtx.beginPath();
      targetCtx.moveTo(x1, y1);
      targetCtx.lineTo(x1 - headLen * Math.cos(angle - Math.PI / 6), y1 - headLen * Math.sin(angle - Math.PI / 6));
      targetCtx.moveTo(x1, y1);
      targetCtx.lineTo(x1 - headLen * Math.cos(angle + Math.PI / 6), y1 - headLen * Math.sin(angle + Math.PI / 6));
      targetCtx.stroke();
    } else if (s.kind === 'rect' && Array.isArray(s.points) && s.points.length >= 2) {
      const p0 = s.points[0];
      const p1 = s.points[s.points.length - 1];
      targetCtx.strokeRect(
        Math.min(p0[0], p1[0]) * canvas.width,
        Math.min(p0[1], p1[1]) * canvas.height,
        Math.abs(p1[0] - p0[0]) * canvas.width,
        Math.abs(p1[1] - p0[1]) * canvas.height
      );
    } else if (s.kind === 'circle' && Array.isArray(s.points) && s.points.length >= 2) {
      const p0 = s.points[0];
      const p1 = s.points[s.points.length - 1];
      const cx = ((p0[0] + p1[0]) / 2) * canvas.width;
      const cy = ((p0[1] + p1[1]) / 2) * canvas.height;
      const rx = (Math.abs(p1[0] - p0[0]) / 2) * canvas.width;
      const ry = (Math.abs(p1[1] - p0[1]) / 2) * canvas.height;
      targetCtx.beginPath();
      targetCtx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
      targetCtx.stroke();
    } else if (Array.isArray(s.points) && s.points.length) {
      // 二次贝塞尔中点平滑
      const pts = s.points;
      targetCtx.beginPath();
      const x0 = pts[0][0] * canvas.width;
      const y0 = pts[0][1] * canvas.height;
      targetCtx.moveTo(x0, y0);
      if (pts.length === 1) {
        targetCtx.lineTo(x0 + 0.1, y0 + 0.1);
      } else if (pts.length === 2) {
        targetCtx.lineTo(pts[1][0] * canvas.width, pts[1][1] * canvas.height);
      } else {
        for (let i = 1; i < pts.length - 1; i++) {
          const xc = ((pts[i][0] + pts[i + 1][0]) / 2) * canvas.width;
          const yc = ((pts[i][1] + pts[i + 1][1]) / 2) * canvas.height;
          targetCtx.quadraticCurveTo(pts[i][0] * canvas.width, pts[i][1] * canvas.height, xc, yc);
        }
        const last = pts[pts.length - 1];
        targetCtx.lineTo(last[0] * canvas.width, last[1] * canvas.height);
      }
      targetCtx.stroke();
    }
    targetCtx.restore();
  }

  function rebuildInkCache() {
    inkCtx.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
    for (const s of getCurrentPage().strokes) {
      drawStrokeOn(inkCtx, s, true);
    }
  }

  function drawRemoteNameTag(targetCtx, name, pt) {
    if (!name || !pt) return;
    targetCtx.save();
    const x = Math.min(canvas.width - 70, Math.max(8, pt[0] * canvas.width + 10));
    const y = Math.min(canvas.height - 24, Math.max(8, pt[1] * canvas.height - 22));
    targetCtx.font = '600 11px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    const w = targetCtx.measureText(name).width + 12;
    targetCtx.fillStyle = 'rgba(37, 99, 235, 0.85)';
    targetCtx.beginPath();
    targetCtx.roundRect(x, y, w, 18, 6);
    targetCtx.fill();
    targetCtx.fillStyle = '#ffffff';
    targetCtx.textBaseline = 'middle';
    targetCtx.fillText(name, x + 6, y + 9);
    targetCtx.restore();
  }

  function drawLaserTrails(targetCtx) {
    const now = Date.now();
    let hasActive = false;
    for (const [cid, trail] of laserTrails.entries()) {
      trail.points = trail.points.filter(p => now - p.t < 700);
      if (trail.points.length === 0) {
        laserTrails.delete(cid);
        continue;
      }
      hasActive = true;
      for (let i = 1; i < trail.points.length; i++) {
        const p0 = trail.points[i - 1];
        const p1 = trail.points[i];
        const alpha = Math.max(0, 1 - (now - p1.t) / 700);
        targetCtx.save();
        targetCtx.strokeStyle = `rgba(239, 68, 68, ${alpha * 0.9})`;
        targetCtx.lineWidth = 4 * alpha + 1.5;
        targetCtx.lineCap = 'round';
        targetCtx.beginPath();
        targetCtx.moveTo(p0.x * canvas.width, p0.y * canvas.height);
        targetCtx.lineTo(p1.x * canvas.width, p1.y * canvas.height);
        targetCtx.stroke();
        targetCtx.restore();
      }
      const head = trail.points[trail.points.length - 1];
      targetCtx.save();
      targetCtx.fillStyle = 'rgba(239, 68, 68, 0.95)';
      targetCtx.shadowColor = '#ef4444';
      targetCtx.shadowBlur = 12;
      targetCtx.beginPath();
      targetCtx.arc(head.x * canvas.width, head.y * canvas.height, 6, 0, Math.PI * 2);
      targetCtx.fill();
      targetCtx.restore();
    }
    return hasActive;
  }

  function scheduleLaserLoop() {
    if (laserRafId) return;
    const tick = () => {
      laserRafId = null;
      renderBoardFrame();
      if (laserTrails.size > 0) {
        laserRafId = requestAnimationFrame(tick);
      }
    };
    laserRafId = requestAnimationFrame(tick);
  }

  function renderPageToContext(targetCtx, page, w, h, overrideBgImg = null) {
    const bgUrl = page?.bgUrl || '';
    if (Object.prototype.hasOwnProperty.call(BG_PRESETS, bgUrl)) {
      drawBackgroundPreset(targetCtx, bgUrl, w, h);
    } else {
      targetCtx.fillStyle = '#ffffff';
      targetCtx.fillRect(0, 0, w, h);
      if (overrideBgImg && overrideBgImg.complete && overrideBgImg.naturalWidth > 0) {
        drawContain(targetCtx, overrideBgImg, overrideBgImg.naturalWidth, overrideBgImg.naturalHeight, w, h);
      }
    }
  }

  function renderBoardFrame() {
    const page = getCurrentPage();
    renderPageToContext(ctx, page, canvas.width, canvas.height, bgImage);
    ctx.drawImage(inkCanvas, 0, 0);
    for (const entry of remoteLiveStrokes.values()) {
      if (entry?.stroke) {
        drawStrokeOn(ctx, entry.stroke, false);
        const pts = entry.stroke.points;
        if (Array.isArray(pts) && pts.length) {
          drawRemoteNameTag(ctx, entry.name, pts[pts.length - 1]);
        }
      }
    }
    if (drawingStroke) {
      drawStrokeOn(ctx, drawingStroke, false);
    }
    drawLaserTrails(ctx);
  }

  function loadBgUrl(url) {
    const cleanUrl = String(url || '');
    if (Object.prototype.hasOwnProperty.call(BG_PRESETS, cleanUrl)) {
      loadedBgUrl = cleanUrl;
      bgImage = null;
      renderBoardFrame();
      return;
    }
    if (cleanUrl === loadedBgUrl) { renderBoardFrame(); return; }
    loadedBgUrl = cleanUrl;
    if (!cleanUrl) { bgImage = null; renderBoardFrame(); return; }
    const img = new Image();
    img.onload = () => {
      if (loadedBgUrl === cleanUrl) { bgImage = img; renderBoardFrame(); }
    };
    img.onerror = () => {
      if (loadedBgUrl === cleanUrl) { bgImage = null; renderBoardFrame(); }
    };
    img.src = cleanUrl;
  }

  function applyWhiteboardState(pages, pageIndex) {
    wbPages = Array.isArray(pages) && pages.length ? pages : [{ strokes: [], bgUrl: '' }];
    teacherPageIdx = Math.max(0, Math.min(wbPages.length - 1, Number(pageIndex) || 0));
    currentPageIdx = teacherPageIdx;
    remoteLiveStrokes.clear();
    rebuildInkCache();
    const curBg = getCurrentPage().bgUrl;
    loadBgUrl(curBg);
    syncPageControlsUi();
    renderBoardFrame();
  }

  function getNormPos(e) {
    const rect = canvas.getBoundingClientRect();
    return [
      Number(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)).toFixed(4)),
      Number(Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)).toFixed(4))
    ];
  }

  function applyShiftConstraint(kind, p0, p1) {
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    if (kind === 'line' || kind === 'arrow') {
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);
      if (adx > ady * 2) return [p1[0], p0[1]];
      if (ady > adx * 2) return [p0[0], p1[1]];
      const d = Math.max(adx, ady);
      return [p0[0] + Math.sign(dx) * d, p0[1] + Math.sign(dy) * d];
    }
    if (kind === 'rect' || kind === 'circle') {
      const aspect = canvas.width / canvas.height;
      const sizeX = Math.max(Math.abs(dx), Math.abs(dy) / aspect);
      const sizeY = sizeX * aspect;
      return [p0[0] + Math.sign(dx || 1) * sizeX, p0[1] + Math.sign(dy || 1) * sizeY];
    }
    return p1;
  }

  function spawnInlineTextInput(pos) {
    canvasWrap.querySelector('.wb-text-overlay')?.remove();
    const wrap = document.createElement('div');
    wrap.className = 'wb-text-overlay';
    wrap.style.left = `${Math.min(68, Math.max(2, pos[0] * 100))}%`;
    wrap.style.top = `${Math.min(72, Math.max(2, pos[1] * 100))}%`;

    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = '输入文字或公式 (如 x^2, a_1)，回车确认…';
    const symBar = document.createElement('div');
    symBar.className = 'wb-symbol-bar';
    for (const sym of MATH_SYMBOLS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wb-symbol-btn';
      btn.textContent = sym;
      btn.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        const start = inp.selectionStart ?? inp.value.length;
        const end = inp.selectionEnd ?? inp.value.length;
        inp.value = inp.value.slice(0, start) + sym + inp.value.slice(end);
        inp.setSelectionRange(start + sym.length, start + sym.length);
        inp.focus();
      });
      symBar.append(btn);
    }

    const actionsRow = document.createElement('div');
    actionsRow.style.cssText = 'display:flex;justify-content:flex-end;gap:6px';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'secondary-button btn-sm';
    cancelBtn.textContent = '取消';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'primary-button btn-sm';
    okBtn.textContent = '确定';
    actionsRow.append(cancelBtn, okBtn);

    wrap.append(inp, symBar, actionsRow);
    canvasWrap.append(wrap);
    inp.focus();

    let committed = false;
    async function commit() {
      if (committed) return;
      committed = true;
      const val = formatMathShortcuts(inp.value.trim());
      wrap.remove();
      if (!val) return;
      const stroke = {
        kind: 'text',
        text: val,
        x: pos[0],
        y: pos[1],
        color: penColor,
        fontSize: penWidth >= 8 ? 32 : penWidth >= 4.5 ? 24 : 18
      };
      getCurrentPage().strokes.push(stroke);
      redoStacks.set(currentPageIdx, []);
      drawStrokeOn(inkCtx, stroke, true);
      renderBoardFrame();
      syncPageControlsUi();
      await api(`/api/classroom/${lesson.id}/action`, {
        method: 'POST',
        body: { type: 'stroke', clientId: myClientId, stroke }
      }).catch(() => {});
    }
    okBtn.addEventListener('click', commit);
    cancelBtn.addEventListener('click', () => { committed = true; wrap.remove(); });
    inp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      else if (ev.key === 'Escape') { committed = true; wrap.remove(); }
    });
  }

  let isLaserDown = false;

  canvas.addEventListener('pointerdown', (e) => {
    if (!canDrawNow()) {
      showToast(myDrawAllowed ? '请先点「回到老师页」再协同书写' : '当前仅老师可书写白板', true);
      return;
    }
    const pos = getNormPos(e);
    if (activeTool === 'text') {
      spawnInlineTextInput(pos);
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    if (activeTool === 'laser') {
      isLaserDown = true;
      const trail = laserTrails.get(myClientId) || { name: app.user?.name || '', points: [] };
      trail.points.push({ x: pos[0], y: pos[1], t: Date.now() });
      laserTrails.set(myClientId, trail);
      scheduleLaserLoop();
      api(`/api/classroom/${lesson.id}/action`, {
        method: 'POST',
        body: { type: 'stroke-live', clientId: myClientId, stroke: { kind: 'laser', point: pos } }
      }).catch(() => {});
      return;
    }

    const pressureWidth = e.pointerType === 'pen' && e.pressure > 0
      ? Number((penWidth * (0.65 + e.pressure * 0.75)).toFixed(2))
      : penWidth;

    lastSentPointIdx = 1;
    drawingStroke = {
      strokeId: Math.random().toString(36).slice(2, 9),
      kind: activeTool,
      color: penColor,
      width: activeTool === 'eraser' ? 26 : pressureWidth,
      eraser: activeTool === 'eraser',
      dashed: isDashed && activeTool !== 'eraser',
      points: [pos]
    };
    renderBoardFrame();
  });

  canvas.addEventListener('pointermove', (e) => {
    const rawPos = getNormPos(e);
    if (isLaserDown) {
      const trail = laserTrails.get(myClientId) || { name: app.user?.name || '', points: [] };
      trail.points.push({ x: rawPos[0], y: rawPos[1], t: Date.now() });
      laserTrails.set(myClientId, trail);
      scheduleLaserLoop();
      const now = Date.now();
      if (now - lastLiveSendMs >= 50) {
        lastLiveSendMs = now;
        api(`/api/classroom/${lesson.id}/action`, {
          method: 'POST',
          body: { type: 'stroke-live', clientId: myClientId, stroke: { kind: 'laser', point: rawPos } }
        }).catch(() => {});
      }
      return;
    }
    if (!drawingStroke) return;
    const pos = e.shiftKey ? applyShiftConstraint(drawingStroke.kind, drawingStroke.points[0], rawPos) : rawPos;
    if (['line', 'arrow', 'rect', 'circle'].includes(drawingStroke.kind)) {
      drawingStroke.points = [drawingStroke.points[0], pos];
    } else {
      drawingStroke.points.push(pos);
    }
    renderBoardFrame();
    const now = Date.now();
    if (now - lastLiveSendMs >= 60) {
      lastLiveSendMs = now;
      if (drawingStroke.kind === 'pen' || drawingStroke.kind === 'eraser') {
        const deltaPts = drawingStroke.points.slice(lastSentPointIdx);
        if (deltaPts.length > 0) {
          const isFirst = lastSentPointIdx === 1;
          lastSentPointIdx = drawingStroke.points.length;
          api(`/api/classroom/${lesson.id}/action`, {
            method: 'POST',
            body: {
              type: 'stroke-live',
              clientId: myClientId,
              delta: {
                strokeId: drawingStroke.strokeId,
                kind: drawingStroke.kind,
                color: drawingStroke.color,
                width: drawingStroke.width,
                eraser: drawingStroke.eraser,
                dashed: drawingStroke.dashed,
                points: isFirst ? [drawingStroke.points[0], ...deltaPts] : deltaPts
              }
            }
          }).catch(() => {});
        }
      } else {
        api(`/api/classroom/${lesson.id}/action`, {
          method: 'POST',
          body: { type: 'stroke-live', clientId: myClientId, stroke: drawingStroke }
        }).catch(() => {});
      }
    }
  });

  async function finishPointer() {
    if (isLaserDown) {
      isLaserDown = false;
      return;
    }
    if (!drawingStroke) return;
    const completed = { ...drawingStroke };
    delete completed.strokeId;
    drawingStroke = null;
    getCurrentPage().strokes.push(completed);
    redoStacks.set(currentPageIdx, []);
    drawStrokeOn(inkCtx, completed, true);
    renderBoardFrame();
    syncPageControlsUi();
    await api(`/api/classroom/${lesson.id}/action`, {
      method: 'POST',
      body: { type: 'stroke', clientId: myClientId, stroke: completed }
    }).catch(() => {});
  }
  canvas.addEventListener('pointerup', finishPointer);
  canvas.addEventListener('pointercancel', finishPointer);

  const toolboxMenu = shell.querySelector('#toolbox-menu');
  const toolboxTrigger = shell.querySelector('#toolbox-trigger-btn');
  const boardMoreMenu = shell.querySelector('#board-more-menu');
  const boardMoreBtn = shell.querySelector('#board-more-btn');
  const classroomMoreMenu = shell.querySelector('#classroom-more-menu');
  const classroomMoreBtn = shell.querySelector('#classroom-more-btn');

  function closeBoardMenus() {
    if (toolboxMenu) toolboxMenu.hidden = true;
    if (boardMoreMenu) boardMoreMenu.hidden = true;
    if (classroomMoreMenu) classroomMoreMenu.hidden = true;
  }

  function handleDocMenuClick(e) {
    if (!e.target.closest('#toolbox-wrap') && toolboxMenu) toolboxMenu.hidden = true;
    if (!e.target.closest('#board-more-wrap') && boardMoreMenu) boardMoreMenu.hidden = true;
    if (!e.target.closest('#classroom-more-wrap') && classroomMoreMenu) classroomMoreMenu.hidden = true;
  }
  document.addEventListener('click', handleDocMenuClick);

  toolboxTrigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = toolboxMenu.hidden;
    closeBoardMenus();
    toolboxMenu.hidden = !next;
  });

  boardMoreBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = boardMoreMenu.hidden;
    closeBoardMenus();
    boardMoreMenu.hidden = !next;
  });

  classroomMoreBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = classroomMoreMenu.hidden;
    closeBoardMenus();
    classroomMoreMenu.hidden = !next;
  });

  function syncToolButtonsUi() {
    shell.querySelectorAll('[data-tool]').forEach(b => {
      b.classList.toggle('is-active', b.getAttribute('data-tool') === activeTool);
    });
    const inToolbox = toolboxMenu?.querySelector(`[data-tool="${activeTool}"]`);
    if (toolboxTrigger) {
      if (inToolbox) {
        toolboxTrigger.textContent = `${inToolbox.getAttribute('data-tool-label') || '工具箱'} ▾`;
        toolboxTrigger.classList.add('is-active');
      } else {
        toolboxTrigger.textContent = '工具箱 ▾';
        toolboxTrigger.classList.remove('is-active');
      }
    }
  }

  shell.querySelectorAll('.color-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      setActivePenColor(dot.getAttribute('data-color'));
      if (activeTool === 'eraser' || activeTool === 'laser') {
        activeTool = 'pen';
        syncToolButtonsUi();
      }
    });
  });

  shell.querySelectorAll('[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTool = btn.getAttribute('data-tool');
      syncToolButtonsUi();
      closeBoardMenus();
    });
  });

  const dashBtn = shell.querySelector('#board-dash-btn');
  const dashHint = shell.querySelector('#dash-state-hint');
  dashBtn?.addEventListener('click', () => {
    isDashed = !isDashed;
    dashBtn.classList.toggle('is-active', isDashed);
    if (dashHint) dashHint.textContent = isDashed ? '开' : '关';
  });

  shell.querySelector('#pen-width').addEventListener('change', (e) => {
    penWidth = Number(e.target.value);
  });

  async function triggerUndo() {
    if (!isTeacher()) return;
    const popped = getCurrentPage().strokes.pop();
    if (popped) getRedoStack().push(popped);
    rebuildInkCache();
    renderBoardFrame();
    syncPageControlsUi();
    await api(`/api/classroom/${lesson.id}/action`, { method: 'POST', body: { type: 'undo' } }).catch(() => {});
  }

  async function triggerRedo() {
    if (!isTeacher()) return;
    const stack = getRedoStack();
    const stroke = stack.pop();
    if (!stroke) return;
    getCurrentPage().strokes.push(stroke);
    drawStrokeOn(inkCtx, stroke, true);
    renderBoardFrame();
    syncPageControlsUi();
    await api(`/api/classroom/${lesson.id}/action`, {
      method: 'POST',
      body: { type: 'stroke', clientId: myClientId, stroke }
    }).catch(() => {});
  }

  shell.querySelector('#board-undo-btn')?.addEventListener('click', triggerUndo);
  shell.querySelector('#board-redo-btn')?.addEventListener('click', triggerRedo);

  shell.querySelector('#board-clear-btn')?.addEventListener('click', async () => {
    if (getCurrentPage().strokes.length && !confirm('确认清空当前页白板笔迹？')) return;
    getCurrentPage().strokes = [];
    redoStacks.set(currentPageIdx, []);
    rebuildInkCache();
    renderBoardFrame();
    syncPageControlsUi();
    await api(`/api/classroom/${lesson.id}/action`, { method: 'POST', body: { type: 'clear' } });
  });

  shell.querySelector('#board-bg-select')?.addEventListener('change', async (e) => {
    const val = e.target.value;
    getCurrentPage().bgUrl = val;
    loadBgUrl(val);
    await api(`/api/classroom/${lesson.id}/action`, { method: 'POST', body: { type: 'background', bgUrl: val } });
  });

  async function goPrevPage() {
    if (currentPageIdx <= 0) return;
    if (isTeacher()) {
      await api(`/api/classroom/${lesson.id}/action`, { method: 'POST', body: { type: 'page-switch', pageIndex: currentPageIdx - 1 } });
    } else {
      currentPageIdx -= 1;
      rebuildInkCache();
      loadBgUrl(getCurrentPage().bgUrl);
      syncPageControlsUi();
      renderBoardFrame();
    }
  }

  async function goNextPage() {
    if (currentPageIdx >= wbPages.length - 1) return;
    if (isTeacher()) {
      await api(`/api/classroom/${lesson.id}/action`, { method: 'POST', body: { type: 'page-switch', pageIndex: currentPageIdx + 1 } });
    } else {
      currentPageIdx += 1;
      rebuildInkCache();
      loadBgUrl(getCurrentPage().bgUrl);
      syncPageControlsUi();
      renderBoardFrame();
    }
  }

  shell.querySelector('#board-prev-page')?.addEventListener('click', goPrevPage);
  shell.querySelector('#board-next-page')?.addEventListener('click', goNextPage);

  shell.querySelector('#student-follow-page-btn')?.addEventListener('click', () => {
    currentPageIdx = teacherPageIdx;
    rebuildInkCache();
    loadBgUrl(getCurrentPage().bgUrl);
    syncPageControlsUi();
    renderBoardFrame();
  });

  shell.querySelector('#board-add-page')?.addEventListener('click', async () => {
    try {
      await api(`/api/classroom/${lesson.id}/action`, { method: 'POST', body: { type: 'page-add' } });
    } catch (err) { showToast(err.message, true); }
  });

  shell.querySelector('#board-del-page')?.addEventListener('click', async () => {
    if (wbPages.length <= 1 || !confirm(`确认删除第 ${currentPageIdx + 1} 页白板？`)) return;
    await api(`/api/classroom/${lesson.id}/action`, { method: 'POST', body: { type: 'page-delete' } });
  });

  shell.querySelector('#student-draw-btn')?.addEventListener('click', async () => {
    await api(`/api/classroom/${lesson.id}/action`, { method: 'POST', body: { type: 'student-draw-toggle', allowed: !allowStudentDraw } });
  });

  // --- 保存当前页 & 导出全部板书 ---
  shell.querySelector('#save-board-btn')?.addEventListener('click', async () => {
    renderBoardFrame();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const pageSuffix = wbPages.length > 1 ? `_P${currentPageIdx + 1}` : '';
    const filename = `${lesson.title}_板书${pageSuffix}_${new Date().toTimeString().slice(0, 5).replace(':', '')}.png`;
    try {
      const q = new URLSearchParams({ scope: 'lesson', targetId: lesson.id, category: '课后板书', filename });
      const res = await api(`/api/materials/upload?${q}`, {
        method: 'POST',
        rawBody: blob,
        headers: { 'Content-Type': 'image/png' }
      });
      app.state = res.state;
      updateNavCounts();
      renderLiveMaterialsPane();
      showToast('板书已保存至本课资料（不影响当前语音与录制）');
    } catch (err) { showToast(err.message, true); }
  });

  shell.querySelector('#export-all-board-btn')?.addEventListener('click', async () => {
    closeBoardMenus();
    try {
      showToast('正在合并全部板书…');
      const total = wbPages.length;
      const gap = 16;
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = canvas.width;
      exportCanvas.height = total * canvas.height + (total - 1) * gap;
      const eCtx = exportCanvas.getContext('2d');
      eCtx.fillStyle = '#0f1419';
      eCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

      for (let i = 0; i < total; i++) {
        const p = wbPages[i];
        let pImg = null;
        if (p.bgUrl && !Object.prototype.hasOwnProperty.call(BG_PRESETS, p.bgUrl)) {
          pImg = await new Promise((resolve) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => resolve(null);
            im.src = p.bgUrl;
          });
        }
        const pageCanvas = document.createElement('canvas');
        pageCanvas.width = canvas.width;
        pageCanvas.height = canvas.height;
        const pCtx = pageCanvas.getContext('2d');
        renderPageToContext(pCtx, p, canvas.width, canvas.height, pImg);
        const pageInk = document.createElement('canvas');
        pageInk.width = canvas.width;
        pageInk.height = canvas.height;
        const pInkCtx = pageInk.getContext('2d');
        for (const s of p.strokes || []) drawStrokeOn(pInkCtx, s, true);
        pCtx.drawImage(pageInk, 0, 0);
        eCtx.drawImage(pageCanvas, 0, i * (canvas.height + gap));
      }

      const blob = await new Promise(resolve => exportCanvas.toBlob(resolve, 'image/png'));
      const filename = `${lesson.title}_全课板书_${total}页_${new Date().toTimeString().slice(0, 5).replace(':', '')}.png`;
      const q = new URLSearchParams({ scope: 'lesson', targetId: lesson.id, category: '课后板书', filename });
      const res = await api(`/api/materials/upload?${q}`, {
        method: 'POST',
        rawBody: blob,
        headers: { 'Content-Type': 'image/png' }
      });
      app.state = res.state;
      updateNavCounts();
      renderLiveMaterialsPane();

      const dlUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = dlUrl;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(dlUrl), 3000);
      showToast(`已导出并保存全课 ${total} 页板书`);
    } catch (err) {
      showToast(`导出失败：${err.message}`, true);
    }
  });

  // --- 粘贴截图 & 快捷键 ---
  async function handlePaste(e) {
    if (!canDrawNow()) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) return;
        try {
          showToast('正在粘贴图片到白板…');
          const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
          const filename = `${lesson.title}_截图_${Date.now().toString().slice(-4)}.${ext}`;
          const q = new URLSearchParams({ scope: 'lesson', targetId: lesson.id, category: '课堂截图', filename });
          const upRes = await api(`/api/materials/upload?${q}`, {
            method: 'POST',
            rawBody: file,
            headers: { 'Content-Type': file.type }
          });
          app.state = upRes.state;
          updateNavCounts();
          renderLiveMaterialsPane();
          const url = `/api/materials/${upRes.material.id}/file`;
          const dims = await new Promise((resolve) => {
            const im = new Image();
            im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
            im.onerror = () => resolve({ w: 600, h: 400 });
            im.src = url;
          });
          const maxNormW = 0.55;
          const aspect = (dims.h / Math.max(1, dims.w)) * (canvas.width / canvas.height);
          let normW = maxNormW;
          let normH = normW * aspect;
          if (normH > 0.72) {
            normH = 0.72;
            normW = normH / Math.max(0.01, aspect);
          }
          const stroke = {
            kind: 'image',
            url,
            x: Number(((1 - normW) / 2).toFixed(4)),
            y: Number(((1 - normH) / 2).toFixed(4)),
            w: Number(normW.toFixed(4)),
            h: Number(normH.toFixed(4))
          };
          getCurrentPage().strokes.push(stroke);
          redoStacks.set(currentPageIdx, []);
          getCachedStrokeImage(url);
          drawStrokeOn(inkCtx, stroke, true);
          renderBoardFrame();
          syncPageControlsUi();
          await api(`/api/classroom/${lesson.id}/action`, {
            method: 'POST',
            body: { type: 'stroke', clientId: myClientId, stroke }
          });
          showToast('截图已贴入白板');
        } catch (err) {
          showToast(`粘贴失败：${err.message}`, true);
        }
        break;
      }
    }
  }

  function handleKeydown(e) {
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === 'Escape' && isFullscreenMode) {
      setFullscreenState(false);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) triggerRedo();
      else triggerUndo();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      triggerRedo();
      return;
    }
    if (e.key === 'ArrowLeft') { e.preventDefault(); goPrevPage(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); goNextPage(); }
  }

  document.addEventListener('paste', handlePaste);
  document.addEventListener('keydown', handleKeydown);
  syncPageControlsUi();
  renderBoardFrame();

  // --- 语音（软静音 + 设备选择）、连线音视频、投屏与录制 ---
  let localScreenStream = null;
  let localMicStream = null;
  let localCamStream = null;
  let isMicMuted = false;
  let selectedMicDeviceId = '';
  let currentSharingClientId = null;
  let currentSharingStreamId = '';
  const peerConnections = new Map();
  const peerStates = new Map();
  const remoteAudioStreams = new Map();
  const remoteCamStreams = new Map();
  const audioContainer = document.querySelector('#remote-audio-container');
  audioContainer.innerHTML = '';

  const linkStage = shell.querySelector('#live-link-stage');
  const linkStageGrid = shell.querySelector('#link-stage-grid');
  const linkStageHint = shell.querySelector('#link-stage-hint');
  const screenStage = shell.querySelector('#screen-stage');
  const remoteVideo = shell.querySelector('#remote-screen-video');

  let audioCtx = null;
  let mixDest = null;
  let micMeterTimer = null;
  const connectedMixSources = new Map();

  function ensureAudioMixer() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      mixDest = audioCtx.createMediaStreamDestination();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return mixDest;
  }

  function startMicLevelMeter(stream) {
    const meterEl = shell.querySelector('#mic-level-meter');
    if (!meterEl || !stream) return;
    try {
      ensureAudioMixer();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 32;
      const src = audioCtx.createMediaStreamSource(stream);
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const bars = [...meterEl.querySelectorAll('.mic-level-bar')];
      meterEl.hidden = false;
      clearInterval(micMeterTimer);
      micMeterTimer = setInterval(() => {
        if (isMicMuted) {
          bars.forEach(b => { b.style.height = '3px'; });
          return;
        }
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((s, v) => s + v, 0) / Math.max(1, data.length);
        bars.forEach((b, idx) => {
          const h = Math.min(14, Math.max(3, Math.round((avg / 180) * (10 + idx * 1.5))));
          b.style.height = `${h}px`;
        });
      }, 120);
    } catch {}
  }

  function stopMicLevelMeter() {
    clearInterval(micMeterTimer);
    micMeterTimer = null;
    const meterEl = shell.querySelector('#mic-level-meter');
    if (meterEl) meterEl.hidden = true;
  }

  function attachStreamToMixer(stream) {
    if (!stream || !audioCtx || !mixDest || connectedMixSources.has(stream.id)) return;
    if (stream.getAudioTracks().length === 0) return;
    try {
      const src = audioCtx.createMediaStreamSource(stream);
      src.connect(mixDest);
      connectedMixSources.set(stream.id, src);
    } catch {}
  }

  function detachStreamFromMixer(stream) {
    if (!stream) return;
    const src = connectedMixSources.get(stream.id);
    if (src) {
      try { src.disconnect(); } catch {}
      connectedMixSources.delete(stream.id);
    }
  }

  function getOutboundTrackEntries() {
    const entries = [];
    if (localScreenStream) {
      for (const t of localScreenStream.getTracks()) entries.push({ track: t, stream: localScreenStream });
    }
    if (localCamStream) {
      for (const t of localCamStream.getVideoTracks()) entries.push({ track: t, stream: localCamStream });
    }
    if (localMicStream) {
      for (const t of localMicStream.getAudioTracks()) entries.push({ track: t, stream: localMicStream });
    }
    return entries;
  }

  function getOutboundTracks() {
    return getOutboundTrackEntries().map(e => e.track);
  }

  function closePeer(remoteClientId) {
    const pc = peerConnections.get(remoteClientId);
    if (pc) {
      try { pc.close(); } catch {}
      peerConnections.delete(remoteClientId);
    }
    peerStates.delete(remoteClientId);
    const rStream = remoteAudioStreams.get(remoteClientId);
    if (rStream) {
      detachStreamFromMixer(rStream);
      remoteAudioStreams.delete(remoteClientId);
    }
    remoteCamStreams.delete(remoteClientId);
    const audioEl = audioContainer.querySelector(`[data-peer="${remoteClientId}"]`);
    if (audioEl) {
      audioEl.srcObject = null;
      audioEl.remove();
    }
    remoteLiveStrokes.delete(remoteClientId);
  }

  async function sendOfferForPeer(remoteClientId, pc) {
    const st = peerStates.get(remoteClientId);
    if (!st || st.makingOffer) return;
    try {
      st.makingOffer = true;
      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);
      await api(`/api/classroom/${lesson.id}/action`, {
        method: 'POST',
        body: { type: 'rtc-signal', fromClientId: myClientId, toClientId: remoteClientId, sdp: pc.localDescription }
      }).catch(() => {});
    } catch {} finally {
      st.makingOffer = false;
    }
  }

  async function syncAllPeersWithLocalTracks() {
    const entries = getOutboundTrackEntries();
    const activeTrackIds = new Set(entries.map(e => e.track.id));
    for (const r of currentRoster) {
      if (r.clientId === myClientId) continue;
      const pc = peerConnections.get(r.clientId) || createPeer(r.clientId, false);
      let changed = false;
      for (const sender of pc.getSenders()) {
        if (sender.track && !activeTrackIds.has(sender.track.id)) {
          try { pc.removeTrack(sender); changed = true; } catch {}
        }
      }
      const curSenders = pc.getSenders();
      for (const { track, stream } of entries) {
        if (!curSenders.some(s => s.track && s.track.id === track.id)) {
          pc.addTrack(track, stream);
          changed = true;
        }
      }
      if (changed) await sendOfferForPeer(r.clientId, pc);
    }
  }

  async function removeLocalStreamTracks(stream) {
    if (!stream) return;
    detachStreamFromMixer(stream);
    const ids = new Set(stream.getTracks().map(t => t.id));
    for (const [remoteClientId, pc] of peerConnections.entries()) {
      let removed = false;
      for (const sender of pc.getSenders()) {
        if (sender.track && ids.has(sender.track.id)) {
          try { pc.removeTrack(sender); removed = true; } catch {}
        }
      }
      if (removed) await sendOfferForPeer(remoteClientId, pc);
    }
    stream.getTracks().forEach(t => t.stop());
  }

  function isScreenVideoStream(remoteClientId, stream) {
    if (currentSharingStreamId && stream.id === currentSharingStreamId) return true;
    const peer = currentRoster.find(r => r.clientId === remoteClientId);
    if (peer?.camStreamId && stream.id === peer.camStreamId) return false;
    return remoteClientId === currentSharingClientId && !peer?.camActive;
  }

  function createPeer(remoteClientId, isInitiator) {
    if (peerConnections.has(remoteClientId)) return peerConnections.get(remoteClientId);
    const pc = new RTCPeerConnection({ iceServers: parseOrgIceServers() });
    peerConnections.set(remoteClientId, pc);
    peerStates.set(remoteClientId, {
      makingOffer: false,
      ignoreOffer: false,
      polite: myClientId.localeCompare(remoteClientId) < 0
    });

    for (const { track, stream } of getOutboundTrackEntries()) {
      pc.addTrack(track, stream);
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        api(`/api/classroom/${lesson.id}/action`, {
          method: 'POST',
          body: { type: 'rtc-signal', fromClientId: myClientId, toClientId: remoteClientId, candidate: ev.candidate }
        }).catch(() => {});
      }
    };

    pc.ontrack = (ev) => {
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      if (ev.track.kind === 'video') {
        if (isScreenVideoStream(remoteClientId, stream)) {
          screenStage.hidden = false;
          remoteVideo.srcObject = stream;
          ev.track.onended = () => {
            if (!localScreenStream) screenStage.hidden = true;
          };
        } else {
          remoteCamStreams.set(remoteClientId, stream);
          renderLinkStage();
          ev.track.onended = () => {
            if (remoteCamStreams.get(remoteClientId)?.id === stream.id) {
              remoteCamStreams.delete(remoteClientId);
              renderLinkStage();
            }
          };
        }
      } else if (ev.track.kind === 'audio') {
        const prev = remoteAudioStreams.get(remoteClientId);
        if (prev && prev.id !== stream.id) detachStreamFromMixer(prev);
        remoteAudioStreams.set(remoteClientId, stream);
        let audioEl = audioContainer.querySelector(`[data-peer="${remoteClientId}"]`);
        if (!audioEl) {
          audioEl = document.createElement('audio');
          audioEl.autoplay = true;
          audioEl.setAttribute('data-peer', remoteClientId);
          audioContainer.append(audioEl);
        }
        audioEl.srcObject = stream;
        attachStreamToMixer(stream);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        pc.restartIce?.();
      }
    };

    if (isInitiator) {
      sendOfferForPeer(remoteClientId, pc);
    }
    return pc;
  }

  const micDevSel = shell.querySelector('#mic-device-select');
  const micDevWrap = shell.querySelector('#mic-device-wrap');
  async function refreshMicDevices() {
    if (!micDevSel || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
      if (devs.length > 1) {
        micDevSel.innerHTML = devs.map((d, i) =>
          `<option value="${esc(d.deviceId)}" ${d.deviceId === selectedMicDeviceId ? 'selected' : ''}>${esc(d.label || `麦克风 ${i + 1}`)}</option>`
        ).join('');
        if (micDevWrap) micDevWrap.hidden = false;
      }
    } catch {}
  }

  const teacherMicBtn = shell.querySelector('#teacher-mic-btn');
  const teacherMuteBtn = shell.querySelector('#teacher-mic-mute-btn');
  async function openTeacherMic() {
    const constraints = selectedMicDeviceId ? { audio: { deviceId: { exact: selectedMicDeviceId } } } : { audio: true };
    localMicStream = await navigator.mediaDevices.getUserMedia(constraints);
    isMicMuted = false;
    attachStreamToMixer(localMicStream);
    startMicLevelMeter(localMicStream);
    await refreshMicDevices();
    if (teacherMicBtn) {
      teacherMicBtn.textContent = '关语音';
      teacherMicBtn.classList.add('is-active');
    }
    if (teacherMuteBtn) {
      teacherMuteBtn.hidden = false;
      teacherMuteBtn.textContent = '静音';
      teacherMuteBtn.classList.remove('is-active');
    }
    await syncAllPeersWithLocalTracks();
  }

  if (teacherMicBtn) {
    teacherMicBtn.addEventListener('click', async () => {
      if (localMicStream) {
        const old = localMicStream;
        localMicStream = null;
        isMicMuted = false;
        stopMicLevelMeter();
        await removeLocalStreamTracks(old);
        teacherMicBtn.textContent = '语音';
        teacherMicBtn.classList.remove('is-active');
        if (teacherMuteBtn) teacherMuteBtn.hidden = true;
        showToast('语音已关闭');
        return;
      }
      try {
        await openTeacherMic();
        showToast('语音已开启');
      } catch {
        showToast('未获得麦克风权限', true);
      }
    });
  }

  async function toggleSoftMute(btn) {
    if (!localMicStream) return;
    isMicMuted = !isMicMuted;
    localMicStream.getAudioTracks().forEach(t => { t.enabled = !isMicMuted; });
    if (btn) {
      btn.textContent = isMicMuted ? '取消静音' : '静音';
      btn.classList.toggle('is-active', isMicMuted);
    }
    await api(`/api/classroom/${lesson.id}/action`, {
      method: 'POST',
      body: { type: 'mic-mute', clientId: myClientId, muted: isMicMuted }
    }).catch(() => {});
  }

  teacherMuteBtn?.addEventListener('click', () => toggleSoftMute(teacherMuteBtn));
  micDevSel?.addEventListener('change', async (e) => {
    selectedMicDeviceId = e.target.value;
    if (localMicStream) {
      const old = localMicStream;
      localMicStream = null;
      stopMicLevelMeter();
      await removeLocalStreamTracks(old);
      await openTeacherMic().catch(() => {});
      showToast('已切换麦克风设备');
    }
  });

  const teacherCamBtn = shell.querySelector('#teacher-cam-btn');
  async function toggleLocalCamera(btn, forceState = null) {
    const shouldEnable = forceState !== null ? forceState : !localCamStream;
    if (!shouldEnable) {
      if (!localCamStream) return;
      const old = localCamStream;
      localCamStream = null;
      await removeLocalStreamTracks(old);
      if (btn) {
        btn.textContent = btn === teacherCamBtn ? '摄像头' : '开启摄像头';
        btn.classList.remove('is-active');
      }
      await api(`/api/classroom/${lesson.id}/action`, {
        method: 'POST',
        body: { type: 'cam-state', clientId: myClientId, active: false, streamId: '' }
      }).catch(() => {});
      renderLinkStage();
      return;
    }
    if (localCamStream) return;
    try {
      localCamStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 } } });
      if (btn) {
        btn.textContent = btn === teacherCamBtn ? '关镜头' : '关闭摄像头';
        btn.classList.add('is-active');
      }
      await api(`/api/classroom/${lesson.id}/action`, {
        method: 'POST',
        body: { type: 'cam-state', clientId: myClientId, active: true, streamId: localCamStream.id }
      }).catch(() => {});
      await syncAllPeersWithLocalTracks();
      renderLinkStage();
    } catch {
      showToast('未获得摄像头权限或设备不可用', true);
    }
  }
  teacherCamBtn?.addEventListener('click', () => toggleLocalCamera(teacherCamBtn));

  const shareStatusPill = shell.querySelector('#share-status-pill');
  function syncShareStatusUi() {
    const isSharing = Boolean(localScreenStream || currentSharingClientId);
    if (shareStatusPill) {
      shareStatusPill.className = isSharing ? 'status-pill is-ok' : 'page-badge';
      shareStatusPill.textContent = isSharing ? (localScreenStream ? '屏幕共享中' : '老师共享中') : '未共享';
    }
    syncTeacherHudStatus?.();
  }

  const shareBtn = shell.querySelector('#share-screen-btn');
  if (shareBtn) {
    shareBtn.addEventListener('click', async () => {
      if (localScreenStream) {
        const old = localScreenStream;
        localScreenStream = null;
        await removeLocalStreamTracks(old);
        screenStage.hidden = true;
        remoteVideo.srcObject = null;
        shareBtn.textContent = '共享屏幕';
        shareBtn.classList.remove('is-active');
        syncShareStatusUi();
        await api(`/api/classroom/${lesson.id}/action`, {
          method: 'POST',
          body: { type: 'share-state', clientId: myClientId, sharing: false, streamId: '' }
        });
        return;
      }
      try {
        localScreenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        attachStreamToMixer(localScreenStream);
        screenStage.hidden = false;
        remoteVideo.srcObject = localScreenStream;
        remoteVideo.muted = true;
        shareBtn.textContent = '停止共享';
        shareBtn.classList.add('is-active');
        syncShareStatusUi();

        localScreenStream.getVideoTracks()[0].onended = () => {
          if (localScreenStream) shareBtn.click();
        };

        await api(`/api/classroom/${lesson.id}/action`, {
          method: 'POST',
          body: { type: 'share-state', clientId: myClientId, sharing: true, streamId: localScreenStream.id }
        });
        await syncAllPeersWithLocalTracks();
        const opened = await openTeacherHud({ silent: true });
        if (!opened) {
          showToast('屏幕共享已开启，可点击「互动小窗」悬浮查看学生发言');
        }
      } catch {
        showToast('已取消共享');
      }
    });
  }

  const EARLY_START_WINDOW_MS = 10 * 60 * 1000;
  let lessonStatus = lesson.status || 'scheduled';
  const classSessionBtn = shell.querySelector('#class-session-btn');
  const classStatusPill = shell.querySelector('#class-status-pill');
  const studentWaitingCard = shell.querySelector('#student-waiting-card');

  let mediaRecorder = null;
  let activeRecId = null;
  let compositeTimer = null;
  let recClockTimer = null;
  let recordStartMs = 0;
  let pausedAccumMs = 0;
  let pauseStartedMs = 0;
  let lastUploadedBytes = 0;
  let uploadChain = Promise.resolve();
  let recordingFinishPromise = null;
  let recordingOutcome = null;
  const recordBtn = shell.querySelector('#record-class-btn');
  const pauseRecordBtn = shell.querySelector('#pause-record-btn');
  const recBadge = shell.querySelector('#rec-progress-badge');
  const recoverRecBtn = shell.querySelector('#rec-recover-btn');
  recoverRecBtn?.addEventListener('click', async () => {
    recoverRecBtn.disabled = true;
    try {
      app.state = await api('/api/state');
      switchView('vod', { pendingRecordingId: recordingOutcome?.id });
    } catch (err) {
      showToast(`刷新回放状态失败：${err.message}`, true);
    } finally {
      recoverRecBtn.disabled = false;
    }
  });

  function getRecordingElapsedSec() {
    if (!recordStartMs) return 0;
    const pausedNow = pauseStartedMs ? (Date.now() - pauseStartedMs) : 0;
    return Math.max(0, (Date.now() - recordStartMs - pausedAccumMs - pausedNow) / 1000);
  }

  function stopRecordingAndWait() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    return recordingFinishPromise;
  }

  function syncClassSessionUi() {
    const canStartNow = Date.now() >= Number(lesson.start_ms) - EARLY_START_WINDOW_MS;
    const unlockTimeStr = new Date(Number(lesson.start_ms) - EARLY_START_WINDOW_MS).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    if (classStatusPill) {
      if (lessonStatus === 'in_progress') {
        classStatusPill.className = 'status-pill is-ok';
        classStatusPill.textContent = '上课中';
      } else if (lessonStatus === 'completed') {
        classStatusPill.className = 'page-badge';
        classStatusPill.textContent = '已完课';
      } else if (lessonStatus === 'cancelled') {
        classStatusPill.className = 'status-pill is-danger';
        classStatusPill.textContent = '已取消';
      } else {
        classStatusPill.className = 'status-pill is-warn';
        classStatusPill.textContent = '待开课';
      }
    }

    if (classSessionBtn) {
      if (lessonStatus === 'in_progress') {
        classSessionBtn.textContent = '下课';
        classSessionBtn.className = 'danger-button';
        classSessionBtn.disabled = false;
        classSessionBtn.title = '结束上课，自动结束并保存录制并打开点名';
      } else if (lessonStatus === 'completed') {
        classSessionBtn.textContent = '已完课';
        classSessionBtn.className = 'secondary-button';
        classSessionBtn.disabled = true;
        classSessionBtn.title = '本课已完课';
      } else if (lessonStatus === 'cancelled') {
        classSessionBtn.textContent = '已取消';
        classSessionBtn.className = 'secondary-button';
        classSessionBtn.disabled = true;
        classSessionBtn.title = '本课已取消';
      } else {
        classSessionBtn.textContent = canStartNow ? '上课' : '未到时间';
        classSessionBtn.className = 'primary-button';
        classSessionBtn.disabled = !canStartNow;
        classSessionBtn.title = canStartNow
          ? '点击开始上课，学生即可进入课堂发言'
          : `约定时间前 10 分钟可点击上课（${unlockTimeStr} 起可点击）`;
      }
    }

    const isRecActive = Boolean(mediaRecorder && mediaRecorder.state !== 'inactive');
    if (recordBtn && !isRecActive) {
      recordBtn.disabled = lessonStatus !== 'in_progress' || Boolean(recordingFinishPromise);
      recordBtn.title = lessonStatus === 'in_progress'
        ? '开始录制当前课堂'
        : '请先点击「上课」后再开始录制';
    }

    if (!isTeacher()) {
      const inClass = lessonStatus === 'in_progress';
      const isWaiting = lessonStatus === 'scheduled';
      if (studentWaitingCard) studentWaitingCard.hidden = !isWaiting;
      if (classroomGrid) classroomGrid.hidden = isWaiting;

      const chatInput = shell.querySelector('#live-chat-form input[name="text"]');
      const chatSubmit = shell.querySelector('#live-chat-form button[type="submit"]');
      if (chatInput) {
        chatInput.disabled = !inClass;
        chatInput.placeholder = inClass ? '发消息...' : (lessonStatus === 'completed' ? '本课已下课' : '开课后可发言…');
      }
      if (chatSubmit) chatSubmit.disabled = !inClass;
      if (handBtn) {
        handBtn.disabled = !inClass;
        if (!inClass && !myHandRaised) {
          handBtn.textContent = lessonStatus === 'completed' ? '已下课' : '等待开课';
        } else if (inClass && !handBtn.hidden) {
          handBtn.textContent = myHandRaised ? '取消举手（等待连线…）' : '举手连线';
        }
      }
    }
  }

  const startWindowTimer = setInterval(() => {
    if (lessonStatus === 'scheduled') syncClassSessionUi();
  }, 5000);

  if (recordBtn) {
    recordBtn.addEventListener('click', async () => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        recordBtn.disabled = true;
        recordBtn.textContent = '保存中…';
        if (pauseRecordBtn) pauseRecordBtn.hidden = true;
        mediaRecorder.stop();
        return;
      }

      if (lessonStatus !== 'in_progress') {
        showToast('请先点击「上课」后再开始录制', true);
        return;
      }

      try {
        if (!localMicStream) {
          try { await openTeacherMic(); } catch {}
        }

        const filename = `${lesson.title}_回放_${new Date().toTimeString().slice(0, 5).replace(':', '')}.webm`;
        const initRes = await api('/api/recordings/init', {
          method: 'POST',
          body: { lessonId: lesson.id, title: `${lesson.title} 回放`, filename, mimeType: 'video/webm' }
        });
        activeRecId = initRes.id;
        recordingOutcome = null;
        if (recoverRecBtn) recoverRecBtn.hidden = true;
        recordStartMs = Date.now();
        pausedAccumMs = 0;
        pauseStartedMs = 0;
        lastUploadedBytes = 0;
        uploadChain = Promise.resolve();

        const compCanvas = document.createElement('canvas');
        compCanvas.width = 1280;
        compCanvas.height = 720;
        const compCtx = compCanvas.getContext('2d');
        compositeTimer = setInterval(() => {
          compCtx.fillStyle = '#0f1419';
          compCtx.fillRect(0, 0, compCanvas.width, compCanvas.height);
          if (localScreenStream && remoteVideo.readyState >= 2 && remoteVideo.videoWidth > 0) {
            drawContain(compCtx, remoteVideo, remoteVideo.videoWidth, remoteVideo.videoHeight, compCanvas.width, compCanvas.height);
          } else {
            drawContain(compCtx, canvas, canvas.width, canvas.height, compCanvas.width, compCanvas.height);
          }
        }, 50);

        const dest = ensureAudioMixer();
        if (localMicStream) attachStreamToMixer(localMicStream);
        if (localScreenStream) attachStreamToMixer(localScreenStream);
        for (const s of remoteAudioStreams.values()) attachStreamToMixer(s);

        const mixedStream = new MediaStream([
          ...compCanvas.captureStream(20).getVideoTracks(),
          ...dest.stream.getAudioTracks()
        ]);

        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
          ? 'video/webm;codecs=vp8,opus'
          : 'video/webm';
        mediaRecorder = new MediaRecorder(mixedStream, { mimeType, videoBitsPerSecond: 1000000 });

        let nextSeq = 0;
        const failedChunks = new Map();

        async function uploadChunkWithRetry(recId, seq, blob, maxAttempts = 3) {
          let lastErr = null;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              const res = await fetch(`/api/recordings/${recId}/chunk?seq=${seq}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: blob
              });
              const json = await res.json();
              if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
              failedChunks.delete(seq);
              return json;
            } catch (err) {
              lastErr = err;
              if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 800 * attempt));
            }
          }
          failedChunks.set(seq, blob);
          throw lastErr;
        }

        function updateRecBadge() {
          if (!recBadge) return;
          const elapsed = formatDuration(getRecordingElapsedSec());
          const isPaused = mediaRecorder?.state === 'paused';
          if (isPaused) {
            recBadge.className = 'status-pill is-warn';
            recBadge.textContent = `已暂停 ${elapsed}`;
          } else {
            recBadge.className = 'page-badge is-live';
            if (failedChunks.size > 0) {
              recBadge.innerHTML = `<span class="rec-dot"></span>录制中 ${elapsed} · ${failedChunks.size} 片待重传`;
            } else {
              const sizeHint = lastUploadedBytes ? ` · ${formatSize(lastUploadedBytes)}` : '';
              recBadge.innerHTML = `<span class="rec-dot"></span>录制中 ${elapsed}${sizeHint}`;
            }
          }
          syncTeacherHudStatus?.();
        }

        recClockTimer = setInterval(updateRecBadge, 1000);
        app.liveIsRecording = true;
        updateRecBadge();

        mediaRecorder.ondataavailable = (ev) => {
          if (!ev.data || ev.data.size === 0 || !activeRecId) return;
          const recId = activeRecId;
          const seq = nextSeq++;
          const chunkBlob = ev.data;
          uploadChain = uploadChain.then(async () => {
            try {
              const json = await uploadChunkWithRetry(recId, seq, chunkBlob);
              lastUploadedBytes = json.sizeBytes || lastUploadedBytes;
              updateRecBadge();
            } catch {
              updateRecBadge();
            }
          });
        };

        mediaRecorder.onpause = () => {
          pauseStartedMs = Date.now();
          if (pauseRecordBtn) {
            pauseRecordBtn.textContent = '继续录制';
            pauseRecordBtn.classList.add('is-active');
          }
          updateRecBadge();
          showToast('录制已暂停（课程仍在上课中）');
        };

        mediaRecorder.onresume = () => {
          if (pauseStartedMs) {
            pausedAccumMs += Date.now() - pauseStartedMs;
            pauseStartedMs = 0;
          }
          if (pauseRecordBtn) {
            pauseRecordBtn.textContent = '暂停录制';
            pauseRecordBtn.classList.remove('is-active');
          }
          updateRecBadge();
          showToast('已继续录制');
        };

        let resolveFinish;
        recordingFinishPromise = new Promise(r => { resolveFinish = r; });
        mediaRecorder.onstop = async () => {
          recordBtn.disabled = true;
          recordBtn.textContent = '正在保存回放…';
          if (pauseStartedMs) {
            pausedAccumMs += Date.now() - pauseStartedMs;
            pauseStartedMs = 0;
          }
          clearInterval(compositeTimer);
          clearInterval(recClockTimer);
          compositeTimer = null;
          recClockTimer = null;
          if (pauseRecordBtn) {
            pauseRecordBtn.hidden = true;
            pauseRecordBtn.textContent = '暂停录制';
            pauseRecordBtn.classList.remove('is-active');
          }
          await uploadChain;

          for (const [seq, blob] of [...failedChunks.entries()]) {
            try { await uploadChunkWithRetry(activeRecId, seq, blob, 3); } catch {}
          }

          const durationSec = Math.max(1, Math.round(getRecordingElapsedSec()));
          try {
            const finRes = await api(`/api/recordings/${activeRecId}/finish`, {
              method: 'POST',
              body: {
                totalChunks: nextSeq,
                durationSec,
                title: `${lesson.title}（${formatDuration(durationSec)}）`
              }
            });
            app.state = finRes.state;
            updateNavCounts();
            recordingOutcome = { id: activeRecId, status: 'saved' };
            activeRecId = null;
            if (recBadge) {
              recBadge.className = 'page-badge is-accent';
              recBadge.textContent = '已保存回放';
            }
            syncTeacherHudStatus?.();
            showToast('录制完成，已存入回放');
          } catch (err) {
            recordingOutcome = { id: activeRecId, status: 'unconfirmed' };
            if (recBadge) {
              recBadge.className = 'status-pill is-warn';
              recBadge.textContent = '回放待核对';
            }
            if (recoverRecBtn) recoverRecBtn.hidden = false;
            syncTeacherHudStatus?.();
            showToast(`录制保存失败：${err.message}`, true);
          }
          app.liveIsRecording = false;
          recordBtn.disabled = lessonStatus !== 'in_progress';
          recordBtn.textContent = '开始录制';
          recordBtn.className = 'secondary-button';
          resolveFinish?.();
          recordingFinishPromise = null;
        };

        mediaRecorder.start(10000);
        recordBtn.textContent = '结束录制';
        recordBtn.className = 'secondary-button is-recording';
        if (pauseRecordBtn) {
          pauseRecordBtn.hidden = false;
          pauseRecordBtn.textContent = '暂停录制';
          pauseRecordBtn.classList.remove('is-active');
        }
        showToast('已开始录制');
      } catch (err) {
        clearInterval(compositeTimer);
        clearInterval(recClockTimer);
        compositeTimer = recClockTimer = null;
        recordingFinishPromise = null;
        app.liveIsRecording = false;
        showToast(err.message, true);
      }
    });
  }

  pauseRecordBtn?.addEventListener('click', () => {
    if (!mediaRecorder) return;
    if (mediaRecorder.state === 'recording') {
      mediaRecorder.pause();
    } else if (mediaRecorder.state === 'paused') {
      mediaRecorder.resume();
    }
  });

  // 上课 / 下课主控按钮：开课前10分钟可点击上课；点击下课自动结束录制、标为完课并点名
  classSessionBtn?.addEventListener('click', async () => {
    if (lessonStatus === 'scheduled') {
      try {
        classSessionBtn.disabled = true;
        app.state = await api(`/api/lessons/${lesson.id}/status`, { method: 'PATCH', body: { status: 'in_progress' } });
        lessonStatus = 'in_progress';
        syncClassSessionUi();
        showToast('已开始上课，学生可进入课堂发言；如需录制请点击「开始录制」');
      } catch (err) {
        syncClassSessionUi();
        showToast(err.message, true);
      }
      return;
    }

    if (lessonStatus === 'in_progress') {
      if (!confirm('确认下课？系统会尝试保存当前录制，并打开出勤点名。')) return;
      classSessionBtn.disabled = true;
      if (recordingFinishPromise) {
        showToast('正在自动结束并保存录制，请稍候…');
        await stopRecordingAndWait();
      }
      try {
        app.state = await api(`/api/lessons/${lesson.id}/status`, { method: 'PATCH', body: { status: 'completed' } });
        lessonStatus = 'completed';
        syncClassSessionUi();
        showToast('已下课并标记完课');
        openLessonDetailModal(lesson.id, 'attendance', recordingOutcome);
      } catch (err) {
        syncClassSessionUi();
        showToast(err.message, true);
      }
    }
  });

  const handBtn = shell.querySelector('#raise-hand-btn');
  const studentMuteBtn = shell.querySelector('#student-mic-mute-btn');
  const studentCamBtn = shell.querySelector('#student-cam-btn');
  const studentHangupBtn = shell.querySelector('#student-hangup-btn');

  function syncHandButtonUi(me) {
    if (!handBtn) return;
    if (me?.micAllowed) {
      myHandRaised = false;
      handBtn.hidden = true;
      return;
    }
    handBtn.hidden = false;
    handBtn.textContent = myHandRaised ? '取消举手（等待连线…）' : '举手连线';
    handBtn.className = myHandRaised ? 'secondary-button is-active' : 'primary-button';
  }

  if (handBtn) {
    handBtn.addEventListener('click', async () => {
      if (lessonStatus !== 'in_progress') {
        showToast('老师尚未点击上课，开课后即可举手连线', true);
        return;
      }
      const nextRaised = !myHandRaised;
      try {
        await api(`/api/classroom/${lesson.id}/action`, {
          method: 'POST',
          body: { type: 'hand', clientId: myClientId, raised: nextRaised, mode: 'audio' }
        });
        myHandRaised = nextRaised;
        syncHandButtonUi();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  }
  syncClassSessionUi();

  studentMuteBtn?.addEventListener('click', () => toggleSoftMute(studentMuteBtn));
  studentCamBtn?.addEventListener('click', () => toggleLocalCamera(studentCamBtn));
  studentHangupBtn?.addEventListener('click', async () => {
    await api(`/api/classroom/${lesson.id}/action`, {
      method: 'POST',
      body: { type: 'link-end', clientId: myClientId }
    }).catch(() => {});
  });

  async function syncStudentMicState(me) {
    if (isTeacher() || !me) return;
    syncHandButtonUi(me);
    const badge = shell.querySelector('#student-mic-status');
    if (me.micAllowed && !localMicStream) {
      try {
        localMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        isMicMuted = false;
        if (badge) {
          badge.hidden = false;
          badge.textContent = me.camAllowed ? '视频连线中' : '语音连线中';
        }
        if (studentMuteBtn) {
          studentMuteBtn.hidden = false;
          studentMuteBtn.textContent = '静音';
          studentMuteBtn.classList.remove('is-active');
        }
        if (studentCamBtn) {
          studentCamBtn.hidden = false;
          studentCamBtn.textContent = localCamStream ? '关闭摄像头' : '开启摄像头';
          studentCamBtn.classList.toggle('is-active', Boolean(localCamStream));
        }
        if (studentHangupBtn) studentHangupBtn.hidden = false;
        showToast(me.camAllowed ? '老师已接通视频连线' : '老师已接通语音连线，请发言');
        await syncAllPeersWithLocalTracks();
        if (me.camAllowed && !localCamStream) {
          await toggleLocalCamera(studentCamBtn, true);
        }
        renderLinkStage();
      } catch {
        showToast('未获得麦克风权限，已自动取消连线', true);
        await api(`/api/classroom/${lesson.id}/action`, {
          method: 'POST',
          body: { type: 'link-end', clientId: myClientId }
        }).catch(() => {});
      }
    } else if (!me.micAllowed && (localMicStream || localCamStream)) {
      if (localCamStream) {
        const oldCam = localCamStream;
        localCamStream = null;
        await removeLocalStreamTracks(oldCam);
      }
      if (localMicStream) {
        const old = localMicStream;
        localMicStream = null;
        isMicMuted = false;
        await removeLocalStreamTracks(old);
      }
      if (badge) badge.hidden = true;
      if (studentMuteBtn) studentMuteBtn.hidden = true;
      if (studentCamBtn) {
        studentCamBtn.hidden = true;
        studentCamBtn.textContent = '开启摄像头';
        studentCamBtn.classList.remove('is-active');
      }
      if (studentHangupBtn) studentHangupBtn.hidden = true;
      syncHandButtonUi(me);
      renderLinkStage();
      showToast('已结束连线');
    } else if (me.micAllowed && badge) {
      badge.textContent = localCamStream || me.camActive ? '视频连线中' : '语音连线中';
    }
  }

  let dismissedHandIds = new Set();
  function getSortedRaisedStudents(roster) {
    return roster
      .filter(r => r.role === 'student' && r.handRaised)
      .sort((a, b) => (a.handRaisedAt || 0) - (b.handRaisedAt || 0));
  }

  function updateHandAlertBar(roster) {
    if (!isTeacher()) return;
    const bar = shell.querySelector('#hand-alert-bar');
    const txt = shell.querySelector('#hand-alert-text');
    const allowBtn = shell.querySelector('#hand-alert-allow-btn');
    const avBtn = shell.querySelector('#hand-alert-av-btn');
    const rejectBtn = shell.querySelector('#hand-alert-reject-btn');
    const dismissBtn = shell.querySelector('#hand-alert-dismiss-btn');
    if (!bar || !txt || !allowBtn || !dismissBtn) return;

    const raisedList = getSortedRaisedStudents(roster);
    const rosterBadge = shell.querySelector('#tab-badge-roster');
    if (rosterBadge) {
      rosterBadge.textContent = String(raisedList.length);
      rosterBadge.hidden = raisedList.length === 0;
    }

    const pending = raisedList.filter(r => !dismissedHandIds.has(r.clientId));
    if (pending.length === 0) {
      bar.hidden = true;
      return;
    }
    const first = pending[0];
    txt.textContent = pending.length === 1
      ? `✋ ${first.name} 正在举手申请连线`
      : `✋ ${first.name} 等 ${pending.length} 位同学正在举手排队`;
    bar.hidden = false;
    allowBtn.onclick = async () => {
      await api(`/api/classroom/${lesson.id}/action`, {
        method: 'POST',
        body: { type: 'mic', targetClientId: first.clientId, allowed: true, withVideo: false }
      });
    };
    if (avBtn) {
      avBtn.onclick = async () => {
        await api(`/api/classroom/${lesson.id}/action`, {
          method: 'POST',
          body: { type: 'mic', targetClientId: first.clientId, allowed: true, withVideo: true }
        });
      };
    }
    if (rejectBtn) {
      rejectBtn.onclick = async () => {
        await api(`/api/classroom/${lesson.id}/action`, {
          method: 'POST',
          body: { type: 'hand-reject', targetClientId: first.clientId }
        });
      };
    }
    dismissBtn.onclick = () => {
      pending.forEach(p => dismissedHandIds.add(p.clientId));
      bar.hidden = true;
    };
  }

  function renderLinkStage() {
    if (!linkStage || !linkStageGrid) return;
    const connectedStudents = currentRoster.filter(r => r.role === 'student' && r.micAllowed);
    const anyCamera = Boolean(localCamStream) || currentRoster.some(r => r.camActive || remoteCamStreams.has(r.clientId));
    if (connectedStudents.length === 0 && !anyCamera) {
      linkStage.hidden = true;
      linkStageGrid.innerHTML = '';
      return;
    }

    const participants = currentRoster.filter(r => {
      if (r.role === 'student') return Boolean(r.micAllowed);
      return Boolean(r.camActive || (r.clientId === myClientId && (localCamStream || localMicStream)) || remoteCamStreams.has(r.clientId));
    });
    if (participants.length === 0) {
      linkStage.hidden = true;
      linkStageGrid.innerHTML = '';
      return;
    }

    linkStage.hidden = false;
    if (linkStageHint) {
      linkStageHint.textContent = connectedStudents.length > 0
        ? `${connectedStudents.length} 位学生连线中`
        : '教师视频画面';
    }

    linkStageGrid.innerHTML = participants.map(p => {
      const isMe = p.clientId === myClientId;
      const hasCam = isMe ? Boolean(localCamStream) : (Boolean(p.camActive) || remoteCamStreams.has(p.clientId));
      const initials = esc(String(p.name || '?').slice(0, 2));
      return `
        <div class="link-card ${p.micMuted ? 'is-muted' : 'is-speaking'}" data-link-peer="${esc(p.clientId)}">
          <div class="link-card-media">
            ${hasCam
              ? `<video class="link-video ${isMe ? 'is-mirror' : ''}" data-link-video="${esc(p.clientId)}" autoplay playsinline ${isMe ? 'muted' : ''}></video>`
              : `<div class="link-avatar">${initials}</div>`}
            <span class="link-role-tag">${roleLabel(p.role)}${isMe ? ' (我)' : ''}</span>
            <span class="link-mic-tag ${p.micMuted ? 'is-muted' : ''}">${p.micMuted ? '已静音' : '连线中'}</span>
          </div>
          <div class="link-card-footer">
            <strong class="link-card-name">${esc(p.name)}</strong>
            <div class="link-card-actions">
              ${isTeacher() && p.role === 'student' ? `
                <button type="button" class="secondary-button btn-sm" data-stage-draw="${esc(p.clientId)}" data-draw-next="${!p.drawAllowed}">${p.drawAllowed ? '禁写' : '板书'}</button>
                <button type="button" class="danger-button btn-sm" data-stage-hangup="${esc(p.clientId)}">挂断</button>
              ` : ''}
              ${isMe && !isTeacher() ? `
                <button type="button" class="danger-button btn-sm" data-stage-self-hangup="1">挂断</button>
              ` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');

    for (const p of participants) {
      const vidEl = linkStageGrid.querySelector(`[data-link-video="${CSS.escape(p.clientId)}"]`);
      if (!vidEl) continue;
      const stream = p.clientId === myClientId ? localCamStream : remoteCamStreams.get(p.clientId);
      if (stream && vidEl.srcObject !== stream) {
        vidEl.srcObject = stream;
      }
    }

    linkStageGrid.querySelectorAll('[data-stage-hangup]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await api(`/api/classroom/${lesson.id}/action`, {
          method: 'POST',
          body: { type: 'mic', targetClientId: btn.getAttribute('data-stage-hangup'), allowed: false }
        });
      });
    });

    linkStageGrid.querySelectorAll('[data-stage-draw]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await api(`/api/classroom/${lesson.id}/action`, {
          method: 'POST',
          body: {
            type: 'student-draw-client',
            targetClientId: btn.getAttribute('data-stage-draw'),
            allowed: btn.getAttribute('data-draw-next') === 'true'
          }
        });
      });
    });

    linkStageGrid.querySelector('[data-stage-self-hangup]')?.addEventListener('click', async () => {
      await api(`/api/classroom/${lesson.id}/action`, {
        method: 'POST',
        body: { type: 'link-end', clientId: myClientId }
      }).catch(() => {});
    });
  }

  function renderRoster(roster, sharingClientId, sharingStreamId = '') {
    currentRoster = roster;
    currentSharingClientId = sharingClientId || null;
    currentSharingStreamId = sharingStreamId || '';
    const activeIds = new Set(roster.map(r => r.clientId));
    for (const remoteId of [...peerConnections.keys()]) {
      if (!activeIds.has(remoteId)) closePeer(remoteId);
    }
    for (const r of roster) {
      if (!r.camActive && remoteCamStreams.has(r.clientId)) {
        remoteCamStreams.delete(r.clientId);
      }
    }
    for (const cid of [...dismissedHandIds]) {
      const stillRaised = roster.some(r => r.clientId === cid && r.handRaised);
      if (!stillRaised) dismissedHandIds.delete(cid);
    }

    updateHandAlertBar(roster);

    const raisedRank = new Map();
    getSortedRaisedStudents(roster).forEach((r, idx) => raisedRank.set(r.clientId, idx + 1));

    const sortedRoster = [...roster].sort((a, b) => {
      const score = (x) => (x.role !== 'student' ? 0 : x.micAllowed ? 1 : x.handRaised ? 2 : 3);
      const diff = score(a) - score(b);
      if (diff !== 0) return diff;
      if (a.handRaised && b.handRaised) return (a.handRaisedAt || 0) - (b.handRaisedAt || 0);
      return 0;
    });

    const countEl = shell.querySelector('#roster-count');
    const listEl = shell.querySelector('#live-roster');
    if (!countEl || !listEl) return;
    countEl.textContent = roster.length;
    listEl.innerHTML = sortedRoster.map(r => {
      const rank = raisedRank.get(r.clientId);
      return `
      <div class="item-row" style="padding:8px 10px;gap:6px">
        <div style="font-size:12px;display:flex;align-items:center;gap:5px;flex-wrap:wrap">
          <strong>${esc(r.name)}</strong>
          <span class="page-badge">${roleLabel(r.role)}</span>
          ${r.handRaised ? `<span class="status-pill is-warn">✋ 举手${rank ? ` #${rank}` : ''}</span>` : ''}
          ${r.micAllowed && r.role === 'student' ? `<span class="status-pill is-ok">${r.micMuted ? '已静音' : (r.camActive ? '视频连线' : '语音连线')}</span>` : ''}
          ${r.role === 'student' && r.drawAllowed ? `<span class="page-badge is-accent">可板书</span>` : ''}
        </div>
        ${isTeacher() && r.role === 'student' ? `
          <div style="display:flex;gap:4px;flex-shrink:0;flex-wrap:wrap">
            ${r.handRaised && !r.micAllowed ? `
              <button type="button" class="primary-button btn-sm" data-mic-client="${esc(r.clientId)}" data-mic-next="true" data-mic-video="false">语音</button>
              <button type="button" class="secondary-button btn-sm" data-mic-client="${esc(r.clientId)}" data-mic-next="true" data-mic-video="true">视频</button>
              <button type="button" class="secondary-button btn-sm" data-reject-client="${esc(r.clientId)}">拒绝</button>
            ` : `
              <button type="button" class="${r.micAllowed ? 'danger-button' : 'secondary-button'} btn-sm" data-mic-client="${esc(r.clientId)}" data-mic-next="${!r.micAllowed}" data-mic-video="false">
                ${r.micAllowed ? '挂断' : '连线'}
              </button>
            `}
            <button type="button" class="secondary-button btn-sm" data-draw-client="${esc(r.clientId)}" data-draw-next="${!r.drawAllowed}">
              ${r.drawAllowed ? '禁写' : '板书'}
            </button>
          </div>
        ` : ''}
      </div>
    `;
    }).join('');

    listEl.querySelectorAll('[data-mic-client]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await api(`/api/classroom/${lesson.id}/action`, {
          method: 'POST',
          body: {
            type: 'mic',
            targetClientId: btn.getAttribute('data-mic-client'),
            allowed: btn.getAttribute('data-mic-next') === 'true',
            withVideo: btn.getAttribute('data-mic-video') === 'true'
          }
        });
      });
    });

    listEl.querySelectorAll('[data-reject-client]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await api(`/api/classroom/${lesson.id}/action`, {
          method: 'POST',
          body: {
            type: 'hand-reject',
            targetClientId: btn.getAttribute('data-reject-client')
          }
        });
      });
    });

    listEl.querySelectorAll('[data-draw-client]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await api(`/api/classroom/${lesson.id}/action`, {
          method: 'POST',
          body: {
            type: 'student-draw-client',
            targetClientId: btn.getAttribute('data-draw-client'),
            allowed: btn.getAttribute('data-draw-next') === 'true'
          }
        });
      });
    });

    const me = roster.find(r => r.clientId === myClientId);
    if (me && !isTeacher()) {
      const nextDraw = Boolean(me.drawAllowed);
      if (nextDraw !== myDrawAllowed) {
        myDrawAllowed = nextDraw;
        syncDrawPermissionUi();
      }
      myHandRaised = Boolean(me.handRaised);
      syncHandButtonUi(me);
    }
    syncStudentMicState(me);
    renderLinkStage();
    syncShareStatusUi();
    syncTeacherHud();

    if (getOutboundTracks().length > 0) {
      for (const r of roster) {
        if (r.clientId !== myClientId && !peerConnections.has(r.clientId)) {
          createPeer(r.clientId, true);
        }
      }
    }
    if (!sharingClientId && !localScreenStream) {
      screenStage.hidden = true;
    }
  }

  let chatMessages = [];
  function appendChat(msg, countUnread = false) {
    chatMessages.push(msg);
    const box = shell.querySelector('#live-chat-list');
    if (box) {
      const div = document.createElement('div');
      div.className = 'chat-msg';
      div.innerHTML = `<strong>${esc(msg.name)}</strong> <span style="color:var(--subtle)">${esc(msg.time)}</span><br>${esc(msg.text)}`;
      box.append(div);
      box.scrollTop = box.scrollHeight;
    }
    if (countUnread && app.liveSideTab !== 'chat') {
      unreadChatCount += 1;
      updateChatBadge();
    }
    syncTeacherHud();
  }

  // --- 教师共享屏幕时的悬浮互动小窗（优先 Document PiP，降级独立弹窗） ---
  let hudWindow = null;
  const teacherHudBtn = shell.querySelector('#teacher-hud-btn');
  const screenHudBtn = shell.querySelector('#screen-hud-btn');

  function updateHudButtonUi() {
    const active = Boolean(hudWindow && !hudWindow.closed);
    const hudHint = shell.querySelector('#teacher-hud-hint');
    if (teacherHudBtn) {
      teacherHudBtn.classList.toggle('is-active', active);
    }
    if (hudHint) {
      hudHint.textContent = active ? '已打开' : '悬浮';
    }
    if (screenHudBtn) {
      screenHudBtn.textContent = active ? '关闭互动小窗' : '打开互动小窗';
      screenHudBtn.classList.toggle('is-active', active);
    }
  }

  function closeTeacherHud() {
    if (hudWindow && !hudWindow.closed) {
      try { hudWindow.close(); } catch {}
    }
    hudWindow = null;
    updateHudButtonUi();
  }

  function syncTeacherHudStatus() {
    if (!hudWindow || hudWindow.closed) return;
    const doc = hudWindow.document;
    const sharePill = doc.getElementById('hud-share-pill');
    const recPill = doc.getElementById('hud-rec-pill');
    const isSharing = Boolean(localScreenStream || currentSharingClientId);
    if (sharePill) {
      sharePill.className = isSharing ? 'status-pill is-ok' : 'page-badge';
      sharePill.textContent = isSharing ? '屏幕共享中' : '未共享';
    }
    if (recPill && recBadge) {
      recPill.className = recBadge.className;
      recPill.innerHTML = recBadge.innerHTML;
    }
  }

  function syncTeacherHud() {
    if (!hudWindow || hudWindow.closed) return;
    const doc = hudWindow.document;
    const countEl = doc.getElementById('hud-online-count');
    const handBox = doc.getElementById('hud-hand-box');
    const chatBox = doc.getElementById('hud-chat-list');
    if (!handBox || !chatBox) return;

    if (countEl) countEl.textContent = `${currentRoster.length}人在线`;
    syncTeacherHudStatus();

    const raised = getSortedRaisedStudents(currentRoster);
    const linked = currentRoster.filter(r => r.role === 'student' && r.micAllowed);

    if (raised.length === 0 && linked.length === 0) {
      handBox.innerHTML = `<div class="hud-empty">暂无举手或连线中的学生</div>`;
    } else {
      handBox.innerHTML = [
        ...raised.map((r, idx) => `
          <div class="item-row hud-row is-warn">
            <div class="hud-row-info">
              <strong>✋ ${esc(r.name)}</strong>
              <span class="status-pill is-warn">举手排队 #${idx + 1}</span>
            </div>
            <div class="hud-row-actions">
              <button type="button" class="primary-button btn-sm" data-hud-mic="${esc(r.clientId)}" data-hud-video="false">语音</button>
              <button type="button" class="secondary-button btn-sm" data-hud-mic="${esc(r.clientId)}" data-hud-video="true">视频</button>
              <button type="button" class="secondary-button btn-sm" data-hud-reject="${esc(r.clientId)}">拒绝</button>
            </div>
          </div>
        `),
        ...linked.map(r => `
          <div class="item-row hud-row is-ok">
            <div class="hud-row-info">
              <strong>🎙 ${esc(r.name)}</strong>
              <span class="status-pill is-ok">${r.camActive ? '视频连线中' : '语音连线中'}</span>
            </div>
            <div class="hud-row-actions">
              <button type="button" class="secondary-button btn-sm" data-hud-draw="${esc(r.clientId)}" data-hud-draw-next="${!r.drawAllowed}">${r.drawAllowed ? '禁写' : '板书'}</button>
              <button type="button" class="danger-button btn-sm" data-hud-hangup="${esc(r.clientId)}">挂断</button>
            </div>
          </div>
        `)
      ].join('');

      handBox.querySelectorAll('[data-hud-mic]').forEach(btn => {
        btn.addEventListener('click', () => {
          api(`/api/classroom/${lesson.id}/action`, {
            method: 'POST',
            body: {
              type: 'mic',
              targetClientId: btn.getAttribute('data-hud-mic'),
              allowed: true,
              withVideo: btn.getAttribute('data-hud-video') === 'true'
            }
          }).catch(() => {});
        });
      });
      handBox.querySelectorAll('[data-hud-reject]').forEach(btn => {
        btn.addEventListener('click', () => {
          api(`/api/classroom/${lesson.id}/action`, {
            method: 'POST',
            body: { type: 'hand-reject', targetClientId: btn.getAttribute('data-hud-reject') }
          }).catch(() => {});
        });
      });
      handBox.querySelectorAll('[data-hud-draw]').forEach(btn => {
        btn.addEventListener('click', () => {
          api(`/api/classroom/${lesson.id}/action`, {
            method: 'POST',
            body: {
              type: 'student-draw-client',
              targetClientId: btn.getAttribute('data-hud-draw'),
              allowed: btn.getAttribute('data-hud-draw-next') === 'true'
            }
          }).catch(() => {});
        });
      });
      handBox.querySelectorAll('[data-hud-hangup]').forEach(btn => {
        btn.addEventListener('click', () => {
          api(`/api/classroom/${lesson.id}/action`, {
            method: 'POST',
            body: { type: 'mic', targetClientId: btn.getAttribute('data-hud-hangup'), allowed: false }
          }).catch(() => {});
        });
      });
    }

    const recent = chatMessages.slice(-60);
    if (recent.length === 0) {
      chatBox.innerHTML = `<div class="hud-empty">暂无学生发言</div>`;
    } else {
      chatBox.innerHTML = recent.map(m => `
        <div class="chat-msg ${m.role === 'student' ? '' : 'is-teacher'}">
          <strong>${esc(m.name)}</strong> <span style="color:var(--subtle)">${esc(m.time)}</span><br>${esc(m.text)}
        </div>
      `).join('');
      chatBox.scrollTop = chatBox.scrollHeight;
    }
  }

  async function openTeacherHud({ silent = false } = {}) {
    if (!isTeacher()) return false;
    if (hudWindow && !hudWindow.closed) {
      try { hudWindow.focus(); } catch {}
      syncTeacherHud();
      return true;
    }
    let win = null;
    try {
      if (window.documentPictureInPicture?.requestWindow) {
        win = await window.documentPictureInPicture.requestWindow({ width: 380, height: 520 });
      }
    } catch {}
    if (!win) {
      try {
        win = window.open('', `classroom_hud_${lesson.id}`, 'popup=yes,width=380,height=540,resizable=yes,scrollbars=yes');
      } catch {}
    }
    if (!win) {
      if (!silent) showToast('浏览器拦截了小窗，请在地址栏允许弹窗或画中画权限', true);
      return false;
    }

    hudWindow = win;
    const doc = win.document;
    doc.documentElement.dataset.theme = document.documentElement.dataset.theme || '';
    doc.head.innerHTML = `
      <meta charset="utf-8">
      <title>课堂互动小窗 · ${esc(lesson.title)}</title>
      <link rel="stylesheet" href="${location.origin}/public/styles/app.css">
      <style>
        body{margin:0;background:var(--surface);color:var(--ink);display:flex;flex-direction:column;height:100vh;overflow:hidden}
        .hud-header{display:flex;flex-direction:column;gap:6px;padding:10px 12px;background:var(--chrome);border-bottom:1px solid var(--line);flex-shrink:0}
        .hud-header-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
        .hud-title{font-weight:700;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .hud-status-strip{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
        .hud-section-title{font-size:11px;font-weight:600;color:var(--muted);padding:8px 12px 4px;flex-shrink:0}
        .hud-hand-box{padding:0 10px 8px;display:grid;gap:6px;flex-shrink:0;max-height:175px;overflow-y:auto;border-bottom:1px solid var(--line)}
        .hud-row{padding:7px 9px;gap:8px;background:var(--paper)}
        .hud-row.is-warn{border-color:color-mix(in srgb,var(--warn) 55%,var(--line));background:var(--warn-soft)}
        .hud-row.is-ok{border-color:color-mix(in srgb,var(--ok) 55%,var(--line));background:var(--ok-soft)}
        .hud-row-info{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
        .hud-row-info strong{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .hud-row-actions{display:flex;gap:4px;flex-shrink:0}
        .hud-chat{flex:1;overflow-y:auto;padding:8px 10px;display:flex;flex-direction:column;gap:6px}
        .hud-chat .chat-msg.is-teacher{background:var(--accent-soft);border-color:color-mix(in srgb,var(--accent) 35%,var(--line))}
        .hud-empty{font-size:12px;color:var(--subtle);text-align:center;padding:10px 6px}
        .hud-form{display:flex;gap:6px;padding:8px 10px;border-top:1px solid var(--line);background:var(--chrome);flex-shrink:0}
        .hud-form input{flex:1;min-width:0;border:1px solid var(--line-strong);background:var(--control);color:var(--ink);border-radius:var(--radius-sm);padding:6px 9px;font-size:12px;outline:none}
        .hud-form input:focus{border-color:var(--accent)}
      </style>
    `;
    doc.body.innerHTML = `
      <div class="hud-header">
        <div class="hud-header-top">
          <span class="hud-title">${esc(lesson.title)}</span>
          <span class="page-badge" id="hud-online-count">${currentRoster.length}人在线</span>
        </div>
        <div class="hud-status-strip">
          <span class="page-badge" id="hud-share-pill">未共享</span>
          <span class="page-badge" id="hud-rec-pill">未录制</span>
        </div>
      </div>
      <div class="hud-section-title">举手与连线互动</div>
      <div class="hud-hand-box" id="hud-hand-box"></div>
      <div class="hud-section-title">学生实时发言</div>
      <div class="hud-chat" id="hud-chat-list"></div>
      <form class="hud-form" id="hud-chat-form">
        <input type="text" name="text" placeholder="快捷回复学生…" autocomplete="off" />
        <button type="submit" class="primary-button btn-sm">发送</button>
      </form>
    `;

    doc.getElementById('hud-chat-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const inp = e.target.elements.text;
      const text = inp.value.trim();
      if (!text) return;
      inp.value = '';
      await api(`/api/classroom/${lesson.id}/action`, { method: 'POST', body: { type: 'chat', text } }).catch(() => {});
    });

    win.addEventListener('pagehide', () => {
      hudWindow = null;
      updateHudButtonUi();
    });
    win.addEventListener('unload', () => {
      hudWindow = null;
      updateHudButtonUi();
    });

    updateHudButtonUi();
    syncTeacherHud();
    return true;
  }

  function handleHudToggle() {
    closeBoardMenus();
    if (hudWindow && !hudWindow.closed) closeTeacherHud();
    else openTeacherHud({ silent: false });
  }
  teacherHudBtn?.addEventListener('click', handleHudToggle);
  screenHudBtn?.addEventListener('click', handleHudToggle);

  shell.querySelector('#live-chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!isTeacher() && lessonStatus !== 'in_progress') {
      showToast(lessonStatus === 'completed' ? '本课已下课，无法继续发言' : '老师尚未点击上课，开课后即可发言', true);
      return;
    }
    const input = e.target.elements.text;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      await api(`/api/classroom/${lesson.id}/action`, { method: 'POST', body: { type: 'chat', text } });
    } catch (err) {
      input.value = text;
      showToast(err.message, true);
    }
  });

  shell.querySelector('#archive-chat-qa-btn')?.addEventListener('click', async () => {
    if (!chatMessages.length) {
      showToast('当前暂无讨论记录可归档', true);
      return;
    }
    const summary = chatMessages.slice(-40).map(m => `[${m.time}] ${m.name}：${m.text}`).join('\n');
    try {
      await api('/api/qa', {
        method: 'POST',
        body: {
          courseId: lesson.course_id,
          lessonId: lesson.id,
          title: `【课堂讨论归档】${lesson.title}`,
          content: summary
        }
      });
      showToast('已归档到课程群');
    } catch (err) {
      showToast(`归档失败：${err.message}`, true);
    }
  });

  const connPill = shell.querySelector('#sse-conn-pill');
  const es = new EventSource(`/api/classroom/${lesson.id}/stream?clientId=${encodeURIComponent(myClientId)}`);
  es.onopen = () => {
    if (connPill) {
      connPill.textContent = '已连接';
      connPill.className = 'conn-pill is-ok';
    }
  };
  es.onerror = () => {
    if (connPill) {
      connPill.textContent = es.readyState === EventSource.CLOSED ? '已断开' : '重连中…';
      connPill.className = es.readyState === EventSource.CLOSED ? 'conn-pill is-err' : 'conn-pill is-warn';
    }
  };

  es.addEventListener('init', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.lessonStatus) {
      lessonStatus = d.lessonStatus;
      syncClassSessionUi();
    }
    allowStudentDraw = Boolean(d.allowStudentDraw);
    if (!isTeacher()) myDrawAllowed = allowStudentDraw;
    if (Array.isArray(d.pages) && d.pages.length) {
      applyWhiteboardState(d.pages, d.currentPage || 0);
    } else {
      applyWhiteboardState([{ strokes: d.strokes || [], bgUrl: d.bgUrl || '' }], 0);
    }
    renderRoster(d.roster || [], d.sharingClientId, d.sharingStreamId || '');
    const chatBox = shell.querySelector('#live-chat-list');
    if (chatBox) chatBox.innerHTML = '';
    chatMessages = [];
    (d.chat || []).forEach(m => appendChat(m, false));
  });

  es.addEventListener('stroke-live', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.pageIndex !== currentPageIdx || !d.clientId) return;
    if (d.stroke?.kind === 'laser' && d.stroke.point) {
      const trail = laserTrails.get(d.clientId) || { name: d.name || '', points: [] };
      trail.points.push({ x: d.stroke.point[0], y: d.stroke.point[1], t: Date.now() });
      laserTrails.set(d.clientId, trail);
      scheduleLaserLoop();
      return;
    }
    if (d.delta && Array.isArray(d.delta.points)) {
      const existing = remoteLiveStrokes.get(d.clientId);
      if (existing && existing.stroke?.strokeId === d.delta.strokeId) {
        existing.stroke.points.push(...d.delta.points);
      } else {
        remoteLiveStrokes.set(d.clientId, {
          name: d.name || '',
          stroke: { ...d.delta, points: [...d.delta.points] }
        });
      }
      renderBoardFrame();
    } else if (d.stroke) {
      remoteLiveStrokes.set(d.clientId, { name: d.name || '', stroke: d.stroke });
      renderBoardFrame();
    }
  });

  es.addEventListener('stroke', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.clientId) remoteLiveStrokes.delete(d.clientId);
    const targetIdx = Number.isInteger(d.pageIndex) ? d.pageIndex : currentPageIdx;
    if (d.stroke && wbPages[targetIdx]) {
      wbPages[targetIdx].strokes.push(d.stroke);
      if (targetIdx === currentPageIdx) {
        drawStrokeOn(inkCtx, d.stroke, true);
        renderBoardFrame();
      }
    }
  });

  es.addEventListener('replace-strokes', (ev) => {
    const d = JSON.parse(ev.data);
    const targetIdx = Number.isInteger(d.pageIndex) ? d.pageIndex : currentPageIdx;
    if (wbPages[targetIdx]) {
      wbPages[targetIdx].strokes = d.strokes || [];
      if (targetIdx === currentPageIdx) {
        rebuildInkCache();
        renderBoardFrame();
      }
    }
  });

  es.addEventListener('background', (ev) => {
    const d = JSON.parse(ev.data);
    const targetIdx = Number.isInteger(d.pageIndex) ? d.pageIndex : currentPageIdx;
    if (wbPages[targetIdx]) {
      wbPages[targetIdx].bgUrl = d.bgUrl || '';
      if (targetIdx === currentPageIdx) {
        loadBgUrl(d.bgUrl);
        syncPageControlsUi();
      }
    }
  });

  es.addEventListener('whiteboard-sync', (ev) => {
    const d = JSON.parse(ev.data);
    applyWhiteboardState(d.pages, d.currentPage);
  });

  es.addEventListener('student-draw', (ev) => {
    const d = JSON.parse(ev.data);
    allowStudentDraw = Boolean(d.allowStudentDraw);
    if (!isTeacher()) myDrawAllowed = allowStudentDraw;
    syncDrawPermissionUi();
  });

  es.addEventListener('roster', (ev) => {
    const d = JSON.parse(ev.data);
    renderRoster(d.roster || [], d.sharingClientId, d.sharingStreamId || '');
  });

  es.addEventListener('hand-rejected', (ev) => {
    const d = JSON.parse(ev.data || '{}');
    myHandRaised = false;
    syncHandButtonUi();
    showToast(`${d.by || '老师'}暂未接通你的连线请求`);
  });

  es.addEventListener('lesson-status', (ev) => {
    const d = JSON.parse(ev.data || '{}');
    if (!d.status) return;
    const prev = lessonStatus;
    lessonStatus = d.status;
    lesson.status = d.status;
    syncClassSessionUi();
    updateNavCounts();
    if (!isTeacher()) {
      if (prev !== 'in_progress' && lessonStatus === 'in_progress') {
        showToast('老师已开始上课，欢迎进入课堂！');
      } else if (prev !== 'completed' && lessonStatus === 'completed') {
        showToast('老师已下课');
      }
    }
  });

  es.addEventListener('chat', (ev) => appendChat(JSON.parse(ev.data), true));

  es.addEventListener('rtc-signal', async (ev) => {
    const msg = JSON.parse(ev.data);
    const pc = peerConnections.get(msg.fromClientId) || createPeer(msg.fromClientId, false);
    const st = peerStates.get(msg.fromClientId) || { makingOffer: false, ignoreOffer: false, polite: false };
    try {
      if (msg.sdp) {
        const offerCollision = msg.sdp.type === 'offer' && (st.makingOffer || pc.signalingState !== 'stable');
        st.ignoreOffer = !st.polite && offerCollision;
        if (st.ignoreOffer) return;
        if (offerCollision && pc.signalingState !== 'stable') {
          await Promise.all([
            pc.setLocalDescription({ type: 'rollback' }),
            pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
          ]);
        } else {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        }
        if (msg.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await api(`/api/classroom/${lesson.id}/action`, {
            method: 'POST',
            body: { type: 'rtc-signal', fromClientId: myClientId, toClientId: msg.fromClientId, sdp: pc.localDescription }
          });
        }
      } else if (msg.candidate && !st.ignoreOffer) {
        await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
      }
    } catch {}
  });

  app.liveCleanup = () => {
    app.liveIsRecording = false;
    document.body.style.overflow = '';
    document.removeEventListener('paste', handlePaste);
    document.removeEventListener('keydown', handleKeydown);
    document.removeEventListener('click', handleDocMenuClick);
    if (laserRafId) { cancelAnimationFrame(laserRafId); laserRafId = null; }
    closeTeacherHud();
    stopMicLevelMeter();
    es.close();
    clearInterval(compositeTimer);
    clearInterval(recClockTimer);
    clearInterval(startWindowTimer);
    for (const remoteId of [...peerConnections.keys()]) closePeer(remoteId);
    audioContainer.innerHTML = '';
    if (localScreenStream) { localScreenStream.getTracks().forEach(t => t.stop()); localScreenStream = null; }
    if (localMicStream) { localMicStream.getTracks().forEach(t => t.stop()); localMicStream = null; }
    if (localCamStream) { localCamStream.getTracks().forEach(t => t.stop()); localCamStream = null; }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  };
}

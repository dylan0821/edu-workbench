import { esc, openModal } from '../utils.js';
import { app, isTeacher, switchView } from '../state.js';

export function openOutlineNoteModal(node) {
  const body = openModal(node.title, `
    <div style="white-space:pre-wrap;line-height:1.7;font-size:14px;color:var(--ink);padding:4px 0">${esc(node.content || '暂无内容')}</div>
    <div class="form-actions" style="margin-top:16px">
      <button type="button" class="secondary-button" id="outline-note-close">关闭</button>
    </div>
  `);
  body?.querySelector('#outline-note-close')?.addEventListener('click', () => {
    document.querySelector('#modal')?.close();
  });
}

// 通用课程大纲侧栏构建（复用于独立播放页与实时课堂大纲栏）
export function buildCourseOutlinePanelData(courseId, activeMatch = null) {
  const state = app.state;
  const nodes = (state.courseNodes || []).filter(n => n.course_id === courseId);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const childrenMap = new Map();
  for (const n of nodes) {
    const pid = (n.parent_id && byId.has(n.parent_id)) ? n.parent_id : '';
    if (!childrenMap.has(pid)) childrenMap.set(pid, []);
    childrenMap.get(pid).push(n);
  }
  for (const list of childrenMap.values()) {
    list.sort((a, b) => (a.sort_order - b.sort_order) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  }

  const matMap = new Map(state.materials.map(m => [m.id, m]));
  const vodMap = new Map(state.vodLessons.map(v => [v.id, v]));
  const lesMap = new Map(state.lessons.map(l => [l.id, l]));
  const recByLesson = new Map();
  for (const r of (state.recordings || [])) {
    if (!recByLesson.has(r.lesson_id)) recByLesson.set(r.lesson_id, []);
    recByLesson.get(r.lesson_id).push(r);
  }
  const curStuId = state.currentUser?.role === 'student' ? state.currentUser.linkedId : '';
  const progMap = new Map();
  if (curStuId) {
    for (const p of (state.playbackProgress || [])) {
      if (p.student_id === curStuId) progMap.set(`${p.target_type}:${p.target_id}`, p);
    }
  }

  const MINI_ICONS = {
    folder: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    vod: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="m10 8.5 6 3.5-6 3.5z" fill="currentColor" stroke="none"/></svg>',
    material: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    lesson: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 10 4-2.5v9L17 14"/></svg>',
    note: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/></svg>'
  };

  const mountedVodIds = new Set();
  const mountedRecIds = new Set();
  const mountedMatIds = new Set();
  const playlist = [];
  let activePath = [];
  const parts = [];

  function getProgBadge(type, id) {
    const p = progMap.get(`${type}:${id}`);
    if (!p) return '';
    const pct = p.duration_sec > 0 ? Math.min(100, Math.round((p.watched_sec / p.duration_sec) * 100)) : 0;
    if (pct >= 90) return `<span class="status-pill is-ok" style="font-size:10px;padding:0 5px">已完</span>`;
    if (pct > 0) return `<span style="font-size:11px;color:var(--subtle)">${pct}%</span>`;
    return '';
  }

  function walk(parentId, depth, trail) {
    const list = childrenMap.get(parentId) || [];
    for (const n of list) {
      const pad = depth * 14 + 8;
      if (n.node_type === 'folder') {
        parts.push(`<div class="fpo-folder" style="padding-left:${pad}px">${MINI_ICONS.folder}<span>${esc(n.title)}</span></div>`);
        walk(n.id, depth + 1, [...trail, n.title]);
      } else if (n.node_type === 'vod') {
        const v = vodMap.get(n.ref_id);
        if (!v) continue;
        mountedVodIds.add(v.id);
        const isAct = activeMatch?.type === 'vod' && activeMatch?.id === v.id;
        if (isAct) activePath = [...trail, n.title];
        playlist.push({ type: 'vod', id: v.id, title: n.title, courseId });
        parts.push(`
          <button type="button" class="fpo-item ${isAct ? 'is-active' : ''}" style="padding-left:${pad}px" data-fpo-play-vod="${v.id}">
            ${isAct ? '<span class="fpo-pulse"></span>' : MINI_ICONS.vod}
            <span class="fpo-item-title">${esc(n.title)}</span>
            ${isAct ? '<span style="font-size:11px">播放中</span>' : getProgBadge('vod', v.id)}
          </button>
        `);
      } else if (n.node_type === 'lesson') {
        const l = lesMap.get(n.ref_id);
        if (!l) continue;
        const recs = recByLesson.get(l.id) || [];
        const isLiveAct = activeMatch?.type === 'lesson' && activeMatch?.id === l.id;
        if (isLiveAct) activePath = [...trail, n.title];
        if (recs.length) {
          recs.forEach((rec, idx) => {
            mountedRecIds.add(rec.id);
            const isRecAct = activeMatch?.type === 'recording' && activeMatch?.id === rec.id;
            const recLabel = recs.length > 1 ? `${n.title}（第${idx + 1}段）` : n.title;
            if (isRecAct) activePath = [...trail, recLabel];
            playlist.push({ type: 'recording', id: rec.id, title: recLabel, courseId });
            parts.push(`
              <button type="button" class="fpo-item ${(isRecAct || isLiveAct) ? 'is-active' : ''}" style="padding-left:${pad}px" data-fpo-play-rec="${rec.id}">
                ${(isRecAct || isLiveAct) ? '<span class="fpo-pulse"></span>' : MINI_ICONS.lesson}
                <span class="fpo-item-title">${esc(recLabel)}</span>
                ${isRecAct ? '<span style="font-size:11px">回放中</span>' : isLiveAct ? '<span style="font-size:11px">当前直播</span>' : getProgBadge('recording', rec.id)}
              </button>
            `);
          });
        } else {
          parts.push(`
            <button type="button" class="fpo-item ${isLiveAct ? 'is-active' : ''}" style="padding-left:${pad}px" data-fpo-go-live="${l.id}">
              ${isLiveAct ? '<span class="fpo-pulse"></span>' : MINI_ICONS.lesson}
              <span class="fpo-item-title">${esc(n.title)}</span>
              ${isLiveAct ? '<span style="font-size:11px">当前直播</span>' : `<span style="font-size:11px;color:var(--subtle)">${l.status === 'in_progress' ? '上课中' : l.status === 'completed' ? '已完课' : '直播'}</span>`}
            </button>
          `);
        }
      } else if (n.node_type === 'material') {
        const m = matMap.get(n.ref_id);
        if (!m) continue;
        mountedMatIds.add(m.id);
        parts.push(`
          <a class="fpo-item" style="padding-left:${pad}px" href="/api/materials/${m.id}/file" target="_blank" rel="noopener">
            ${MINI_ICONS.material}
            <span class="fpo-item-title">${esc(n.title)}</span>
            <span style="font-size:11px;color:var(--subtle)">资料</span>
          </a>
        `);
      } else if (n.node_type === 'note') {
        parts.push(`
          <button type="button" class="fpo-item" style="padding-left:${pad}px" data-fpo-note="${n.id}">
            ${MINI_ICONS.note}
            <span class="fpo-item-title">${esc(n.title)}</span>
            <span style="font-size:11px;color:var(--subtle)">说明</span>
          </button>
        `);
      }
    }
  }
  walk('', 0, []);

  // 补充未挂载到大纲中的本课程录播、回放与资料
  const courseLessons = state.lessons.filter(l => l.course_id === courseId);
  const courseLesIds = new Set(courseLessons.map(l => l.id));
  const extraVods = state.vodLessons.filter(v => v.course_id === courseId && !mountedVodIds.has(v.id));
  const extraRecs = (state.recordings || []).filter(r => courseLesIds.has(r.lesson_id) && !mountedRecIds.has(r.id));
  const extraMats = state.materials.filter(m =>
    !mountedMatIds.has(m.id) &&
    ((m.scope === 'course' && m.target_id === courseId) || (m.scope === 'lesson' && courseLesIds.has(m.target_id)))
  );

  if (extraVods.length || extraRecs.length || extraMats.length) {
    parts.push(`<div class="fpo-folder" style="padding-left:8px;margin-top:6px"><span>其他课程资源</span></div>`);
    for (const v of extraVods) {
      const isAct = activeMatch?.type === 'vod' && activeMatch?.id === v.id;
      if (isAct) activePath = ['其他课程资源', v.title];
      playlist.push({ type: 'vod', id: v.id, title: v.title, courseId });
      parts.push(`
        <button type="button" class="fpo-item ${isAct ? 'is-active' : ''}" style="padding-left:16px" data-fpo-play-vod="${v.id}">
          ${isAct ? '<span class="fpo-pulse"></span>' : MINI_ICONS.vod}
          <span class="fpo-item-title">${esc(v.title)}</span>
          ${isAct ? '<span style="font-size:11px">播放中</span>' : getProgBadge('vod', v.id)}
        </button>
      `);
    }
    for (const r of extraRecs) {
      const isAct = activeMatch?.type === 'recording' && activeMatch?.id === r.id;
      const label = `${r.lesson_title} · ${r.title}`;
      if (isAct) activePath = ['其他课程资源', label];
      playlist.push({ type: 'recording', id: r.id, title: label, courseId });
      parts.push(`
        <button type="button" class="fpo-item ${isAct ? 'is-active' : ''}" style="padding-left:16px" data-fpo-play-rec="${r.id}">
          ${isAct ? '<span class="fpo-pulse"></span>' : MINI_ICONS.lesson}
          <span class="fpo-item-title">${esc(label)}</span>
          ${isAct ? '<span style="font-size:11px">回放中</span>' : getProgBadge('recording', r.id)}
        </button>
      `);
    }
    for (const m of extraMats) {
      parts.push(`
        <a class="fpo-item" style="padding-left:16px" href="/api/materials/${m.id}/file" target="_blank" rel="noopener">
          ${MINI_ICONS.material}
          <span class="fpo-item-title">${esc(m.filename)}</span>
          <span style="font-size:11px;color:var(--subtle)">${esc(m.category || '资料')}</span>
        </a>
      `);
    }
  }

  const html = parts.length
    ? parts.join('')
    : `<div class="empty-state" style="padding:24px 12px;font-size:12px">本课程暂无大纲内容</div>`;
  return { html, activePath, playlist };
}

export function bindOutlinePanelEvents(container, courseId) {
  if (!container) return;
  container.querySelectorAll('[data-fpo-play-vod]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-fpo-play-vod');
      switchView('player', { playVodId: id, courseId });
    });
  });
  container.querySelectorAll('[data-fpo-play-rec]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-fpo-play-rec');
      switchView('player', { playRecId: id, courseId });
    });
  });
  container.querySelectorAll('[data-fpo-go-live]').forEach(btn => {
    btn.addEventListener('click', () => {
      switchView('classroom', { lessonId: btn.getAttribute('data-fpo-go-live') });
    });
  });
  container.querySelectorAll('[data-fpo-note]').forEach(btn => {
    btn.addEventListener('click', () => {
      const node = (app.state.courseNodes || []).find(n => n.id === btn.getAttribute('data-fpo-note'));
      if (node) openOutlineNoteModal(node);
    });
  });
}

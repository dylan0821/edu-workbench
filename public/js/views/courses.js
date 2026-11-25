import { esc, formatSize, formatDuration, formatLessonTime, toLocalDatetime, nextWholeHourMs, showToast, openModal } from '../utils.js';
import {
  app,
  api,
  isAdmin,
  isTeacher,
  persistNavState,
  uploadMediaWithProgress,
  switchView,
  renderView,
  updateNavCounts,
  openCourseStudentsModal
} from '../state.js';
import { openOutlineNoteModal } from './outline-panel.js';
import { openHomeworkEditorModal, openStudentSubmitModal } from './homework.js';

// Note: syncSidebarActive is handled by renderView/switchView in app.js
export function openLessonDetailModal(lessonId, activeTab = 'overview', recordingOutcome = null) {
  const state = app.state;
  const lesson = state.lessons.find(l => l.id === lessonId);
  if (!lesson) return;
  if (!['overview', 'attendance', 'qa'].includes(activeTab)) activeTab = 'overview';

  const mats = state.materials.filter(
    m => (m.scope === 'lesson' && m.target_id === lesson.id) || (m.scope === 'course' && m.target_id === lesson.course_id)
  );
  const recs = state.recordings.filter(r => r.lesson_id === lesson.id);
  const pendingRec = isTeacher() && (state.pendingRecordings || []).find(r => {
    if (r.lesson_id !== lesson.id) return false;
    if (recordingOutcome) return r.id === recordingOutcome.id;
    return r.status === 'interrupted' || lesson.status === 'completed';
  });
  const savedRec = recordingOutcome?.status === 'saved' || recs.some(r => r.id === recordingOutcome?.id);
  const qas = state.qaPosts.filter(p => !p.recall_kind && p.lesson_id === lesson.id);
  const classStudents = state.enrollments.filter(e => e.course_id === lesson.course_id && e.status === 'active');
  const statusLabel = lesson.status === 'in_progress' ? '上课中' : lesson.status === 'completed' ? '已完课' : lesson.status === 'cancelled' ? '已取消' : '待开课';

  const body = openModal(lesson.title, `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding-bottom:12px;border-bottom:1px solid var(--line);margin-bottom:12px">
      <div style="font-size:13px;color:var(--muted)">
        <strong style="color:var(--ink)">${esc(lesson.course_name)}</strong> · ${esc(lesson.teacher_name)}
        <span class="status-pill ${lesson.status === 'in_progress' || lesson.status === 'completed' ? 'is-ok' : lesson.status === 'cancelled' ? 'is-danger' : 'is-warn'}" style="margin-left:6px">${statusLabel}</span><br>
        ${formatLessonTime(lesson.start_ms, lesson.end_ms)} · ${lesson.physical_room ? esc(lesson.physical_room) : (lesson.external_room_url ? '外接课堂' : '线上课堂')}
      </div>
      <div class="row-actions">
        ${lesson.external_room_url && lesson.status !== 'cancelled' ? `<a class="secondary-button" href="${esc(lesson.external_room_url)}" target="_blank" rel="noopener">外接课堂</a>` : ''}
        ${lesson.status !== 'cancelled' ? `<button type="button" class="primary-button" id="detail-enter-live">进课堂</button>` : ''}
      </div>
    </div>

    ${pendingRec || recordingOutcome ? `
      <div class="item-row" role="status" style="margin-bottom:12px">
        <div class="item-main">
          <span class="status-pill ${pendingRec || !savedRec ? 'is-warn' : 'is-ok'}">${pendingRec ? '回放待恢复' : savedRec ? '回放已保存' : '回放待核对'}</span>
          <span class="item-meta">${pendingRec ? '已收到 ' + pendingRec.received_count + ' 个分片' : savedRec ? '可到录播回放核看' : '请到录播回放查看归档状态'}</span>
        </div>
        <div class="row-actions">
          <button type="button" class="secondary-button btn-sm" id="detail-verify-recording">${pendingRec ? '查看待恢复录制' : savedRec ? '核看回放' : '查看录播回放'}</button>
        </div>
      </div>
    ` : ''}

    <div class="modal-tabs">
      <button type="button" class="secondary-button ${activeTab === 'overview' ? 'is-active' : ''}" data-les-tab="overview">课前课后 (${mats.length + recs.length})</button>
      ${isTeacher() ? `<button type="button" class="secondary-button ${activeTab === 'attendance' ? 'is-active' : ''}" data-les-tab="attendance">出勤点名 (${classStudents.length})</button>` : ''}
      <button type="button" class="secondary-button ${activeTab === 'qa' ? 'is-active' : ''}" data-les-tab="qa">本课答疑 (${qas.length})</button>
    </div>

    <div ${activeTab === 'overview' ? '' : 'hidden'}>
      ${isTeacher() ? `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px;padding:10px 12px;background:var(--control);border:1px solid var(--line);border-radius:var(--radius-sm)">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span style="font-size:12px;color:var(--muted)">课次状态：</span>
            ${[['scheduled', '待开课'], ['completed', '已完课'], ['cancelled', '已取消']].map(([val, lbl]) => `
              <button type="button" class="secondary-button btn-sm ${lesson.status === val ? 'is-active' : ''}" data-det-status="${val}">${lbl}</button>
            `).join('')}
          </div>
          <form id="det-note-form" style="display:flex;gap:6px;flex:1;min-width:220px">
            <input name="note" value="${esc(lesson.note || '')}" placeholder="课次备注（如：作业布置、讲义页码…）" style="flex:1;padding:5px 8px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--paper);color:var(--ink);font-size:12px">
            <button type="submit" class="secondary-button btn-sm">保存备注</button>
          </form>
        </div>
      ` : (lesson.note ? `<div style="margin-bottom:14px;padding:9px 12px;background:var(--control);border-radius:var(--radius-sm);font-size:13px;color:var(--muted)"><strong style="color:var(--ink)">课次备注：</strong>${esc(lesson.note)}</div>` : '')}

      <div style="margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;flex-wrap:wrap">
          <h3 style="font-size:13px;color:var(--muted);margin:0">资料与板书（${mats.length}）</h3>
          ${isTeacher() ? `
            <form id="det-mat-upload-form" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
              <select name="category" style="padding:4px 8px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--control);color:var(--ink);font-size:12px">
                <option>课前讲义</option>
                <option>课后板书</option>
                <option>其他附件</option>
              </select>
              <input type="file" id="det-mat-file" multiple style="font-size:12px;max-width:190px" required>
              <button type="submit" class="primary-button btn-sm" id="det-mat-btn">＋ 上传本课资料</button>
            </form>
          ` : ''}
        </div>
        ${mats.length === 0 ? `<div class="empty-state" style="padding:14px">暂无资料</div>` : `
          <div class="item-list">
            ${mats.map(m => `
              <div class="item-row" style="padding:8px 12px">
                <div style="font-size:13px">
                  <strong>${esc(m.filename)}</strong>
                  <span class="page-badge">${esc(m.category)}</span>
                  <span style="font-size:11px;color:var(--subtle);margin-left:4px">${m.scope === 'course' ? '课程通用' : '当次'} · ${formatSize(m.size_bytes)}</span>
                </div>
                <div class="row-actions">
                  <a class="secondary-button btn-sm" href="/api/materials/${m.id}/file" target="_blank" rel="noopener">查看</a>
                  <a class="secondary-button btn-sm" href="/api/materials/${m.id}/file?download=1">下载</a>
                  ${isTeacher() && m.scope === 'lesson' ? `<button type="button" class="secondary-button btn-sm danger-button" data-det-del-mat="${m.id}">删除</button>` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </div>

      <div>
        <h3 style="font-size:13px;color:var(--muted);margin:0 0 8px">本课回放（${recs.length}）</h3>
        ${recs.length === 0 ? `<div class="empty-state" style="padding:14px">暂无回放</div>` : `
          <div class="item-list">
            ${recs.map(r => `
              <div class="item-row" style="padding:8px 12px">
                <div style="font-size:13px">
                  <strong>第 ${r.segment} 段 · ${esc(r.title)}</strong>
                  <span class="status-pill ${r.status === 'published' ? 'is-ok' : 'is-warn'}" style="margin-left:6px">${r.status === 'published' ? '已发布' : '待审核'}</span>
                </div>
                <div class="row-actions">
                  <button type="button" class="secondary-button btn-sm" data-detail-play-rec="${r.id}">播放</button>
                  ${isTeacher() ? `<button type="button" class="primary-button btn-sm" data-det-pub="${r.id}" data-next="${r.status === 'published' ? 'withdrawn' : 'published'}">${r.status === 'published' ? '撤回' : '发布'}</button>` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    </div>

    ${isTeacher() ? `
      <div ${activeTab === 'attendance' ? '' : 'hidden'}>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <h3 style="font-size:13px;color:var(--muted);margin:0">出勤点名（${classStudents.length} 人）</h3>
          ${classStudents.length ? `<button type="button" class="secondary-button btn-sm" id="att-all-present">全部出勤</button>` : ''}
        </div>
        ${classStudents.length === 0 ? `<div class="empty-state" style="padding:14px">暂无在读学生</div>` : `
          <div class="item-list">
            ${classStudents.map(en => {
              const att = (state.attendance || []).find(a => a.lesson_id === lesson.id && a.student_id === en.student_id);
              const curStatus = att?.status || '未点名';
              return `
                <div class="item-row" style="padding:7px 12px">
                  <div style="font-size:13px">
                    <strong>${esc(en.student_name)}</strong>
                    <span class="status-pill ${curStatus === '出勤' ? 'is-ok' : curStatus === '缺勤' ? 'is-danger' : 'is-warn'}" style="margin-left:6px">${curStatus}</span>
                    ${att?.note ? `<span style="font-size:11px;color:var(--subtle);margin-left:6px">${esc(att.note)}</span>` : ''}
                  </div>
                  <div class="row-actions">
                    ${['出勤', '请假', '缺勤'].map(st => `
                      <button type="button" class="secondary-button btn-sm ${curStatus === st ? 'is-active' : ''}" data-att-stu="${en.student_id}" data-att-val="${st}">${st}</button>
                    `).join('')}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `}
      </div>
    ` : ''}

    <div ${activeTab === 'qa' ? '' : 'hidden'}>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <h3 style="font-size:13px;color:var(--muted);margin:0">课程答疑（${qas.length}）</h3>
        <button type="button" class="secondary-button btn-sm" id="detail-go-qa">去提问</button>
      </div>
      ${qas.length === 0 ? `<div class="empty-state" style="padding:14px">暂无提问</div>` : `
        <div class="item-list">
          ${qas.map(q => `<div class="item-row" style="padding:8px 12px"><div style="font-size:13px"><strong>${esc(q.title || q.content)}</strong> <span style="font-size:12px;color:var(--subtle)">${esc(q.author_name)}</span></div><span class="status-pill ${q.resolved ? 'is-ok' : 'is-warn'}">${q.resolved ? '已解答' : '待解答'}</span></div>`).join('')}
        </div>
      `}
    </div>
  `);
  if (!body) return;
  const modal = document.querySelector('#modal');

  body.querySelectorAll('[data-les-tab]').forEach(btn => {
    btn.addEventListener('click', () => openLessonDetailModal(lesson.id, btn.getAttribute('data-les-tab'), recordingOutcome));
  });
  body.querySelector('#detail-verify-recording')?.addEventListener('click', () => {
    modal.close();
    if (savedRec) switchView('player', { playRecId: recordingOutcome.id, courseId: lesson.course_id });
    else switchView('vod', { pendingRecordingId: pendingRec?.id });
  });
  body.querySelector('#detail-enter-live')?.addEventListener('click', () => {
    modal.close();
    switchView('classroom', { lessonId: lesson.id });
  });
  body.querySelectorAll('[data-detail-play-rec]').forEach(btn => {
    btn.addEventListener('click', () => {
      modal.close();
      switchView('player', { playRecId: btn.getAttribute('data-detail-play-rec'), courseId: lesson.course_id });
    });
  });
  body.querySelector('#detail-go-qa')?.addEventListener('click', () => {
    modal.close();
    switchView('qa', { qaDraft: { courseId: lesson.course_id, lessonId: lesson.id } });
  });

  body.querySelectorAll('[data-det-status]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const nextStatus = btn.getAttribute('data-det-status');
      if (nextStatus === lesson.status) return;
      try {
        app.state = await api(`/api/lessons/${lesson.id}/status`, { method: 'PATCH', body: { status: nextStatus } });
        showToast('课次状态已更新');
        openLessonDetailModal(lesson.id, activeTab);
        renderView();
      } catch (err) { showToast(err.message, true); }
    });
  });

  body.querySelector('#det-note-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const fd = new FormData(e.target);
      app.state = await api(`/api/lessons/${lesson.id}/note`, { method: 'PATCH', body: { note: fd.get('note') } });
      showToast('备注已保存');
      openLessonDetailModal(lesson.id, activeTab);
      renderView();
    } catch (err) { showToast(err.message, true); }
  });

  const detMatForm = body.querySelector('#det-mat-upload-form');
  if (detMatForm) {
    detMatForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const files = [...body.querySelector('#det-mat-file').files];
      if (!files.length) return;
      const cat = new FormData(detMatForm).get('category');
      const btn = body.querySelector('#det-mat-btn');
      btn.disabled = true;
      try {
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const q = new URLSearchParams({ scope: 'lesson', targetId: lesson.id, category: cat, filename: f.name });
          const task = uploadMediaWithProgress(`/api/materials/upload?${q}`, f, {
            contentType: f.type || 'application/octet-stream',
            onProgress: (pct) => { btn.textContent = `上传 (${i + 1}/${files.length}) ${pct}%`; }
          });
          const res = await task.promise;
          app.state = res.state;
        }
        showToast(`已上传 ${files.length} 份资料`);
        openLessonDetailModal(lesson.id, 'overview');
        renderView();
      } catch (err) {
        showToast(err.message, true);
        btn.disabled = false;
        btn.textContent = '＋ 上传本课资料';
      }
    });
  }

  body.querySelectorAll('[data-det-del-mat]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('确认删除该文件？')) return;
      try {
        app.state = await api(`/api/materials/${btn.getAttribute('data-det-del-mat')}`, { method: 'DELETE' });
        showToast('已删除');
        openLessonDetailModal(lesson.id, 'overview');
        renderView();
      } catch (err) { showToast(err.message, true); }
    });
  });

  body.querySelector('#att-all-present')?.addEventListener('click', async () => {
    try {
      app.state = await api('/api/attendance/batch', {
        method: 'POST',
        body: {
          lessonId: lesson.id,
          records: classStudents.map(en => ({ studentId: en.student_id, status: '出勤' }))
        }
      });
      showToast('已全部标记出勤');
      openLessonDetailModal(lesson.id, 'attendance');
      renderView();
    } catch (err) { showToast(err.message, true); }
  });

  body.querySelectorAll('[data-det-pub]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        app.state = await api(`/api/recordings/${btn.getAttribute('data-det-pub')}`, {
          method: 'PATCH',
          body: { status: btn.getAttribute('data-next') }
        });
        showToast('状态已更新');
        openLessonDetailModal(lesson.id, 'overview');
        renderView();
      } catch (err) { showToast(err.message, true); }
    });
  });

  body.querySelectorAll('[data-att-stu]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        app.state = await api('/api/attendance', {
          method: 'POST',
          body: {
            lessonId: lesson.id,
            studentId: btn.getAttribute('data-att-stu'),
            status: btn.getAttribute('data-att-val')
          }
        });
        openLessonDetailModal(lesson.id, 'attendance');
        renderView();
      } catch (err) { showToast(err.message, true); }
    });
  });
}

export function renderCourses(shell) {
  const state = app.state;
  const editing = state.lessons.find(l => l.id === app.editingLessonId) || null;
  const editingCourse = state.courses.find(c => c.id === app.editingCourseId) || null;
  const activeOutlineCourse = (app.courseTab === 'catalog' && app.outlineCourseId)
    ? (state.courses.find(c => c.id === app.outlineCourseId) || null)
    : null;
  if (app.courseTab === 'catalog' && app.outlineCourseId && !activeOutlineCourse) {
    app.outlineCourseId = '';
  }
  persistNavState();
  const schedulePanelOpen = app.showCreatePanel || Boolean(editing);
  const coursePanelOpen = app.showCreatePanel || Boolean(editingCourse);

  const outlineNodeCount = activeOutlineCourse
    ? (state.courseNodes || []).filter(n => n.course_id === activeOutlineCourse.id).length
    : 0;

  const metaMap = {
    schedule: { eyebrow: isAdmin() ? '课程管理' : '我的课程', title: isAdmin() ? '课表排课' : '我的课表', badge: `${state.lessons.length} 节课` },
    materials: { eyebrow: isAdmin() ? '课程管理' : '我的课程', title: '课程资料', badge: `${state.materials.length} 份` },
    catalog: activeOutlineCourse
      ? { eyebrow: '课程内容', title: esc(activeOutlineCourse.name), badge: `${outlineNodeCount} 项` }
      : { eyebrow: isAdmin() ? '课程管理' : '我的课程', title: isAdmin() ? '课程列表' : '我的课程', badge: `${state.courses.length} 门` }
  };
  const cur = metaMap[app.courseTab] || metaMap.schedule;

  let actionsHtml = '';
  if (app.courseTab === 'schedule' && isAdmin()) {
    actionsHtml = `
      <button type="button" class="secondary-button" id="toggle-batch-panel">${app.showBatchPanel ? '收起' : '批量排课'}</button>
      <button type="button" class="primary-button" id="toggle-les-panel">${schedulePanelOpen ? '收起' : '＋ 新建课次'}</button>
    `;
  } else if (app.courseTab === 'materials' && isTeacher()) {
    actionsHtml = `<button type="button" class="primary-button" id="toggle-mat-upload">${app.showCreatePanel ? '收起' : '＋ 上传资料'}</button>`;
  } else if (app.courseTab === 'catalog' && activeOutlineCourse) {
    actionsHtml = `<button type="button" class="secondary-button" id="outline-back-btn">← 返回课程列表</button>`;
  } else if (app.courseTab === 'catalog' && isAdmin()) {
    actionsHtml = `<button type="button" class="primary-button" id="toggle-course-create">${coursePanelOpen ? '收起' : '＋ 新建课程'}</button>`;
  }

  shell.innerHTML = `
    <div class="page-heading">
      <div>
        <span class="page-eyebrow">${cur.eyebrow}</span>
        <div class="page-title-row">
          <h1>${cur.title}</h1>
          <span class="page-badge">${cur.badge}</span>
        </div>
      </div>
      ${actionsHtml ? `<div class="page-actions">${actionsHtml}</div>` : ''}
    </div>
    <div id="course-tab-body" style="display:grid;gap:16px"></div>
  `;

  const body = shell.querySelector('#course-tab-body');
  if (app.courseTab === 'schedule') renderScheduleTab(shell, body);
  else if (app.courseTab === 'materials') renderMaterialsTab(shell, body);
  else if (app.courseTab === 'catalog') {
    if (activeOutlineCourse) renderCourseOutlineView(shell, body, activeOutlineCourse);
    else renderCourseCatalogTab(shell, body);
  }
}

function renderCourseCatalogTab(shell, body) {
  const state = app.state;
  const editingCourse = state.courses.find(c => c.id === app.editingCourseId) || null;
  const panelOpen = isAdmin() && (app.showCreatePanel || Boolean(editingCourse));
  const subjectPresets = ['数学', '物理', '化学', '英语', '语文', '生物', '历史', '地理', '政治', '编程'];
  const existingSubjects = [...new Set(state.courses.map(c => (c.subject || '').trim()).filter(Boolean))];
  const editingTeacherIds = new Set(editingCourse?.teacher_ids || (editingCourse?.teacher_id ? [editingCourse.teacher_id] : []));
  const defaultCapVal = editingCourse
    ? (editingCourse.capacity != null ? editingCourse.capacity : '')
    : (state.org?.default_class_capacity || '');

  body.innerHTML = `
    ${isAdmin() ? `
    <section class="create-panel" ${panelOpen ? '' : 'hidden'}>
      <h3>${editingCourse ? `编辑课程：${esc(editingCourse.name)}` : '新建课程'}</h3>
      <form id="course-form">
        <div class="form-grid">
          <label class="form-field"><span>课程名称 *</span><input name="name" value="${esc(editingCourse?.name || '')}" required></label>
          <label class="form-field">
            <span>学科</span>
            <input name="subject" list="course-subject-presets" value="${esc(editingCourse?.subject || '')}" placeholder="如：数学、物理">
            <datalist id="course-subject-presets">
              ${subjectPresets.map(s => `<option value="${s}">`).join('')}
            </datalist>
          </label>
          <label class="form-field">
            <span>形式</span>
            <select name="mode">
              ${['直播课', '录播课', '线下课'].map(m => `<option ${editingCourse?.mode === m ? 'selected' : ''}>${m}</option>`).join('')}
            </select>
          </label>
          <label class="form-field">
            <span>人数上限</span>
            <input name="capacity" type="number" min="1" value="${defaultCapVal}" placeholder="留空不限">
          </label>
          <label class="form-field" style="grid-column:1 / -1"><span>课程简介</span><input name="description" value="${esc(editingCourse?.description || '')}"></label>
        </div>
        ${state.teachers.length ? `
          <div class="form-field" style="margin-top:12px">
            <span>授课教师</span>
            <div class="teacher-picker">
              ${state.teachers.map(t => `
                <label class="teacher-chip">
                  <input type="checkbox" name="teacherIds" value="${t.id}" ${editingTeacherIds.has(t.id) ? 'checked' : ''}>
                  <span>${esc(t.name)}</span>${t.subject ? `<span class="teacher-chip-sub">${esc(t.subject)}</span>` : ''}
                </label>
              `).join('')}
            </div>
          </div>
        ` : ''}
        ${editingCourse ? `
          <label style="display:inline-flex;align-items:center;gap:6px;margin-top:10px;font-size:12.5px;color:var(--muted);cursor:pointer">
            <input type="checkbox" name="syncFutureLessons">
            <span>同步将后续待开课次的授课教师更新为首位授课教师</span>
          </label>
        ` : ''}
        <div class="form-actions">
          <button type="submit" class="primary-button">${editingCourse ? '保存修改' : '创建课程'}</button>
          <button type="button" class="secondary-button" id="cancel-course-create">取消</button>
        </div>
      </form>
    </section>
    ` : ''}

    <div class="filter-bar">
      <label class="filter-search"><span>搜索</span><input id="course-search-input" type="search" placeholder="课程名称、学科、授课教师…" value="${esc(app.courseSearch)}"></label>
      <label>
        <span>学科</span>
        <select id="course-subject-select">
          <option value="">全部学科</option>
          ${existingSubjects.map(s => `<option value="${esc(s)}" ${app.courseSubjectFilter === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select>
      </label>
      <label>
        <span>形式</span>
        <select id="course-mode-select">
          <option value="">全部形式</option>
          <option value="直播课" ${app.courseModeFilter === '直播课' ? 'selected' : ''}>直播课</option>
          <option value="录播课" ${app.courseModeFilter === '录播课' ? 'selected' : ''}>录播课</option>
          <option value="线下课" ${app.courseModeFilter === '线下课' ? 'selected' : ''}>线下课</option>
        </select>
      </label>
    </div>

    <div id="course-list-container"></div>
  `;

  function renderCourseList() {
    const st = app.state;
    const filtered = st.courses.filter(c => {
      if (app.courseModeFilter && c.mode !== app.courseModeFilter) return false;
      if (app.courseSubjectFilter && (c.subject || '') !== app.courseSubjectFilter) return false;
      if (app.courseSearch) {
        const kw = app.courseSearch.toLowerCase();
        return c.name.toLowerCase().includes(kw)
          || (c.subject || '').toLowerCase().includes(kw)
          || (c.teacher_name || '').toLowerCase().includes(kw)
          || (c.description || '').toLowerCase().includes(kw);
      }
      return true;
    });

    const box = body.querySelector('#course-list-container');
    if (!filtered.length) {
      box.innerHTML = `<div class="empty-state">暂无匹配的课程</div>`;
      return;
    }

    const allNodes = st.courseNodes || [];
    box.innerHTML = `
      <div class="table-wrap">
        <table class="data-table mobile-cards-table">
          <thead>
            <tr>
              <th>课程名称</th>
              <th>学科</th>
              <th>形式</th>
              <th>授课教师</th>
              <th>章节内容</th>
              ${isAdmin() ? '<th>在读学生</th>' : ''}
              <th>课次 / 录播</th>
              <th>资料数</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map(c => {
              const courseLessons = st.lessons.filter(l => l.course_id === c.id);
              const lesIds = new Set(courseLessons.map(l => l.id));
              const activeStuCnt = st.enrollments.filter(e => e.status === 'active' && e.course_id === c.id).length;
              const vodCnt = st.vodLessons.filter(v => v.course_id === c.id).length;
              const matCnt = st.materials.filter(m => (m.scope === 'course' && m.target_id === c.id) || (m.scope === 'lesson' && lesIds.has(m.target_id))).length;
              const nodeCnt = allNodes.filter(n => n.course_id === c.id).length;
              const stuLabel = c.capacity != null ? `${activeStuCnt} / ${c.capacity} 人` : `${activeStuCnt} 人`;
              return `
                <tr>
                  <td class="mc-title">
                    <button type="button" class="outline-title-link" data-open-outline="${c.id}" style="font-weight:600">${esc(c.name)}</button>
                    ${c.description ? `<div style="font-size:12px;color:var(--subtle);margin-top:2px">${esc(c.description)}</div>` : ''}
                  </td>
                  <td data-label="学科">${c.subject ? `<span class="page-badge">${esc(c.subject)}</span>` : '<span style="color:var(--subtle)">-</span>'}</td>
                  <td data-label="形式"><span class="page-badge is-accent">${esc(c.mode)}</span></td>
                  <td data-label="授课教师">${c.teacher_name ? esc(c.teacher_name) : '<span style="color:var(--subtle)">未指定</span>'}</td>
                  <td data-label="章节内容"><button type="button" class="link-count" data-open-outline="${c.id}">${nodeCnt} 项</button></td>
                  ${isAdmin() ? `
                    <td data-label="在读学生" style="font-variant-numeric:tabular-nums"><button type="button" class="link-count" data-manage-course-stu="${c.id}" title="管理本课程学生">${stuLabel}</button></td>
                  ` : ''}
                  <td data-label="课次 / 录播">
                    <button type="button" class="link-count" data-drill-les="${c.id}" title="查看该课程课表">${courseLessons.length} 节</button>
                    ${vodCnt > 0 ? `<button type="button" class="link-count" ${isTeacher() ? `data-drill-vod="${c.id}" title="查看录播课"` : `data-open-outline="${c.id}" title="进入课程内容"`}>· ${vodCnt} 录播</button>` : ''}
                  </td>
                  <td data-label="资料数"><button type="button" class="link-count" ${isTeacher() ? `data-drill-mat="${c.id}" title="查看该课程资料"` : `data-open-outline="${c.id}" title="进入课程内容"`}>${matCnt}</button></td>
                  <td class="mc-actions">
                    <div class="row-actions">
                      <button type="button" class="primary-button btn-sm" data-open-outline="${c.id}">${isTeacher() ? '管理内容' : '查看内容'}</button>
                      ${isAdmin() ? `
                        <button type="button" class="secondary-button btn-sm" data-manage-course-stu="${c.id}">学生</button>
                        <button type="button" class="secondary-button btn-sm" data-edit-course="${c.id}">编辑</button>
                        <button type="button" class="secondary-button btn-sm" data-quick-schedule="${c.id}">排课</button>
                        <button type="button" class="secondary-button btn-sm danger-button" data-del-course="${c.id}">删除</button>
                      ` : ''}
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    box.querySelectorAll('[data-open-outline]').forEach(btn => {
      btn.addEventListener('click', () => {
        app.outlineCourseId = btn.getAttribute('data-open-outline');
        app.outlineSearch = '';
        app.outlineTypeFilter = '';
        renderCourses(shell);
      });
    });
    box.querySelectorAll('[data-manage-course-stu]').forEach(btn => {
      btn.addEventListener('click', () => openCourseStudentsModal(btn.getAttribute('data-manage-course-stu')));
    });
    box.querySelectorAll('[data-drill-les]').forEach(btn => {
      btn.addEventListener('click', () => {
        app.lesCourseFilter = btn.getAttribute('data-drill-les');
        app.lesFilterType = 'all';
        app.lesFilterTarget = '';
        switchView('schedule');
      });
    });
    box.querySelectorAll('[data-drill-vod]').forEach(btn => {
      btn.addEventListener('click', () => {
        app.vodCourseFilter = btn.getAttribute('data-drill-vod');
        app.vodViewTab = 'vod';
        switchView('vod');
      });
    });
    box.querySelectorAll('[data-drill-mat]').forEach(btn => {
      btn.addEventListener('click', () => {
        app.matCourseFilter = btn.getAttribute('data-drill-mat');
        app.matFilterScope = '';
        switchView('materials');
      });
    });
    box.querySelectorAll('[data-quick-schedule]').forEach(btn => {
      btn.addEventListener('click', () => {
        app.lesCourseFilter = btn.getAttribute('data-quick-schedule');
        switchView('schedule', { openCreate: true });
      });
    });
    box.querySelectorAll('[data-edit-course]').forEach(btn => {
      btn.addEventListener('click', () => {
        app.editingCourseId = btn.getAttribute('data-edit-course');
        app.showCreatePanel = true;
        renderCourses(shell);
      });
    });
    box.querySelectorAll('[data-del-course]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const cid = btn.getAttribute('data-del-course');
        const c = app.state.courses.find(x => x.id === cid);
        const enCnt = app.state.enrollments.filter(e => e.course_id === cid).length;
        const courseLessons = app.state.lessons.filter(l => l.course_id === cid);
        const lesIds = new Set(courseLessons.map(l => l.id));
        const recCnt = app.state.recordings.filter(r => lesIds.has(r.lesson_id)).length;
        const vodCnt = app.state.vodLessons.filter(v => v.course_id === cid).length;
        const matCnt = app.state.materials.filter(m => (m.scope === 'course' && m.target_id === cid) || (m.scope === 'lesson' && lesIds.has(m.target_id))).length;
        const msg = `确认删除课程「${c?.name || cid}」？\n\n此操作将永久删除其下全部关联数据与磁盘文件：\n- ${enCnt} 条学生报名记录\n- ${courseLessons.length} 节课次\n- ${recCnt} 段回放、${vodCnt} 节录播、${matCnt} 份资料`;
        if (!confirm(msg)) return;
        try {
          app.state = await api(`/api/courses/${cid}`, { method: 'DELETE' });
          if (app.editingCourseId === cid) app.editingCourseId = null;
          showToast('课程及关联数据已删除');
          renderView();
        } catch (err) { showToast(err.message, true); }
      });
    });
  }

  renderCourseList();

  shell.querySelector('#toggle-course-create')?.addEventListener('click', () => { app.editingCourseId = null; app.showCreatePanel = !panelOpen; renderCourses(shell); });
  body.querySelector('#cancel-course-create')?.addEventListener('click', () => { app.editingCourseId = null; app.showCreatePanel = false; renderCourses(shell); });
  body.querySelector('#course-search-input').addEventListener('input', (e) => { app.courseSearch = e.target.value; renderCourseList(); });
  body.querySelector('#course-subject-select').addEventListener('change', (e) => { app.courseSubjectFilter = e.target.value; renderCourseList(); });
  body.querySelector('#course-mode-select').addEventListener('change', (e) => { app.courseModeFilter = e.target.value; renderCourseList(); });

  body.querySelector('#course-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const rawCap = String(fd.get('capacity') || '').trim();
    const payload = {
      name: fd.get('name'),
      subject: fd.get('subject'),
      mode: fd.get('mode'),
      description: fd.get('description'),
      teacherIds: fd.getAll('teacherIds'),
      capacity: rawCap === '' ? null : Number(rawCap),
      syncFutureLessons: fd.get('syncFutureLessons') === 'on'
    };
    try {
      if (editingCourse) {
        const res = await api(`/api/courses/${editingCourse.id}`, { method: 'PUT', body: payload });
        app.state = res.state || res;
        app.editingCourseId = null;
        app.showCreatePanel = false;
        showToast(res.syncedLessons > 0 ? `课程已更新，并同步更新 ${res.syncedLessons} 节待开课次` : '课程已更新');
      } else {
        const res = await api('/api/courses', { method: 'POST', body: payload });
        app.state = res.state;
        app.showCreatePanel = false;
        showToast('已创建课程');
      }
      renderView();
    } catch (err) { showToast(err.message, true); }
  });
}

function renderCourseOutlineView(shell, body, course) {
  const state = app.state;
  const canEdit = isTeacher();
  const TYPE_LABEL = { folder: '目录', material: '资料', vod: '录播', lesson: '课次', note: '说明' };
  const TYPE_ICON = {
    folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    material: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>',
    vod: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m10 8.5 6 3.5-6 3.5z" fill="currentColor" stroke="none"/></svg>',
    lesson: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 10 4-2.5v9L17 14"/></svg>',
    note: '<svg viewBox="0 0 24 24"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/></svg>'
  };
  const GRIP_SVG = '<svg viewBox="0 0 16 16"><circle cx="5.5" cy="4" r="1.2"/><circle cx="10.5" cy="4" r="1.2"/><circle cx="5.5" cy="8" r="1.2"/><circle cx="10.5" cy="8" r="1.2"/><circle cx="5.5" cy="12" r="1.2"/><circle cx="10.5" cy="12" r="1.2"/></svg>';
  const CHEVRON_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 4 4 4-4 4"/></svg>';

  function formatOutlineTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  shell.querySelector('#outline-back-btn')?.addEventListener('click', () => {
    app.outlineCourseId = '';
    renderCourses(shell);
  });

  const courseNodes = (state.courseNodes || []).filter(n => n.course_id === course.id);
  const folderIds = courseNodes.filter(n => n.node_type === 'folder').map(n => n.id);
  const allCollapsed = folderIds.length > 0 && folderIds.every(id => app.collapsedOutlineNodes.has(id));
  const otherCoursesWithOutline = state.courses.filter(c =>
    c.id !== course.id && (state.courseNodes || []).some(n => n.course_id === c.id && (n.node_type === 'folder' || n.node_type === 'note'))
  );
  const courseLessonsAll = state.lessons.filter(l => l.course_id === course.id);
  const courseLesIdsAll = new Set(courseLessonsAll.map(l => l.id));
  const courseMatCnt = state.materials.filter(m => (m.scope === 'course' && m.target_id === course.id) || (m.scope === 'lesson' && courseLesIdsAll.has(m.target_id))).length;
  const courseVodCnt = state.vodLessons.filter(v => v.course_id === course.id).length;
  const courseHwCnt = (state.homeworks || []).filter(h => h.course_id === course.id).length;

  // 统计未挂载到大纲的本课资源数（提示教师及时归档）
  const mountedKeys = new Set(courseNodes.filter(n => n.ref_id).map(n => `${n.node_type}:${n.ref_id}`));
  const unmountedCount =
    state.materials.filter(m => ((m.scope === 'course' && m.target_id === course.id) || (m.scope === 'lesson' && courseLesIdsAll.has(m.target_id))) && !mountedKeys.has(`material:${m.id}`)).length +
    state.vodLessons.filter(v => v.course_id === course.id && !mountedKeys.has(`vod:${v.id}`)).length +
    courseLessonsAll.filter(l => !mountedKeys.has(`lesson:${l.id}`)).length;

  body.innerHTML = `
    <div class="outline-subnav">
      <span style="color:var(--subtle)">本课快捷跳转：</span>
      <button type="button" class="secondary-button btn-sm" id="outline-go-schedule">${canEdit ? '课表排课' : '我的课表'} (${courseLessonsAll.length})</button>
      ${canEdit ? `
        <button type="button" class="secondary-button btn-sm" id="outline-go-materials">课程资料 (${courseMatCnt})</button>
        <button type="button" class="secondary-button btn-sm" id="outline-go-vod">录播回放 (${courseVodCnt})</button>
      ` : ''}
      <button type="button" class="secondary-button btn-sm" id="outline-go-homework">课程作业 (${courseHwCnt})</button>
      <button type="button" class="secondary-button btn-sm" id="outline-go-qa">课程群</button>
    </div>

    ${canEdit && unmountedCount > 0 ? `
      <div class="message-bar" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <span>本课程还有 <strong>${unmountedCount}</strong> 项资料 / 录播 / 课次尚未编入大纲目录</span>
        <button type="button" class="primary-button btn-sm" id="outline-banner-import">一键批量导入</button>
      </div>
    ` : ''}

    <div class="outline-toolbar">
      <div class="outline-toolbar-left">
        ${canEdit ? `
          <button type="button" class="primary-button" id="outline-add-content">＋ 添加学习内容</button>
          <button type="button" class="secondary-button" id="outline-add-folder">＋ 添加目录</button>
          <button type="button" class="secondary-button" id="outline-add-homework">＋ 布置作业</button>
          <button type="button" class="secondary-button" id="outline-batch-import">批量导入</button>
          ${otherCoursesWithOutline.length ? `<button type="button" class="secondary-button" id="outline-copy-btn">复制大纲</button>` : ''}
        ` : ''}
        ${folderIds.length ? `<button type="button" class="secondary-button" id="outline-toggle-all">${allCollapsed ? '全部展开' : '全部折叠'}</button>` : ''}
      </div>
      <div class="outline-toolbar-right">
        <input id="outline-search-input" type="search" placeholder="搜索章节或内容…" value="${esc(app.outlineSearch)}" style="padding:7px 10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--control);color:var(--ink);font-size:13px;min-width:160px">
        <select id="outline-type-filter" style="padding:7px 10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--control);color:var(--ink);font-size:13px">
          <option value="" ${app.outlineTypeFilter === '' ? 'selected' : ''}>全部类型</option>
          <option value="folder" ${app.outlineTypeFilter === 'folder' ? 'selected' : ''}>目录</option>
          <option value="material" ${app.outlineTypeFilter === 'material' ? 'selected' : ''}>资料</option>
          <option value="vod" ${app.outlineTypeFilter === 'vod' ? 'selected' : ''}>录播</option>
          <option value="lesson" ${app.outlineTypeFilter === 'lesson' ? 'selected' : ''}>课次</option>
          <option value="note" ${app.outlineTypeFilter === 'note' ? 'selected' : ''}>说明</option>
        </select>
      </div>
    </div>
    <div id="outline-tree-container"></div>
    <div id="outline-extra-resources"></div>
  `;

  function renderTree() {
    const st = app.state;
    const nodes = (st.courseNodes || []).filter(n => n.course_id === course.id);
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

    const kw = app.outlineSearch.trim().toLowerCase();
    const typeF = app.outlineTypeFilter;
    let visibleIds = null;
    if (kw || typeF) {
      visibleIds = new Set();
      for (const n of nodes) {
        const matchType = !typeF || n.node_type === typeF;
        const hay = `${n.title || ''} ${n.content || ''}`.toLowerCase();
        const matchKw = !kw || hay.includes(kw);
        if (matchType && matchKw) {
          let cur = n;
          while (cur) {
            visibleIds.add(cur.id);
            cur = cur.parent_id ? byId.get(cur.parent_id) : null;
          }
        }
      }
    }

    const rows = [];
    function walk(parentId, depth) {
      const list = (childrenMap.get(parentId) || []).filter(n => !visibleIds || visibleIds.has(n.id));
      list.forEach((node, idx) => {
        const kids = (childrenMap.get(node.id) || []).filter(k => !visibleIds || visibleIds.has(k.id));
        const isFolder = node.node_type === 'folder';
        const isExpanded = (kw || typeF) ? true : !app.collapsedOutlineNodes.has(node.id);
        rows.push({
          node, depth, isFolder, hasChildren: kids.length > 0,
          directChildCount: (childrenMap.get(node.id) || []).length,
          isExpanded, siblingIndex: idx, siblingCount: list.length
        });
        if (isFolder && isExpanded) walk(node.id, depth + 1);
      });
    }
    walk('', 0);

    const container = body.querySelector('#outline-tree-container');
    const extraBox = body.querySelector('#outline-extra-resources');
    const matMap = new Map(st.materials.map(m => [m.id, m]));
    const vodMap = new Map(st.vodLessons.map(v => [v.id, v]));
    const lesMap = new Map(st.lessons.map(l => [l.id, l]));
    const recByLesson = new Map();
    for (const rec of (st.recordings || [])) {
      if (!recByLesson.has(rec.lesson_id)) recByLesson.set(rec.lesson_id, []);
      recByLesson.get(rec.lesson_id).push(rec);
    }
    const stuProgMap = new Map();
    if (st.currentUser?.role === 'student') {
      for (const p of (st.playbackProgress || [])) stuProgMap.set(`${p.target_type}:${p.target_id}`, p);
    }

    function calcProgPct(p) {
      if (!p) return 0;
      if (p.duration_sec > 0) return Math.min(100, Math.round((p.watched_sec / p.duration_sec) * 100));
      return Math.min(100, Math.round(Number(p.completion_pct || 0)));
    }

    let hasExtraForStudent = false;
    if (extraBox) {
      if (!canEdit) {
        const mountedVodIds = new Set(nodes.filter(n => n.node_type === 'vod' && n.ref_id).map(n => n.ref_id));
        const mountedMatIds = new Set(nodes.filter(n => n.node_type === 'material' && n.ref_id).map(n => n.ref_id));
        const mountedLesIds = new Set(nodes.filter(n => n.node_type === 'lesson' && n.ref_id).map(n => n.ref_id));
        const extraVods = (!typeF || typeF === 'vod') ? st.vodLessons.filter(v => v.course_id === course.id && v.status === 'published' && !mountedVodIds.has(v.id)) : [];
        const extraRecs = (!typeF || typeF === 'lesson' || typeF === 'vod') ? (st.recordings || []).filter(r => r.status === 'published' && courseLesIdsAll.has(r.lesson_id) && !mountedLesIds.has(r.lesson_id)) : [];
        const extraMats = (!typeF || typeF === 'material') ? st.materials.filter(m => ((m.scope === 'course' && m.target_id === course.id) || (m.scope === 'lesson' && courseLesIdsAll.has(m.target_id))) && !mountedMatIds.has(m.id)) : [];
        const extraRows = [
          ...extraVods.map(v => {
            const prog = stuProgMap.get(`vod:${v.id}`);
            const pct = calcProgPct(prog);
            return {
              type: 'vod',
              titleHtml: `<button type="button" class="outline-title outline-title-link" data-extra-play-vod="${v.id}">${esc(v.title)}</button>`,
              metaHtml: `<div class="outline-meta-text">${v.duration_sec ? `<span>${formatDuration(v.duration_sec)}</span>` : ''}${prog ? `<span class="status-pill ${pct >= 90 ? 'is-ok' : 'is-warn'}" style="font-size:11px;padding:1px 6px">${pct >= 90 ? '已学完' : `已看 ${pct}%`}</span>` : '<span>未学习</span>'}</div>`,
              actionsHtml: `<button type="button" class="outline-action-link" data-extra-play-vod="${v.id}">播放</button>`
            };
          }),
          ...extraRecs.map(r => {
            const les = lesMap.get(r.lesson_id);
            const prog = stuProgMap.get(`recording:${r.id}`);
            const pct = calcProgPct(prog);
            return {
              type: 'lesson',
              titleHtml: `<button type="button" class="outline-title outline-title-link" data-extra-play-rec="${r.id}">${esc(r.title || (les ? `${les.title} · 回放` : '课堂回放'))}</button>`,
              metaHtml: `<div class="outline-meta-text">${r.duration_sec ? `<span>${formatDuration(r.duration_sec)}</span>` : ''}<span class="page-badge is-accent">直播回放</span>${prog ? `<span class="status-pill ${pct >= 90 ? 'is-ok' : 'is-warn'}" style="font-size:11px;padding:1px 6px">${pct >= 90 ? '已学完' : `已看 ${pct}%`}</span>` : ''}</div>`,
              actionsHtml: `<button type="button" class="outline-action-link" data-extra-play-rec="${r.id}">回放</button>`
            };
          }),
          ...extraMats.map(m => ({
            type: 'material',
            titleHtml: `<a class="outline-title outline-title-link" href="/api/materials/${m.id}/file" target="_blank" rel="noopener">${esc(m.filename)}</a>`,
            metaHtml: `<div class="outline-meta-text"><span class="page-badge">${esc(m.category || '资料')}</span><span>${formatSize(m.size_bytes)}</span></div>`,
            actionsHtml: `<a class="outline-action-link" href="/api/materials/${m.id}/file" target="_blank" rel="noopener">预览</a><a class="outline-action-link" href="/api/materials/${m.id}/file?download=1">下载</a>`
          }))
        ];
        hasExtraForStudent = extraRows.length > 0;
        if (extraRows.length) {
          extraBox.innerHTML = `
            <div style="margin-top:${rows.length ? '18px' : '0'}">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding:0 2px">
                <span style="font-size:13px;font-weight:600;color:var(--muted)">更多课程资源（未编入目录）</span>
                <span class="page-badge">${extraRows.length} 项</span>
              </div>
              <div class="table-wrap">
                <table class="data-table outline-table mobile-cards-table">
                  <thead><tr><th>名称</th><th style="width:82px">类型</th><th style="width:240px">详情 / 进度</th><th style="width:130px;text-align:right">操作</th></tr></thead>
                  <tbody>
                    ${extraRows.map(item => `
                      <tr>
                        <td class="mc-title"><div class="outline-tree-cell"><span class="outline-toggle-spacer"></span><span class="outline-icon is-${item.type}">${TYPE_ICON[item.type] || TYPE_ICON.material}</span>${item.titleHtml}</div></td>
                        <td data-label="类型"><span class="outline-type-badge is-${item.type}">${TYPE_LABEL[item.type] || item.type}</span></td>
                        <td data-label="详情 / 进度">${item.metaHtml}</td>
                        <td class="mc-actions"><div class="row-actions" style="gap:2px;justify-content:flex-end">${item.actionsHtml}</div></td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          `;
          extraBox.querySelectorAll('[data-extra-play-vod]').forEach(btn => {
            btn.addEventListener('click', () => switchView('player', { playVodId: btn.getAttribute('data-extra-play-vod'), courseId: course.id }));
          });
          extraBox.querySelectorAll('[data-extra-play-rec]').forEach(btn => {
            btn.addEventListener('click', () => switchView('player', { playRecId: btn.getAttribute('data-extra-play-rec'), courseId: course.id }));
          });
        } else {
          extraBox.innerHTML = '';
        }
      } else {
        extraBox.innerHTML = '';
      }
    }

    if (!rows.length) {
      container.innerHTML = hasExtraForStudent
        ? ''
        : `<div class="empty-state">${(kw || typeF) ? '没有匹配的章节或内容' : (canEdit ? '暂无课程内容，点击上方「添加目录」「添加学习内容」或「批量导入」开始编排' : '暂无课程内容')}</div>`;
      return;
    }

    container.innerHTML = `
      <div class="table-wrap">
        <table class="data-table outline-table mobile-cards-table">
          <thead>
            <tr>
              <th>名称</th>
              <th style="width:82px">类型</th>
              <th style="width:240px">详情 / 进度</th>
              <th style="width:${canEdit ? '250px' : '130px'};text-align:right">操作</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => {
              const n = r.node;
              const indent = r.depth * 26;
              const mat = n.node_type === 'material' ? matMap.get(n.ref_id) : null;
              const vod = n.node_type === 'vod' ? vodMap.get(n.ref_id) : null;
              const les = n.node_type === 'lesson' ? lesMap.get(n.ref_id) : null;
              const lesRecs = les ? (recByLesson.get(les.id) || []) : [];

              let titleHtml = `<span class="outline-title">${esc(n.title)}</span>`;
              if (n.node_type === 'material' && mat) {
                titleHtml = `<a class="outline-title outline-title-link" href="/api/materials/${mat.id}/file" target="_blank" rel="noopener">${esc(n.title)}</a>`;
              } else if (n.node_type === 'vod' && vod) {
                titleHtml = `<button type="button" class="outline-title outline-title-link" data-outline-play-vod="${vod.id}">${esc(n.title)}</button>`;
              } else if (n.node_type === 'lesson' && les) {
                titleHtml = `<button type="button" class="outline-title outline-title-link" data-outline-open-les="${les.id}">${esc(n.title)}</button>`;
              } else if (n.node_type === 'note') {
                titleHtml = `<button type="button" class="outline-title outline-title-link" data-outline-view-note="${n.id}">${esc(n.title)}</button>`;
              }

              let metaHtml = `<span style="color:var(--subtle)">${formatOutlineTime(n.created_at)}</span>`;
              if (r.isFolder) {
                metaHtml = `<span class="outline-meta-text">${r.directChildCount} 项内容</span>`;
              } else if (n.node_type === 'material') {
                metaHtml = mat
                  ? `<div class="outline-meta-text"><span class="page-badge">${esc(mat.category || '资料')}</span><span>${formatSize(mat.size_bytes)}</span></div>`
                  : `<span style="color:var(--subtle);font-size:12px">资源已删除</span>`;
              } else if (n.node_type === 'vod') {
                if (vod) {
                  const parts = [];
                  if (vod.duration_sec) parts.push(`<span>${formatDuration(vod.duration_sec)}</span>`);
                  if (canEdit) {
                    parts.push(`<span class="status-pill ${vod.status === 'published' ? 'is-ok' : 'is-warn'}" style="font-size:11px;padding:1px 6px">${vod.status === 'published' ? '已发布' : '已撤回'}</span>`);
                  } else {
                    const prog = stuProgMap.get(`vod:${vod.id}`);
                    if (prog) {
                      const pct = calcProgPct(prog);
                      parts.push(`<span class="status-pill ${pct >= 90 ? 'is-ok' : 'is-warn'}" style="font-size:11px;padding:1px 6px">${pct >= 90 ? '已学完' : `已看 ${pct}%`}</span>`);
                    } else parts.push(`<span>未学习</span>`);
                  }
                  metaHtml = `<div class="outline-meta-text">${parts.join('')}</div>`;
                } else metaHtml = `<span style="color:var(--subtle);font-size:12px">资源已删除</span>`;
              } else if (n.node_type === 'lesson') {
                if (les) {
                  const stLabel = les.status === 'in_progress' ? '上课中' : les.status === 'completed' ? '已完课' : les.status === 'cancelled' ? '已取消' : '待开课';
                  const stCls = les.status === 'in_progress' || les.status === 'completed' ? 'is-ok' : les.status === 'cancelled' ? 'is-danger' : 'is-warn';
                  metaHtml = `<div class="outline-meta-text"><span style="font-variant-numeric:tabular-nums">${formatLessonTime(les.start_ms, les.end_ms)}</span><span class="status-pill ${stCls}" style="font-size:11px;padding:1px 6px">${stLabel}</span>${lesRecs.length ? `<span class="page-badge is-accent">${lesRecs.length}段回放</span>` : ''}</div>`;
                } else metaHtml = `<span style="color:var(--subtle);font-size:12px">课次已删除</span>`;
              } else if (n.node_type === 'note') {
                const snippet = String(n.content || '').replace(/\s+/g, ' ').trim();
                metaHtml = `<span class="outline-meta-text" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block">${snippet ? esc(snippet.slice(0, 36)) : '无正文'}</span>`;
              }

              const actionParts = [];
              if (r.isFolder) {
                if (canEdit) actionParts.push(`<button type="button" class="outline-action-link" data-outline-add-child="${n.id}">添加</button>`);
              } else if (n.node_type === 'material') {
                if (mat) {
                  actionParts.push(`<a class="outline-action-link" href="/api/materials/${mat.id}/file" target="_blank" rel="noopener">预览</a>`);
                  actionParts.push(`<a class="outline-action-link" href="/api/materials/${mat.id}/file?download=1">下载</a>`);
                } else actionParts.push(`<span style="color:var(--subtle);font-size:12px">已删除</span>`);
              } else if (n.node_type === 'vod') {
                if (vod) actionParts.push(`<button type="button" class="outline-action-link" data-outline-play-vod="${vod.id}">播放</button>`);
                else actionParts.push(`<span style="color:var(--subtle);font-size:12px">已删除</span>`);
              } else if (n.node_type === 'lesson') {
                if (les) {
                  if (lesRecs.length) actionParts.push(`<button type="button" class="outline-action-link" data-outline-play-rec="${lesRecs[0].id}">回放</button>`);
                  else if (les.status !== 'cancelled') actionParts.push(`<button type="button" class="outline-action-link" data-outline-go-live="${les.id}">进课堂</button>`);
                  actionParts.push(`<button type="button" class="outline-action-link" data-outline-open-les="${les.id}">详情</button>`);
                } else actionParts.push(`<span style="color:var(--subtle);font-size:12px">已删除</span>`);
              } else if (n.node_type === 'note') {
                actionParts.push(`<button type="button" class="outline-action-link" data-outline-view-note="${n.id}">查看</button>`);
              }

              if (canEdit) {
                if (!kw && !typeF) {
                  if (r.siblingIndex > 0) actionParts.push(`<button type="button" class="outline-action-link is-muted" data-outline-move="${n.id}" data-dir="up" title="上移">↑</button>`);
                  if (r.siblingIndex < r.siblingCount - 1) actionParts.push(`<button type="button" class="outline-action-link is-muted" data-outline-move="${n.id}" data-dir="down" title="下移">↓</button>`);
                }
                actionParts.push(`<button type="button" class="outline-action-link" data-outline-edit="${n.id}">编辑</button>`);
                actionParts.push(`<button type="button" class="outline-action-link is-danger" data-outline-del="${n.id}">移除</button>`);
              }

              const guides = Array.from({ length: r.depth }, (_, d) => `<span class="outline-depth-guide" style="left:${d * 26 + 10}px"></span>`).join('');

              return `
                <tr class="${r.isFolder ? 'outline-row-folder' : ''}" data-node-id="${n.id}" data-node-type="${n.node_type}" ${canEdit ? 'draggable="true"' : ''}>
                  <td class="mc-title">
                    <div class="outline-tree-cell" style="--depth:${r.depth};padding-left:${indent}px">
                      ${guides}
                      ${r.isFolder ? `<button type="button" class="outline-toggle ${r.isExpanded ? 'is-expanded' : ''}" data-outline-toggle="${n.id}" aria-label="${r.isExpanded ? '折叠' : '展开'}">${CHEVRON_SVG}</button>` : `<span class="outline-toggle-spacer"></span>`}
                      ${canEdit ? `<span class="outline-drag-handle" title="拖动调整顺序">${GRIP_SVG}</span>` : ''}
                      <span class="outline-icon is-${n.node_type}">${TYPE_ICON[n.node_type] || TYPE_ICON.material}</span>
                      ${titleHtml}
                    </div>
                  </td>
                  <td data-label="类型"><span class="outline-type-badge is-${n.node_type}">${TYPE_LABEL[n.node_type] || n.node_type}</span></td>
                  <td data-label="详情 / 进度">${metaHtml}</td>
                  <td class="mc-actions${actionParts.length ? '' : ' is-empty-actions'}"><div class="row-actions" style="gap:2px;justify-content:flex-end">${actionParts.length ? actionParts.join('') : '<span style="color:var(--subtle)">-</span>'}</div></td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    container.querySelectorAll('[data-outline-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-outline-toggle');
        if (app.collapsedOutlineNodes.has(id)) app.collapsedOutlineNodes.delete(id);
        else app.collapsedOutlineNodes.add(id);
        renderTree();
      });
    });
    container.querySelectorAll('[data-outline-move]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          app.state = await api(`/api/course-nodes/${btn.getAttribute('data-outline-move')}/move`, { method: 'POST', body: { direction: btn.getAttribute('data-dir') } });
          renderTree();
        } catch (err) { showToast(err.message, true); }
      });
    });
    container.querySelectorAll('[data-outline-add-child]').forEach(btn => {
      btn.addEventListener('click', () => openCourseNodeModal(course, { parentId: btn.getAttribute('data-outline-add-child'), defaultType: 'material' }));
    });
    container.querySelectorAll('[data-outline-edit]').forEach(btn => {
      btn.addEventListener('click', () => {
        const node = (app.state.courseNodes || []).find(x => x.id === btn.getAttribute('data-outline-edit'));
        if (node) openCourseNodeModal(course, { editingNode: node });
      });
    });
    container.querySelectorAll('[data-outline-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-outline-del');
        const node = (app.state.courseNodes || []).find(x => x.id === id);
        if (!node) return;
        const hint = node.node_type === 'folder' ? `确认移除目录「${node.title}」及其下全部子项？\n（不删除已上传的资料或录播文件）` : `确认移除「${node.title}」？`;
        if (!confirm(hint)) return;
        try {
          app.state = await api(`/api/course-nodes/${id}`, { method: 'DELETE' });
          showToast('已移除');
          renderCourses(shell);
        } catch (err) { showToast(err.message, true); }
      });
    });
    container.querySelectorAll('[data-outline-play-vod]').forEach(btn => {
      btn.addEventListener('click', () => switchView('player', { playVodId: btn.getAttribute('data-outline-play-vod'), courseId: course.id }));
    });
    container.querySelectorAll('[data-outline-play-rec]').forEach(btn => {
      btn.addEventListener('click', () => switchView('player', { playRecId: btn.getAttribute('data-outline-play-rec'), courseId: course.id }));
    });
    container.querySelectorAll('[data-outline-go-live]').forEach(btn => {
      btn.addEventListener('click', () => switchView('classroom', { lessonId: btn.getAttribute('data-outline-go-live') }));
    });
    container.querySelectorAll('[data-outline-open-les]').forEach(btn => {
      btn.addEventListener('click', () => openLessonDetailModal(btn.getAttribute('data-outline-open-les')));
    });
    container.querySelectorAll('[data-outline-view-note]').forEach(btn => {
      btn.addEventListener('click', () => {
        const node = (app.state.courseNodes || []).find(x => x.id === btn.getAttribute('data-outline-view-note'));
        if (node) openOutlineNoteModal(node);
      });
    });

    if (canEdit) {
      let dragNodeId = '';
      let dropTargetId = '';
      let dropPosition = '';
      function clearDropMarks() {
        container.querySelectorAll('tr.is-drop-before, tr.is-drop-after, tr.is-drop-inside').forEach(tr => {
          tr.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-inside');
        });
      }
      container.querySelectorAll('tr[data-node-id]').forEach(tr => {
        tr.addEventListener('dragstart', (e) => {
          dragNodeId = tr.getAttribute('data-node-id');
          tr.classList.add('is-dragging');
          if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragNodeId); }
        });
        tr.addEventListener('dragend', () => {
          dragNodeId = ''; dropTargetId = ''; dropPosition = '';
          tr.classList.remove('is-dragging');
          clearDropMarks();
        });
        tr.addEventListener('dragover', (e) => {
          const targetId = tr.getAttribute('data-node-id');
          if (!dragNodeId || dragNodeId === targetId) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
          const rect = tr.getBoundingClientRect();
          const ratio = (e.clientY - rect.top) / Math.max(1, rect.height);
          const isFolder = tr.getAttribute('data-node-type') === 'folder';
          let pos = 'after';
          if (isFolder) pos = ratio < 0.28 ? 'before' : ratio > 0.72 ? 'after' : 'inside';
          else pos = ratio < 0.5 ? 'before' : 'after';
          if (dropTargetId !== targetId || dropPosition !== pos) {
            clearDropMarks();
            dropTargetId = targetId; dropPosition = pos;
            tr.classList.add(pos === 'before' ? 'is-drop-before' : pos === 'after' ? 'is-drop-after' : 'is-drop-inside');
          }
        });
        tr.addEventListener('drop', async (e) => {
          e.preventDefault();
          const fromId = dragNodeId;
          const toId = dropTargetId || tr.getAttribute('data-node-id');
          const pos = dropPosition || 'after';
          clearDropMarks();
          if (!fromId || !toId || fromId === toId) return;
          try {
            app.state = await api(`/api/course-nodes/${fromId}/reorder`, { method: 'POST', body: { targetId: toId, position: pos } });
            if (pos === 'inside') app.collapsedOutlineNodes.delete(toId);
            renderTree();
          } catch (err) { showToast(err.message, true); }
        });
      });
    }
  }

  renderTree();

  body.querySelector('#outline-go-schedule')?.addEventListener('click', () => {
    app.lesCourseFilter = course.id; app.lesFilterType = 'all'; app.lesFilterTarget = '';
    switchView('schedule');
  });
  body.querySelector('#outline-go-materials')?.addEventListener('click', () => {
    app.matCourseFilter = course.id; app.matFilterScope = '';
    switchView('materials');
  });
  body.querySelector('#outline-go-vod')?.addEventListener('click', () => {
    app.vodCourseFilter = course.id; app.vodViewTab = 'all';
    switchView('vod');
  });
  body.querySelector('#outline-go-homework')?.addEventListener('click', () => {
    switchView('homework', { hwCourseFilter: course.id, hwActiveId: '' });
  });
  body.querySelector('#outline-add-homework')?.addEventListener('click', () => {
    openHomeworkEditorModal(null, () => {
      updateNavCounts();
      renderCourses(shell);
    }, course.id);
  });

  // 在课程内容底部展示本课作业清单
  const extraBox = body.querySelector('#outline-extra-resources');
  if (extraBox) {
    const courseHomeworks = (app.state.homeworks || []).filter(h => h.course_id === course.id);
    const courseSubs = app.state.homeworkSubmissions || [];
    if (courseHomeworks.length || canEdit) {
      extraBox.innerHTML = `
        <section class="panel" style="margin-top:14px">
          <div class="panel-head" style="margin-bottom:10px">
            <div style="display:flex;align-items:center;gap:8px">
              <h3 style="margin:0">课程作业</h3>
              <span class="page-badge">${courseHomeworks.length} 份</span>
            </div>
            ${canEdit ? `<button type="button" class="secondary-button btn-sm" id="extra-add-hw">＋ 布置作业</button>` : ''}
          </div>
          ${courseHomeworks.length ? `
            <div class="table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>作业标题</th>
                    <th>截止日期</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  ${courseHomeworks.map(hw => {
                    const subs = courseSubs.filter(s => s.homework_id === hw.id);
                    let statusHtml = '';
                    let actionHtml = '';
                    if (canEdit) {
                      const pending = subs.filter(s => s.status !== 'graded').length;
                      statusHtml = pending > 0
                        ? `<span class="status-pill is-warn">待批改 ${pending} 份（已交 ${subs.length}）</span>`
                        : `<span class="status-pill is-ok">已交 ${subs.length} 份</span>`;
                      actionHtml = `<button type="button" class="secondary-button btn-sm" data-course-open-hw="${esc(hw.id)}">查看与批改</button>`;
                    } else {
                      const mySub = subs[0] || null;
                      statusHtml = !mySub
                        ? `<span class="status-pill is-warn">待提交</span>`
                        : mySub.status === 'graded'
                          ? `<span class="status-pill is-ok">已批改${mySub.score ? ` · ${esc(mySub.score)}` : ''}</span>`
                          : `<span class="status-pill is-active">已提交 · 待批改</span>`;
                      actionHtml = `<button type="button" class="${mySub ? 'secondary-button' : 'primary-button'} btn-sm" data-course-stu-hw="${esc(hw.id)}">${!mySub ? '提交作业' : (mySub.status === 'graded' ? '查看批改' : '修改提交')}</button>`;
                    }
                    return `
                      <tr>
                        <td><strong>${esc(hw.title)}</strong></td>
                        <td style="font-size:12px;color:var(--subtle)">${hw.due_date ? esc(hw.due_date) : '不限'}</td>
                        <td>${statusHtml}</td>
                        <td>${actionHtml}</td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          ` : `<div class="empty-state">本课程暂未布置作业</div>`}
        </section>
      `;
      extraBox.querySelector('#extra-add-hw')?.addEventListener('click', () => {
        openHomeworkEditorModal(null, () => {
          updateNavCounts();
          renderCourses(shell);
        }, course.id);
      });
      extraBox.querySelectorAll('[data-course-open-hw]').forEach(btn => {
        btn.addEventListener('click', () => {
          switchView('homework', { hwCourseFilter: course.id, hwActiveId: btn.getAttribute('data-course-open-hw') });
        });
      });
      extraBox.querySelectorAll('[data-course-stu-hw]').forEach(btn => {
        btn.addEventListener('click', () => {
          const hw = courseHomeworks.find(h => h.id === btn.getAttribute('data-course-stu-hw'));
          if (!hw) return;
          const mySub = courseSubs.find(s => s.homework_id === hw.id) || null;
          openStudentSubmitModal(hw, mySub, () => {
            updateNavCounts();
            renderCourses(shell);
          });
        });
      });
    }
  }
  body.querySelector('#outline-go-qa')?.addEventListener('click', () => {
    app.qaCourseFilter = course.id;
    switchView('qa');
  });

  const searchInp = body.querySelector('#outline-search-input');
  if (searchInp) {
    let comp = false;
    searchInp.addEventListener('compositionstart', () => { comp = true; });
    searchInp.addEventListener('compositionend', () => { comp = false; app.outlineSearch = searchInp.value; renderTree(); });
    searchInp.addEventListener('input', () => { if (!comp) { app.outlineSearch = searchInp.value; renderTree(); } });
  }
  body.querySelector('#outline-type-filter')?.addEventListener('change', (e) => {
    app.outlineTypeFilter = e.target.value;
    renderTree();
  });

  body.querySelector('#outline-add-content')?.addEventListener('click', () => openCourseNodeModal(course, { defaultType: 'material' }));
  body.querySelector('#outline-add-folder')?.addEventListener('click', () => openCourseNodeModal(course, { defaultType: 'folder' }));
  body.querySelector('#outline-batch-import')?.addEventListener('click', () => openBatchImportNodesModal(course));
  body.querySelector('#outline-banner-import')?.addEventListener('click', () => openBatchImportNodesModal(course));
  body.querySelector('#outline-copy-btn')?.addEventListener('click', () => openCopyOutlineModal(course, otherCoursesWithOutline));
  body.querySelector('#outline-toggle-all')?.addEventListener('click', () => {
    if (allCollapsed) folderIds.forEach(id => app.collapsedOutlineNodes.delete(id));
    else folderIds.forEach(id => app.collapsedOutlineNodes.add(id));
    renderCourses(shell);
  });
}

function openBatchImportNodesModal(course) {
  const state = app.state;
  const courseNodes = (state.courseNodes || []).filter(n => n.course_id === course.id);
  const mountedKeys = new Set(courseNodes.filter(n => n.ref_id).map(n => `${n.node_type}:${n.ref_id}`));

  const folderOptions = [];
  function collectFolders(pid, depth) {
    const list = courseNodes
      .filter(n => n.node_type === 'folder' && (n.parent_id || '') === pid)
      .sort((a, b) => (a.sort_order - b.sort_order) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
    for (const f of list) {
      folderOptions.push({ id: f.id, label: `${'　'.repeat(depth)}${depth > 0 ? '└ ' : ''}${f.title}` });
      collectFolders(f.id, depth + 1);
    }
  }
  collectFolders('', 0);

  const courseLessons = state.lessons.filter(l => l.course_id === course.id);
  const courseLesIds = new Set(courseLessons.map(l => l.id));
  const candidates = [];
  state.materials
    .filter(m => (m.scope === 'course' && m.target_id === course.id) || (m.scope === 'lesson' && courseLesIds.has(m.target_id)))
    .forEach(m => { if (!mountedKeys.has(`material:${m.id}`)) candidates.push({ nodeType: 'material', refId: m.id, title: m.filename, badge: '资料', meta: `${m.category || '资料'} · ${formatSize(m.size_bytes)}` }); });
  state.vodLessons
    .filter(v => v.course_id === course.id)
    .forEach(v => { if (!mountedKeys.has(`vod:${v.id}`)) candidates.push({ nodeType: 'vod', refId: v.id, title: v.title, badge: '录播', meta: v.chapter_name || '' }); });
  courseLessons.forEach(l => {
    if (!mountedKeys.has(`lesson:${l.id}`)) candidates.push({ nodeType: 'lesson', refId: l.id, title: l.title, badge: '课次', meta: formatLessonTime(l.start_ms, l.end_ms) });
  });

  const modal = document.querySelector('#modal');
  if (!candidates.length) {
    const body = openModal(`批量导入未挂载内容 · ${course.name}`, `
      <div class="empty-state">本课程的所有资料、录播与课次均已挂载到大纲中</div>
      <div class="form-actions" style="margin-top:14px"><button type="button" class="secondary-button" id="bi-close-btn">关闭</button></div>
    `);
    body?.querySelector('#bi-close-btn')?.addEventListener('click', () => modal.close());
    return;
  }

  const body = openModal(`批量导入未挂载内容 · ${course.name}`, `
    <form id="batch-import-nodes-form" style="display:grid;gap:12px">
      <label class="form-field">
        <span>导入到目录</span>
        <select name="parentId">
          <option value="">根目录</option>
          ${folderOptions.map(f => `<option value="${f.id}">${esc(f.label)}</option>`).join('')}
        </select>
      </label>
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted)">
        <span>共 ${candidates.length} 项未挂载内容</span>
        <label style="cursor:pointer;display:inline-flex;align-items:center;gap:4px"><input type="checkbox" id="bi-check-all" checked> 全选</label>
      </div>
      <div style="max-height:300px;overflow:auto;border:1px solid var(--line);border-radius:var(--radius-sm);padding:6px;display:grid;gap:4px">
        ${candidates.map((c, idx) => `
          <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:13px">
            <input type="checkbox" name="pick" value="${idx}" checked>
            <span class="page-badge is-accent">${c.badge}</span>
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.title)}</span>
            <span style="font-size:11px;color:var(--subtle);white-space:nowrap">${esc(c.meta)}</span>
          </label>
        `).join('')}
      </div>
      <div class="form-actions">
        <button type="submit" class="primary-button" id="bi-submit-btn">批量导入</button>
        <button type="button" class="secondary-button" id="bi-cancel-btn">取消</button>
      </div>
    </form>
  `);
  const checkAll = body.querySelector('#bi-check-all');
  const boxes = [...body.querySelectorAll('input[name="pick"]')];
  checkAll.addEventListener('change', () => boxes.forEach(b => { b.checked = checkAll.checked; }));
  body.querySelector('#bi-cancel-btn').addEventListener('click', () => modal.close());
  body.querySelector('#batch-import-nodes-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const picked = boxes.filter(b => b.checked).map(b => candidates[Number(b.value)]);
    if (!picked.length) { showToast('请至少选择一项', true); return; }
    const parentId = new FormData(e.target).get('parentId') || '';
    const btn = body.querySelector('#bi-submit-btn');
    btn.disabled = true;
    btn.textContent = '导入中…';
    try {
      const res = await api('/api/course-nodes/batch', {
        method: 'POST',
        body: { courseId: course.id, parentId, items: picked.map(p => ({ nodeType: p.nodeType, refId: p.refId, title: p.title })) }
      });
      app.state = res.state;
      if (parentId) app.collapsedOutlineNodes.delete(parentId);
      modal.close();
      showToast(`已导入 ${res.ids.length} 项内容`);
      renderView();
    } catch (err) {
      showToast(err.message, true);
      btn.disabled = false;
      btn.textContent = '批量导入';
    }
  });
}

function openCopyOutlineModal(course, sourceCourses) {
  const modal = document.querySelector('#modal');
  const body = openModal(`复制大纲结构到「${course.name}」`, `
    <form id="copy-outline-form" style="display:grid;gap:12px">
      <div style="font-size:13px;color:var(--muted)">将复制来源课程的目录层级与图文说明节点（追加到当前课程根目录，不覆盖现有内容）。</div>
      <label class="form-field">
        <span>选择来源课程 *</span>
        <select name="sourceCourseId" required>
          <option value="">请选择课程…</option>
          ${sourceCourses.map(c => `<option value="${c.id}">${esc(c.name)}${c.subject ? `（${esc(c.subject)}）` : ''}</option>`).join('')}
        </select>
      </label>
      <div class="form-actions">
        <button type="submit" class="primary-button">确认复制</button>
        <button type="button" class="secondary-button" id="co-cancel-btn">取消</button>
      </div>
    </form>
  `);
  body.querySelector('#co-cancel-btn').addEventListener('click', () => modal.close());
  body.querySelector('#copy-outline-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const sourceCourseId = new FormData(e.target).get('sourceCourseId');
    if (!sourceCourseId) return;
    try {
      const res = await api(`/api/courses/${course.id}/copy-outline`, { method: 'POST', body: { sourceCourseId } });
      app.state = res.state;
      modal.close();
      showToast(`已复制 ${res.copied} 个大纲节点`);
      renderView();
    } catch (err) { showToast(err.message, true); }
  });
}

function openCourseNodeModal(course, { parentId = '', defaultType = 'folder', editingNode = null } = {}) {
  const state = app.state;
  const modal = document.querySelector('#modal');
  const nodeTypeInit = editingNode ? editingNode.node_type : defaultType;
  const parentIdInit = editingNode ? (editingNode.parent_id || '') : parentId;

  const courseNodes = (state.courseNodes || []).filter(n => n.course_id === course.id);
  const excludedIds = new Set();
  if (editingNode) {
    excludedIds.add(editingNode.id);
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of courseNodes) {
        if (n.parent_id && excludedIds.has(n.parent_id) && !excludedIds.has(n.id)) {
          excludedIds.add(n.id);
          changed = true;
        }
      }
    }
  }

  const folderOptions = [];
  function collectFolders(pid, depth) {
    const list = courseNodes
      .filter(n => n.node_type === 'folder' && (n.parent_id || '') === pid && !excludedIds.has(n.id))
      .sort((a, b) => (a.sort_order - b.sort_order) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
    for (const f of list) {
      folderOptions.push({ id: f.id, label: `${'　'.repeat(depth)}${depth > 0 ? '└ ' : ''}${f.title}` });
      collectFolders(f.id, depth + 1);
    }
  }
  collectFolders('', 0);

  const courseLessons = state.lessons.filter(l => l.course_id === course.id);
  const courseLesIds = new Set(courseLessons.map(l => l.id));
  const courseMaterials = state.materials.filter(m => (m.scope === 'course' && m.target_id === course.id) || (m.scope === 'lesson' && courseLesIds.has(m.target_id)));
  const courseVods = state.vodLessons.filter(v => v.course_id === course.id);

  const isFolderMode = nodeTypeInit === 'folder';
  const body = openModal(editingNode ? (isFolderMode ? '编辑目录' : '编辑内容') : (isFolderMode ? '添加目录' : '添加学习内容'), `
    <form id="course-node-form" style="display:grid;gap:14px">
      ${isFolderMode ? `
        <input type="hidden" name="nodeType" id="cn-type-select" value="folder">
        <label class="form-field">
          <span>上级目录</span>
          <select name="parentId"><option value="">根目录</option>${folderOptions.map(f => `<option value="${f.id}" ${parentIdInit === f.id ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select>
        </label>
      ` : `
        <div class="form-grid">
          <label class="form-field">
            <span>上级目录</span>
            <select name="parentId"><option value="">根目录</option>${folderOptions.map(f => `<option value="${f.id}" ${parentIdInit === f.id ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select>
          </label>
          <label class="form-field">
            <span>类型</span>
            <select name="nodeType" id="cn-type-select">
              <option value="material" ${nodeTypeInit === 'material' ? 'selected' : ''}>资料</option>
              <option value="vod" ${nodeTypeInit === 'vod' ? 'selected' : ''}>录播视频</option>
              <option value="lesson" ${nodeTypeInit === 'lesson' ? 'selected' : ''}>直播课次</option>
              <option value="note" ${nodeTypeInit === 'note' ? 'selected' : ''}>图文说明</option>
            </select>
          </label>
        </div>
      `}
      <label class="form-field">
        <span>${isFolderMode ? '目录名称' : '名称'}</span>
        <input name="title" id="cn-title-input" value="${esc(editingNode?.title || '')}" placeholder="${isFolderMode ? '如：第一章 计数原理' : '留空则自动使用所选内容名称'}">
      </label>
      <div id="cn-dynamic-fields" style="display:grid;gap:12px"></div>
      <div class="form-actions">
        <button type="submit" class="primary-button" id="cn-submit-btn">${editingNode ? '保存' : '添加'}</button>
        <button type="button" class="secondary-button" id="cn-cancel-btn">取消</button>
      </div>
    </form>
  `);

  const typeSelect = body.querySelector('#cn-type-select');
  const titleInput = body.querySelector('#cn-title-input');
  const dynBox = body.querySelector('#cn-dynamic-fields');

  function renderDynamicFields() {
    const t = typeSelect.value;
    const initRef = (editingNode && editingNode.node_type === t) ? (editingNode.ref_id || '') : '';
    if (t === 'folder') {
      dynBox.innerHTML = '';
    } else if (t === 'material') {
      const matCats = ['通用讲义', '课前讲义', '课后板书', '其他附件'];
      dynBox.innerHTML = `
        <label class="form-field">
          <span>选择已有资料</span>
          <select name="refId" id="cn-ref-select">
            <option value="">不选（可直接上传新文件）</option>
            ${courseMaterials.map(m => `<option value="${m.id}" ${initRef === m.id ? 'selected' : ''}>[${esc(m.category || '资料')}] ${esc(m.filename)}</option>`).join('')}
          </select>
        </label>
        <div class="form-grid">
          <label class="form-field"><span>或上传新资料${editingNode ? '' : '（支持多选）'}</span><input type="file" id="cn-upload-file" ${editingNode ? '' : 'multiple'}></label>
          <label class="form-field"><span>新资料分类</span><select id="cn-mat-cat">${matCats.map(cat => `<option value="${cat}">${cat}</option>`).join('')}</select></label>
        </div>
      `;
      const sel = dynBox.querySelector('#cn-ref-select');
      const fileInput = dynBox.querySelector('#cn-upload-file');
      sel.addEventListener('change', () => {
        if (!titleInput.value.trim() && sel.value) {
          const m = courseMaterials.find(x => x.id === sel.value);
          if (m) titleInput.value = m.filename;
        }
      });
      fileInput.addEventListener('change', () => {
        const f = fileInput.files?.[0];
        if (f && fileInput.files.length === 1 && !titleInput.value.trim()) titleInput.value = f.name;
      });
    } else if (t === 'vod') {
      dynBox.innerHTML = `
        <label class="form-field">
          <span>选择已有录播视频</span>
          <select name="refId" id="cn-ref-select">
            <option value="">不选（可直接上传新视频）</option>
            ${courseVods.map(v => `<option value="${v.id}" ${initRef === v.id ? 'selected' : ''}>${esc(v.title)}</option>`).join('')}
          </select>
        </label>
        ${editingNode ? '' : `<label class="form-field"><span>或直接上传新录播视频</span><input type="file" id="cn-upload-vod" accept="video/*"></label>`}
      `;
      const sel = dynBox.querySelector('#cn-ref-select');
      const vodFileInput = dynBox.querySelector('#cn-upload-vod');
      sel.addEventListener('change', () => {
        if (!titleInput.value.trim() && sel.value) {
          const v = courseVods.find(x => x.id === sel.value);
          if (v) titleInput.value = v.title;
        }
      });
      vodFileInput?.addEventListener('change', () => {
        const f = vodFileInput.files?.[0];
        if (f && !titleInput.value.trim()) titleInput.value = f.name.replace(/\.[^.]+$/, '');
      });
    } else if (t === 'lesson') {
      dynBox.innerHTML = `
        <label class="form-field">
          <span>选择直播课次 *</span>
          <select name="refId" id="cn-ref-select" required>
            <option value="">请选择课次…</option>
            ${courseLessons.map(l => `<option value="${l.id}" ${initRef === l.id ? 'selected' : ''}>${esc(l.title)}（${formatLessonTime(l.start_ms, l.end_ms)}）</option>`).join('')}
          </select>
        </label>
      `;
      dynBox.querySelector('#cn-ref-select').addEventListener('change', (e) => {
        if (!titleInput.value.trim() && e.target.value) {
          const l = courseLessons.find(x => x.id === e.target.value);
          if (l) titleInput.value = l.title;
        }
      });
    } else if (t === 'note') {
      dynBox.innerHTML = `<label class="form-field"><span>说明内容</span><textarea name="content" rows="5" placeholder="输入章节说明、学习要求或作业提示…">${esc(editingNode?.content || '')}</textarea></label>`;
    }
  }

  renderDynamicFields();
  typeSelect.addEventListener('change', renderDynamicFields);
  body.querySelector('#cn-cancel-btn').addEventListener('click', () => modal.close());

  body.querySelector('#course-node-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const nodeType = fd.get('nodeType');
    const nextParentId = fd.get('parentId') || '';
    let title = String(fd.get('title') || '').trim();
    let refId = String(fd.get('refId') || '').trim();
    const content = String(fd.get('content') || '');
    const submitBtn = body.querySelector('#cn-submit-btn');

    try {
      if (nodeType === 'material') {
        const files = [...(dynBox.querySelector('#cn-upload-file')?.files || [])];
        const matCategory = dynBox.querySelector('#cn-mat-cat')?.value || '通用讲义';
        if (files.length > 1 && !editingNode) {
          submitBtn.disabled = true;
          const createdItems = [];
          for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const q = new URLSearchParams({ scope: 'course', targetId: course.id, category: matCategory, filename: file.name });
            const task = uploadMediaWithProgress(`/api/materials/upload?${q}`, file, {
              contentType: file.type || 'application/octet-stream',
              onProgress: (pct) => { submitBtn.textContent = `上传 (${i + 1}/${files.length}) ${pct}%`; }
            });
            const upRes = await task.promise;
            app.state = upRes.state;
            createdItems.push({ nodeType: 'material', refId: upRes.id, title: file.name });
          }
          submitBtn.textContent = '挂载中…';
          const batchRes = await api('/api/course-nodes/batch', { method: 'POST', body: { courseId: course.id, parentId: nextParentId || '', items: createdItems } });
          app.state = batchRes.state;
          if (nextParentId) app.collapsedOutlineNodes.delete(nextParentId);
          modal.close();
          showToast(`已上传并添加 ${createdItems.length} 份资料`);
          renderView();
          return;
        }
        const file = files[0];
        if (file) {
          submitBtn.disabled = true;
          const q = new URLSearchParams({ scope: 'course', targetId: course.id, category: matCategory, filename: file.name });
          const task = uploadMediaWithProgress(`/api/materials/upload?${q}`, file, {
            contentType: file.type || 'application/octet-stream',
            onProgress: (pct) => { submitBtn.textContent = `上传中 ${pct}%`; }
          });
          const upRes = await task.promise;
          app.state = upRes.state;
          refId = upRes.id;
          if (!title) title = file.name;
        } else if (!refId) { showToast('请选择已有资料或上传新文件', true); return; }
        else if (!title) { title = courseMaterials.find(x => x.id === refId)?.filename || ''; }
      } else if (nodeType === 'vod') {
        const vodFile = dynBox.querySelector('#cn-upload-vod')?.files?.[0];
        if (vodFile && !editingNode) {
          submitBtn.disabled = true;
          const vodTitle = title || vodFile.name.replace(/\.[^.]+$/, '');
          const parentFolder = nextParentId ? courseNodes.find(n => n.id === nextParentId) : null;
          const q = new URLSearchParams({
            courseId: course.id, chapterName: parentFolder?.title || '课程视频',
            title: vodTitle, sortOrder: String(courseVods.length + 1), filename: vodFile.name
          });
          const task = uploadMediaWithProgress(`/api/vod/upload?${q}`, vodFile, {
            contentType: vodFile.type || 'video/mp4',
            onProgress: (pct) => { submitBtn.textContent = `上传视频 ${pct}%`; }
          });
          const upRes = await task.promise;
          app.state = upRes.state;
          refId = upRes.id;
          title = vodTitle;
        } else if (!refId) { showToast('请选择已有录播或上传新视频', true); return; }
        else if (!title) { title = courseVods.find(x => x.id === refId)?.title || ''; }
      } else if (nodeType === 'lesson') {
        if (!refId) { showToast('请选择直播课次', true); return; }
        if (!title) title = courseLessons.find(x => x.id === refId)?.title || '';
      }

      if (!title) {
        showToast('请填写名称', true);
        submitBtn.disabled = false;
        submitBtn.textContent = editingNode ? '保存' : '添加';
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = '保存中…';
      if (editingNode) {
        app.state = await api(`/api/course-nodes/${editingNode.id}`, {
          method: 'PUT', body: { parentId: nextParentId || null, nodeType, title, refId: refId || null, content }
        });
        showToast('已保存');
      } else {
        const res = await api('/api/course-nodes', {
          method: 'POST', body: { courseId: course.id, parentId: nextParentId || null, nodeType, title, refId: refId || null, content }
        });
        app.state = res.state;
        if (nextParentId) app.collapsedOutlineNodes.delete(nextParentId);
        showToast('已添加');
      }
      modal.close();
      renderView();
    } catch (err) {
      showToast(err.message, true);
      submitBtn.disabled = false;
      submitBtn.textContent = editingNode ? '保存' : '添加';
    }
  });
}

function renderScheduleTab(shell, body) {
  const state = app.state;
  const editing = state.lessons.find(l => l.id === app.editingLessonId) || null;
  const panelOpen = app.showCreatePanel || Boolean(editing);
  const defMinutes = Number(state.org?.default_lesson_minutes) || 180;
  let defaultStartMs = nextWholeHourMs(1);
  if (!editing && app.preselectLessonDate) {
    const parsed = Date.parse(`${app.preselectLessonDate}T09:00`);
    if (Number.isFinite(parsed)) defaultStartMs = parsed;
  }
  const defaultStart = editing ? toLocalDatetime(editing.start_ms) : toLocalDatetime(defaultStartMs);
  const defaultEnd = editing ? toLocalDatetime(editing.end_ms) : toLocalDatetime(defaultStartMs + defMinutes * 60000);
  const defaultBatchStart = toLocalDatetime(nextWholeHourMs(24));

  const preselectedCourse = !editing && app.lesCourseFilter
    ? (state.courses.find(c => c.id === app.lesCourseFilter) || null)
    : null;

  function getWeekRange(offsetWeeks = 0) {
    const now = new Date();
    const day = now.getDay() || 7;
    const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1 + offsetWeeks * 7);
    mon.setHours(0, 0, 0, 0);
    return { startMs: mon.getTime(), endMs: mon.getTime() + 7 * 86400000 - 1, mon };
  }

  function filterLessons() {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const todayEnd = todayStart + 86400000 - 1;
    const curWeek = getWeekRange(0);
    const nowMs = Date.now();
    return app.state.lessons.filter(l => {
      if (app.lesCourseFilter && l.course_id !== app.lesCourseFilter) return false;
      if (app.lesFilterStatus && l.status !== app.lesFilterStatus) return false;
      if (app.lesFilterType === 'teacher' && app.lesFilterTarget && l.teacher_id !== app.lesFilterTarget) return false;
      if (app.lesFilterType === 'student' && app.lesFilterTarget) {
        const stuCourseIds = new Set(app.state.enrollments.filter(e => e.student_id === app.lesFilterTarget && e.status === 'active').map(e => e.course_id));
        if (!stuCourseIds.has(l.course_id)) return false;
      }
      if (app.lesViewMode === 'list') {
        if (app.lesTimeFilter === 'today' && (l.start_ms < todayStart || l.start_ms > todayEnd)) return false;
        if (app.lesTimeFilter === 'week' && (l.start_ms < curWeek.startMs || l.start_ms > curWeek.endMs)) return false;
        if (app.lesTimeFilter === 'upcoming' && l.end_ms < nowMs) return false;
        if (app.lesTimeFilter === 'past' && l.end_ms >= nowMs) return false;
      }
      if (app.lesSearch) {
        const kw = app.lesSearch.toLowerCase();
        const hay = `${l.title} ${l.course_name} ${l.teacher_name} ${l.physical_room || ''} ${l.note || ''}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }

  body.innerHTML = `
    <div id="les-error-bar" hidden class="message-bar is-error"></div>

    ${isAdmin() ? `
      <section class="create-panel" ${app.showBatchPanel ? '' : 'hidden'}>
        <h3>批量排课</h3>
        <form id="batch-lesson-form">
          <div class="form-grid">
            <label class="form-field"><span>标题前缀 *</span><input name="titlePrefix" placeholder="如：导数专题" required></label>
            <label class="form-field">
              <span>所属课程 *</span>
              <select name="courseId" id="batch-course" required>
                <option value="">请选择</option>
                ${state.courses.map(c => `<option value="${c.id}" ${preselectedCourse?.id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
              </select>
            </label>
            <label class="form-field">
              <span>授课教师 *</span>
              <select name="teacherId" id="batch-teacher" required>
                <option value="">请选择</option>
                ${state.teachers.map(t => `<option value="${t.id}" ${preselectedCourse?.teacher_id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
              </select>
            </label>
            <label class="form-field"><span>首次开课 *</span><input type="datetime-local" name="firstStart" value="${defaultBatchStart}" required></label>
            <label class="form-field"><span>时长（分钟）*</span><input type="number" name="durationMin" value="${defMinutes}" min="15" required></label>
            <label class="form-field">
              <span>周期</span>
              <select name="intervalDays" id="batch-interval-select">
                <option value="7">每周</option>
                <option value="1">每天</option>
                <option value="14">每两周</option>
                <option value="weekdays">按星期多选</option>
              </select>
            </label>
            <label class="form-field"><span>节数 *</span><input type="number" name="count" value="4" min="1" max="52" required></label>
            <label class="form-field"><span>教室</span><input name="physicalRoom" placeholder="线上课留空"></label>
            <label class="form-field"><span>外接课堂链接</span><input name="externalRoomUrl" placeholder="选填，如 ClassIn 链接"></label>
          </div>
          <div id="batch-weekdays-box" hidden style="margin-top:10px">
            <div style="font-size:12px;color:var(--muted);margin-bottom:4px">选择上课星期（从首次开课日期起按所选星期依次排满指定节数）</div>
            <div class="weekday-picker">
              ${[[1,'周一'],[2,'周二'],[3,'周三'],[4,'周四'],[5,'周五'],[6,'周六'],[0,'周日']].map(([val, lbl]) => `
                <label class="weekday-chip"><input type="checkbox" name="weekday" value="${val}" ${[1,3,5].includes(val) ? 'checked' : ''}><span>${lbl}</span></label>
              `).join('')}
            </div>
          </div>
          <div style="margin-top:10px;display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)">
            <input type="checkbox" id="batch-skip-conflicts" name="skipConflicts">
            <label for="batch-skip-conflicts" style="cursor:pointer">遇时间或并发冲突时自动跳过该讲，继续生成其余课次</label>
          </div>
          <div id="batch-preview-box" style="margin-top:10px"></div>
          <div class="form-actions">
            <button type="button" class="secondary-button" id="preview-batch-btn">预览排课与冲突</button>
            <button type="submit" class="primary-button">批量生成</button>
            <button type="button" class="secondary-button" id="cancel-batch-btn">取消</button>
          </div>
        </form>
      </section>

      <section class="create-panel" ${panelOpen ? '' : 'hidden'}>
        <h3>${editing ? `调课：${esc(editing.title)}` : '新建课次'}</h3>
        <form id="lesson-form">
          <div class="form-grid">
            <label class="form-field"><span>课次名称 *</span><input name="title" value="${esc(editing?.title || '')}" required></label>
            <label class="form-field">
              <span>所属课程 *</span>
              <select name="courseId" id="les-course" required>
                <option value="">请选择</option>
                ${state.courses.map(c => `<option value="${c.id}" ${(editing?.course_id || preselectedCourse?.id) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
              </select>
            </label>
            <label class="form-field">
              <span>授课教师 *</span>
              <select name="teacherId" id="les-teacher" required>
                <option value="">请选择</option>
                ${state.teachers.map(t => `<option value="${t.id}" ${(editing?.teacher_id || preselectedCourse?.teacher_id) === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
              </select>
            </label>
          </div>
          <div class="form-grid" style="margin-top:12px">
            <label class="form-field"><span>开始时间 *</span><input type="datetime-local" name="start" id="les-start" value="${defaultStart}" required></label>
            <label class="form-field"><span>结束时间 *</span><input type="datetime-local" name="end" id="les-end" value="${defaultEnd}" required></label>
            <label class="form-field"><span>教室</span><input name="physicalRoom" value="${esc(editing?.physical_room || '')}" placeholder="线上课留空"></label>
            <label class="form-field"><span>外接课堂链接</span><input name="externalRoomUrl" value="${esc(editing?.external_room_url || '')}" placeholder="选填，如 ClassIn 链接"></label>
            <label class="form-field">
              <span>状态</span>
              <select name="status">
                <option value="scheduled" ${editing?.status === 'scheduled' ? 'selected' : ''}>待开课</option>
                <option value="completed" ${editing?.status === 'completed' ? 'selected' : ''}>已完课</option>
                <option value="cancelled" ${editing?.status === 'cancelled' ? 'selected' : ''}>已取消</option>
              </select>
            </label>
            <label class="form-field"><span>课次备注</span><input name="note" value="${esc(editing?.note || '')}" placeholder="选填，如讲义页码、教学重点…"></label>
          </div>
          <div class="form-actions">
            <button type="submit" class="primary-button">${editing ? '保存' : '确认排课'}</button>
            <button type="button" class="secondary-button" id="cancel-les-btn">取消</button>
          </div>
        </form>
      </section>
    ` : ''}

    <div class="filter-bar">
      <div class="tab-bar" style="margin:0">
        <button type="button" class="tab-btn ${app.lesViewMode === 'list' ? 'active' : ''}" data-les-view="list">列表</button>
        <button type="button" class="tab-btn ${app.lesViewMode === 'week' ? 'active' : ''}" data-les-view="week">周历</button>
      </div>
      <label class="filter-search"><span>搜索</span><input id="les-search-input" type="search" placeholder="课次、课程、教室、备注…" value="${esc(app.lesSearch)}"></label>
      <label>
        <span>课程</span>
        <select id="les-course-filter">
          <option value="">全部课程</option>
          ${state.courses.map(c => `<option value="${c.id}" ${app.lesCourseFilter === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </label>
      ${app.lesViewMode === 'list' ? `
        <label>
          <span>时间</span>
          <select id="les-time-filter">
            <option value="all" ${app.lesTimeFilter === 'all' ? 'selected' : ''}>全部时间</option>
            <option value="today" ${app.lesTimeFilter === 'today' ? 'selected' : ''}>今天</option>
            <option value="week" ${app.lesTimeFilter === 'week' ? 'selected' : ''}>本周</option>
            <option value="upcoming" ${app.lesTimeFilter === 'upcoming' ? 'selected' : ''}>即将上课</option>
            <option value="past" ${app.lesTimeFilter === 'past' ? 'selected' : ''}>历史课次</option>
          </select>
        </label>
      ` : ''}
      ${isAdmin() ? `
        <label>
          <span>视角</span>
          <select id="les-filter-type">
            <option value="all" ${app.lesFilterType === 'all' ? 'selected' : ''}>全部</option>
            <option value="teacher" ${app.lesFilterType === 'teacher' ? 'selected' : ''}>按教师</option>
            <option value="student" ${app.lesFilterType === 'student' ? 'selected' : ''}>按学生</option>
          </select>
        </label>
        ${app.lesFilterType !== 'all' ? `
          <label>
            <span>对象</span>
            <select id="les-filter-target">
              <option value="">全部</option>
              ${app.lesFilterType === 'teacher' ? state.teachers.map(t => `<option value="${t.id}" ${app.lesFilterTarget === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('') : ''}
              ${app.lesFilterType === 'student' ? state.students.map(s => `<option value="${s.id}" ${app.lesFilterTarget === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('') : ''}
            </select>
          </label>
        ` : ''}
      ` : ''}
      <label>
        <span>状态</span>
        <select id="les-filter-status">
          <option value="">全部状态</option>
          <option value="scheduled" ${app.lesFilterStatus === 'scheduled' ? 'selected' : ''}>待开课</option>
          <option value="completed" ${app.lesFilterStatus === 'completed' ? 'selected' : ''}>已完课</option>
          <option value="cancelled" ${app.lesFilterStatus === 'cancelled' ? 'selected' : ''}>已取消</option>
        </select>
      </label>
      <button type="button" class="secondary-button btn-sm" id="export-ics-btn" title="导出为日历文件（可导入 iPad / 手机日历）">导出日历 (.ics)</button>
    </div>

    <div id="les-content-container"></div>
  `;

  function renderScheduleContent() {
    const filtered = filterLessons();
    const box = body.querySelector('#les-content-container');

    if (app.lesViewMode === 'week') {
      const { mon } = getWeekRange(app.lesWeekOffset);
      const todayKey = new Date().toDateString();
      const dayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
      const days = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(mon.getTime() + i * 86400000);
        const dayStart = d.getTime();
        const dayEnd = dayStart + 86400000 - 1;
        const items = filtered.filter(l => l.start_ms >= dayStart && l.start_ms <= dayEnd);
        return { d, label: `${dayNames[i]} ${d.getMonth() + 1}/${d.getDate()}`, isToday: d.toDateString() === todayKey, items };
      });
      const endD = days[6].d;
      const rangeLabel = `${mon.getFullYear()}年${mon.getMonth() + 1}月${mon.getDate()}日 – ${endD.getMonth() + 1}月${endD.getDate()}日`;

      box.innerHTML = `
        <div class="week-nav">
          <strong style="font-size:14px">${rangeLabel}</strong>
          <div class="row-actions">
            <button type="button" class="secondary-button btn-sm" id="week-prev">← 上一周</button>
            <button type="button" class="secondary-button btn-sm" id="week-today">本周</button>
            <button type="button" class="secondary-button btn-sm" id="week-next">下一周 →</button>
          </div>
        </div>
        <div class="week-grid">
          ${days.map(day => `
            <div class="week-col ${day.isToday ? 'is-today' : ''}">
              <div class="week-col-head">
                <span>${day.label}</span>
                <span style="display:inline-flex;align-items:center;gap:4px">
                  <span style="font-size:11px;color:var(--subtle)">${day.items.length ? `${day.items.length}节` : ''}</span>
                  ${isAdmin() ? `<button type="button" class="outline-action-link" data-week-add-date="${day.d.getFullYear()}-${String(day.d.getMonth() + 1).padStart(2, '0')}-${String(day.d.getDate()).padStart(2, '0')}" title="在该日新建课次">＋</button>` : ''}
                </span>
              </div>
              <div class="week-col-body">
                ${day.items.length === 0 ? `<div style="font-size:11px;color:var(--subtle);text-align:center;margin:auto">无排课</div>` : day.items.map(l => {
                  const s = new Date(l.start_ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
                  const e = new Date(l.end_ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
                  return `
                    <button type="button" class="week-card ${l.status === 'cancelled' ? 'is-cancelled' : ''}" data-open-les-detail="${l.id}">
                      <span class="week-card-time">${s}–${e}</span>
                      <span class="week-card-title">${esc(l.title)}</span>
                      <span class="week-card-meta">${esc(l.course_name)} · ${esc(l.teacher_name)}</span>
                    </button>
                  `;
                }).join('')}
              </div>
            </div>
          `).join('')}
        </div>
      `;

      box.querySelector('#week-prev').addEventListener('click', () => { app.lesWeekOffset -= 1; renderScheduleContent(); });
      box.querySelector('#week-today').addEventListener('click', () => { app.lesWeekOffset = 0; renderScheduleContent(); });
      box.querySelector('#week-next').addEventListener('click', () => { app.lesWeekOffset += 1; renderScheduleContent(); });
      box.querySelectorAll('[data-open-les-detail]').forEach(el => {
        el.addEventListener('click', () => openLessonDetailModal(el.getAttribute('data-open-les-detail')));
      });
      box.querySelectorAll('[data-week-add-date]').forEach(btn => {
        btn.addEventListener('click', () => {
          app.preselectLessonDate = btn.getAttribute('data-week-add-date');
          app.editingLessonId = null; app.showBatchPanel = false; app.showCreatePanel = true;
          renderCourses(shell);
        });
      });
      return;
    }

    if (filtered.length === 0) {
      box.innerHTML = `<div class="empty-state">暂无匹配的课次</div>`;
      return;
    }

    box.innerHTML = `
      <div class="table-wrap">
        <table class="data-table mobile-cards-table">
          <thead><tr><th>时间</th><th>课次</th><th>课程</th><th>教师</th><th>地点 / 形式</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            ${filtered.map(l => `
              <tr>
                <td data-label="时间" style="font-variant-numeric:tabular-nums;white-space:nowrap">${formatLessonTime(l.start_ms, l.end_ms)}</td>
                <td data-label="课次">
                  <a href="#lesson" data-open-les-detail="${l.id}"><strong>${esc(l.title)}</strong></a>
                  ${l.note ? `<div style="font-size:11px;color:var(--subtle);margin-top:2px">${esc(l.note)}</div>` : ''}
                </td>
                <td data-label="课程">${esc(l.course_name)}</td>
                <td data-label="教师">${esc(l.teacher_name)}</td>
                <td data-label="地点 / 形式">${l.physical_room ? esc(l.physical_room) : (l.external_room_url ? '外接课堂' : '线上课堂')}</td>
                <td data-label="状态">
                  <span class="status-pill ${l.status === 'in_progress' || l.status === 'completed' ? 'is-ok' : l.status === 'cancelled' ? 'is-danger' : 'is-warn'}">
                    ${l.status === 'in_progress' ? '上课中' : l.status === 'completed' ? '已完课' : l.status === 'cancelled' ? '已取消' : '待开课'}
                  </span>
                </td>
                <td class="mc-actions">
                  <div class="row-actions">
                    ${l.status !== 'cancelled' ? `<button type="button" class="primary-button btn-sm" data-go-live="${l.id}">进课堂</button>` : ''}
                    ${(isTeacher() && l.status === 'scheduled') ? `<button type="button" class="secondary-button btn-sm" data-quick-complete-les="${l.id}">完课</button>` : ''}
                    <button type="button" class="secondary-button btn-sm" data-open-les-detail="${l.id}">详情</button>
                    ${isAdmin() ? `
                      <button type="button" class="secondary-button btn-sm" data-edit-les="${l.id}">调课</button>
                      <button type="button" class="secondary-button btn-sm danger-button" data-del-les="${l.id}">删除</button>
                    ` : ''}
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    box.querySelectorAll('[data-open-les-detail]').forEach(el => {
      el.addEventListener('click', (e) => { e.preventDefault(); openLessonDetailModal(el.getAttribute('data-open-les-detail')); });
    });
    box.querySelectorAll('[data-go-live]').forEach(btn => {
      btn.addEventListener('click', () => switchView('classroom', { lessonId: btn.getAttribute('data-go-live') }));
    });
    box.querySelectorAll('[data-quick-complete-les]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          app.state = await api(`/api/lessons/${btn.getAttribute('data-quick-complete-les')}/status`, { method: 'PATCH', body: { status: 'completed' } });
          showToast('已标记为完课');
          renderView();
        } catch (err) { showToast(err.message, true); }
      });
    });
    box.querySelectorAll('[data-edit-les]').forEach(btn => {
      btn.addEventListener('click', () => { app.editingLessonId = btn.getAttribute('data-edit-les'); app.showCreatePanel = true; renderCourses(shell); });
    });
    box.querySelectorAll('[data-del-les]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const lid = btn.getAttribute('data-del-les');
        const les = app.state.lessons.find(x => x.id === lid);
        const recCnt = app.state.recordings.filter(r => r.lesson_id === lid).length;
        const matCnt = app.state.materials.filter(m => m.scope === 'lesson' && m.target_id === lid).length;
        const extra = (recCnt || matCnt) ? `\n将同时永久删除 ${recCnt} 段回放和 ${matCnt} 份课次资料文件。` : '';
        if (!confirm(`确认删除课次「${les?.title || lid}」？${extra}`)) return;
        try {
          app.state = await api(`/api/lessons/${lid}`, { method: 'DELETE' });
          showToast('已删除课次');
          renderView();
        } catch (err) { showToast(err.message, true); }
      });
    });
  }

  renderScheduleContent();

  body.querySelector('#export-ics-btn')?.addEventListener('click', () => {
    const items = filterLessons().filter(l => l.status !== 'cancelled');
    if (!items.length) { showToast('当前没有可导出的有效课次', true); return; }
    const fmtIcs = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TeachingWorkbench//Schedule//CN'];
    for (const l of items) {
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${l.id}@workbench`);
      lines.push(`DTSTART:${fmtIcs(l.start_ms)}`);
      lines.push(`DTEND:${fmtIcs(l.end_ms)}`);
      lines.push(`SUMMARY:${(l.course_name ? `${l.course_name} - ` : '') + l.title}`);
      lines.push(`DESCRIPTION:教师：${l.teacher_name || ''}${l.note ? `\\n备注：${l.note}` : ''}`);
      if (l.physical_room) lines.push(`LOCATION:${l.physical_room}`);
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `课表_${new Date().toISOString().slice(0, 10)}.ics`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    showToast(`已导出 ${items.length} 节课次到日历文件`);
  });

  shell.querySelector('#toggle-batch-panel')?.addEventListener('click', () => { app.showBatchPanel = !app.showBatchPanel; app.showCreatePanel = false; renderCourses(shell); });
  shell.querySelector('#cancel-batch-btn')?.addEventListener('click', () => { app.showBatchPanel = false; renderCourses(shell); });

  const batchCourseSel = shell.querySelector('#batch-course');
  const batchTchSel = shell.querySelector('#batch-teacher');
  if (batchCourseSel && batchTchSel) {
    batchCourseSel.addEventListener('change', () => {
      const co = app.state.courses.find(c => c.id === batchCourseSel.value);
      if (co?.teacher_id) batchTchSel.value = co.teacher_id;
    });
  }

  const batchForm = shell.querySelector('#batch-lesson-form');
  if (batchForm) {
    const intervalSel = batchForm.querySelector('#batch-interval-select');
    const weekdaysBox = batchForm.querySelector('#batch-weekdays-box');
    const previewBox = batchForm.querySelector('#batch-preview-box');
    if (intervalSel && weekdaysBox) {
      intervalSel.addEventListener('change', () => {
        weekdaysBox.hidden = intervalSel.value !== 'weekdays';
        if (previewBox) previewBox.innerHTML = '';
      });
    }
    function buildBatchPayload(dryRun = false) {
      const fd = new FormData(batchForm);
      const mode = fd.get('intervalDays');
      const weekdays = mode === 'weekdays'
        ? [...batchForm.querySelectorAll('input[name="weekday"]:checked')].map(el => Number(el.value))
        : null;
      return {
        titlePrefix: fd.get('titlePrefix'),
        courseId: fd.get('courseId'),
        teacherId: fd.get('teacherId'),
        firstStartMs: Date.parse(fd.get('firstStart')),
        durationMs: Number(fd.get('durationMin')) * 60000,
        intervalDays: mode === 'weekdays' ? 7 : Number(mode),
        weekdays,
        count: Number(fd.get('count')),
        physicalRoom: fd.get('physicalRoom'),
        externalRoomUrl: fd.get('externalRoomUrl'),
        skipConflicts: Boolean(fd.get('skipConflicts')),
        dryRun
      };
    }

    batchForm.querySelector('#preview-batch-btn')?.addEventListener('click', async () => {
      const errBar = shell.querySelector('#les-error-bar');
      errBar.hidden = true;
      const payload = buildBatchPayload(true);
      if (payload.weekdays && !payload.weekdays.length) {
        errBar.textContent = '请至少选择一个上课星期'; errBar.hidden = false; return;
      }
      try {
        const res = await api('/api/lessons/batch', { method: 'POST', body: payload });
        const rows = res.preview || [];
        previewBox.innerHTML = `
          <div style="border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px;background:var(--surface)">
            <div style="font-size:12px;font-weight:600;margin-bottom:6px">
              预排预览：共 ${rows.length} 讲${res.conflictCount ? `（其中 <span style="color:var(--danger)">${res.conflictCount} 讲冲突</span>）` : '（全部可排，无冲突）'}
            </div>
            <div style="display:grid;gap:4px;max-height:180px;overflow:auto;font-size:12px">
              ${rows.map(r => `
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 6px;border-radius:4px;background:var(--control)">
                  <span><strong>${esc(r.title)}</strong> · ${formatLessonTime(r.startMs, r.endMs)}</span>
                  ${r.conflict ? `<span class="status-pill is-danger" title="${esc(r.conflict)}">冲突：${esc(r.conflict.slice(0, 32))}</span>` : `<span class="status-pill is-ok">可排</span>`}
                </div>
              `).join('')}
            </div>
          </div>
        `;
      } catch (err) { errBar.textContent = err.message; errBar.hidden = false; }
    });

    batchForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBar = shell.querySelector('#les-error-bar');
      errBar.hidden = true;
      const payload = buildBatchPayload(false);
      if (payload.weekdays && !payload.weekdays.length) {
        errBar.textContent = '请至少选择一个上课星期'; errBar.hidden = false; return;
      }
      try {
        const res = await api('/api/lessons/batch', { method: 'POST', body: payload });
        app.state = res.state;
        app.showBatchPanel = false;
        const skippedCnt = res.skipped?.length || 0;
        showToast(skippedCnt ? `已生成 ${res.ids.length} 节课，跳过 ${skippedCnt} 节冲突课次` : `已生成 ${res.ids.length} 节课`);
        renderView();
      } catch (err) { errBar.textContent = err.message; errBar.hidden = false; }
    });
  }

  shell.querySelector('#toggle-les-panel')?.addEventListener('click', () => { app.editingLessonId = null; app.preselectLessonDate = ''; app.showBatchPanel = false; app.showCreatePanel = !panelOpen; renderCourses(shell); });
  shell.querySelector('#cancel-les-btn')?.addEventListener('click', () => { app.editingLessonId = null; app.preselectLessonDate = ''; app.showCreatePanel = false; renderCourses(shell); });

  const courseSel = shell.querySelector('#les-course');
  const tchSel = shell.querySelector('#les-teacher');
  if (courseSel && tchSel) {
    courseSel.addEventListener('change', () => {
      const co = app.state.courses.find(c => c.id === courseSel.value);
      if (co?.teacher_id && !tchSel.value) tchSel.value = co.teacher_id;
    });
  }

  const startInput = shell.querySelector('#les-start');
  const endInput = shell.querySelector('#les-end');
  if (startInput && endInput) {
    let lastStartMs = Date.parse(startInput.value);
    startInput.addEventListener('change', () => {
      const nextStartMs = Date.parse(startInput.value);
      const curEndMs = Date.parse(endInput.value);
      if (Number.isFinite(nextStartMs) && Number.isFinite(lastStartMs) && Number.isFinite(curEndMs)) {
        const dur = Math.max(15 * 60000, curEndMs - lastStartMs);
        endInput.value = toLocalDatetime(nextStartMs + dur);
      }
      lastStartMs = nextStartMs;
    });
  }

  shell.querySelector('#lesson-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errBar = shell.querySelector('#les-error-bar');
    errBar.hidden = true;
    const payload = {
      title: fd.get('title'), courseId: fd.get('courseId'), teacherId: fd.get('teacherId'),
      startMs: Date.parse(fd.get('start')), endMs: Date.parse(fd.get('end')),
      physicalRoom: fd.get('physicalRoom'), externalRoomUrl: fd.get('externalRoomUrl'),
      status: fd.get('status'), note: fd.get('note')
    };
    try {
      if (editing) {
        app.state = await api(`/api/lessons/${editing.id}`, { method: 'PUT', body: payload });
        app.editingLessonId = null; app.showCreatePanel = false;
        showToast('已保存');
      } else {
        const res = await api('/api/lessons', { method: 'POST', body: payload });
        app.state = res.state;
        app.showCreatePanel = false;
        showToast('排课成功');
      }
      renderView();
    } catch (err) { errBar.textContent = err.message; errBar.hidden = false; }
  });

  body.querySelectorAll('[data-les-view]').forEach(btn => {
    btn.addEventListener('click', () => { app.lesViewMode = btn.getAttribute('data-les-view'); renderCourses(shell); });
  });
  body.querySelector('#les-search-input').addEventListener('input', (e) => { app.lesSearch = e.target.value; renderScheduleContent(); });
  body.querySelector('#les-course-filter').addEventListener('change', (e) => { app.lesCourseFilter = e.target.value; renderScheduleContent(); });
  body.querySelector('#les-time-filter')?.addEventListener('change', (e) => { app.lesTimeFilter = e.target.value; renderScheduleContent(); });
  shell.querySelector('#les-filter-type')?.addEventListener('change', (e) => { app.lesFilterType = e.target.value; app.lesFilterTarget = ''; renderCourses(shell); });
  shell.querySelector('#les-filter-target')?.addEventListener('change', (e) => { app.lesFilterTarget = e.target.value; renderScheduleContent(); });
  shell.querySelector('#les-filter-status')?.addEventListener('change', (e) => { app.lesFilterStatus = e.target.value; renderScheduleContent(); });
}

function renderMaterialsTab(shell, body) {
  const state = app.state;
  const matCategories = ['课前讲义', '课后板书', '通用讲义', '其他附件'];
  let pendingFiles = [];

  function getTargetOptionsHtml(scope) {
    if (scope === 'course') {
      return `<option value="">请选择</option>` + app.state.courses.map(c =>
        `<option value="${c.id}" ${app.matCourseFilter === c.id ? 'selected' : ''}>${esc(c.name)}</option>`
      ).join('');
    }
    const lessons = app.matCourseFilter
      ? app.state.lessons.filter(l => l.course_id === app.matCourseFilter)
      : app.state.lessons;
    return `<option value="">请选择</option>` + lessons.map(l =>
      `<option value="${l.id}">${esc(l.title)}（${esc(l.course_name)}）</option>`
    ).join('');
  }

  function getMaterialCourseId(m) {
    if (m.scope === 'course') return m.target_id;
    return app.state.lessons.find(l => l.id === m.target_id)?.course_id || '';
  }

  const activeFolderCourse = app.matCourseFilter ? state.courses.find(c => c.id === app.matCourseFilter) : null;
  const effectiveUploadScope = app.matCourseFilter && !app.showCreatePanel ? 'course' : app.uploadScope;

  body.innerHTML = `
    ${isTeacher() ? `
      <section class="create-panel" ${app.showCreatePanel ? '' : 'hidden'}>
        <h3>${activeFolderCourse ? `上传资料到「${esc(activeFolderCourse.name)}」` : '上传资料'}</h3>
        <form id="upload-mat-form">
          <div class="form-grid">
            <label class="form-field">
              <span>归属</span>
              <select name="scope" id="up-scope-select">
                <option value="course" ${effectiveUploadScope === 'course' ? 'selected' : ''}>课程通用</option>
                <option value="lesson" ${effectiveUploadScope === 'lesson' ? 'selected' : ''}>课次资料</option>
              </select>
            </label>
            <label class="form-field">
              <span>分类</span>
              <select name="category" id="up-cat-select">
                ${matCategories.map(cat => `<option value="${cat}" ${(effectiveUploadScope === 'course' ? cat === '通用讲义' : cat === '课前讲义') ? 'selected' : ''}>${cat}</option>`).join('')}
              </select>
            </label>
            <label class="form-field">
              <span>关联 *</span>
              <select name="targetId" id="up-target-select" required>${getTargetOptionsHtml(effectiveUploadScope)}</select>
            </label>
          </div>
          <div style="margin-top:12px">
            <div class="drop-zone" id="mat-drop-zone">
              <div id="mat-drop-label">拖拽文件到此处，或点击选择（支持多文件批量上传，单文件不超过 100 MB）</div>
              <input type="file" id="mat-file-input" multiple hidden>
            </div>
          </div>
          <div id="mat-upload-progress" class="upload-progress-wrap" hidden>
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span id="mat-upload-text">准备上传…</span>
              <button type="button" class="secondary-button btn-sm" id="mat-abort-btn">取消上传</button>
            </div>
            <div class="prog-track"><div class="prog-fill" id="mat-upload-bar" style="width:0%"></div></div>
          </div>
          <div class="form-actions">
            <button type="submit" class="primary-button" id="up-submit-btn">上传</button>
            <button type="button" class="secondary-button" id="cancel-mat-upload">取消</button>
          </div>
        </form>
      </section>
    ` : ''}

    <div class="filter-bar">
      <label class="filter-search"><span>搜索</span><input id="mat-search-input" type="search" placeholder="文件名、分类、课次…" value="${esc(app.matSearch)}"></label>
      <label>
        <span>课程文件夹</span>
        <select id="mat-course-select">
          <option value="">全部课程文件夹</option>
          ${state.courses.map(c => `<option value="${c.id}" ${app.matCourseFilter === c.id ? 'selected' : ''}>${esc(c.subject ? `[${c.subject}] ${c.name}` : c.name)}</option>`).join('')}
        </select>
      </label>
      <label>
        <span>归属</span>
        <select id="mat-scope-select">
          <option value="">全部</option>
          <option value="lesson" ${app.matFilterScope === 'lesson' ? 'selected' : ''}>课次资料</option>
          <option value="course" ${app.matFilterScope === 'course' ? 'selected' : ''}>课程通用</option>
        </select>
      </label>
      <label>
        <span>分类</span>
        <select id="mat-cat-select">
          <option value="">全部分类</option>
          ${matCategories.map(cat => `<option value="${cat}" ${app.matCatFilter === cat ? 'selected' : ''}>${cat}</option>`).join('')}
        </select>
      </label>
    </div>

    <div id="mat-folder-nav"></div>
    <div id="mat-list-container"></div>
  `;

  function openMountToFolderModal(mat, courseId) {
    const folders = (app.state.courseNodes || []).filter(n => n.course_id === courseId && n.node_type === 'folder');
    if (!folders.length) {
      api('/api/course-nodes', {
        method: 'POST',
        body: { courseId, parentId: '', nodeType: 'material', title: mat.filename, refId: mat.id }
      }).then(res => {
        app.state = res.state;
        showToast('已加入到课程内容大纲');
        renderMaterialList();
      }).catch(err => showToast(err.message, true));
      return;
    }
    const modalBody = openModal('选择挂载目录', `
      <form id="mount-folder-form" style="display:grid;gap:12px">
        <div style="font-size:13px;color:var(--muted)">将「<strong>${esc(mat.filename)}</strong>」加入到课程大纲：</div>
        <label class="form-field">
          <span>目标目录</span>
          <select name="parentId">
            <option value="">根目录</option>
            ${folders.map(f => `<option value="${f.id}">${esc(f.title)}</option>`).join('')}
          </select>
        </label>
        <div class="form-actions">
          <button type="button" class="secondary-button" id="mf-cancel">取消</button>
          <button type="submit" class="primary-button">确认加入</button>
        </div>
      </form>
    `);
    modalBody?.querySelector('#mf-cancel')?.addEventListener('click', () => document.querySelector('#modal')?.close());
    modalBody?.querySelector('#mount-folder-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const parentId = new FormData(e.target).get('parentId') || '';
      try {
        const res = await api('/api/course-nodes', {
          method: 'POST',
          body: { courseId, parentId, nodeType: 'material', title: mat.filename, refId: mat.id }
        });
        app.state = res.state;
        document.querySelector('#modal')?.close();
        showToast('已加入到课程内容大纲');
        renderMaterialList();
      } catch (err) { showToast(err.message, true); }
    });
  }

  function renderMaterialList() {
    const st = app.state;
    const folderNav = body.querySelector('#mat-folder-nav');
    const box = body.querySelector('#mat-list-container');
    const curCourse = app.matCourseFilter ? st.courses.find(c => c.id === app.matCourseFilter) : null;
    const hasFilter = Boolean(app.matSearch.trim() || app.matFilterScope || app.matCatFilter);

    if (!curCourse) {
      const folderCards = st.courses.map(c => {
        const cMats = st.materials.filter(m => getMaterialCourseId(m) === c.id);
        const totalSize = cMats.reduce((s, m) => s + (Number(m.size_bytes) || 0), 0);
        return `
          <div class="stat-card" data-open-folder="${c.id}" style="cursor:pointer">
            <div class="stat-label">
              <span style="display:inline-flex;align-items:center;gap:6px"><svg class="icon"><use href="#i-folder"/></svg><strong>${esc(c.name)}</strong></span>
              ${c.subject ? `<span class="page-badge">${esc(c.subject)}</span>` : ''}
            </div>
            <div class="stat-value" style="font-size:20px">${cMats.length} 份</div>
            <div class="stat-sub">${cMats.length ? `共 ${formatSize(totalSize)}` : '空文件夹 · 点击进入'}</div>
          </div>
        `;
      }).join('');

      folderNav.innerHTML = st.courses.length ? `
        <section class="section-card" style="margin-bottom:14px">
          <div class="section-card-head">
            <h2>课程文件夹</h2>
            <span class="section-summary">${st.courses.length} 个课程 · 共 ${st.materials.length} 份资料</span>
          </div>
          <div class="stat-grid">${folderCards}</div>
        </section>
      ` : '';

      folderNav.querySelectorAll('[data-open-folder]').forEach(card => {
        card.addEventListener('click', () => {
          app.matCourseFilter = card.getAttribute('data-open-folder');
          app.uploadScope = 'course';
          renderCourses(shell);
        });
      });

      if (!hasFilter && st.courses.length) {
        if (!st.materials.length) { box.innerHTML = ''; return; }
        const recent = st.materials.slice(0, 10);
        box.innerHTML = `
          <section class="section-card">
            <div class="section-card-head">
              <h2>最近上传</h2>
              <span class="section-summary">最近 ${recent.length} 份 · 共 ${st.materials.length} 份</span>
            </div>
            <div class="table-wrap">
              <table class="data-table mobile-cards-table">
                <thead><tr><th>文件名</th><th>分类</th><th>关联</th><th>大小</th><th>操作</th></tr></thead>
                <tbody>
                  ${recent.map(m => {
                    const les = m.scope === 'lesson' ? st.lessons.find(l => l.id === m.target_id) : null;
                    const co = m.scope === 'course' ? st.courses.find(c => c.id === m.target_id) : null;
                    const targetHtml = m.scope === 'course'
                      ? `<span class="page-badge is-accent" style="margin-right:4px">课程通用</span>${esc(co?.name || m.target_id)}`
                      : les ? `<div><a href="#lesson" data-mat-open-les="${les.id}"><strong>${esc(les.title)}</strong></a></div><div style="font-size:11px;color:var(--subtle)">${esc(les.course_name)}</div>` : esc(m.target_id);
                    return `
                      <tr>
                        <td class="mc-title"><strong>${esc(m.filename)}</strong></td>
                        <td data-label="分类"><span class="page-badge">${esc(m.category)}</span></td>
                        <td data-label="关联">${targetHtml}</td>
                        <td data-label="大小" style="font-variant-numeric:tabular-nums">${formatSize(m.size_bytes)}</td>
                        <td class="mc-actions"><div class="row-actions"><a class="secondary-button btn-sm" href="/api/materials/${m.id}/file" target="_blank" rel="noopener">查看</a><a class="secondary-button btn-sm" href="/api/materials/${m.id}/file?download=1">下载</a></div></td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </section>
        `;
        box.querySelectorAll('[data-mat-open-les]').forEach(a => {
          a.addEventListener('click', (e) => { e.preventDefault(); openLessonDetailModal(a.getAttribute('data-mat-open-les')); });
        });
        return;
      }
    } else {
      const cMatsCount = st.materials.filter(m => getMaterialCourseId(m) === curCourse.id).length;
      folderNav.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:12px;padding:10px 14px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface)">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <button type="button" class="secondary-button btn-sm" id="back-to-folders-btn">← 全部文件夹</button>
            <span style="color:var(--subtle)">/</span>
            <svg class="icon"><use href="#i-folder"/></svg>
            <strong>${esc(curCourse.name)}</strong>
            ${curCourse.subject ? `<span class="page-badge">${esc(curCourse.subject)}</span>` : ''}
          </div>
          <span style="font-size:12px;color:var(--muted)">${cMatsCount} 份资料</span>
        </div>
      `;
      folderNav.querySelector('#back-to-folders-btn').addEventListener('click', () => {
        app.matCourseFilter = '';
        renderCourses(shell);
      });
    }

    const filtered = st.materials.filter(m => {
      if (app.matFilterScope && m.scope !== app.matFilterScope) return false;
      if (app.matCatFilter && m.category !== app.matCatFilter) return false;
      if (app.matCourseFilter && getMaterialCourseId(m) !== app.matCourseFilter) return false;
      if (app.matSearch) {
        const kw = app.matSearch.toLowerCase();
        const les = m.scope === 'lesson' ? st.lessons.find(l => l.id === m.target_id) : null;
        const co = m.scope === 'course' ? st.courses.find(c => c.id === m.target_id) : null;
        const hay = `${m.filename} ${m.category} ${les?.title || ''} ${les?.course_name || ''} ${co?.name || ''}`.toLowerCase();
        return hay.includes(kw);
      }
      return true;
    });

    if (!filtered.length) {
      box.innerHTML = `<div class="empty-state">${curCourse ? `「${esc(curCourse.name)}」文件夹暂无资料` : '暂无匹配的资料'}</div>`;
      return;
    }

    const mountedMatIds = new Set((st.courseNodes || []).filter(n => n.node_type === 'material' && n.ref_id).map(n => n.ref_id));
    box.innerHTML = `
      ${isTeacher() && app.matSelectedIds.size > 0 ? `
        <div class="message-bar" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <span>已选择 <strong>${app.matSelectedIds.size}</strong> 份资料</span>
          <div class="row-actions">
            <button type="button" class="secondary-button btn-sm" id="mat-batch-clear">取消选择</button>
            <button type="button" class="secondary-button btn-sm danger-button" id="mat-batch-del">批量删除</button>
          </div>
        </div>
      ` : ''}
      <div class="table-wrap">
        <table class="data-table mobile-cards-table">
          <thead><tr>${isTeacher() ? '<th style="width:34px"><input type="checkbox" id="mat-check-all"></th>' : ''}<th>文件名</th><th>分类</th><th>关联</th><th>大纲状态</th><th>大小</th><th>操作</th></tr></thead>
          <tbody>
            ${filtered.map(m => {
              const les = m.scope === 'lesson' ? st.lessons.find(l => l.id === m.target_id) : null;
              const co = m.scope === 'course' ? st.courses.find(c => c.id === m.target_id) : null;
              const mCourseId = getMaterialCourseId(m);
              const isMounted = mountedMatIds.has(m.id);
              const targetHtml = m.scope === 'course'
                ? `<span class="page-badge is-accent" style="margin-right:4px">课程通用</span>${esc(co?.name || m.target_id)}`
                : les ? `<div><a href="#lesson" data-mat-open-les="${les.id}"><strong>${esc(les.title)}</strong></a></div><div style="font-size:11px;color:var(--subtle)">${esc(les.course_name)}</div>` : esc(m.target_id);
              return `
                <tr>
                  ${isTeacher() ? `<td class="mc-check"><input type="checkbox" data-mat-cb="${m.id}" ${app.matSelectedIds.has(m.id) ? 'checked' : ''}></td>` : ''}
                  <td class="mc-title"><strong>${esc(m.filename)}</strong></td>
                  <td data-label="分类">
                    ${isTeacher() ? `
                      <select data-mat-cat-edit="${m.id}" style="padding:3px 6px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--control);color:var(--ink);font-size:12px">
                        ${matCategories.map(cat => `<option value="${cat}" ${m.category === cat ? 'selected' : ''}>${cat}</option>`).join('')}
                        ${!matCategories.includes(m.category) ? `<option value="${esc(m.category)}" selected>${esc(m.category)}</option>` : ''}
                      </select>
                    ` : `<span class="page-badge">${esc(m.category)}</span>`}
                  </td>
                  <td data-label="关联">${targetHtml}</td>
                  <td data-label="大纲状态">
                    ${isMounted
                      ? `<span class="status-pill is-ok" style="font-size:11px">已挂载</span>`
                      : (isTeacher() && mCourseId
                        ? `<button type="button" class="outline-action-link" data-mat-mount="${m.id}" data-mat-course="${mCourseId}">＋ 加入大纲</button>`
                        : `<span style="color:var(--subtle);font-size:12px">未挂载</span>`)}
                  </td>
                  <td data-label="大小" style="font-variant-numeric:tabular-nums">${formatSize(m.size_bytes)}</td>
                  <td class="mc-actions">
                    <div class="row-actions">
                      <a class="secondary-button btn-sm" href="/api/materials/${m.id}/file" target="_blank" rel="noopener">查看</a>
                      <a class="secondary-button btn-sm" href="/api/materials/${m.id}/file?download=1">下载</a>
                      ${isTeacher() ? `<button type="button" class="secondary-button btn-sm" data-rename-mat="${m.id}">重命名</button>` : ''}
                      ${isTeacher() ? `<button type="button" class="secondary-button btn-sm danger-button" data-del-mat="${m.id}">删除</button>` : ''}
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    box.querySelector('#mat-check-all')?.addEventListener('change', (e) => {
      if (e.target.checked) filtered.forEach(m => app.matSelectedIds.add(m.id));
      else filtered.forEach(m => app.matSelectedIds.delete(m.id));
      renderMaterialList();
    });
    box.querySelectorAll('[data-mat-cb]').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = cb.getAttribute('data-mat-cb');
        if (cb.checked) app.matSelectedIds.add(id);
        else app.matSelectedIds.delete(id);
        renderMaterialList();
      });
    });
    box.querySelector('#mat-batch-clear')?.addEventListener('click', () => { app.matSelectedIds.clear(); renderMaterialList(); });
    box.querySelector('#mat-batch-del')?.addEventListener('click', async () => {
      const ids = [...app.matSelectedIds];
      if (!ids.length || !confirm(`确认永久删除选中的 ${ids.length} 份资料？`)) return;
      try {
        for (const id of ids) {
          app.state = await api(`/api/materials/${id}`, { method: 'DELETE' });
        }
        app.matSelectedIds.clear();
        showToast(`已删除 ${ids.length} 份资料`);
        renderView();
      } catch (err) { showToast(err.message, true); }
    });

    box.querySelectorAll('[data-mat-mount]').forEach(btn => {
      btn.addEventListener('click', () => {
        const mid = btn.getAttribute('data-mat-mount');
        const cid = btn.getAttribute('data-mat-course');
        const mat = app.state.materials.find(x => x.id === mid);
        if (mat && cid) openMountToFolderModal(mat, cid);
      });
    });

    box.querySelectorAll('[data-rename-mat]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const mid = btn.getAttribute('data-rename-mat');
        const mat = app.state.materials.find(x => x.id === mid);
        if (!mat) return;
        const nextName = prompt('请输入新的文件名：', mat.filename);
        if (nextName === null) return;
        const clean = nextName.trim();
        if (!clean || clean === mat.filename) return;
        try {
          app.state = await api(`/api/materials/${mid}`, { method: 'PATCH', body: { filename: clean } });
          showToast('文件名已更新');
          renderMaterialList();
        } catch (err) { showToast(err.message, true); }
      });
    });

    box.querySelectorAll('[data-mat-open-les]').forEach(a => {
      a.addEventListener('click', (e) => { e.preventDefault(); openLessonDetailModal(a.getAttribute('data-mat-open-les')); });
    });
    box.querySelectorAll('[data-mat-cat-edit]').forEach(sel => {
      sel.addEventListener('change', async () => {
        try {
          app.state = await api(`/api/materials/${sel.getAttribute('data-mat-cat-edit')}`, { method: 'PATCH', body: { category: sel.value } });
          showToast('分类已更新');
        } catch (err) { showToast(err.message, true); renderMaterialList(); }
      });
    });
    box.querySelectorAll('[data-del-mat]').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('确认删除该文件？')) return;
      try {
        app.state = await api(`/api/materials/${btn.getAttribute('data-del-mat')}`, { method: 'DELETE' });
        showToast('已删除');
        renderView();
      } catch (err) { showToast(err.message, true); }
    }));
  }

  renderMaterialList();

  shell.querySelector('#toggle-mat-upload')?.addEventListener('click', () => { app.showCreatePanel = !app.showCreatePanel; renderCourses(shell); });
  shell.querySelector('#cancel-mat-upload')?.addEventListener('click', () => { app.showCreatePanel = false; renderCourses(shell); });

  const scopeSel = shell.querySelector('#up-scope-select');
  const targetSel = shell.querySelector('#up-target-select');
  const catSel = shell.querySelector('#up-cat-select');
  if (scopeSel && targetSel && catSel) {
    scopeSel.addEventListener('change', (e) => {
      app.uploadScope = e.target.value;
      targetSel.innerHTML = getTargetOptionsHtml(app.uploadScope);
      catSel.value = app.uploadScope === 'course' ? '通用讲义' : '课前讲义';
    });
  }

  const dropZone = shell.querySelector('#mat-drop-zone');
  const fileInput = shell.querySelector('#mat-file-input');
  const dropLabel = shell.querySelector('#mat-drop-label');
  function updatePendingFiles(files) {
    pendingFiles = [...files];
    if (!pendingFiles.length) dropLabel.textContent = '拖拽文件到此处，或点击选择（支持多文件批量上传，单文件不超过 100 MB）';
    else if (pendingFiles.length === 1) dropLabel.textContent = `已选择：${pendingFiles[0].name}（${formatSize(pendingFiles[0].size)}）`;
    else {
      const total = pendingFiles.reduce((s, f) => s + f.size, 0);
      dropLabel.textContent = `已选择 ${pendingFiles.length} 个文件（共 ${formatSize(total)}）：${pendingFiles.map(f => f.name).join('、')}`;
    }
  }
  if (dropZone && fileInput) {
    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => updatePendingFiles(fileInput.files));
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('is-dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-dragover'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('is-dragover');
      if (e.dataTransfer?.files?.length) updatePendingFiles(e.dataTransfer.files);
    });
  }

  shell.querySelector('#mat-search-input').addEventListener('input', (e) => { app.matSearch = e.target.value; renderMaterialList(); });
  shell.querySelector('#mat-course-select').addEventListener('change', (e) => { app.matCourseFilter = e.target.value; renderCourses(shell); });
  shell.querySelector('#mat-scope-select').addEventListener('change', (e) => { app.matFilterScope = e.target.value; renderMaterialList(); });
  shell.querySelector('#mat-cat-select').addEventListener('change', (e) => { app.matCatFilter = e.target.value; renderMaterialList(); });

  const form = shell.querySelector('#upload-mat-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!pendingFiles.length) { showToast('请先选择至少一个文件', true); return; }
      const fd = new FormData(form);
      const btn = shell.querySelector('#up-submit-btn');
      const progWrap = shell.querySelector('#mat-upload-progress');
      const progText = shell.querySelector('#mat-upload-text');
      const progBar = shell.querySelector('#mat-upload-bar');
      const abortBtn = shell.querySelector('#mat-abort-btn');
      btn.disabled = true;
      progWrap.hidden = false;
      try {
        for (let i = 0; i < pendingFiles.length; i++) {
          const file = pendingFiles[i];
          btn.textContent = `上传中 (${i + 1}/${pendingFiles.length})…`;
          const q = new URLSearchParams({
            scope: fd.get('scope'), targetId: fd.get('targetId'),
            category: fd.get('category'), filename: file.name
          });
          const task = uploadMediaWithProgress(`/api/materials/upload?${q}`, file, {
            contentType: file.type || 'application/octet-stream',
            onProgress: (pct, loaded, total) => {
              progBar.style.width = `${pct}%`;
              progText.textContent = `正在上传 (${i + 1}/${pendingFiles.length}) ${file.name} · ${pct}%（${formatSize(loaded)} / ${formatSize(total)}）`;
            }
          });
          abortBtn.onclick = () => task.abort();
          const res = await task.promise;
          app.state = res.state;
        }
        app.showCreatePanel = false;
        showToast(`已成功上传 ${pendingFiles.length} 份资料`);
        renderView();
      } catch (err) {
        showToast(err.message, true);
        btn.disabled = false;
        btn.textContent = '上传';
        progWrap.hidden = true;
      }
    });
  }
}

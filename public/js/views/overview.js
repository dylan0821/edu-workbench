import { esc, formatDuration, formatLessonTime, showToast } from '../utils.js';
import {
  app,
  api,
  isAdmin,
  isTeacher,
  getTotalQaUnreadCount,
  switchView,
  renderView,
  openLessonDetailModal
} from '../state.js';
import { openStudentSubmitModal } from './homework.js';

export function renderOverview(shell) {
  const state = app.state;
  const nowMs = Date.now();
  const pendingRecs = state.recordings.filter(r => r.status === 'pending_review');
  const unresolvedQa = state.qaPosts.filter(p => !p.recall_kind && (p.msg_type || 'chat') === 'question' && !p.resolved);
  const unreadQa = getTotalQaUnreadCount();

  const liveLessons = state.lessons.filter(l => l.status === 'in_progress');
  const scheduledLessons = state.lessons.filter(l => l.status === 'scheduled');
  const upcomingLessons = [
    ...liveLessons,
    ...scheduledLessons.filter(l => l.end_ms >= nowMs).sort((a, b) => a.start_ms - b.start_ms)
  ];
  const nextLesson = upcomingLessons[0];
  const pastUnclosed = isTeacher()
    ? scheduledLessons.filter(l => l.end_ms < nowMs).sort((a, b) => b.end_ms - a.end_ms)
    : [];

  const submissionsByHomework = new Map();
  for (const submission of state.homeworkSubmissions || []) {
    if (!submissionsByHomework.has(submission.homework_id)) submissionsByHomework.set(submission.homework_id, []);
    submissionsByHomework.get(submission.homework_id).push(submission);
  }
  const homeworkRows = (state.homeworks || []).map(hw => {
    const submissions = submissionsByHomework.get(hw.id) || [];
    return { hw, mySub: submissions[0], pending: submissions.filter(s => s.status !== 'graded').length };
  });
  const today = new Date(nowMs).toLocaleDateString('sv-SE');
  const homeworkTodo = isTeacher()
    ? homeworkRows.filter(row => row.pending > 0)
    : homeworkRows.filter(({ mySub }) => !mySub).sort(({ hw: a }, { hw: b }) => {
      const aOverdue = Boolean(a.due_date && a.due_date < today);
      const bOverdue = Boolean(b.due_date && b.due_date < today);
      return Number(aOverdue) - Number(bOverdue) || (a.due_date || '9999-12-31').localeCompare(b.due_date || '9999-12-31');
    });
  const recentlyGraded = isTeacher() ? [] : homeworkRows.filter(row => row.mySub?.status === 'graded')
    .sort((a, b) => (b.mySub.graded_at || '').localeCompare(a.mySub.graded_at || '')).slice(0, 2);
  const pendingArchives = (state.pendingRecordings || []).filter(r =>
    r.status === 'interrupted' || state.lessons.some(l => l.id === r.lesson_id && l.status === 'completed')
  );

  // 学生端：最近观看续播卡片 & 账号到期提醒
  let studentResumeItem = null;
  let expiryWarning = '';
  if (!isTeacher()) {
    const stuId = state.currentUser.linkedId;
    const selfStu = state.students.find(s => s.id === stuId);
    if (selfStu?.valid_until) {
      const expMs = Date.parse(`${selfStu.valid_until}T23:59:59`);
      const daysLeft = Math.ceil((expMs - nowMs) / 86400000);
      if (daysLeft >= 0 && daysLeft <= 7) {
        expiryWarning = `你的学习账号将于 ${selfStu.valid_until} 到期（剩余 ${daysLeft} 天），如需续期请联系老师。`;
      }
    }
    const progs = (state.playbackProgress || [])
      .filter(p => p.student_id === stuId && !p.completed && p.last_position_sec > 2)
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    for (const p of progs) {
      if (p.target_type === 'vod') {
        const v = state.vodLessons.find(x => x.id === p.target_id);
        if (v) { studentResumeItem = { type: 'vod', id: v.id, courseId: v.course_id, title: `${v.course_name} · ${v.title}`, prog: p }; break; }
      } else if (p.target_type === 'recording') {
        const r = state.recordings.find(x => x.id === p.target_id);
        if (r) {
          const les = state.lessons.find(l => l.id === r.lesson_id);
          studentResumeItem = { type: 'recording', id: r.id, courseId: r.course_id || les?.course_id || '', title: `${r.lesson_title} · ${r.title}`, prog: p };
          break;
        }
      }
    }
  }

  shell.innerHTML = `
    <div class="page-heading">
      <div>
        <span class="page-eyebrow">${esc(state.currentUser.name)} · ${isAdmin() ? '管理员工作台' : isTeacher() ? '教师工作台' : '学习空间'}</span>
        <div class="page-title-row">
          <h1>${esc(state.org.name)}</h1>
        </div>
      </div>
      <div class="page-actions">
        ${nextLesson
          ? `<button type="button" class="primary-button" data-enter-live="${esc(nextLesson.id)}">${nextLesson.status === 'in_progress' ? '进入正在进行的课堂' : '查看下一节课'}</button>`
          : '<button type="button" class="primary-button" data-go="schedule">查看课表</button>'}
        <button type="button" class="secondary-button" data-go="${isTeacher() ? 'courses' : 'catalog'}">${isTeacher() ? '课程管理' : '课程内容'}</button>
        ${isTeacher() ? '<button type="button" class="secondary-button" data-go="vod">录播回放</button>' : nextLesson ? '<button type="button" class="secondary-button" data-go="schedule">我的课表</button>' : ''}
      </div>
    </div>

    ${expiryWarning ? `<div class="message-bar" style="border-color:var(--warn);background:var(--warn-soft);color:var(--warn)">${esc(expiryWarning)}</div>` : ''}

    <div class="stat-grid">
      <div class="stat-card" data-go="schedule">
        <div class="stat-label"><span>${isTeacher() ? '课次' : '我的课表'}</span><svg class="icon"><use href="#i-calendar"/></svg></div>
        <div class="stat-value">${state.lessons.length}</div>
        <div class="stat-sub">${upcomingLessons.length ? `${upcomingLessons.length} 节近期排课` : `${state.courses.length} 门课程`}</div>
      </div>
      ${isTeacher() ? `
        <div class="stat-card" data-go="vod">
          <div class="stat-label"><span>录播与回放</span><svg class="icon"><use href="#i-vod"/></svg></div>
          <div class="stat-value">${state.recordings.length + state.vodLessons.length}</div>
          <div class="stat-sub">${pendingRecs.length ? `${pendingRecs.length} 段待审核` : `${state.recordings.length} 回放 · ${state.vodLessons.length} 录播`}</div>
        </div>
      ` : `
        <div class="stat-card" data-go="catalog">
          <div class="stat-label"><span>我的课程</span><svg class="icon"><use href="#i-book"/></svg></div>
          <div class="stat-value">${state.courses.length}</div>
          <div class="stat-sub">${state.recordings.length + state.vodLessons.length} 节视频 · ${state.materials.length} 份资料</div>
        </div>
      `}
      <div class="stat-card" data-go="qa">
        <div class="stat-label"><span>课程群</span><svg class="icon"><use href="#i-qa"/></svg></div>
        <div class="stat-value">${unreadQa > 0 ? unreadQa : unresolvedQa.length}</div>
        <div class="stat-sub">${unreadQa > 0 ? `${unreadQa} 条未读 · ` : ''}${unresolvedQa.length} 条待解答 · ${state.courses.length} 个群</div>
      </div>
      <div class="stat-card" data-go="${isAdmin() ? 'students' : isTeacher() ? 'materials' : 'catalog'}">
        <div class="stat-label"><span>${isAdmin() ? '学生人数' : '课程资料'}</span><svg class="icon"><use href="#i-${isAdmin() ? 'users' : 'folder'}"/></svg></div>
        <div class="stat-value">${isAdmin() ? state.students.length : state.materials.length}</div>
        <div class="stat-sub">${isAdmin() ? `${state.students.filter(s => s.status === '在读').length} 人在读 · ${state.teachers.length} 位教师` : isTeacher() ? '讲义与板书' : '按课程内容查看'}</div>
      </div>
    </div>

    ${studentResumeItem ? `
      <section class="section-card">
        <div class="section-card-head">
          <h2>继续学习</h2>
          <button type="button" class="primary-button btn-sm" id="ov-resume-btn">续播 ${formatDuration(studentResumeItem.prog.last_position_sec)}</button>
        </div>
        <div class="item-row">
          <div class="item-main">
            <div>
              <div class="item-title">${esc(studentResumeItem.title)}</div>
              <div class="item-meta">已累计观看 ${formatDuration(studentResumeItem.prog.watched_sec)} · 上次停留在 ${formatDuration(studentResumeItem.prog.last_position_sec)}</div>
            </div>
          </div>
        </div>
      </section>
    ` : ''}

    <section class="section-card">
      <div class="section-card-head">
        <h2>近期课次</h2>
        <button type="button" class="secondary-button btn-sm" data-go="schedule">全部课表</button>
      </div>
      ${upcomingLessons.length === 0 ? `<div class="empty-state">近期暂无待上或进行中的课次</div>` : `
        <div class="item-list">
          ${upcomingLessons.slice(0, Math.max(6, liveLessons.length)).map((l, idx) => {
            const isLiveNow = l.status === 'in_progress';
            return `
              <div class="item-row">
                <div class="item-main">
                  <span class="item-index">${idx + 1}</span>
                  <div style="min-width:0">
                    <div class="item-title" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                      <a href="#lesson" data-ov-detail="${l.id}" style="color:inherit">${esc(l.title)}</a>
                      <span class="status-pill ${isLiveNow ? 'is-ok' : ''}">${isLiveNow ? '进行中' : '待开课'}</span>
                    </div>
                    <div class="item-meta">
                      ${esc(l.course_name)} · ${esc(l.teacher_name)} · ${formatLessonTime(l.start_ms, l.end_ms)}
                    </div>
                  </div>
                </div>
                <div class="row-actions">
                  ${l.external_room_url ? `<a class="secondary-button btn-sm" href="${esc(l.external_room_url)}" target="_blank" rel="noopener">外接课堂</a>` : ''}
                  <button type="button" class="${isLiveNow ? 'primary-button' : 'secondary-button'} btn-sm" data-enter-live="${esc(l.id)}">${isLiveNow ? '进课堂' : '进入候课'}</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `}
    </section>

    ${homeworkTodo.length || recentlyGraded.length ? `
      <section class="section-card">
        <div class="section-card-head">
          <h2>${isTeacher() ? '待批改作业' : '我的作业'}</h2>
          <button type="button" class="secondary-button btn-sm" data-go="homework">全部作业</button>
        </div>
        <div class="item-list">
          ${[...homeworkTodo.slice(0, 4), ...recentlyGraded].map(({ hw, mySub, pending }) => {
            const graded = !isTeacher() && mySub?.status === 'graded';
            const overdue = hw.due_date && hw.due_date < today;
            return `
              <div class="item-row">
                <div class="item-main">
                  <span class="status-pill ${graded ? 'is-ok' : 'is-warn'}">${isTeacher() ? pending + ' 份待批改' : graded ? '已批改' : overdue ? '已逾期' : '待提交'}</span>
                  <div style="min-width:0">
                    <div class="item-title">${esc(hw.title)}</div>
                    <div class="item-meta">${esc(hw.course_name || '')}${hw.due_date && !graded ? ' · 截止 ' + esc(hw.due_date) : ''}</div>
                  </div>
                </div>
                <div class="row-actions">
                  <button type="button" class="${graded ? 'secondary-button' : 'primary-button'} btn-sm" data-ov-homework="${esc(hw.id)}">${isTeacher() ? '去批改' : graded ? '查看批改' : '查看与提交'}</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </section>
    ` : ''}

    ${isTeacher() && (pendingArchives.length > 0 || pendingRecs.length > 0 || pastUnclosed.length > 0 || unresolvedQa.length > 0) ? `
      <section class="section-card">
        <div class="section-card-head">
          <h2>待办事项</h2>
          <span class="section-summary">${pendingArchives.length ? pendingArchives.length + ' 待恢复 · ' : ''}${pendingRecs.length} 待核看回放 · ${pastUnclosed.length} 待完课 · ${unresolvedQa.length} 待解答</span>
        </div>
        <div class="item-list">
          ${pendingArchives.slice(0, 3).map(r => `
            <div class="item-row">
              <div class="item-main">
                <span class="status-pill is-warn">回放待恢复</span>
                <div style="min-width:0">
                  <div class="item-title">${esc(r.lesson_title)}</div>
                  <div class="item-meta">${esc(r.course_name || '')} · 已收 ${r.received_count} 个分片</div>
                </div>
              </div>
              <div class="row-actions">
                <button type="button" class="secondary-button btn-sm" data-recover-archive="${esc(r.id)}">查看录制</button>
              </div>
            </div>
          `).join('')}
          ${pendingRecs.slice(0, 3).map(r => `
            <div class="item-row">
              <div class="item-main">
                <span class="status-pill is-warn">待核看</span>
                <div style="min-width:0">
                  <div class="item-title">${esc(r.lesson_title)} · ${esc(r.title)}</div>
                  <div class="item-meta">${esc(r.course_name || '')} · 第 ${r.segment} 段</div>
                </div>
              </div>
              <div class="row-actions">
                <button type="button" class="secondary-button btn-sm" data-ov-play-rec="${r.id}">试播</button>
                <button type="button" class="primary-button btn-sm" data-ov-pub-rec="${r.id}">发布</button>
              </div>
            </div>
          `).join('')}
          ${pastUnclosed.slice(0, 4).map(l => `
            <div class="item-row">
              <div class="item-main">
                <span class="status-pill is-warn">待完课</span>
                <div style="min-width:0">
                  <div class="item-title"><a href="#lesson" data-ov-detail="${l.id}" style="color:inherit">${esc(l.title)}</a></div>
                  <div class="item-meta">${esc(l.course_name)} · ${formatLessonTime(l.start_ms, l.end_ms)}</div>
                </div>
              </div>
              <div class="row-actions">
                <button type="button" class="secondary-button btn-sm" data-ov-detail="${l.id}">点名</button>
                <button type="button" class="primary-button btn-sm" data-ov-complete-les="${l.id}">标记完课</button>
              </div>
            </div>
          `).join('')}
          ${unresolvedQa.slice(0, 3).map(q => `
            <div class="item-row">
              <div class="item-main">
                <span class="status-pill is-warn">待解答</span>
                <div style="min-width:0">
                  <div class="item-title">${esc(q.content || q.title)}</div>
                  <div class="item-meta">${esc(q.author_name)} · ${esc(state.courses.find(c => c.id === q.course_id)?.name || '')}</div>
                </div>
              </div>
              <div class="row-actions">
                <button type="button" class="secondary-button btn-sm" data-ov-go-qa="${q.course_id}" data-ov-qa-post="${q.id}">去解答</button>
              </div>
            </div>
          `).join('')}
        </div>
      </section>
    ` : ''}
  `;

  shell.querySelectorAll('[data-go]').forEach(el => {
    el.addEventListener('click', () => {
      const view = el.getAttribute('data-go');
      switchView(view, view === 'homework' ? { hwActiveId: '', hwCourseFilter: '', hwStatusFilter: '', hwSearch: '' } : {});
    });
  });
  shell.querySelectorAll('[data-ov-homework]').forEach(btn => {
    btn.addEventListener('click', () => {
      const { hw, mySub } = homeworkRows.find(row => row.hw.id === btn.getAttribute('data-ov-homework'));
      if (isTeacher()) {
        switchView('homework', { hwActiveId: hw.id, hwCourseFilter: hw.course_id, hwStatusFilter: '', hwSearch: '' });
      } else {
        openStudentSubmitModal(hw, mySub, renderView);
      }
    });
  });
  shell.querySelectorAll('[data-recover-archive]').forEach(btn => {
    btn.addEventListener('click', () => switchView('vod', { pendingRecordingId: btn.getAttribute('data-recover-archive') }));
  });
  shell.querySelectorAll('[data-enter-live]').forEach(btn => {
    btn.addEventListener('click', () => switchView('classroom', { lessonId: btn.getAttribute('data-enter-live') }));
  });
  shell.querySelectorAll('[data-ov-detail]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      openLessonDetailModal(el.getAttribute('data-ov-detail'));
    });
  });
  shell.querySelector('#ov-resume-btn')?.addEventListener('click', () => {
    if (!studentResumeItem) return;
    switchView('player', studentResumeItem.type === 'vod'
      ? { playVodId: studentResumeItem.id, courseId: studentResumeItem.courseId }
      : { playRecId: studentResumeItem.id, courseId: studentResumeItem.courseId });
  });
  shell.querySelectorAll('[data-ov-play-rec]').forEach(btn => {
    btn.addEventListener('click', () => switchView('player', { playRecId: btn.getAttribute('data-ov-play-rec') }));
  });
  shell.querySelectorAll('[data-ov-pub-rec]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        app.state = await api(`/api/recordings/${btn.getAttribute('data-ov-pub-rec')}`, {
          method: 'PATCH',
          body: { status: 'published' }
        });
        showToast('回放已发布');
        renderView();
      } catch (err) { showToast(err.message, true); }
    });
  });
  shell.querySelectorAll('[data-ov-complete-les]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        app.state = await api(`/api/lessons/${btn.getAttribute('data-ov-complete-les')}/status`, {
          method: 'PATCH',
          body: { status: 'completed' }
        });
        showToast('已标记为完课');
        renderView();
      } catch (err) { showToast(err.message, true); }
    });
  });
  shell.querySelectorAll('[data-ov-go-qa]').forEach(btn => {
    btn.addEventListener('click', () => {
      app.qaCourseFilter = btn.getAttribute('data-ov-go-qa');
      switchView('qa', { qaFocusPostId: btn.getAttribute('data-ov-qa-post') });
    });
  });
}

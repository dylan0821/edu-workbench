import { esc, formatDuration, formatLessonTime, showToast, openModal } from '../utils.js';
import {
  app,
  api,
  roleLabel,
  roleBadgeClass,
  persistNavState,
  bindPasswordToggles,
  openChangeOwnPasswordModal,
  accountPlaybackCode,
  renderView
} from '../state.js';

export function renderStudents(shell) {
  const state = app.state;
  shell.innerHTML = `
    <div class="page-heading">
      <div>
        <span class="page-eyebrow">账号管理</span>
        <div class="page-title-row">
          <h1>学生管理</h1>
          <span class="page-badge" id="stu-count-badge">${state.students.length} 人</span>
        </div>
      </div>
      <div class="page-actions">
        <button type="button" class="secondary-button" id="batch-import-stu-btn">批量导入</button>
        <button type="button" class="primary-button" id="toggle-stu-create">
          ${app.showCreatePanel ? '收起' : '＋ 添加学生'}
        </button>
      </div>
    </div>

    <section class="create-panel" ${app.showCreatePanel ? '' : 'hidden'}>
      <h3>添加学生</h3>
      <form id="create-stu-form">
        <div class="form-grid">
          <label class="form-field"><span>用户名</span><input name="loginUsername" type="text" maxlength="32" pattern="[A-Za-z0-9_-]{4,32}" placeholder="如：zhangsan01"></label>
          <label class="form-field"><span>姓名 / 昵称 *</span><input name="name" required></label>
          <label class="form-field"><span>密码</span><div class="pw-field-wrap"><input name="password" type="password" minlength="4" autocomplete="new-password" placeholder="至少 4 位"><button type="button" class="pw-toggle-btn" data-toggle-pw>显示</button></div></label>
          <label class="form-field"><span>手机号</span><input name="phone" type="tel" inputmode="numeric" maxlength="11" pattern="1[0-9]{10}" placeholder="选填"></label>
          <label class="form-field"><span>账号有效期</span><input type="date" name="validUntil"></label>
          <label class="form-field"><span>年级</span><input name="grade" placeholder="如：高三"></label>
          <label class="form-field">
            <span>状态</span>
            <select name="status">
              <option value="意向">意向</option>
              <option value="试听">试听</option>
              <option value="在读">在读</option>
              <option value="已退课">已退课</option>
            </select>
          </label>
        </div>
        ${state.courses.length ? `
          <div style="margin-top:10px">
            <div style="font-size:12px;color:var(--muted);margin-bottom:6px">报读课程（可多选）</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${state.courses.map(c => `
                <label style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border:1px solid var(--line);border-radius:var(--radius-sm);font-size:12px;cursor:pointer;background:var(--control)">
                  <input type="checkbox" name="courseIds" value="${c.id}">
                  <span>${esc(c.name)}</span>
                </label>
              `).join('')}
            </div>
          </div>
        ` : ''}
        <div class="form-actions">
          <button type="submit" class="primary-button">保存</button>
          <button type="button" class="secondary-button" id="cancel-stu-create">取消</button>
        </div>
      </form>
    </section>

    <div class="filter-bar">
      <label class="filter-search"><span>搜索</span><input id="stu-search-input" type="search" placeholder="用户名、昵称、手机号、年级…" value="${esc(app.stuSearch)}"></label>
      <label>
        <span>课程</span>
        <select id="stu-course-select">
          <option value="">全部课程</option>
          ${state.courses.map(c => `<option value="${c.id}" ${app.clsCourseFilter === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </label>
      <label>
        <span>状态</span>
        <select id="stu-status-select">
          <option value="">全部状态</option>
          ${['意向', '试听', '在读', '已退课'].map(st => `<option value="${st}" ${app.stuStatus === st ? 'selected' : ''}>${st}</option>`).join('')}
        </select>
      </label>
    </div>

    <div id="stu-list-container"></div>
  `;
  bindPasswordToggles(shell);

  function formatValidUntilBadge(validUntil) {
    if (!validUntil) return '<span style="color:var(--subtle);font-size:12px">长期有效</span>';
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (today > validUntil) return `<span class="status-pill is-danger">${esc(validUntil)} 已过期</span>`;
    return `<span class="status-pill is-ok">${esc(validUntil)}</span>`;
  }

  function renderStudentList() {
    const st = app.state;
    const stuAccMap = new Map(st.accounts.filter(a => a.role === 'student').map(a => [a.linked_id, a]));
    const filtered = st.students.filter(s => {
      if (app.stuStatus && s.status !== app.stuStatus) return false;
      if (app.clsCourseFilter) {
        const enrolled = st.enrollments.some(e => e.student_id === s.id && e.course_id === app.clsCourseFilter && e.status === 'active');
        if (!enrolled) return false;
      }
      if (app.stuSearch) {
        const kw = app.stuSearch.toLowerCase();
        const uname = (stuAccMap.get(s.id)?.username || '').toLowerCase();
        return s.name.toLowerCase().includes(kw) || (s.phone || '').toLowerCase().includes(kw) || (s.grade || '').toLowerCase().includes(kw) || uname.includes(kw);
      }
      return true;
    });

    const badge = shell.querySelector('#stu-count-badge');
    if (badge) badge.textContent = `${filtered.length} 人`;
    const box = shell.querySelector('#stu-list-container');
    if (!filtered.length) {
      box.innerHTML = `<div class="empty-state">暂无匹配学生</div>`;
      return;
    }

    box.innerHTML = `
      <div class="table-wrap">
        <table class="data-table mobile-cards-table">
          <thead><tr><th>用户名</th><th>姓名 / 昵称</th><th>手机号</th><th>在读课程</th><th>账号有效期</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            ${filtered.map(s => {
              const activeCourses = st.enrollments.filter(e => e.student_id === s.id && e.status === 'active').map(e => e.course_name);
              const acc = stuAccMap.get(s.id);
              const validUntil = s.valid_until || '';
              return `
                <tr>
                  <td data-label="用户名">${acc ? `<strong>${esc(acc.username)}</strong>` : '<span style="color:var(--subtle)">未开号</span>'}</td>
                  <td data-label="姓名"><strong>${esc(s.name)}</strong> ${s.grade ? `<span style="color:var(--muted)">${esc(s.grade)}</span>` : ''}</td>
                  <td data-label="手机号">${esc(s.phone) || '<span style="color:var(--subtle)">未填</span>'}</td>
                  <td data-label="在读课程">${activeCourses.length ? esc(activeCourses.join('、')) : '<span style="color:var(--subtle)">未报课</span>'}</td>
                  <td data-label="账号有效期">${formatValidUntilBadge(validUntil)}</td>
                  <td data-label="状态"><span class="status-pill ${s.status === '在读' ? 'is-ok' : s.status === '已退课' ? 'is-danger' : 'is-warn'}">${esc(s.status)}</span></td>
                  <td class="mc-actions">
                    <div class="row-actions">
                      <button type="button" class="primary-button btn-sm" data-open-stu="${s.id}">档案</button>
                      <button type="button" class="secondary-button btn-sm danger-button" data-del-stu="${s.id}">删除</button>
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    box.querySelectorAll('[data-open-stu]').forEach(btn => {
      btn.addEventListener('click', () => openStudentArchiveModal(btn.getAttribute('data-open-stu'), 'profile'));
    });
    box.querySelectorAll('[data-del-stu]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('确认删除该学生？')) return;
        app.state = await api(`/api/students/${btn.getAttribute('data-del-stu')}`, { method: 'DELETE' });
        showToast('已删除');
        renderView();
      });
    });
  }

  renderStudentList();

  shell.querySelector('#toggle-stu-create').addEventListener('click', () => { app.showCreatePanel = !app.showCreatePanel; renderStudents(shell); });
  shell.querySelector('#cancel-stu-create').addEventListener('click', () => { app.showCreatePanel = false; renderStudents(shell); });
  shell.querySelector('#stu-search-input').addEventListener('input', (e) => { app.stuSearch = e.target.value; renderStudentList(); });
  shell.querySelector('#stu-course-select').addEventListener('change', (e) => { app.clsCourseFilter = e.target.value; renderStudentList(); });
  shell.querySelector('#stu-status-select').addEventListener('change', (e) => { app.stuStatus = e.target.value; renderStudentList(); });

  shell.querySelector('#batch-import-stu-btn')?.addEventListener('click', () => openBatchImportStudentsModal());

  shell.querySelector('#create-stu-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const fd = new FormData(e.target);
      const payload = Object.fromEntries(fd);
      payload.courseIds = fd.getAll('courseIds');
      const res = await api('/api/students', { method: 'POST', body: payload });
      app.state = res.state;
      app.showCreatePanel = false;
      showToast('已添加学生');
      renderView();
    } catch (err) { showToast(err.message, true); }
  });
}

function openBatchImportStudentsModal() {
  const courses = app.state.courses || [];
  const modal = document.querySelector('#modal');
  const body = openModal('批量导入学生', `
    <form id="batch-stu-form" style="display:grid;gap:12px">
      <div style="font-size:12px;color:var(--muted)">
        每行一位学生，用逗号或空格分隔：<br>
        <code>姓名, 手机号(选填), 年级(选填), 状态(意向/试听/在读), 登录用户名(选填), 初始密码(选填)</code>
      </div>
      <textarea name="rawLines" rows="7" placeholder="张三, 13800001001, 高三, 在读, zhangsan, 123456&#10;李四, , 高二, 试听, lisi01, 123456" style="width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--control);color:var(--ink);font-size:13px" required></textarea>
      ${courses.length ? `
        <div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:6px">统一加入课程（选填）</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${courses.map(c => `<label style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border:1px solid var(--line);border-radius:var(--radius-sm);font-size:12px;cursor:pointer;background:var(--control)"><input type="checkbox" name="courseIds" value="${c.id}"><span>${esc(c.name)}</span></label>`).join('')}
          </div>
        </div>
      ` : ''}
      <div class="form-actions">
        <button type="button" class="secondary-button" id="bs-cancel">取消</button>
        <button type="submit" class="primary-button" id="bs-submit">开始导入</button>
      </div>
    </form>
  `);
  body?.querySelector('#bs-cancel')?.addEventListener('click', () => modal.close());
  body?.querySelector('#batch-stu-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const lines = String(fd.get('rawLines') || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) return;
    const courseIds = fd.getAll('courseIds');
    const btn = body.querySelector('#bs-submit');
    btn.disabled = true;
    let ok = 0;
    const errs = [];
    for (let i = 0; i < lines.length; i++) {
      const cols = lines[i].split(/[,，\t]+/).map(x => x.trim());
      const [name, phone = '', grade = '', status = '在读', loginUsername = '', password = ''] = cols;
      if (!name) continue;
      btn.textContent = `导入中 (${i + 1}/${lines.length})…`;
      try {
        const res = await api('/api/students', {
          method: 'POST',
          body: { name, phone, grade, status: status || '在读', loginUsername, password, courseIds }
        });
        app.state = res.state;
        ok += 1;
      } catch (err) {
        errs.push(`第 ${i + 1} 行 (${name}): ${err.message}`);
      }
    }
    modal.close();
    renderView();
    if (errs.length) {
      showToast(`成功导入 ${ok} 人，${errs.length} 条失败：${errs[0]}`, true);
    } else {
      showToast(`成功批量导入 ${ok} 名学生`);
    }
  });
}

export function openStudentArchiveModal(studentId, activeTab = 'profile') {
  const state = app.state;
  const stu = state.students.find(s => s.id === studentId);
  if (!stu) return;
  if (!['profile', 'followup', 'trials', 'video'].includes(activeTab)) activeTab = 'profile';
  const modal = document.querySelector('#modal');

  const stuEnrolls = state.enrollments.filter(e => e.student_id === stu.id);
  const stuAccount = state.accounts.find(a => a.linked_id === stu.id && a.role === 'student');
  const followups = (state.followups || []).filter(f => f.student_id === stu.id);
  const trials = (state.trialGrants || []).filter(t => t.student_id === stu.id);
  const progs = state.playbackProgress.filter(p => p.student_id === stu.id);
  const nowMs = Date.now();

  const body = openModal(`${stu.name}${stu.grade ? ` · ${stu.grade}` : ''}`, `
    <div class="modal-tabs">
      <button type="button" class="secondary-button ${activeTab === 'profile' ? 'is-active' : ''}" data-tab="profile">资料与课程</button>
      <button type="button" class="secondary-button ${activeTab === 'followup' ? 'is-active' : ''}" data-tab="followup">跟进记录 (${followups.length})</button>
      <button type="button" class="secondary-button ${activeTab === 'trials' ? 'is-active' : ''}" data-tab="trials">限时试听 (${trials.length})</button>
      <button type="button" class="secondary-button ${activeTab === 'video' ? 'is-active' : ''}" data-tab="video">视频进度 (${progs.length})</button>
    </div>

    <div ${activeTab === 'profile' ? '' : 'hidden'}>
      <form id="edit-stu-form" style="padding-bottom:16px;border-bottom:1px solid var(--line);margin-bottom:16px">
        <div class="form-grid">
          <label class="form-field"><span>姓名 / 昵称 *</span><input name="name" value="${esc(stu.name)}" required></label>
          <label class="form-field"><span>手机号</span><input name="phone" type="tel" inputmode="numeric" maxlength="11" pattern="1[0-9]{10}" value="${esc(stu.phone || '')}" placeholder="选填"></label>
          <label class="form-field"><span>账号有效期</span><input type="date" name="validUntil" value="${esc(stu.valid_until || '')}"></label>
          <label class="form-field"><span>下次跟进日期</span><input type="date" name="nextFollowupDate" value="${esc(stu.next_followup_date || '')}"></label>
          <label class="form-field"><span>年级</span><input name="grade" value="${esc(stu.grade)}"></label>
          <label class="form-field"><span>状态</span><select name="status">${['意向', '试听', '在读', '已退课'].map(st => `<option value="${st}" ${stu.status === st ? 'selected' : ''}>${st}</option>`).join('')}</select></label>
          <label class="form-field" style="grid-column:1 / -1"><span>档案备注</span><input name="note" value="${esc(stu.note || '')}" placeholder="基础情况、目标分数等…"></label>
        </div>
        ${state.courses.length ? `
          <div style="margin-top:12px">
            <div style="font-size:12px;color:var(--muted);margin-bottom:6px">报读课程（可多选）</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${state.courses.map(c => {
                const checked = stuEnrolls.some(e => e.course_id === c.id && e.status === 'active');
                return `
                  <label style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border:1px solid var(--line);border-radius:var(--radius-sm);font-size:12px;cursor:pointer;background:var(--control)">
                    <input type="checkbox" name="courseIds" value="${c.id}" ${checked ? 'checked' : ''}>
                    <span>${esc(c.name)}</span>
                  </label>
                `;
              }).join('')}
            </div>
          </div>
        ` : ''}
        <div class="form-actions"><button type="submit" class="primary-button btn-sm">保存资料</button></div>
      </form>

      <form id="stu-account-form" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input name="username" type="text" minlength="4" maxlength="32" pattern="[A-Za-z0-9_-]{4,32}" value="${esc(stuAccount?.username || stu.phone || '')}" placeholder="登录用户名 *" style="flex:1;min-width:140px;padding:6px 10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--control);color:var(--ink)" required>
        <div class="pw-field-wrap" style="flex:1;min-width:140px"><input name="password" type="password" minlength="4" autocomplete="new-password" placeholder="新密码（至少 4 位）*" style="width:100%;padding:6px 46px 6px 10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--control);color:var(--ink)" required><button type="button" class="pw-toggle-btn" data-toggle-pw>显示</button></div>
        <button type="submit" class="secondary-button">${stuAccount ? '重置密码' : '开通账号'}</button>
      </form>
    </div>

    <div ${activeTab === 'followup' ? '' : 'hidden'}>
      <form id="stu-followup-form" style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
        <input name="content" placeholder="记录沟通情况、试听反馈或学情备注…" style="flex:1;min-width:200px;padding:7px 10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--control);color:var(--ink);font-size:13px" required>
        <button type="submit" class="primary-button btn-sm">＋ 添加跟进</button>
      </form>
      ${followups.length === 0 ? `<div class="empty-state">暂无跟进记录</div>` : `
        <div class="item-list">
          ${followups.map(f => `
            <div class="item-row">
              <div>
                <div class="item-title" style="font-weight:500">${esc(f.content)}</div>
                <div class="item-meta">${esc(f.created_at)}</div>
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </div>

    <div ${activeTab === 'trials' ? '' : 'hidden'}>
      <form id="stu-trial-form" style="padding:12px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--list-surface);margin-bottom:14px;display:grid;gap:10px">
        <div class="form-grid">
          <label class="form-field">
            <span>试听类型</span>
            <select name="targetType" id="trial-type-sel">
              <option value="lesson">直播课次</option>
              <option value="vod">录播小节</option>
            </select>
          </label>
          <label class="form-field">
            <span>试听内容 *</span>
            <select name="targetId" id="trial-target-sel" required></select>
          </label>
          <label class="form-field">
            <span>有效天数 *</span>
            <input type="number" name="days" value="7" min="1" max="365" required>
          </label>
          <label class="form-field">
            <span>备注</span>
            <input name="note" placeholder="如：高三试听导数">
          </label>
        </div>
        <div class="form-actions" style="margin-top:2px"><button type="submit" class="primary-button btn-sm">发放试听权限</button></div>
      </form>
      ${trials.length === 0 ? `<div class="empty-state">暂无限时试听授权</div>` : `
        <div class="item-list">
          ${trials.map(t => {
            const expired = Number(t.expires_at) <= nowMs;
            const expStr = new Date(Number(t.expires_at)).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            return `
              <div class="item-row">
                <div>
                  <div class="item-title">
                    <span class="page-badge is-accent">${t.target_type === 'lesson' ? '课次' : '录播'}</span>
                    ${esc(t.target_title || t.target_id)}
                    <span class="status-pill ${expired ? 'is-danger' : 'is-ok'}" style="margin-left:6px">${expired ? '已过期' : `有效至 ${expStr}`}</span>
                  </div>
                  ${t.note ? `<div class="item-meta">${esc(t.note)}</div>` : ''}
                </div>
                <button type="button" class="secondary-button btn-sm danger-button" data-del-trial="${t.id}">收回</button>
              </div>
            `;
          }).join('')}
        </div>
      `}
    </div>

    <div ${activeTab === 'video' ? '' : 'hidden'}>
      ${progs.length === 0 ? `<div class="empty-state">暂无观看记录</div>` : `
        <div class="item-list">
          ${progs.map(p => {
            const title = p.target_type === 'recording'
              ? state.recordings.find(r => r.id === p.target_id)?.title || '直播回放'
              : state.vodLessons.find(v => v.id === p.target_id)?.title || '录播小节';
            const pct = p.duration_sec > 0 ? Math.min(100, Math.round((p.watched_sec / p.duration_sec) * 100)) : 0;
            return `
              <div class="item-row">
                <div>
                  <div class="item-title">${esc(title)}</div>
                  <div class="item-meta">已看 ${formatDuration(p.watched_sec)}（${pct}%）· 上次位置 ${formatDuration(p.last_position_sec)}</div>
                </div>
                <span class="status-pill ${p.completed ? 'is-ok' : 'is-warn'}">${p.completed ? '已完课' : '学习中'}</span>
              </div>
            `;
          }).join('')}
        </div>
      `}
    </div>
  `);
  if (!body) return;
  bindPasswordToggles(body);

  body.querySelectorAll('[data-tab]').forEach(btn => btn.addEventListener('click', () => openStudentArchiveModal(stu.id, btn.getAttribute('data-tab'))));

  body.querySelector('#edit-stu-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const fd = new FormData(e.target);
      const payload = Object.fromEntries(fd);
      payload.courseIds = fd.getAll('courseIds');
      app.state = await api(`/api/students/${stu.id}`, { method: 'PUT', body: payload });
      showToast('已保存资料');
      openStudentArchiveModal(stu.id, 'profile');
      renderView();
    } catch (err) { showToast(err.message, true); }
  });

  body.querySelector('#stu-account-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const res = await api('/api/accounts', {
        method: 'POST',
        body: { username: fd.get('username'), password: fd.get('password'), role: 'student', linkedId: stu.id, name: stu.name }
      });
      app.state = res.state;
      showToast('账号已更新');
      openStudentArchiveModal(stu.id, 'profile');
      renderView();
    } catch (err) { showToast(err.message, true); }
  });

  body.querySelector('#stu-followup-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = String(new FormData(e.target).get('content') || '').trim();
    if (!content) return;
    try {
      app.state = await api(`/api/students/${stu.id}/followups`, { method: 'POST', body: { content } });
      showToast('已添加跟进记录');
      openStudentArchiveModal(stu.id, 'followup');
    } catch (err) { showToast(err.message, true); }
  });

  // 限时试听表单
  const trialTypeSel = body.querySelector('#trial-type-sel');
  const trialTargetSel = body.querySelector('#trial-target-sel');
  function fillTrialTargets() {
    if (!trialTypeSel || !trialTargetSel) return;
    if (trialTypeSel.value === 'lesson') {
      trialTargetSel.innerHTML = `<option value="">请选择课次…</option>` + app.state.lessons.map(l => `<option value="${l.id}">${esc(l.title)}（${esc(l.course_name)}）</option>`).join('');
    } else {
      trialTargetSel.innerHTML = `<option value="">请选择录播…</option>` + app.state.vodLessons.map(v => `<option value="${v.id}">${esc(v.title)}（${esc(v.course_name)}）</option>`).join('');
    }
  }
  fillTrialTargets();
  trialTypeSel?.addEventListener('change', fillTrialTargets);

  body.querySelector('#stu-trial-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const days = Math.max(1, Number(fd.get('days')) || 7);
    const expiresAt = Date.now() + days * 86400000;
    try {
      const res = await api('/api/trials', {
        method: 'POST',
        body: { studentId: stu.id, targetType: fd.get('targetType'), targetId: fd.get('targetId'), expiresAt, note: fd.get('note') }
      });
      app.state = res.state;
      showToast(`已发放 ${days} 天试听权限`);
      openStudentArchiveModal(stu.id, 'trials');
    } catch (err) { showToast(err.message, true); }
  });
  body.querySelectorAll('[data-del-trial]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        app.state = await api(`/api/trials/${btn.getAttribute('data-del-trial')}`, { method: 'DELETE' });
        showToast('已收回试听权限');
        openStudentArchiveModal(stu.id, 'trials');
      } catch (err) { showToast(err.message, true); }
    });
  });
}

export function openCourseStudentsModal(courseId) {
  const state = app.state;
  const course = state.courses.find(c => c.id === courseId);
  if (!course) return;
  const members = state.enrollments.filter(e => e.course_id === courseId);
  const activeMembers = members.filter(e => e.status === 'active');
  const withdrawnMembers = members.filter(e => e.status === 'withdrawn');
  const hasCap = course.capacity != null && course.capacity > 0;
  const remain = hasCap ? Math.max(0, course.capacity - activeMembers.length) : Infinity;

  const body = openModal(`课程学生 · ${course.name}`, `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--line)">
      <div style="font-size:13px;color:var(--muted)">
        授课教师：<strong style="color:var(--ink)">${course.teacher_name ? esc(course.teacher_name) : '未指定'}</strong>
        · 在读 <strong style="color:var(--ink)">${hasCap ? `${activeMembers.length} / ${course.capacity}` : `${activeMembers.length}`}</strong> 人${hasCap ? `（剩余名额 ${remain}）` : '（不限上限）'}
      </div>
      <button type="button" class="primary-button btn-sm" id="course-stu-batch-add" ${remain === 0 ? 'disabled' : ''}>＋ 批量添加学生</button>
    </div>

    <div style="margin-bottom:16px">
      <div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:8px">在读学生（${activeMembers.length}）</div>
      ${activeMembers.length === 0
        ? `<div class="empty-state" style="padding:18px">暂无在读学生，点击右上角「批量添加学生」加入本课程</div>`
        : `<div class="item-list" style="max-height:280px;overflow-y:auto">
            ${activeMembers.map(m => `
              <div class="item-row" style="padding:8px 12px">
                <div style="font-size:13px"><strong>${esc(m.student_name)}</strong>${m.student_grade ? `<span style="color:var(--subtle);margin-left:6px;font-size:12px">${esc(m.student_grade)}</span>` : ''}</div>
                <div class="row-actions">
                  <button type="button" class="secondary-button btn-sm" data-cs-transfer="${m.id}">转课</button>
                  <button type="button" class="secondary-button btn-sm danger-button" data-cs-withdraw="${m.id}">退课</button>
                </div>
              </div>
            `).join('')}
          </div>`}
    </div>

    ${withdrawnMembers.length ? `
      <div>
        <div style="font-size:12px;font-weight:600;color:var(--subtle);margin-bottom:8px">已退课（${withdrawnMembers.length}）</div>
        <div class="item-list" style="max-height:160px;overflow-y:auto">
          ${withdrawnMembers.map(m => `
            <div class="item-row" style="padding:7px 12px;opacity:.8">
              <div style="font-size:13px"><span>${esc(m.student_name)}</span>${m.student_grade ? `<span style="color:var(--subtle);margin-left:6px;font-size:12px">${esc(m.student_grade)}</span>` : ''}</div>
              <div class="row-actions"><button type="button" class="secondary-button btn-sm" data-cs-restore="${m.id}">恢复在读</button></div>
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}
  `);
  if (!body) return;
  body.querySelector('#course-stu-batch-add')?.addEventListener('click', () => openBatchEnrollModal(courseId));
  body.querySelectorAll('[data-cs-transfer]').forEach(btn => {
    btn.addEventListener('click', () => openTransferModal(btn.getAttribute('data-cs-transfer'), courseId));
  });
  body.querySelectorAll('[data-cs-withdraw]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('确认将该学生从本课程退课？')) return;
      try {
        app.state = await api(`/api/enrollments/${btn.getAttribute('data-cs-withdraw')}`, { method: 'PATCH', body: { status: 'withdrawn' } });
        showToast('已办理退课');
        openCourseStudentsModal(courseId);
        renderView();
      } catch (err) { showToast(err.message, true); }
    });
  });
  body.querySelectorAll('[data-cs-restore]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        app.state = await api(`/api/enrollments/${btn.getAttribute('data-cs-restore')}`, { method: 'PATCH', body: { status: 'active' } });
        showToast('已恢复在读');
        openCourseStudentsModal(courseId);
        renderView();
      } catch (err) { showToast(err.message, true); }
    });
  });
}

function openBatchEnrollModal(courseId) {
  const state = app.state;
  const course = state.courses.find(c => c.id === courseId);
  if (!course) return;
  const activeIds = new Set(state.enrollments.filter(e => e.course_id === courseId && e.status === 'active').map(e => e.student_id));
  const candidates = state.students.filter(s => !activeIds.has(s.id));
  const hasCap = course.capacity != null && course.capacity > 0;
  const remain = hasCap ? Math.max(0, course.capacity - activeIds.size) : Infinity;
  const selected = new Set();
  let kw = '';

  const body = openModal(`批量添加学生 · ${course.name}`, `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px;font-size:13px;color:var(--muted)">
      <span>${esc(course.name)} · 当前在读 <strong style="color:var(--ink)">${hasCap ? `${activeIds.size} / ${course.capacity}` : `${activeIds.size}`}</strong> 人${hasCap ? `（剩余名额 ${remain}）` : '（不限上限）'}</span>
      <span id="batch-en-selected-count" class="page-badge is-accent">已选 0 人</span>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
      <input id="batch-en-search" type="search" placeholder="搜索学生姓名、年级、手机号…" style="flex:1 1 180px;min-width:0;padding:7px 10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--control);color:var(--ink);font-size:13px">
      <button type="button" class="secondary-button btn-sm" id="batch-en-select-all">全选当前</button>
      <button type="button" class="secondary-button btn-sm" id="batch-en-clear">清空</button>
    </div>
    <div id="batch-en-list" style="max-height:300px;overflow-y:auto;border:1px solid var(--line);border-radius:var(--radius-sm);margin-bottom:14px"></div>
    <div style="display:flex;justify-content:flex-end;gap:8px">
      <button type="button" class="secondary-button" id="batch-en-cancel">返回</button>
      <button type="button" class="primary-button" id="batch-en-submit" ${remain === 0 ? 'disabled' : ''}>确认加入课程</button>
    </div>
  `);

  function updateCount() {
    const badge = body.querySelector('#batch-en-selected-count');
    badge.textContent = `已选 ${selected.size} 人`;
    badge.classList.toggle('is-danger', hasCap && selected.size > remain);
  }
  function renderCandidateList() {
    const list = candidates.filter(s => !kw || `${s.name} ${s.grade || ''} ${s.phone || ''}`.toLowerCase().includes(kw.toLowerCase()));
    const box = body.querySelector('#batch-en-list');
    if (!list.length) {
      box.innerHTML = `<div class="empty-state" style="padding:20px">${candidates.length ? '无匹配学生' : '所有学生均已在该课程在读'}</div>`;
      return;
    }
    box.innerHTML = list.map(s => `
      <label style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;border-bottom:1px solid var(--line);cursor:pointer;font-size:13px">
        <span style="display:flex;align-items:center;gap:8px"><input type="checkbox" data-batch-stu="${s.id}" ${selected.has(s.id) ? 'checked' : ''}><strong>${esc(s.name)}</strong><span style="color:var(--subtle);font-size:12px">${esc([s.grade, s.phone].filter(Boolean).join(' · '))}</span></span>
        <span class="page-badge">${esc(s.status || '意向')}</span>
      </label>
    `).join('');
    box.querySelectorAll('[data-batch-stu]').forEach(cb => {
      cb.addEventListener('change', () => {
        const sid = cb.getAttribute('data-batch-stu');
        if (cb.checked) selected.add(sid);
        else selected.delete(sid);
        updateCount();
      });
    });
  }
  renderCandidateList();

  body.querySelector('#batch-en-search').addEventListener('input', (e) => { kw = e.target.value; renderCandidateList(); });
  body.querySelector('#batch-en-select-all').addEventListener('click', () => {
    body.querySelectorAll('[data-batch-stu]').forEach(cb => { cb.checked = true; selected.add(cb.getAttribute('data-batch-stu')); });
    updateCount();
  });
  body.querySelector('#batch-en-clear').addEventListener('click', () => { selected.clear(); renderCandidateList(); updateCount(); });
  body.querySelector('#batch-en-cancel').addEventListener('click', () => openCourseStudentsModal(courseId));
  body.querySelector('#batch-en-submit').addEventListener('click', async () => {
    if (!selected.size) { showToast('请至少选择一名学生', true); return; }
    const btn = body.querySelector('#batch-en-submit');
    btn.disabled = true; btn.textContent = '提交中…';
    try {
      const res = await api('/api/enrollments/batch', { method: 'POST', body: { courseId, studentIds: [...selected] } });
      app.state = res.state;
      showToast(`已成功加入课程 ${res.added} 人`);
      openCourseStudentsModal(courseId);
      renderView();
    } catch (err) {
      showToast(err.message, true);
      btn.disabled = false; btn.textContent = '确认加入课程';
    }
  });
}

function openTransferModal(enrollmentId, returnCourseId = '') {
  const state = app.state;
  const en = state.enrollments.find(e => e.id === enrollmentId);
  if (!en) return;
  const fromCourse = state.courses.find(c => c.id === en.course_id);
  const otherCourses = state.courses.filter(c => c.id !== en.course_id);
  const modal = document.querySelector('#modal');

  const body = openModal(`学生转课 · ${en.student_name}`, `
    <form id="transfer-en-form" style="display:grid;gap:14px">
      <div style="font-size:13px;color:var(--muted)">当前课程：<strong style="color:var(--ink)">${esc(fromCourse?.name || en.course_name)}</strong></div>
      ${otherCourses.length === 0 ? `<div class="empty-state" style="padding:16px">暂无其他可转入的课程，请先新建目标课程</div>` : `
        <label class="form-field">
          <span>转入目标课程 *</span>
          <select name="targetCourseId" required>
            <option value="">请选择目标课程…</option>
            ${otherCourses.map(c => {
              const cnt = state.enrollments.filter(e => e.course_id === c.id && e.status === 'active').length;
              const hasCap = c.capacity != null && c.capacity > 0;
              const full = hasCap && cnt >= c.capacity;
              const capTxt = hasCap ? `${cnt}/${c.capacity}人${full ? ' 已满' : ''}` : `${cnt}人`;
              return `<option value="${c.id}" ${full ? 'disabled' : ''}>${esc(c.name)}（${c.teacher_name ? `${esc(c.teacher_name)} · ` : ''}${capTxt}）</option>`;
            }).join('')}
          </select>
        </label>
        <div style="font-size:12px;color:var(--subtle)">转课将自动把原课程置为退课并加入目标课程，校验目标课程人数上限与未来课次时间冲突。</div>
        <div class="form-actions">
          <button type="submit" class="primary-button">确认转课</button>
          <button type="button" class="secondary-button" id="transfer-cancel">返回</button>
        </div>
      `}
    </form>
  `);
  body?.querySelector('#transfer-cancel')?.addEventListener('click', () => {
    if (returnCourseId) openCourseStudentsModal(returnCourseId);
    else modal.close();
  });
  const form = body?.querySelector('#transfer-en-form');
  if (form && otherCourses.length) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const targetCourseId = new FormData(form).get('targetCourseId');
      try {
        app.state = await api(`/api/enrollments/${enrollmentId}/transfer`, { method: 'POST', body: { targetCourseId } });
        showToast('转课成功');
        if (returnCourseId) openCourseStudentsModal(returnCourseId);
        else modal.close();
        renderView();
      } catch (err) { showToast(err.message, true); }
    });
  }
}

export function openEditTeacherModal(teacher) {
  const modal = document.querySelector('#modal');
  const body = openModal(`编辑教师 · ${teacher.name}`, `
    <form id="edit-teacher-form" style="display:grid;gap:12px">
      <label class="form-field"><span>姓名 *</span><input name="name" value="${esc(teacher.name)}" required></label>
      <label class="form-field"><span>科目</span><input name="subject" value="${esc(teacher.subject || '')}" placeholder="如：数学、物理"></label>
      <label class="form-field"><span>11 位手机号 *</span><input name="phone" type="tel" inputmode="numeric" maxlength="11" pattern="1[0-9]{10}" title="请输入 11 位有效手机号" value="${esc(teacher.phone || '')}" required></label>
      <div style="font-size:12px;color:var(--subtle)">若该教师已开通登录账号，修改姓名或手机号将自动同步更新其登录账号。</div>
      <div class="form-actions">
        <button type="button" class="secondary-button" id="cancel-edit-tch">取消</button>
        <button type="submit" class="primary-button">保存</button>
      </div>
    </form>
  `);
  body?.querySelector('#cancel-edit-tch')?.addEventListener('click', () => modal.close());
  body?.querySelector('#edit-teacher-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      app.state = await api(`/api/teachers/${teacher.id}`, { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
      modal.close();
      showToast('教师信息已更新');
      renderView();
    } catch (err) { showToast(err.message, true); }
  });
}

function openTeacherAccountModal(teacher, acc) {
  const modal = document.querySelector('#modal');
  const body = openModal(acc ? `管理账号 · ${teacher.name}` : `开通账号 · ${teacher.name}`, `
    <form id="teacher-acc-form" style="display:grid;gap:12px">
      <div style="font-size:13px;color:var(--muted)">登录手机号：<strong>${esc(teacher.phone)}</strong></div>
      <label class="form-field">
        <span>账号角色</span>
        <select name="role">
          <option value="teacher" ${(acc?.role || 'teacher') === 'teacher' ? 'selected' : ''}>教师（仅访问自己授课的班级与课次）</option>
          <option value="admin" ${acc?.role === 'admin' ? 'selected' : ''}>管理员（全站教务与系统设置权限）</option>
        </select>
      </label>
      <label class="form-field">
        <span>${acc ? '重置密码（留空则保持原密码不变）' : '初始密码（至少 4 位）*'}</span>
        <div class="pw-field-wrap"><input name="password" type="password" minlength="4" autocomplete="new-password" placeholder="${acc ? '不修改请留空' : '至少 4 位'}" ${acc ? '' : 'required'}><button type="button" class="pw-toggle-btn" data-toggle-pw>显示</button></div>
      </label>
      <div class="form-actions">
        <button type="button" class="secondary-button" id="cancel-tch-acc">取消</button>
        <button type="submit" class="primary-button">${acc ? '保存设置' : '开通账号'}</button>
      </div>
    </form>
  `);
  bindPasswordToggles(body);
  body?.querySelector('#cancel-tch-acc')?.addEventListener('click', () => modal.close());
  body?.querySelector('#teacher-acc-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const fd = new FormData(e.target);
      app.state = await api(`/api/teachers/${teacher.id}/account`, {
        method: 'POST',
        body: { role: fd.get('role'), password: String(fd.get('password') || '').trim() }
      });
      modal.close();
      showToast(acc ? '教师账号设置已保存' : '教师账号已开通');
      renderView();
    } catch (err) { showToast(err.message, true); }
  });
}

function openResetAccountPasswordModal(acc) {
  const modal = document.querySelector('#modal');
  const body = openModal(`重置密码 · ${acc.name}`, `
    <form id="reset-acc-pw-form" style="display:grid;gap:12px">
      <div style="font-size:13px;color:var(--muted)">账号：<strong>${esc(acc.username)}</strong>（${roleLabel(acc.role)}）</div>
      <label class="form-field"><span>新密码（至少 4 位）*</span><div class="pw-field-wrap"><input name="password" type="password" minlength="4" autocomplete="new-password" placeholder="至少 4 位" required><button type="button" class="pw-toggle-btn" data-toggle-pw>显示</button></div></label>
      <div style="font-size:12px;color:var(--subtle)">重置后该账号在所有设备上的登录状态将被强制下线。</div>
      <div class="form-actions">
        <button type="button" class="secondary-button" id="cancel-reset-acc">取消</button>
        <button type="submit" class="primary-button">确认重置</button>
      </div>
    </form>
  `);
  bindPasswordToggles(body);
  body?.querySelector('#cancel-reset-acc')?.addEventListener('click', () => modal.close());
  body?.querySelector('#reset-acc-pw-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const password = String(new FormData(e.target).get('password') || '').trim();
      app.state = await api(`/api/accounts/${acc.id}`, { method: 'PUT', body: { password } });
      modal.close();
      showToast(`已重置「${acc.name}」的密码`);
      renderView();
    } catch (err) { showToast(err.message, true); }
  });
}

export function renderTeachers(shell) {
  persistNavState();
  const state = app.state;
  const teacherAccMap = new Map();
  for (const acc of state.accounts) {
    if (acc.role !== 'student') teacherAccMap.set(acc.linked_id, acc);
  }

  shell.innerHTML = `
    <div class="page-heading">
      <div>
        <span class="page-eyebrow">账号管理</span>
        <div class="page-title-row">
          <h1>教师管理</h1>
          <span class="page-badge" id="tch-count-badge">${state.teachers.length} 人</span>
        </div>
      </div>
      <div class="page-actions">
        <button type="button" class="primary-button" id="toggle-tch-create">${app.showCreatePanel ? '收起' : '＋ 添加教师'}</button>
      </div>
    </div>

    <section class="create-panel" ${app.showCreatePanel ? '' : 'hidden'}>
      <h3>添加教师</h3>
      <form id="add-teacher-form">
        <div class="form-grid">
          <label class="form-field"><span>姓名 *</span><input name="name" required></label>
          <label class="form-field"><span>任教科目</span><input name="subject" placeholder="如：高中数学"></label>
          <label class="form-field"><span>手机号 *</span><input name="phone" type="tel" inputmode="numeric" maxlength="11" pattern="1[0-9]{10}" title="请输入 11 位有效手机号" placeholder="11 位手机号" required></label>
          <label class="form-field"><span>初始密码</span><div class="pw-field-wrap"><input name="password" type="password" minlength="4" autocomplete="new-password" placeholder="选填，至少 4 位"><button type="button" class="pw-toggle-btn" data-toggle-pw>显示</button></div></label>
          <label class="form-field">
            <span>角色</span>
            <select name="role"><option value="teacher">教师</option><option value="admin">管理员</option></select>
          </label>
        </div>
        <div class="form-actions">
          <button type="submit" class="primary-button">保存</button>
          <button type="button" class="secondary-button" id="cancel-tch-create">取消</button>
        </div>
      </form>
    </section>

    <div class="filter-bar">
      <label class="filter-search"><span>搜索</span><input id="tch-search-input" type="search" placeholder="姓名、科目、手机号…" value="${esc(app.tchSearch)}"></label>
      <label>
        <span>角色</span>
        <select id="tch-role-select">
          <option value="">全部角色</option>
          <option value="teacher" ${app.tchRoleFilter === 'teacher' ? 'selected' : ''}>教师</option>
          <option value="admin" ${app.tchRoleFilter === 'admin' ? 'selected' : ''}>管理员</option>
          <option value="none" ${app.tchRoleFilter === 'none' ? 'selected' : ''}>未开通账号</option>
        </select>
      </label>
    </div>

    <div id="tch-list-container"></div>
  `;
  bindPasswordToggles(shell);

  function renderTeacherList() {
    const st = app.state;
    const kw = app.tchSearch.trim().toLowerCase();
    const filtered = st.teachers.filter(t => {
      const acc = teacherAccMap.get(t.id);
      if (app.tchRoleFilter === 'none' && acc) return false;
      if (app.tchRoleFilter && app.tchRoleFilter !== 'none' && acc?.role !== app.tchRoleFilter) return false;
      if (kw) {
        const hay = `${t.name} ${t.subject || ''} ${t.phone || ''} ${acc?.username || ''}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });

    const badge = shell.querySelector('#tch-count-badge');
    if (badge) badge.textContent = `${filtered.length} 人`;
    const box = shell.querySelector('#tch-list-container');
    if (!filtered.length) { box.innerHTML = `<div class="empty-state">暂无匹配教师</div>`; return; }

    box.innerHTML = `
      <div class="table-wrap">
        <table class="data-table mobile-cards-table">
          <thead><tr><th>姓名</th><th>科目</th><th>手机号</th><th>授课课程</th><th>角色 / 账号</th><th>操作</th></tr></thead>
          <tbody>
            ${filtered.map(t => {
              const acc = teacherAccMap.get(t.id);
              const teachingCourses = st.courses.filter(c => (c.teacher_ids || (c.teacher_id ? [c.teacher_id] : [])).includes(t.id)).map(c => c.name);
              const accBadge = acc
                ? (acc.disabled ? `<span class="status-pill is-danger">已停用</span>` : `<span class="page-badge ${roleBadgeClass(acc.role)}">${roleLabel(acc.role)}</span>`)
                : `<span class="status-pill is-warn">未开通账号</span>`;
              return `
                <tr>
                  <td class="mc-title"><strong>${esc(t.name)}</strong></td>
                  <td data-label="科目">${t.subject ? `<span class="page-badge">${esc(t.subject)}</span>` : '<span style="color:var(--subtle)">-</span>'}</td>
                  <td data-label="手机号">${esc(t.phone) || '<span style="color:var(--subtle)">未填</span>'}</td>
                  <td data-label="授课课程">${teachingCourses.length ? esc(teachingCourses.join('、')) : '<span style="color:var(--subtle)">未分配</span>'}</td>
                  <td data-label="角色 / 账号">${accBadge}</td>
                  <td class="mc-actions">
                    <div class="row-actions">
                      <button type="button" class="primary-button btn-sm" data-edit-tch="${t.id}">编辑</button>
                      <button type="button" class="secondary-button btn-sm" data-acc-tch="${t.id}">${acc ? '账号设置' : '开通账号'}</button>
                      <button type="button" class="secondary-button btn-sm danger-button" data-del-tch="${t.id}" data-del-tch-name="${esc(t.name)}">删除</button>
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    box.querySelectorAll('[data-edit-tch]').forEach(btn => btn.addEventListener('click', () => {
      const t = app.state.teachers.find(x => x.id === btn.getAttribute('data-edit-tch'));
      if (t) openEditTeacherModal(t);
    }));
    box.querySelectorAll('[data-acc-tch]').forEach(btn => btn.addEventListener('click', () => {
      const t = app.state.teachers.find(x => x.id === btn.getAttribute('data-acc-tch'));
      if (t) openTeacherAccountModal(t, teacherAccMap.get(t.id));
    }));
    box.querySelectorAll('[data-del-tch]').forEach(btn => btn.addEventListener('click', async () => {
      const name = btn.getAttribute('data-del-tch-name') || '该教师';
      if (!confirm(`确认删除教师「${name}」及其关联登录账号？`)) return;
      try {
        app.state = await api(`/api/teachers/${btn.getAttribute('data-del-tch')}`, { method: 'DELETE' });
        showToast('已删除教师');
        renderView();
      } catch (err) { showToast(err.message, true); }
    }));
  }

  renderTeacherList();

  shell.querySelector('#toggle-tch-create').addEventListener('click', () => { app.showCreatePanel = !app.showCreatePanel; renderTeachers(shell); });
  shell.querySelector('#cancel-tch-create').addEventListener('click', () => { app.showCreatePanel = false; renderTeachers(shell); });
  shell.querySelector('#tch-search-input').addEventListener('input', (e) => { app.tchSearch = e.target.value; renderTeacherList(); });
  shell.querySelector('#tch-role-select').addEventListener('change', (e) => { app.tchRoleFilter = e.target.value; renderTeacherList(); });

  shell.querySelector('#add-teacher-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api('/api/teachers', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      app.state = res.state;
      app.showCreatePanel = false;
      showToast('已添加教师');
      renderView();
    } catch (err) { showToast(err.message, true); }
  });
}

export function renderAccounts(shell) {
  persistNavState();
  const state = app.state;
  shell.innerHTML = `
    <div class="page-heading">
      <div>
        <span class="page-eyebrow">账号管理</span>
        <div class="page-title-row">
          <h1>账号列表</h1>
          <span class="page-badge" id="acc-count-badge">${state.accounts.length} 个</span>
        </div>
      </div>
    </div>

    <div class="filter-bar">
      <label class="filter-search"><span>搜索</span><input id="acc-search-input" type="search" value="${esc(app.settingsAccSearch)}" placeholder="按账号、姓名或播放编号搜索…"></label>
      <label>
        <span>角色</span>
        <select id="acc-role-filter">
          <option value="" ${app.settingsAccRoleFilter === '' ? 'selected' : ''}>全部角色</option>
          <option value="admin" ${app.settingsAccRoleFilter === 'admin' ? 'selected' : ''}>管理员</option>
          <option value="teacher" ${app.settingsAccRoleFilter === 'teacher' ? 'selected' : ''}>教师</option>
          <option value="student" ${app.settingsAccRoleFilter === 'student' ? 'selected' : ''}>学生</option>
        </select>
      </label>
    </div>

    <div id="acc-list-container"></div>
  `;

  function renderAccountList() {
    const st = app.state;
    const kw = app.settingsAccSearch.trim().toLowerCase();
    const filteredAccounts = st.accounts.filter(acc => {
      if (app.settingsAccRoleFilter && acc.role !== app.settingsAccRoleFilter) return false;
      if (kw && !acc.name.toLowerCase().includes(kw) && !acc.username.toLowerCase().includes(kw)
        && accountPlaybackCode(acc.id).toLowerCase() !== kw) return false;
      return true;
    });

    const badge = shell.querySelector('#acc-count-badge');
    if (badge) badge.textContent = `${filteredAccounts.length} / ${st.accounts.length} 个`;
    const box = shell.querySelector('#acc-list-container');
    if (!filteredAccounts.length) { box.innerHTML = `<div class="empty-state">暂无匹配账号</div>`; return; }

    box.innerHTML = `
      <div class="table-wrap">
        <table class="data-table mobile-cards-table">
          <thead><tr><th>账号</th><th>姓名</th><th>角色</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead>
          <tbody>
            ${filteredAccounts.map(acc => {
              const isSelf = acc.id === st.currentUser.id;
              return `
                <tr>
                  <td class="mc-title"><strong>${esc(acc.username)}</strong></td>
                  <td data-label="姓名"><button type="button" class="outline-title-link" data-open-acc-link="${acc.role}:${acc.linked_id}" title="查看关联档案">${esc(acc.name)}</button></td>
                  <td data-label="角色"><span class="page-badge ${roleBadgeClass(acc.role)}">${roleLabel(acc.role)}</span></td>
                  <td data-label="状态"><span class="status-pill ${acc.disabled ? 'is-danger' : 'is-ok'}">${acc.disabled ? '已停用' : '正常'}</span></td>
                  <td data-label="创建时间" style="font-size:12px;color:var(--subtle)">${esc(acc.created_at)}</td>
                  <td class="mc-actions">
                    <div class="row-actions">
                      ${isSelf ? `
                        <button type="button" class="secondary-button btn-sm" id="self-change-pw-btn">修改密码</button>
                      ` : `
                        <button type="button" class="secondary-button btn-sm" data-reset-acc="${acc.id}">重置密码</button>
                        <button type="button" class="secondary-button btn-sm" data-toggle-acc="${acc.id}" data-next-dis="${acc.disabled ? '0' : '1'}">${acc.disabled ? '启用' : '停用'}</button>
                        <button type="button" class="secondary-button btn-sm danger-button" data-del-acc="${acc.id}" data-del-acc-name="${esc(acc.name)}">删除</button>
                      `}
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    box.querySelectorAll('[data-open-acc-link]').forEach(btn => {
      btn.addEventListener('click', () => {
        const [role, linkedId] = btn.getAttribute('data-open-acc-link').split(':');
        if (role === 'student') openStudentArchiveModal(linkedId, 'profile');
        else {
          const t = app.state.teachers.find(x => x.id === linkedId);
          if (t) openEditTeacherModal(t);
        }
      });
    });

    box.querySelector('#self-change-pw-btn')?.addEventListener('click', openChangeOwnPasswordModal);
    box.querySelectorAll('[data-reset-acc]').forEach(btn => btn.addEventListener('click', () => {
      const acc = app.state.accounts.find(a => a.id === btn.getAttribute('data-reset-acc'));
      if (acc) openResetAccountPasswordModal(acc);
    }));
    box.querySelectorAll('[data-toggle-acc]').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-toggle-acc');
      const nextDis = btn.getAttribute('data-next-dis') === '1';
      if (nextDis && !confirm('停用后该账号将立即下线且无法登录，确认停用？')) return;
      try {
        app.state = await api(`/api/accounts/${id}`, { method: 'PUT', body: { disabled: nextDis } });
        showToast(nextDis ? '已停用账号' : '已重新启用账号');
        renderView();
      } catch (err) { showToast(err.message, true); }
    }));
    box.querySelectorAll('[data-del-acc]').forEach(btn => btn.addEventListener('click', async () => {
      const name = btn.getAttribute('data-del-acc-name') || '该账号';
      if (!confirm(`确认永久删除账号「${name}」？`)) return;
      try {
        app.state = await api(`/api/accounts/${btn.getAttribute('data-del-acc')}`, { method: 'DELETE' });
        showToast('已删除账号');
        renderView();
      } catch (err) { showToast(err.message, true); }
    }));
  }

  renderAccountList();

  shell.querySelector('#acc-role-filter').addEventListener('change', (e) => { app.settingsAccRoleFilter = e.target.value; renderAccountList(); });
  shell.querySelector('#acc-search-input').addEventListener('input', (e) => { app.settingsAccSearch = e.target.value; renderAccountList(); });
}

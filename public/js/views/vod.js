import { esc, formatSize, formatDuration, showToast, openModal } from '../utils.js';
import {
  app,
  api,
  isTeacher,
  stopVodWatermark,
  startWatermarkOnStage,
  probeVideoDuration,
  uploadMediaWithProgress,
  renderProgressCell,
  switchView,
  renderView,
  PLAYBACK_RATE_KEY,
  instanceStorageKey
} from '../state.js';

export function renderVod(shell) {
  stopVodWatermark();
  const state = app.state;
  const currentStudentId = !isTeacher() ? state.currentUser.linkedId : '';
  const savedRate = Number(localStorage.getItem(instanceStorageKey(PLAYBACK_RATE_KEY))) || 1;

  function getRecCourseId(r) {
    const les = app.state.lessons.find(l => l.id === r.lesson_id);
    return r.course_id || les?.course_id || '';
  }

  function getExpectedStudents(targetType, item) {
    if (!isTeacher()) return [];
    const cid = targetType === 'recording' ? getRecCourseId(item) : item.course_id;
    const sids = [...new Set(app.state.enrollments.filter(e => e.course_id === cid && e.status === 'active').map(e => e.student_id))];
    return sids.map(id => app.state.students.find(s => s.id === id) || { id, name: id });
  }

  function renderTeacherProgressCell(targetType, item) {
    const expected = getExpectedStudents(targetType, item);
    const progs = app.state.playbackProgress.filter(p => p.target_type === targetType && p.target_id === item.id);
    const progBySid = new Map(progs.map(p => [p.student_id, p]));
    const total = expected.length;
    const completedCnt = expected.filter(s => progBySid.get(s.id)?.completed).length;
    const watchedCnt = expected.filter(s => (progBySid.get(s.id)?.watched_sec || 0) > 0).length;
    const extraWatched = progs.filter(p => !expected.some(s => s.id === p.student_id) && p.watched_sec > 0).length;
    const pct = total > 0 ? Math.round((completedCnt / total) * 100) : 0;
    const summaryText = total > 0
      ? `${completedCnt}/${total} 已完课 · ${watchedCnt} 人看过${extraWatched ? ` (+${extraWatched} 试听)` : ''}`
      : (progs.length ? `${progs.length} 人有观看记录` : '暂无在读学生');
    return `
      <button type="button" class="progress-link-btn" data-prog-detail="${targetType}" data-prog-id="${item.id}" title="点击查看各学生观看明细">
        <div class="prog-cell">
          <div class="prog-track"><div class="prog-fill ${total > 0 && completedCnt === total ? 'is-done' : ''}" style="width:${pct}%"></div></div>
          <div class="prog-text">${summaryText}</div>
        </div>
      </button>
    `;
  }

  shell.innerHTML = `
    <div class="page-heading">
      <div>
        <span class="page-eyebrow">教学</span>
        <div class="page-title-row">
          <h1>录播回放</h1>
          <span class="page-badge" id="vod-total-badge">${state.recordings.length} 回放 · ${state.vodLessons.length} 录播</span>
        </div>
      </div>
      <div class="page-actions">
        <div class="tab-bar">
          <button type="button" class="tab-btn ${app.vodViewTab === 'all' ? 'active' : ''}" data-vod-view="all">全部</button>
          <button type="button" class="tab-btn ${app.vodViewTab === 'rec' ? 'active' : ''}" data-vod-view="rec">直播回放</button>
          <button type="button" class="tab-btn ${app.vodViewTab === 'vod' ? 'active' : ''}" data-vod-view="vod">录播课</button>
        </div>
        ${isTeacher() ? `
          <button type="button" class="primary-button" id="toggle-vod-upload">
            ${app.showCreatePanel ? '收起' : '＋ 上传视频'}
          </button>
        ` : ''}
      </div>
    </div>

    ${isTeacher() && state.pendingRecordings?.length ? `
      <section class="section-card" style="border-color:var(--warn, #d97706)">
        <div class="section-card-head">
          <h2>未归档 / 中断待恢复录制</h2>
          <span class="status-pill is-warn">${state.pendingRecordings.length} 条</span>
        </div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px">
          可把从开头连续收到的录制分片归档为待核看回放。发布前请先试播。
        </div>
        <div class="item-list">
          ${state.pendingRecordings.map(p => {
            const awaitingRecovery = p.status === 'interrupted'
              || state.lessons.some(l => l.id === p.lesson_id && l.status === 'completed');
            const canRecover = p.received_seqs.includes(0);
            return `
            <div class="item-row" data-pending-recording="${esc(p.id)}" tabindex="-1">
              <div class="item-main">
                <div>
                  <div class="item-title" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                    <span>${esc(p.lesson_title)} · ${esc(p.title)}</span>
                    <span class="status-pill ${awaitingRecovery ? 'is-warn' : 'is-ok'}">${awaitingRecovery ? '待恢复' : '录制中'}</span>
                  </div>
                  <div class="item-meta">${esc(p.course_name || '')} · 已收 ${p.received_count} 个分片 · ${formatSize(p.size_bytes)}${awaitingRecovery && !canRecover ? ' · 缺少起始分片' : ''}</div>
                </div>
              </div>
              <div class="row-actions">
                ${canRecover ? `<button type="button" class="primary-button btn-sm" data-recover-rec="${p.id}">归档已有部分</button>` : ''}
                <button type="button" class="secondary-button btn-sm danger-button" data-discard-rec="${p.id}">放弃并清理</button>
              </div>
            </div>
          `; }).join('')}
        </div>
      </section>
    ` : ''}

    ${isTeacher() ? `
      <section class="create-panel" ${app.showCreatePanel ? '' : 'hidden'}>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
          <div class="tab-bar">
            <button type="button" class="tab-btn ${app.vodUploadTab === 'vod' ? 'active' : ''}" data-up-tab="vod">上传录播课</button>
            <button type="button" class="tab-btn ${app.vodUploadTab === 'rec' ? 'active' : ''}" data-up-tab="rec">上传课次回放</button>
          </div>
        </div>

        <form id="upload-vod-form" ${app.vodUploadTab === 'vod' ? '' : 'hidden'}>
          <div class="form-grid">
            <label class="form-field">
              <span>所属课程 *</span>
              <select name="courseId" required>
                <option value="">请选择</option>
                ${state.courses.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
              </select>
            </label>
            <label class="form-field"><span>章节 *</span><input name="chapterName" placeholder="如：第一章 导数" required></label>
            <label class="form-field"><span>小节标题 *</span><input name="title" required></label>
            <label class="form-field"><span>序号</span><input type="number" name="sortOrder" value="${state.vodLessons.length + 1}" min="1"></label>
          </div>
          <label class="form-field" style="margin-top:10px"><span>视频文件 *</span><input type="file" id="vod-file-input" accept="video/*" required></label>
          <div id="vod-upload-progress" class="upload-progress-wrap" hidden>
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span id="vod-upload-text">准备上传…</span>
              <button type="button" class="secondary-button btn-sm" id="vod-abort-btn">取消上传</button>
            </div>
            <div class="prog-track"><div class="prog-fill" id="vod-upload-bar" style="width:0%"></div></div>
          </div>
          <div class="form-actions">
            <button type="submit" class="primary-button" id="vod-submit-btn">上传并发布</button>
            <button type="button" class="secondary-button" id="cancel-vod-upload">取消</button>
          </div>
        </form>

        <form id="upload-rec-form" ${app.vodUploadTab === 'rec' ? '' : 'hidden'}>
          <div class="form-grid">
            <label class="form-field">
              <span>关联课次 *</span>
              <select name="lessonId" required>
                <option value="">请选择</option>
                ${state.lessons.map(l => `<option value="${l.id}">${esc(l.title)}（${esc(l.course_name)}）</option>`).join('')}
              </select>
            </label>
            <label class="form-field"><span>标题 *</span><input name="title" placeholder="如：完整回放" required></label>
          </div>
          <label class="form-field" style="margin-top:10px"><span>视频文件 *</span><input type="file" id="rec-file-input" accept="video/*" required></label>
          <div id="rec-upload-progress" class="upload-progress-wrap" hidden>
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span id="rec-upload-text">准备上传…</span>
              <button type="button" class="secondary-button btn-sm" id="rec-abort-btn">取消上传</button>
            </div>
            <div class="prog-track"><div class="prog-fill" id="rec-upload-bar" style="width:0%"></div></div>
          </div>
          <div class="form-actions">
            <button type="submit" class="primary-button" id="rec-submit-btn">上传回放</button>
            <button type="button" class="secondary-button" id="cancel-rec-upload">取消</button>
          </div>
        </form>
      </section>
    ` : ''}

    <div class="filter-bar">
      <label class="filter-search"><span>搜索</span><input id="vod-search-input" type="search" placeholder="搜索课次、章节、标题…" value="${esc(app.vodSearch)}"></label>
      <label>
        <span>课程</span>
        <select id="vod-course-filter">
          <option value="">全部课程</option>
          ${state.courses.map(c => `<option value="${c.id}" ${app.vodCourseFilter === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </label>
      ${isTeacher() ? `
        <label>
          <span>状态</span>
          <select id="vod-status-filter">
            <option value="">全部状态</option>
            <option value="published" ${app.vodStatusFilter === 'published' ? 'selected' : ''}>已发布</option>
            <option value="pending_review" ${app.vodStatusFilter === 'pending_review' ? 'selected' : ''}>待审核</option>
            <option value="withdrawn" ${app.vodStatusFilter === 'withdrawn' ? 'selected' : ''}>已撤回/下架</option>
          </select>
        </label>
      ` : ''}
    </div>

    <section id="video-player-card" class="section-card" hidden>
      <div class="section-card-head">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <h2 id="player-title">播放</h2>
          <span class="page-badge">版权保护</span>
          <span style="font-size:11px;color:var(--subtle)">空格暂停 · ←/→ 快退/进5秒</span>
        </div>
        <div class="row-actions">
          <select id="player-rate-select" class="secondary-button btn-sm" title="播放倍速">
            ${[0.75, 1, 1.25, 1.5, 2].map(rate => `<option value="${rate}" ${savedRate === rate ? 'selected' : ''}>${rate}x</option>`).join('')}
          </select>
          <button type="button" class="secondary-button btn-sm" id="player-focus-btn" title="进入专注大纲播放页">专注播放</button>
          <button type="button" class="secondary-button btn-sm" id="player-ask-qa-btn" title="带当前播放时间点跳转到课程答疑">在此时间点提问</button>
          <button type="button" class="secondary-button btn-sm" id="player-fullscreen-btn">全屏</button>
          <button type="button" class="secondary-button btn-sm" id="close-player-btn">收起</button>
        </div>
      </div>
      <div id="player-stage" class="player-stage" oncontextmenu="return false">
        <video id="main-vod-player" controls controlsList="nodownload nofullscreen" disablePictureInPicture playsinline></video>
        <div id="video-watermark" class="video-watermark"></div>
      </div>
      <div class="bookmark-bar" id="vod-bookmarks-bar" style="max-width:none">
        <span style="font-size:12px;color:var(--muted);font-weight:500">时间点书签</span>
        <span id="vod-bookmarks-list" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:1;min-width:0">
          <span style="font-size:12px;color:var(--subtle)">暂无书签</span>
        </span>
        ${isTeacher() ? `<button type="button" class="secondary-button btn-sm" id="vod-add-bookmark-btn">+ 标记当前时间点</button>` : ''}
      </div>
    </section>

    <div id="vod-lists-container" style="display:grid;gap:18px"></div>
  `;

  let activePlayingMeta = null;

  function startInlinePlayer({ targetType, targetId, url, title, fallbackDuration, courseId, lessonId }) {
    activePlayingMeta = { targetType, targetId, courseId, lessonId, shortTitle: title, fallbackDuration };
    const card = shell.querySelector('#video-player-card');
    const player = shell.querySelector('#main-vod-player');
    const stage = shell.querySelector('#player-stage');
    shell.querySelector('#player-title').textContent = title;
    card.hidden = false;
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    player.src = url;
    player.playbackRate = Number(shell.querySelector('#player-rate-select')?.value) || 1;

    const onKeydown = (e) => {
      if (!card || card.hidden) return;
      const tag = (e.target?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (player.paused) player.play().catch(() => {});
        else player.pause();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        player.currentTime = Math.max(0, (player.currentTime || 0) - 5);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        const dur = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : (activePlayingMeta?.fallbackDuration || Infinity);
        player.currentTime = Math.min(dur, (player.currentTime || 0) + 5);
      }
    };
    startWatermarkOnStage(stage, player, { onKeydownExtra: onKeydown });

    const prog = app.state.playbackProgress.find(
      p => p.student_id === currentStudentId && p.target_type === targetType && p.target_id === targetId
    );
    let lastReportMs = 0;
    const getEffectiveDuration = () => (Number.isFinite(player.duration) && player.duration > 0) ? player.duration : fallbackDuration;
    const collectPlayedRanges = () => {
      const ranges = [];
      for (let i = 0; i < player.played.length; i++) {
        const s = Number(player.played.start(i).toFixed(1));
        const e = Number(player.played.end(i).toFixed(1));
        if (e > s) ranges.push([s, e]);
      }
      return ranges;
    };
    async function syncPlayedProgress() {
      if (!currentStudentId) return;
      try {
        const res = await api('/api/progress', {
          method: 'POST',
          body: {
            targetType,
            targetId,
            positionSec: Number((player.currentTime || 0).toFixed(1)),
            durationSec: Number((getEffectiveDuration() || 0).toFixed(1)),
            watchedRanges: collectPlayedRanges()
          }
        });
        if (Array.isArray(res.playbackProgress)) {
          app.state.playbackProgress = res.playbackProgress;
          const cell = shell.querySelector(`[data-prog-cell="${targetType}:${targetId}"]`);
          const latest = app.state.playbackProgress.find(
            p => p.student_id === currentStudentId && p.target_type === targetType && p.target_id === targetId
          );
          if (cell && latest) cell.innerHTML = renderProgressCell(latest);
        }
      } catch {}
    }

    player.onloadedmetadata = () => {
      player.playbackRate = Number(shell.querySelector('#player-rate-select')?.value) || 1;
      const effDur = getEffectiveDuration();
      if (prog && prog.last_position_sec > 2 && (!effDur || prog.last_position_sec < effDur - 2)) {
        player.currentTime = prog.last_position_sec;
        showToast(`已从 ${formatDuration(prog.last_position_sec)} 续播`);
      }
      player.play().catch(() => {});
    };
    player.ontimeupdate = () => {
      const now = Date.now();
      if (now - lastReportMs >= 5000) {
        lastReportMs = now;
        syncPlayedProgress();
      }
    };
    player.onpause = syncPlayedProgress;
    player.onended = syncPlayedProgress;

    loadInlineBookmarks(targetType, targetId, player);
  }

  async function loadInlineBookmarks(targetType, targetId, player) {
    const bmkListEl = shell.querySelector('#vod-bookmarks-list');
    if (!bmkListEl) return;
    try {
      const res = await api(`/api/bookmarks?targetType=${encodeURIComponent(targetType)}&targetId=${encodeURIComponent(targetId)}`);
      const list = res.bookmarks || [];
      if (!list.length) {
        bmkListEl.innerHTML = `<span style="font-size:12px;color:var(--subtle)">暂无书签</span>`;
        return;
      }
      bmkListEl.innerHTML = list.map(b => `
        <span class="bookmark-chip" data-jump-sec="${b.time_sec}">
          <span class="bookmark-chip-time">${formatDuration(b.time_sec)}</span>
          <span>${esc(b.label)}</span>
          ${b.ref_tag ? `<span class="bookmark-chip-ref">(${esc(b.ref_tag)})</span>` : ''}
          ${isTeacher() ? `<button type="button" class="bookmark-chip-del" data-del-bmk="${esc(b.id)}" title="删除书签">×</button>` : ''}
        </span>
      `).join('');
      bmkListEl.querySelectorAll('[data-jump-sec]').forEach(el => {
        el.style.cursor = 'pointer';
        el.addEventListener('click', (ev) => {
          if (ev.target.closest('[data-del-bmk]')) return;
          const sec = Number(el.getAttribute('data-jump-sec')) || 0;
          player.currentTime = sec;
          player.play().catch(() => {});
          showToast(`已跳转到 ${formatDuration(sec)}`);
        });
      });
      bmkListEl.querySelectorAll('[data-del-bmk]').forEach(btn => {
        btn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          try {
            await api(`/api/bookmarks/${encodeURIComponent(btn.getAttribute('data-del-bmk'))}`, { method: 'DELETE' });
            showToast('书签已删除');
            loadInlineBookmarks(targetType, targetId, player);
          } catch (err) { showToast(err.message, true); }
        });
      });
    } catch {
      bmkListEl.innerHTML = `<span style="font-size:12px;color:var(--subtle)">暂无书签</span>`;
    }
  }

  function renderVodTables() {
    const st = app.state;
    const showRecs = app.vodViewTab === 'all' || app.vodViewTab === 'rec';
    const showVods = app.vodViewTab === 'all' || app.vodViewTab === 'vod';
    const kw = app.vodSearch.trim().toLowerCase();

    const filteredRecs = st.recordings.filter(r => {
      if (app.vodCourseFilter && getRecCourseId(r) !== app.vodCourseFilter) return false;
      if (app.vodStatusFilter && r.status !== app.vodStatusFilter) return false;
      if (kw && !`${r.lesson_title} ${r.course_name || ''} ${r.title}`.toLowerCase().includes(kw)) return false;
      return true;
    });

    const filteredVods = st.vodLessons.filter(v => {
      if (app.vodCourseFilter && v.course_id !== app.vodCourseFilter) return false;
      if (app.vodStatusFilter && app.vodStatusFilter !== 'pending_review' && v.status !== app.vodStatusFilter) return false;
      if (kw && !`${v.course_name} ${v.chapter_name} ${v.title}`.toLowerCase().includes(kw)) return false;
      return true;
    });

    const vodGroups = [];
    const vodGroupMap = new Map();
    for (const v of filteredVods) {
      const key = `${v.course_id}::${v.chapter_name}`;
      if (!vodGroupMap.has(key)) {
        const g = { key, courseName: v.course_name, chapterName: v.chapter_name, items: [] };
        vodGroupMap.set(key, g);
        vodGroups.push(g);
      }
      vodGroupMap.get(key).items.push(v);
    }

    const box = shell.querySelector('#vod-lists-container');
    if (!box) return;
    box.innerHTML = `
      ${showRecs ? `
        <section class="section-card">
          <div class="section-card-head">
            <h2>直播回放</h2>
            <span class="section-summary">${filteredRecs.length} / ${st.recordings.length} 段</span>
          </div>
          ${filteredRecs.length === 0 ? `<div class="empty-state">${st.recordings.length ? '无匹配的直播回放' : '暂无直播回放'}</div>` : `
            <div class="table-wrap">
              <table class="data-table">
                <thead>
                  <tr><th>课次</th><th>分段</th><th>时长 / 大小</th><th>状态</th><th>${isTeacher() ? '班级完课' : '进度'}</th><th>操作</th></tr>
                </thead>
                <tbody>
                  ${filteredRecs.map(r => {
                    const prog = st.playbackProgress.find(p => p.student_id === currentStudentId && p.target_type === 'recording' && p.target_id === r.id);
                    const courseId = getRecCourseId(r);
                    return `
                      <tr>
                        <td><strong>${esc(r.lesson_title)}</strong><div style="font-size:12px;color:var(--muted)">${esc(r.course_name || '')}</div></td>
                        <td>第 ${r.segment} 段 · ${esc(r.title)}</td>
                        <td style="font-variant-numeric:tabular-nums">${r.duration_sec ? `${formatDuration(r.duration_sec)} · ` : ''}${formatSize(r.size_bytes)}</td>
                        <td>
                          <span class="status-pill ${r.status === 'published' ? 'is-ok' : r.status === 'pending_review' ? 'is-warn' : 'is-danger'}">
                            ${r.status === 'published' ? '已发布' : r.status === 'pending_review' ? '待审核' : '已撤回'}
                          </span>
                        </td>
                        <td data-prog-cell="recording:${r.id}">${isTeacher() ? renderTeacherProgressCell('recording', r) : renderProgressCell(prog)}</td>
                        <td>
                          <div class="row-actions">
                            <button type="button" class="primary-button btn-sm"
                              data-play-video="recording"
                              data-vid-id="${r.id}"
                              data-vid-url="/api/recordings/${r.id}/file"
                              data-vid-title="${esc(r.lesson_title)} · ${esc(r.title)}"
                              data-vid-duration="${Number(r.duration_sec) || 0}"
                              data-vid-course="${esc(courseId)}"
                              data-vid-lesson="${esc(r.lesson_id)}">
                              ${prog && prog.last_position_sec > 2 ? `续播 ${formatDuration(prog.last_position_sec)}` : '播放'}
                            </button>
                            ${isTeacher() ? `
                              <button type="button" class="secondary-button btn-sm" data-edit-rec="${r.id}">编辑</button>
                              <button type="button" class="secondary-button btn-sm" data-pub-rec="${r.id}" data-next="${r.status === 'published' ? 'withdrawn' : 'published'}">
                                ${r.status === 'published' ? '撤回' : '发布'}
                              </button>
                              <button type="button" class="secondary-button btn-sm danger-button" data-del-rec="${r.id}">删除</button>
                            ` : ''}
                          </div>
                        </td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          `}
        </section>
      ` : ''}

      ${showVods ? `
        <section class="section-card">
          <div class="section-card-head">
            <h2>录播课</h2>
            <span class="section-summary">${filteredVods.length} / ${st.vodLessons.length} 节</span>
          </div>
          ${vodGroups.length === 0 ? `<div class="empty-state">${st.vodLessons.length ? '无匹配的录播课' : '暂无录播课'}</div>` : `
            <div>
              ${vodGroups.map(g => {
                const collapsed = app.collapsedVodGroups.has(g.key);
                return `
                  <div class="vod-group-card">
                    <div class="vod-group-head" data-toggle-vod-group="${esc(g.key)}">
                      <span>${collapsed ? '▸' : '▾'} ${esc(g.courseName)} · ${esc(g.chapterName)}</span>
                      <span class="page-badge">${g.items.length} 节</span>
                    </div>
                    <div class="table-wrap" ${collapsed ? 'hidden' : ''}>
                      <table class="data-table">
                        <thead>
                          <tr><th>小节</th><th>时长 / 大小</th>${isTeacher() ? '<th>状态</th>' : ''}<th>${isTeacher() ? '课程完课' : '进度'}</th><th>操作</th></tr>
                        </thead>
                        <tbody>
                          ${g.items.map(v => {
                            const prog = st.playbackProgress.find(p => p.student_id === currentStudentId && p.target_type === 'vod' && p.target_id === v.id);
                            return `
                              <tr>
                                <td><strong>第 ${v.sort_order} 节 · ${esc(v.title)}</strong></td>
                                <td style="font-variant-numeric:tabular-nums">${v.duration_sec ? `${formatDuration(v.duration_sec)} · ` : ''}${formatSize(v.size_bytes)}</td>
                                ${isTeacher() ? `
                                  <td>
                                    <span class="status-pill ${v.status === 'published' ? 'is-ok' : 'is-danger'}">
                                      ${v.status === 'published' ? '已发布' : '已下架'}
                                    </span>
                                  </td>
                                ` : ''}
                                <td data-prog-cell="vod:${v.id}">${isTeacher() ? renderTeacherProgressCell('vod', v) : renderProgressCell(prog)}</td>
                                <td>
                                  <div class="row-actions">
                                    <button type="button" class="primary-button btn-sm"
                                      data-play-video="vod"
                                      data-vid-id="${v.id}"
                                      data-vid-url="/api/vod/${v.id}/file"
                                      data-vid-title="${esc(v.course_name)} · ${esc(v.title)}"
                                      data-vid-duration="${Number(v.duration_sec) || 0}"
                                      data-vid-course="${esc(v.course_id)}"
                                      data-vid-lesson="">
                                      ${prog && prog.last_position_sec > 2 ? `续播 ${formatDuration(prog.last_position_sec)}` : '播放'}
                                    </button>
                                    ${isTeacher() ? `
                                      <button type="button" class="secondary-button btn-sm" data-edit-vod="${v.id}">编辑</button>
                                      <button type="button" class="secondary-button btn-sm danger-button" data-del-vod="${v.id}">删除</button>
                                    ` : ''}
                                  </div>
                                </td>
                              </tr>
                            `;
                          }).join('')}
                        </tbody>
                      </table>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          `}
        </section>
      ` : ''}
    `;

    box.querySelectorAll('[data-toggle-vod-group]').forEach(head => {
      head.addEventListener('click', () => {
        const key = head.getAttribute('data-toggle-vod-group');
        if (app.collapsedVodGroups.has(key)) app.collapsedVodGroups.delete(key);
        else app.collapsedVodGroups.add(key);
        renderVodTables();
      });
    });

    box.querySelectorAll('[data-play-video]').forEach(btn => {
      btn.addEventListener('click', () => {
        startInlinePlayer({
          targetType: btn.getAttribute('data-play-video'),
          targetId: btn.getAttribute('data-vid-id'),
          url: btn.getAttribute('data-vid-url'),
          title: btn.getAttribute('data-vid-title'),
          fallbackDuration: Number(btn.getAttribute('data-vid-duration')) || 0,
          courseId: btn.getAttribute('data-vid-course') || '',
          lessonId: btn.getAttribute('data-vid-lesson') || ''
        });
      });
    });

    // 教师端查看学生完课明细弹窗（含未完课筛选 & 一键群提醒）
    box.querySelectorAll('[data-prog-detail]').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetType = btn.getAttribute('data-prog-detail');
        const targetId = btn.getAttribute('data-prog-id');
        const item = targetType === 'recording'
          ? app.state.recordings.find(r => r.id === targetId)
          : app.state.vodLessons.find(v => v.id === targetId);
        if (!item) return;
        const cid = targetType === 'recording' ? getRecCourseId(item) : item.course_id;
        const expected = getExpectedStudents(targetType, item);
        const progs = app.state.playbackProgress.filter(p => p.target_type === targetType && p.target_id === targetId);
        const progMap = new Map(progs.map(p => [p.student_id, p]));
        const allStudents = [...expected];
        for (const p of progs) {
          if (!allStudents.some(s => s.id === p.student_id)) {
            const stu = app.state.students.find(s => s.id === p.student_id);
            allStudents.push({ id: p.student_id, name: `${stu?.name || p.student_id}（试听/非在读）` });
          }
        }
        const title = targetType === 'recording' ? `${item.lesson_title} · ${item.title}` : `${item.course_name} · ${item.title}`;
        let filterMode = 'all';

        function renderDetailModal() {
          const rows = allStudents.filter(s => {
            const p = progMap.get(s.id);
            if (filterMode === 'incomplete') return !p?.completed;
            if (filterMode === 'done') return Boolean(p?.completed);
            return true;
          });
          const incompleteNames = expected.filter(s => !progMap.get(s.id)?.completed).map(s => s.name);
          const modalBody = openModal(`观看明细 · ${title}`, allStudents.length === 0
            ? `<div class="empty-state">暂无学生数据</div>`
            : `
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px">
                <div class="tab-bar">
                  <button type="button" class="tab-btn ${filterMode === 'all' ? 'active' : ''}" data-pm="all">全部 (${allStudents.length})</button>
                  <button type="button" class="tab-btn ${filterMode === 'incomplete' ? 'active' : ''}" data-pm="incomplete">未完课 (${allStudents.filter(s => !progMap.get(s.id)?.completed).length})</button>
                  <button type="button" class="tab-btn ${filterMode === 'done' ? 'active' : ''}" data-pm="done">已完课 (${allStudents.filter(s => progMap.get(s.id)?.completed).length})</button>
                </div>
                ${cid && incompleteNames.length ? `<button type="button" class="secondary-button btn-sm" id="pm-remind-qa">去课程群提醒未完课学员</button>` : ''}
              </div>
              <div class="table-wrap"><table class="data-table">
                <thead><tr><th>学生</th><th>累计观看</th><th>进度</th><th>状态</th><th>最近观看</th></tr></thead>
                <tbody>
                  ${rows.map(s => {
                    const p = progMap.get(s.id);
                    const dur = p?.duration_sec || item.duration_sec || 0;
                    const pct = p && dur > 0 ? Math.min(100, Math.round((p.watched_sec / dur) * 100)) : 0;
                    return `<tr>
                      <td><strong>${esc(s.name)}</strong></td>
                      <td>${p ? formatDuration(p.watched_sec) : '00:00'}</td>
                      <td>${pct}%</td>
                      <td><span class="status-pill ${p?.completed ? 'is-ok' : p?.watched_sec > 0 ? 'is-warn' : ''}">${p?.completed ? '已完课' : p?.watched_sec > 0 ? '学习中' : '未观看'}</span></td>
                      <td style="font-size:12px;color:var(--subtle)">${esc(p?.updated_at || '—')}</td>
                    </tr>`;
                  }).join('')}
                </tbody>
              </table></div>
            `
          );
          modalBody?.querySelectorAll('[data-pm]').forEach(b => {
            b.addEventListener('click', () => { filterMode = b.getAttribute('data-pm'); renderDetailModal(); });
          });
          modalBody?.querySelector('#pm-remind-qa')?.addEventListener('click', () => {
            document.querySelector('#modal')?.close();
            const mentions = incompleteNames.slice(0, 10).map(n => `@${n}`).join(' ');
            switchView('qa', {
              qaDraft: {
                courseId: cid,
                content: `${mentions} 请记得尽快完成「${title}」的视频学习并及时复习。`
              }
            });
          });
        }
        renderDetailModal();
      });
    });

    box.querySelectorAll('[data-edit-rec]').forEach(btn => {
      btn.addEventListener('click', () => {
        const rec = app.state.recordings.find(r => r.id === btn.getAttribute('data-edit-rec'));
        if (!rec) return;
        const modalBody = openModal('编辑回放信息', `
          <form id="edit-rec-modal-form" style="display:grid;gap:12px">
            <label class="form-field"><span>回放标题 *</span><input name="title" value="${esc(rec.title)}" required></label>
            <label class="form-field">
              <span>发布状态</span>
              <select name="status">
                <option value="pending_review" ${rec.status === 'pending_review' ? 'selected' : ''}>待审核</option>
                <option value="published" ${rec.status === 'published' ? 'selected' : ''}>已发布</option>
                <option value="withdrawn" ${rec.status === 'withdrawn' ? 'selected' : ''}>已撤回</option>
              </select>
            </label>
            <div class="form-actions"><button type="submit" class="primary-button">保存</button></div>
          </form>
        `);
        modalBody?.querySelector('#edit-rec-modal-form')?.addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          try {
            app.state = await api(`/api/recordings/${rec.id}`, {
              method: 'PATCH',
              body: { title: fd.get('title'), status: fd.get('status') }
            });
            document.querySelector('#modal').close();
            showToast('回放信息已更新');
            renderVod(shell);
          } catch (err) { showToast(err.message, true); }
        });
      });
    });

    box.querySelectorAll('[data-edit-vod]').forEach(btn => {
      btn.addEventListener('click', () => {
        const vod = app.state.vodLessons.find(v => v.id === btn.getAttribute('data-edit-vod'));
        if (!vod) return;
        const modalBody = openModal('编辑录播课', `
          <form id="edit-vod-modal-form" style="display:grid;gap:12px">
            <label class="form-field"><span>章节 *</span><input name="chapterName" value="${esc(vod.chapter_name)}" required></label>
            <label class="form-field"><span>小节标题 *</span><input name="title" value="${esc(vod.title)}" required></label>
            <label class="form-field"><span>排序序号</span><input type="number" name="sortOrder" value="${vod.sort_order}" min="1" required></label>
            <label class="form-field">
              <span>状态</span>
              <select name="status">
                <option value="published" ${vod.status === 'published' ? 'selected' : ''}>已发布</option>
                <option value="withdrawn" ${vod.status === 'withdrawn' ? 'selected' : ''}>已下架</option>
              </select>
            </label>
            <div class="form-actions"><button type="submit" class="primary-button">保存</button></div>
          </form>
        `);
        modalBody?.querySelector('#edit-vod-modal-form')?.addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          try {
            app.state = await api(`/api/vod/${vod.id}`, {
              method: 'PATCH',
              body: {
                chapterName: fd.get('chapterName'),
                title: fd.get('title'),
                sortOrder: Number(fd.get('sortOrder')) || 1,
                status: fd.get('status')
              }
            });
            document.querySelector('#modal').close();
            showToast('录播课信息已更新');
            renderVod(shell);
          } catch (err) { showToast(err.message, true); }
        });
      });
    });

    box.querySelectorAll('[data-pub-rec]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          app.state = await api(`/api/recordings/${btn.getAttribute('data-pub-rec')}`, {
            method: 'PATCH',
            body: { status: btn.getAttribute('data-next') }
          });
          showToast('状态已更新');
          renderVodTables();
        } catch (err) { showToast(err.message, true); }
      });
    });

    box.querySelectorAll('[data-del-rec]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('确认删除该回放？')) return;
        app.state = await api(`/api/recordings/${btn.getAttribute('data-del-rec')}`, { method: 'DELETE' });
        showToast('已删除');
        renderView();
      });
    });

    box.querySelectorAll('[data-del-vod]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('确认删除该录播课？')) return;
        app.state = await api(`/api/vod/${btn.getAttribute('data-del-vod')}`, { method: 'DELETE' });
        showToast('已删除');
        renderView();
      });
    });
  }

  renderVodTables();
  if (app.pendingRecordingFocusId) {
    const target = [...shell.querySelectorAll('[data-pending-recording]')]
      .find(row => row.dataset.pendingRecording === app.pendingRecordingFocusId);
    app.pendingRecordingFocusId = '';
    target?.focus();
  }

  shell.querySelectorAll('[data-recover-rec]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const recId = btn.getAttribute('data-recover-rec');
      if (!confirm('确认归档从开头连续收到的分片？归档后可在待核看列表试播。')) return;
      btn.disabled = true;
      btn.textContent = '归档中…';
      try {
        const res = await api(`/api/recordings/${recId}/finish`, {
          method: 'POST',
          body: { recoverPartial: true }
        });
        app.state = res.state;
        showToast('回放已归档，可在下方待核看列表中试播');
        renderVod(shell);
      } catch (err) {
        showToast(err.message, true);
        btn.disabled = false;
        btn.textContent = '归档已有部分';
      }
    });
  });

  shell.querySelectorAll('[data-discard-rec]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const recId = btn.getAttribute('data-discard-rec');
      if (!confirm('确认放弃并永久删除该条未归档录制的分片文件？')) return;
      try {
        app.state = await api(`/api/recordings/sessions/${recId}`, { method: 'DELETE' });
        showToast('已清理未归档录制');
        renderVod(shell);
      } catch (err) { showToast(err.message, true); }
    });
  });

  shell.querySelectorAll('[data-vod-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      app.vodViewTab = btn.getAttribute('data-vod-view');
      shell.querySelectorAll('[data-vod-view]').forEach(b => b.classList.toggle('active', b === btn));
      renderVodTables();
    });
  });
  shell.querySelectorAll('[data-up-tab]').forEach(btn => {
    btn.addEventListener('click', () => { app.vodUploadTab = btn.getAttribute('data-up-tab'); renderVod(shell); });
  });

  // 搜索框支持中文输入法组合且不重绘播放器
  const searchInp = shell.querySelector('#vod-search-input');
  if (searchInp) {
    let composing = false;
    searchInp.addEventListener('compositionstart', () => { composing = true; });
    searchInp.addEventListener('compositionend', () => {
      composing = false;
      app.vodSearch = searchInp.value;
      renderVodTables();
    });
    searchInp.addEventListener('input', () => {
      if (composing) return;
      app.vodSearch = searchInp.value;
      renderVodTables();
    });
  }
  shell.querySelector('#vod-course-filter')?.addEventListener('change', (e) => { app.vodCourseFilter = e.target.value; renderVodTables(); });
  shell.querySelector('#vod-status-filter')?.addEventListener('change', (e) => { app.vodStatusFilter = e.target.value; renderVodTables(); });

  shell.querySelector('#toggle-vod-upload')?.addEventListener('click', () => { app.showCreatePanel = !app.showCreatePanel; renderVod(shell); });
  shell.querySelector('#cancel-vod-upload')?.addEventListener('click', () => { app.showCreatePanel = false; renderVod(shell); });
  shell.querySelector('#cancel-rec-upload')?.addEventListener('click', () => { app.showCreatePanel = false; renderVod(shell); });

  shell.querySelector('#close-player-btn')?.addEventListener('click', () => {
    stopVodWatermark();
    const player = shell.querySelector('#main-vod-player');
    player.pause();
    player.removeAttribute('src');
    activePlayingMeta = null;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    shell.querySelector('#video-player-card').hidden = true;
  });

  shell.querySelector('#player-focus-btn')?.addEventListener('click', () => {
    if (!activePlayingMeta) return;
    const { targetType, targetId, courseId } = activePlayingMeta;
    switchView('player', targetType === 'vod' ? { playVodId: targetId, courseId } : { playRecId: targetId, courseId });
  });

  const rateSelect = shell.querySelector('#player-rate-select');
  if (rateSelect) {
    rateSelect.addEventListener('change', () => {
      const rate = Number(rateSelect.value) || 1;
      localStorage.setItem(instanceStorageKey(PLAYBACK_RATE_KEY), String(rate));
      const player = shell.querySelector('#main-vod-player');
      if (player) player.playbackRate = rate;
    });
  }

  shell.querySelector('#player-ask-qa-btn')?.addEventListener('click', () => {
    const player = shell.querySelector('#main-vod-player');
    const ts = formatDuration(player?.currentTime || 0);
    if (player && !player.paused) player.pause();
    const meta = activePlayingMeta || {};
    switchView('qa', {
      openCreate: true,
      qaDraft: {
        courseId: meta.courseId || '',
        lessonId: meta.lessonId || '',
        refTag: `${meta.shortTitle ? `${meta.shortTitle} ` : ''}[${ts}]`
      }
    });
  });

  shell.querySelector('#player-fullscreen-btn')?.addEventListener('click', () => {
    const stage = shell.querySelector('#player-stage');
    if (!stage) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else stage.requestFullscreen?.().catch(() => {});
  });

  shell.querySelector('#vod-add-bookmark-btn')?.addEventListener('click', () => {
    if (!activePlayingMeta) return;
    const player = shell.querySelector('#main-vod-player');
    const curSec = Math.round((player?.currentTime || 0) * 10) / 10;
    if (player && !player.paused) player.pause();
    const { targetType, targetId } = activePlayingMeta;
    const modalBody = openModal(`添加时间点书签 · ${formatDuration(curSec)}`, `
      <form id="vod-add-bmk-form" style="display:grid;gap:12px">
        <label class="form-field"><span>书签名称 *</span><input name="label" placeholder="如：例题2 切线放缩" required></label>
        <label class="form-field"><span>关联讲义页码 / 题号（选填）</span><input name="refTag" placeholder="如：讲义 P5 题 2"></label>
        <div class="form-actions">
          <button type="button" class="secondary-button" id="vbmk-cancel">取消</button>
          <button type="submit" class="primary-button">保存书签</button>
        </div>
      </form>
    `);
    modalBody?.querySelector('#vbmk-cancel')?.addEventListener('click', () => document.querySelector('#modal')?.close());
    modalBody?.querySelector('#vod-add-bmk-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const label = String(fd.get('label') || '').trim();
      const refTag = String(fd.get('refTag') || '').trim();
      if (!label) return;
      try {
        await api('/api/bookmarks', {
          method: 'POST',
          body: { targetType, targetId, timeSec: curSec, label, refTag }
        });
        document.querySelector('#modal')?.close();
        showToast('已添加时间点书签');
        loadInlineBookmarks(targetType, targetId, player);
      } catch (err) { showToast(err.message, true); }
    });
  });

  const vodForm = shell.querySelector('#upload-vod-form');
  if (vodForm) {
    vodForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(vodForm);
      const file = shell.querySelector('#vod-file-input').files[0];
      if (!file) return;
      const btn = shell.querySelector('#vod-submit-btn');
      const progWrap = shell.querySelector('#vod-upload-progress');
      const progText = shell.querySelector('#vod-upload-text');
      const progBar = shell.querySelector('#vod-upload-bar');
      const abortBtn = shell.querySelector('#vod-abort-btn');
      btn.disabled = true;
      btn.textContent = '上传中…';
      progWrap.hidden = false;
      progText.textContent = '正在读取视频时长…';
      progBar.style.width = '0%';
      try {
        const durationSec = await probeVideoDuration(file);
        const q = new URLSearchParams({
          courseId: fd.get('courseId'),
          chapterName: fd.get('chapterName'),
          title: fd.get('title'),
          sortOrder: fd.get('sortOrder') || '1',
          durationSec: String(durationSec),
          filename: file.name
        });
        const task = uploadMediaWithProgress(`/api/vod/upload?${q}`, file, {
          contentType: file.type || 'video/mp4',
          onProgress: (pct, loaded, total) => {
            progBar.style.width = `${pct}%`;
            progText.textContent = `已上传 ${pct}%（${formatSize(loaded)} / ${formatSize(total)}）`;
          }
        });
        abortBtn.onclick = () => task.abort();
        const res = await task.promise;
        app.state = res.state;
        app.showCreatePanel = false;
        showToast('录播课已发布');
        renderView();
      } catch (err) {
        showToast(err.message, true);
        btn.disabled = false;
        btn.textContent = '上传并发布';
        progWrap.hidden = true;
      }
    });
  }

  const recForm = shell.querySelector('#upload-rec-form');
  if (recForm) {
    recForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(recForm);
      const file = shell.querySelector('#rec-file-input').files[0];
      if (!file) return;
      const btn = shell.querySelector('#rec-submit-btn');
      const progWrap = shell.querySelector('#rec-upload-progress');
      const progText = shell.querySelector('#rec-upload-text');
      const progBar = shell.querySelector('#rec-upload-bar');
      const abortBtn = shell.querySelector('#rec-abort-btn');
      btn.disabled = true;
      btn.textContent = '上传中…';
      progWrap.hidden = false;
      progText.textContent = '正在读取视频时长…';
      progBar.style.width = '0%';
      try {
        const durationSec = await probeVideoDuration(file);
        const q = new URLSearchParams({
          lessonId: fd.get('lessonId'),
          title: fd.get('title'),
          durationSec: String(durationSec),
          filename: file.name
        });
        const task = uploadMediaWithProgress(`/api/recordings/upload?${q}`, file, {
          contentType: file.type || 'video/mp4',
          onProgress: (pct, loaded, total) => {
            progBar.style.width = `${pct}%`;
            progText.textContent = `已上传 ${pct}%（${formatSize(loaded)} / ${formatSize(total)}）`;
          }
        });
        abortBtn.onclick = () => task.abort();
        const res = await task.promise;
        app.state = res.state;
        app.showCreatePanel = false;
        showToast('回放已上传');
        renderView();
      } catch (err) {
        showToast(err.message, true);
        btn.disabled = false;
        btn.textContent = '上传回放';
        progWrap.hidden = true;
      }
    });
  }

  if (app.pendingVodPlay) {
    const target = app.pendingVodPlay;
    app.pendingVodPlay = null;
    const btn = shell.querySelector(`[data-play-video="${target.type}"][data-vid-id="${target.id}"]`);
    if (btn) btn.click();
  }
}

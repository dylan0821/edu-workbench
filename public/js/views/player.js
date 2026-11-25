import { esc, formatDuration, showToast, openModal } from '../utils.js';
import {
  app,
  api,
  isTeacher,
  stopVodWatermark,
  startWatermarkOnStage,
  startStudentVodPlayback,
  renderProgressCell,
  switchView,
  PLAYBACK_RATE_KEY,
  instanceStorageKey
} from '../state.js';
import { buildCourseOutlinePanelData, bindOutlinePanelEvents } from './outline-panel.js';

export function renderFocusPlayer(shell) {
  stopVodWatermark();
  const state = app.state;
  const target = app.activePlayerTarget || app.pendingVodPlay;
  app.pendingVodPlay = null;

  let media = null;
  let courseId = target?.courseId || '';
  if (target?.type === 'vod') {
    const v = state.vodLessons.find(x => x.id === target.id);
    if (v) {
      courseId = v.course_id;
      media = {
        type: 'vod',
        id: v.id,
        title: v.title,
        url: `/api/vod/${v.id}/file`,
        durationSec: Number(v.duration_sec) || 0,
        courseId: v.course_id,
        lessonId: ''
      };
    }
  } else if (target?.type === 'recording') {
    const r = state.recordings.find(x => x.id === target.id);
    if (r) {
      const les = state.lessons.find(l => l.id === r.lesson_id);
      courseId = r.course_id || les?.course_id || courseId;
      media = {
        type: 'recording',
        id: r.id,
        title: `${r.lesson_title} · ${r.title}`,
        url: `/api/recordings/${r.id}/file`,
        durationSec: Number(r.duration_sec) || 0,
        courseId,
        lessonId: r.lesson_id
      };
    }
  }

  if (!media) {
    switchView(isTeacher() ? 'vod' : 'catalog');
    return;
  }

  app.activePlayerTarget = { type: media.type, id: media.id, courseId: media.courseId };
  const protectedVod = media.type === 'vod' && state.currentUser.role === 'student';
  const course = state.courses.find(c => c.id === media.courseId) || null;
  const outlineData = buildCourseOutlinePanelData(media.courseId, { type: media.type, id: media.id });
  const curIdx = outlineData.playlist.findIndex(p => p.type === media.type && p.id === media.id);
  const prevItem = curIdx > 0 ? outlineData.playlist[curIdx - 1] : null;
  const nextItem = (curIdx >= 0 && curIdx < outlineData.playlist.length - 1) ? outlineData.playlist[curIdx + 1] : null;
  const savedRate = Number(localStorage.getItem(instanceStorageKey(PLAYBACK_RATE_KEY))) || 1;
  const currentStudentId = state.currentUser.role === 'student' ? state.currentUser.linkedId : '';
  const curProg = state.playbackProgress.find(
    p => p.student_id === currentStudentId && p.target_type === media.type && p.target_id === media.id
  );

  shell.innerHTML = `
    <div class="focus-player-topbar">
      <div class="focus-player-crumb">
        <button type="button" class="secondary-button btn-sm" id="fp-back-btn">← 返回${isTeacher() ? '录播列表' : '课程内容'}</button>
        ${course ? `<span>${esc(course.name)}</span>` : ''}
        ${outlineData.activePath.length > 1 ? `<span style="color:var(--subtle)">›</span><span>${esc(outlineData.activePath.slice(0, -1).join(' › '))}</span>` : ''}
        <span style="color:var(--subtle)">›</span>
        <strong>${esc(media.title)}</strong>
      </div>
      <div class="row-actions">
        <select id="fp-rate-select" class="secondary-button btn-sm" title="播放倍速">
          ${[0.75, 1, 1.25, 1.5, 2].map(rate => `<option value="${rate}" ${savedRate === rate ? 'selected' : ''}>${rate}x</option>`).join('')}
        </select>
        <button type="button" class="secondary-button btn-sm" id="fp-ask-qa-btn">在此时间点提问</button>
        <button type="button" class="secondary-button btn-sm" id="fp-fullscreen-btn">全屏</button>
        <button type="button" class="secondary-button btn-sm" id="fp-toggle-outline-btn">${app.playerOutlineCollapsed ? '展开大纲' : '收起大纲'}</button>
      </div>
    </div>

    <div class="focus-player-layout ${app.playerOutlineCollapsed ? 'is-outline-hidden' : ''}" id="fp-layout">
      <div class="focus-player-main">
        <div class="focus-player-video-box">
          <div id="player-stage" class="player-stage" oncontextmenu="return false">
            <video id="main-vod-player" controls controlsList="nodownload nofullscreen${protectedVod ? ' noremoteplayback' : ''}" disablePictureInPicture playsinline${protectedVod ? ' disableRemotePlayback x-webkit-airplay="deny"' : ''}></video>
            <div id="video-watermark" class="video-watermark"></div>
          </div>
        </div>

        <div class="focus-player-meta-bar">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0">
            <span class="outline-type-badge is-${media.type === 'vod' ? 'vod' : 'lesson'}">${media.type === 'vod' ? '录播课' : '直播回放'}</span>
            <strong style="font-size:15px">${esc(media.title)}</strong>
            ${outlineData.activePath.length ? `<span style="font-size:12px;color:var(--subtle)">位置：${esc(outlineData.activePath.join(' › '))}</span>` : ''}
            <span id="fp-prog-badge">${curProg ? renderProgressCell(curProg) : ''}</span>
          </div>
          <div class="row-actions">
            ${prevItem ? `<button type="button" class="secondary-button btn-sm" id="fp-prev-btn">← 上一节</button>` : ''}
            ${nextItem ? `<button type="button" class="primary-button btn-sm" id="fp-next-btn">下一节 →</button>` : ''}
          </div>
        </div>

        <div class="bookmark-bar" id="fp-bookmarks-bar">
          <span style="font-size:12px;color:var(--muted);font-weight:500">时间点书签</span>
          <span id="fp-bookmarks-list" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:1;min-width:0">
            <span style="font-size:12px;color:var(--subtle)">加载中…</span>
          </span>
          ${isTeacher() ? `<button type="button" class="secondary-button btn-sm" id="fp-add-bookmark-btn">+ 标记当前时间点</button>` : ''}
        </div>
      </div>

      <aside class="focus-player-outline" id="fp-outline-aside" ${app.playerOutlineCollapsed ? 'hidden' : ''}>
        <div class="focus-player-outline-head">
          <span>课程大纲</span>
          <span style="font-size:11px;color:var(--subtle)">${outlineData.playlist.length} 节视频</span>
        </div>
        <div class="focus-player-outline-body" id="fp-outline-body">
          ${outlineData.html}
        </div>
      </aside>
    </div>
  `;

  const player = shell.querySelector('#main-vod-player');
  const stage = shell.querySelector('#player-stage');
  const rateSel = shell.querySelector('#fp-rate-select');
  player.playbackRate = savedRate;

  const getEffectiveDuration = () => (Number.isFinite(player.duration) && player.duration > 0) ? player.duration : media.durationSec;

  const onKeyDown = (e) => {
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (player.paused) player.play().catch(() => {});
      else player.pause();
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      player.currentTime = Math.max(0, (player.currentTime || 0) - 5);
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      player.currentTime = Math.min(getEffectiveDuration() || 1e9, (player.currentTime || 0) + 5);
    }
  };
  startWatermarkOnStage(stage, player, { onKeydownExtra: onKeyDown, protectedVod });

  let lastReportMs = 0;
  const collectPlayedRanges = () => {
    const ranges = [];
    for (let i = 0; i < player.played.length; i++) {
      const s = Number(player.played.start(i).toFixed(1));
      const e = Number(player.played.end(i).toFixed(1));
      if (e > s) ranges.push([s, e]);
    }
    return ranges;
  };
  async function syncProgress() {
    if (!currentStudentId || !player.readyState) return;
    try {
      const res = await api('/api/progress', {
        method: 'POST',
        body: {
          targetType: media.type,
          targetId: media.id,
          positionSec: Number((player.currentTime || 0).toFixed(1)),
          durationSec: Number((getEffectiveDuration() || 0).toFixed(1)),
          watchedRanges: collectPlayedRanges()
        }
      });
      if (Array.isArray(res.playbackProgress)) {
        app.state.playbackProgress = res.playbackProgress;
        const latest = app.state.playbackProgress.find(
          p => p.student_id === currentStudentId && p.target_type === media.type && p.target_id === media.id
        );
        const badge = shell.querySelector('#fp-prog-badge');
        if (badge && latest) badge.innerHTML = renderProgressCell(latest);
      }
    } catch {}
  }

  let firstMetadata = true;
  player.onloadedmetadata = () => {
    player.playbackRate = Number(rateSel.value) || 1;
    if (!firstMetadata) return;
    firstMetadata = false;
    const effDur = getEffectiveDuration();
    if (curProg && curProg.last_position_sec > 2 && (!effDur || curProg.last_position_sec < effDur - 2)) {
      player.currentTime = curProg.last_position_sec;
      showToast(`已从 ${formatDuration(curProg.last_position_sec)} 续播`);
    }
    player.play().catch(() => {});
  };
  player.ontimeupdate = () => {
    const now = Date.now();
    if (now - lastReportMs >= 5000) {
      lastReportMs = now;
      syncProgress();
    }
  };
  player.onpause = () => syncProgress();
  player.onended = () => syncProgress();
  if (protectedVod) {
    player.addEventListener('webkitbeginfullscreen', () => player.webkitExitFullscreen?.());
    startStudentVodPlayback(player, media.id);
  } else player.src = media.url;

  rateSel.addEventListener('change', () => {
    const rate = Number(rateSel.value) || 1;
    player.playbackRate = rate;
    localStorage.setItem(instanceStorageKey(PLAYBACK_RATE_KEY), String(rate));
  });

  shell.querySelector('#fp-back-btn').addEventListener('click', () => {
    syncProgress();
    switchView(isTeacher() ? 'vod' : 'catalog', isTeacher() ? {} : { outlineCourseId: media.courseId });
  });

  shell.querySelector('#fp-fullscreen-btn').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else stage.requestFullscreen?.().catch(() => {});
  });

  shell.querySelector('#fp-toggle-outline-btn').addEventListener('click', () => {
    app.playerOutlineCollapsed = !app.playerOutlineCollapsed;
    shell.querySelector('#fp-layout').classList.toggle('is-outline-hidden', app.playerOutlineCollapsed);
    shell.querySelector('#fp-outline-aside').hidden = app.playerOutlineCollapsed;
    shell.querySelector('#fp-toggle-outline-btn').textContent = app.playerOutlineCollapsed ? '展开大纲' : '收起大纲';
  });

  shell.querySelector('#fp-ask-qa-btn').addEventListener('click', () => {
    const t = formatDuration(player.currentTime || 0);
    switchView('qa', {
      qaDraft: {
        courseId: media.courseId,
        lessonId: media.lessonId,
        refTag: `${media.title} ${t}`,
        content: `关于「${media.title}」在 ${t} 处的疑问：`
      }
    });
  });

  if (prevItem) {
    shell.querySelector('#fp-prev-btn').addEventListener('click', () => {
      syncProgress();
      switchView('player', prevItem.type === 'vod' ? { playVodId: prevItem.id, courseId: media.courseId } : { playRecId: prevItem.id, courseId: media.courseId });
    });
  }
  if (nextItem) {
    shell.querySelector('#fp-next-btn').addEventListener('click', () => {
      syncProgress();
      switchView('player', nextItem.type === 'vod' ? { playVodId: nextItem.id, courseId: media.courseId } : { playRecId: nextItem.id, courseId: media.courseId });
    });
  }

  const outlineBody = shell.querySelector('#fp-outline-body');
  bindOutlinePanelEvents(outlineBody, media.courseId);
  const activeEl = outlineBody?.querySelector('.fpo-item.is-active');
  if (activeEl) activeEl.scrollIntoView({ block: 'center', behavior: 'smooth' });

  const bmkListEl = shell.querySelector('#fp-bookmarks-list');
  async function loadBookmarks() {
    if (!bmkListEl) return;
    try {
      const res = await api(`/api/bookmarks?targetType=${encodeURIComponent(media.type)}&targetId=${encodeURIComponent(media.id)}`);
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
            loadBookmarks();
          } catch (err) { showToast(err.message, true); }
        });
      });
    } catch {
      bmkListEl.innerHTML = `<span style="font-size:12px;color:var(--subtle)">暂无书签</span>`;
    }
  }
  loadBookmarks();

  const addBmkBtn = shell.querySelector('#fp-add-bookmark-btn');
  if (addBmkBtn) {
    addBmkBtn.addEventListener('click', () => {
      const curSec = Math.round((player.currentTime || 0) * 10) / 10;
      if (!player.paused) player.pause();
      const body = openModal(`添加时间点书签 · ${formatDuration(curSec)}`, `
        <form id="add-bmk-form" style="display:grid;gap:12px">
          <label class="form-field"><span>书签名称 *</span><input name="label" placeholder="如：例题2 切线放缩" required></label>
          <label class="form-field"><span>关联讲义页码 / 题号（选填）</span><input name="refTag" placeholder="如：讲义 P5 题 2"></label>
          <div class="form-actions">
            <button type="button" class="secondary-button" id="bmk-cancel">取消</button>
            <button type="submit" class="primary-button">保存书签</button>
          </div>
        </form>
      `);
      body?.querySelector('#bmk-cancel')?.addEventListener('click', () => document.querySelector('#modal')?.close());
      body?.querySelector('#add-bmk-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const label = String(fd.get('label') || '').trim();
        const refTag = String(fd.get('refTag') || '').trim();
        if (!label) return;
        try {
          await api('/api/bookmarks', {
            method: 'POST',
            body: { targetType: media.type, targetId: media.id, timeSec: curSec, label, refTag }
          });
          document.querySelector('#modal')?.close();
          showToast('已添加时间点书签');
          loadBookmarks();
        } catch (err) { showToast(err.message, true); }
      });
    });
  }
}

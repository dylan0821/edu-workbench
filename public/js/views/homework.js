import { esc, formatSize, openModal, closeModal, showToast, uploadFileWithProgress, renderMarkdown } from '../utils.js';
import { app, api, isTeacher, isAdmin, updateNavCounts } from '../state.js';

function hwAttachmentUrl(homeworkId, attId, download = false) {
  return `/api/homework/${encodeURIComponent(homeworkId)}/attachments/${encodeURIComponent(attId)}${download ? '?download=1' : ''}`;
}

function hwSubmissionFileUrl(subId, fileId, download = false) {
  return `/api/homework-submissions/${encodeURIComponent(subId)}/files/${encodeURIComponent(fileId)}${download ? '?download=1' : ''}`;
}

function openImageLightbox(url, title = '图片预览') {
  openModal(title, `
    <div style="text-align:center">
      <img src="${esc(url)}" alt="${esc(title)}" style="max-width:100%;max-height:75vh;border-radius:var(--radius-sm);border:1px solid var(--line)">
    </div>
  `);
}

function renderHomeworkBodyHtml(hw) {
  if (!hw.content) return '';
  if (hw.content_format === 'text') {
    return `<div class="hw-text-body">${esc(hw.content)}</div>`;
  }
  return `<div class="hw-md-body">${renderMarkdown(hw.content)}</div>`;
}

function renderAttachmentChips(homeworkId, attachments = []) {
  if (!attachments.length) return '';
  return `
    <div class="hw-attachments">
      ${attachments.map(att => {
        const url = hwAttachmentUrl(homeworkId, att.id, false);
        const dlUrl = hwAttachmentUrl(homeworkId, att.id, true);
        if (att.isImage) {
          return `
            <button type="button" class="hw-att-chip is-image" data-preview-img="${esc(url)}" data-preview-title="${esc(att.filename)}">
              <span>🖼️ ${esc(att.filename)}</span>
              <span class="hw-att-size">${formatSize(att.sizeBytes)}</span>
            </button>
          `;
        }
        return `
          <a class="hw-att-chip" href="${esc(dlUrl)}" target="_blank" rel="noopener noreferrer">
            <span>📎 ${esc(att.filename)}</span>
            <span class="hw-att-size">${formatSize(att.sizeBytes)}</span>
          </a>
        `;
      }).join('')}
    </div>
  `;
}

function bindImagePreviews(container) {
  container.querySelectorAll('[data-preview-img]').forEach(el => {
    el.addEventListener('click', () => {
      openImageLightbox(el.getAttribute('data-preview-img'), el.getAttribute('data-preview-title') || '图片预览');
    });
  });
}

export function openHomeworkEditorModal(existingHw = null, onSaved, presetCourseId = '') {
  const courses = app.state.courses || [];
  if (!courses.length) {
    showToast('请先创建课程后再布置作业', true);
    return;
  }
  const defaultCourseId = existingHw?.course_id || presetCourseId || app.hwCourseFilter || courses[0].id;
  let contentFormat = existingHw?.content_format === 'text' ? 'text' : 'markdown';
  let attachments = existingHw ? [...(existingHw.attachments || [])] : [];
  let previewMode = false;

  const body = openModal(existingHw ? '编辑作业' : '布置作业', `
    <form id="hw-editor-form" class="hw-editor-form">
      <div class="form-grid">
        <label class="form-field">
          <span>所属课程 *</span>
          <select name="courseId" ${existingHw ? 'disabled' : ''} required>
            ${courses.map(c => `<option value="${esc(c.id)}" ${c.id === defaultCourseId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>
        </label>
        <label class="form-field">
          <span>截止日期（选填）</span>
          <input name="dueDate" type="date" value="${esc(existingHw?.due_date || '')}">
        </label>
      </div>

      <label class="form-field">
        <span>作业标题 *</span>
        <input name="title" placeholder="如：第一讲 导数单调性课后练习" value="${esc(existingHw?.title || '')}" required>
      </label>

      <div class="form-field">
        <div class="hw-editor-head">
          <span>作业内容（支持文字、Markdown 与 LaTeX 公式）</span>
          <div class="hw-segmented">
            <button type="button" class="hw-seg-btn ${contentFormat === 'markdown' ? 'is-active' : ''}" data-fmt="markdown">Markdown</button>
            <button type="button" class="hw-seg-btn ${contentFormat === 'text' ? 'is-active' : ''}" data-fmt="text">纯文本</button>
            <button type="button" class="hw-seg-btn" id="hw-toggle-preview" ${contentFormat === 'text' ? 'hidden' : ''}>预览</button>
          </div>
        </div>
        <textarea name="content" id="hw-content-input" rows="6" placeholder="输入作业要求，支持 Markdown 语法及 LaTeX 公式（如 $a+b=c$）…">${esc(existingHw?.content || '')}</textarea>
        <div id="hw-content-preview" class="hw-md-preview hw-md-body" hidden></div>
      </div>

      <div class="form-field">
        <span>附件（选填，支持讲义 PDF、图片、文档，单文件 ≤ 20MB）</span>
        <label class="hw-dropzone" for="hw-att-file-input">
          <span class="hw-dropzone-text" id="hw-att-uploading">📎 点击选择附件上传（可多选）</span>
          <input type="file" id="hw-att-file-input" multiple hidden>
        </label>
        <div id="hw-att-list" class="hw-att-edit-list" hidden></div>
      </div>

      <div id="hw-editor-err" class="message-bar is-error" hidden></div>
      <div class="form-actions">
        <button type="submit" class="primary-button">${existingHw ? '保存修改' : '发布作业'}</button>
        <button type="button" class="secondary-button" id="hw-editor-cancel">取消</button>
      </div>
    </form>
  `);
  if (!body) return;

  const form = body.querySelector('#hw-editor-form');
  const courseSel = form.querySelector('select[name="courseId"]');
  const textarea = body.querySelector('#hw-content-input');
  const previewEl = body.querySelector('#hw-content-preview');
  const previewBtn = body.querySelector('#hw-toggle-preview');
  const attInput = body.querySelector('#hw-att-file-input');
  const attListEl = body.querySelector('#hw-att-list');
  const uploadingEl = body.querySelector('#hw-att-uploading');
  const errEl = body.querySelector('#hw-editor-err');

  function renderAttList() {
    if (!attachments.length) {
      attListEl.hidden = true;
      attListEl.innerHTML = '';
      return;
    }
    attListEl.hidden = false;
    attListEl.innerHTML = attachments.map((att, idx) => `
      <span class="hw-att-chip">
        <span>${att.isImage ? '🖼️' : '📎'} ${esc(att.filename)} (${formatSize(att.sizeBytes)})</span>
        <button type="button" class="hw-att-remove" data-rm-att="${idx}" title="移除">×</button>
      </span>
    `).join('');
    attListEl.querySelectorAll('[data-rm-att]').forEach(btn => {
      btn.addEventListener('click', () => {
        attachments.splice(Number(btn.getAttribute('data-rm-att')), 1);
        renderAttList();
      });
    });
  }
  renderAttList();

  body.querySelectorAll('[data-fmt]').forEach(btn => {
    btn.addEventListener('click', () => {
      contentFormat = btn.getAttribute('data-fmt');
      body.querySelectorAll('[data-fmt]').forEach(b => b.classList.toggle('is-active', b === btn));
      if (contentFormat === 'text') {
        previewMode = false;
        previewBtn.classList.remove('is-active');
        previewBtn.textContent = '预览';
        previewBtn.hidden = true;
        previewEl.hidden = true;
        textarea.hidden = false;
      } else {
        previewBtn.hidden = false;
      }
    });
  });

  previewBtn.addEventListener('click', () => {
    previewMode = !previewMode;
    previewBtn.classList.toggle('is-active', previewMode);
    previewBtn.textContent = previewMode ? '返回编辑' : '预览';
    if (previewMode) {
      previewEl.innerHTML = renderMarkdown(textarea.value) || '<span style="color:var(--subtle)">暂无内容</span>';
      previewEl.hidden = false;
      textarea.hidden = true;
    } else {
      previewEl.hidden = true;
      textarea.hidden = false;
    }
  });

  attInput.addEventListener('change', async () => {
    const files = [...(attInput.files || [])];
    if (!files.length) return;
    const cid = existingHw ? existingHw.course_id : courseSel.value;
    errEl.hidden = true;
    try {
      for (const file of files) {
        const res = await uploadFileWithProgress(
          `/api/homework/upload?courseId=${encodeURIComponent(cid)}&kind=attachment&filename=${encodeURIComponent(file.name)}`,
          file,
          (pct) => { uploadingEl.textContent = `正在上传 ${file.name} (${pct}%)…`; }
        );
        attachments.push(res);
        renderAttList();
      }
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      uploadingEl.textContent = '📎 点击选择附件上传（可多选）';
      attInput.value = '';
    }
  });

  body.querySelector('#hw-editor-cancel').addEventListener('click', () => closeModal());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    const fd = new FormData(form);
    const payload = {
      courseId: existingHw ? existingHw.course_id : fd.get('courseId'),
      title: String(fd.get('title') || '').trim(),
      content: textarea.value,
      contentFormat,
      dueDate: String(fd.get('dueDate') || '').trim(),
      attachments
    };
    try {
      if (existingHw) {
        const res = await api(`/api/homeworks/${encodeURIComponent(existingHw.id)}`, {
          method: 'PATCH',
          body: payload
        });
        if (res.snapshot) app.state = res.snapshot;
        showToast('作业已更新');
        closeModal();
        onSaved?.(res.homework?.id || existingHw.id);
      } else {
        const res = await api('/api/homeworks', {
          method: 'POST',
          body: payload
        });
        if (res.snapshot) app.state = res.snapshot;
        showToast('作业已发布');
        closeModal();
        onSaved?.(res.homework?.id || '');
      }
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });
}

export function openStudentSubmitModal(hw, existingSub, onSaved) {
  let images = existingSub ? [...(existingSub.images || [])] : [];
  const hasGraded = existingSub?.status === 'graded';

  const body = openModal(hasGraded ? `查看批改 · ${hw.title}` : `作业详情与提交 · ${hw.title}`, `
    <div class="hw-submit-modal">
      <div class="hw-submit-meta">
        <span class="page-badge is-accent">${esc(hw.course_name || '')}</span>
        ${hw.due_date ? `<span class="page-badge">截止：${esc(hw.due_date)}</span>` : ''}
        <span style="font-size:12px;color:var(--subtle)">布置人：${esc(hw.creator_name || '老师')}</span>
      </div>

      ${(hw.content || (hw.attachments || []).length) ? `
        <div style="margin-top:10px">
          ${renderHomeworkBodyHtml(hw)}
          ${renderAttachmentChips(hw.id, hw.attachments)}
        </div>
      ` : ''}

      ${hasGraded ? `
        <div class="hw-grade-result-box">
          <div class="hw-grade-result-head">
            <span class="status-pill is-ok">已批改</span>
            ${existingSub.score ? `<span class="hw-score-pill">评分：<strong>${esc(existingSub.score)}</strong></span>` : ''}
            <span style="font-size:12px;color:var(--subtle)">批改人：${esc(existingSub.graded_by || '老师')} · ${esc(existingSub.graded_at || '')}</span>
          </div>
          ${existingSub.feedback ? `<div class="hw-grade-feedback"><strong>老师评语：</strong>${esc(existingSub.feedback)}</div>` : ''}
          ${(existingSub.gradedImages || []).length ? `
            <div style="margin-top:10px">
              <div style="font-size:12px;color:var(--subtle);margin-bottom:6px">批改标注图片（点击放大）：</div>
              <div class="hw-thumb-grid">
                ${existingSub.gradedImages.map((img, i) => `
                  <div class="hw-thumb-card">
                    <img src="${esc(hwSubmissionFileUrl(existingSub.id, img.id))}" alt="批改图片 ${i + 1}" data-preview-img="${esc(hwSubmissionFileUrl(existingSub.id, img.id))}" data-preview-title="批改图片 ${i + 1}">
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}
        </div>
      ` : ''}

      <form id="hw-student-submit-form" class="hw-editor-form" style="margin-top:12px">
        <div class="form-field">
          <span>${existingSub ? '作业图片（可增删后重新提交）*' : '上传作业图片 *'}</span>
          <label class="hw-dropzone" for="hw-stu-img-input">
            <span class="hw-dropzone-text" id="hw-stu-uploading">📷 点击选择作业图片（支持多张拍照 / 截图）</span>
            <input type="file" id="hw-stu-img-input" accept="image/*" multiple hidden>
          </label>
          <div id="hw-stu-img-grid" class="hw-thumb-grid" hidden></div>
        </div>
        <label class="form-field">
          <span>补充说明（选填）</span>
          <textarea name="note" rows="2" placeholder="如有疑问或备注可写在这里…">${esc(existingSub?.note || '')}</textarea>
        </label>
        <div id="hw-stu-err" class="message-bar is-error" hidden></div>
        <div class="form-actions">
          <button type="submit" class="primary-button">${existingSub ? '更新并重新提交' : '确认提交'}</button>
          <button type="button" class="secondary-button" id="hw-stu-cancel">关闭</button>
        </div>
      </form>
    </div>
  `);
  if (!body) return;

  bindImagePreviews(body);

  const gridEl = body.querySelector('#hw-stu-img-grid');
  const fileInput = body.querySelector('#hw-stu-img-input');
  const uploadingEl = body.querySelector('#hw-stu-uploading');
  const errEl = body.querySelector('#hw-stu-err');
  const form = body.querySelector('#hw-student-submit-form');

  function renderImages() {
    if (!images.length) {
      gridEl.hidden = true;
      gridEl.innerHTML = '';
      return;
    }
    gridEl.hidden = false;
    gridEl.innerHTML = images.map((img, idx) => {
      const src = existingSub && (existingSub.images || []).some(x => x.id === img.id)
        ? hwSubmissionFileUrl(existingSub.id, img.id)
        : img._localPreview || '';
      return `
        <div class="hw-thumb-card">
          ${src ? `<img src="${esc(src)}" alt="${esc(img.filename)}" data-preview-img="${esc(src)}" data-preview-title="${esc(img.filename)}">` : `<div class="hw-thumb-placeholder">${esc(img.filename)}</div>`}
          <button type="button" class="hw-thumb-del" data-del-img="${idx}" title="移除">×</button>
        </div>
      `;
    }).join('');
    bindImagePreviews(gridEl);
    gridEl.querySelectorAll('[data-del-img]').forEach(btn => {
      btn.addEventListener('click', () => {
        images.splice(Number(btn.getAttribute('data-del-img')), 1);
        renderImages();
      });
    });
  }
  renderImages();

  fileInput.addEventListener('change', async () => {
    const files = [...(fileInput.files || [])];
    if (!files.length) return;
    errEl.hidden = true;
    try {
      for (const file of files) {
        const localUrl = URL.createObjectURL(file);
        const res = await uploadFileWithProgress(
          `/api/homework/upload?courseId=${encodeURIComponent(hw.course_id)}&kind=submission&filename=${encodeURIComponent(file.name)}`,
          file,
          (pct) => { uploadingEl.textContent = `正在上传 ${file.name} (${pct}%)…`; }
        );
        res._localPreview = localUrl;
        images.push(res);
        renderImages();
      }
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      uploadingEl.textContent = '📷 点击选择作业图片（支持多张拍照 / 截图）';
      fileInput.value = '';
    }
  });

  body.querySelector('#hw-stu-cancel').addEventListener('click', () => closeModal());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    if (!images.length) {
      errEl.textContent = '请至少上传一张作业图片';
      errEl.hidden = false;
      return;
    }
    const cleanImages = images.map(({ _localPreview, ...rest }) => rest);
    try {
      const res = await api(`/api/homeworks/${encodeURIComponent(hw.id)}/submit`, {
        method: 'POST',
        body: {
          images: cleanImages,
          note: form.querySelector('textarea[name="note"]').value
        }
      });
      if (res.snapshot) app.state = res.snapshot;
      showToast('作业提交成功');
      closeModal();
      onSaved?.();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });
}

function openTeacherGradeModal(hw, sub, onGraded) {
  const images = sub.images || [];
  let activeIdx = 0;
  let drawEnabled = true;
  let penColor = '#e11d48';
  let penWidth = 3;
  // Per-image stroke history: Map<idx, Array<{ color, width, points }>>
  const strokesByIdx = new Map();
  const imgElements = new Map();

  const body = openModal(`批改作业 · ${sub.student_name} (${hw.title})`, `
    <div class="hw-grade-workspace">
      <div class="hw-grade-canvas-pane">
        <div class="hw-grade-toolbar">
          <div class="hw-grade-pages">
            ${images.map((_, i) => `<button type="button" class="secondary-button btn-sm ${i === 0 ? 'is-active' : ''}" data-page-idx="${i}">第 ${i + 1} 页</button>`).join('')}
          </div>
          <div class="hw-grade-tools">
            <button type="button" class="secondary-button btn-sm is-active" id="hw-draw-toggle">画笔批注: 开</button>
            <button type="button" class="hw-color-dot is-active" data-pen-color="#e11d48" style="background:#e11d48" title="红笔"></button>
            <button type="button" class="hw-color-dot" data-pen-color="#16a34a" style="background:#16a34a" title="绿笔"></button>
            <button type="button" class="hw-color-dot" data-pen-color="#2563eb" style="background:#2563eb" title="蓝笔"></button>
            <button type="button" class="secondary-button btn-sm" id="hw-draw-undo">撤销</button>
            <button type="button" class="secondary-button btn-sm" id="hw-draw-clear">清空本页</button>
          </div>
        </div>
        <div class="hw-grade-stage" id="hw-grade-stage">
          <img id="hw-grade-base-img" alt="学生作业图片">
          <canvas id="hw-grade-canvas"></canvas>
        </div>
        ${sub.note ? `<div class="hw-stu-note-bar"><strong>学生备注：</strong>${esc(sub.note)}</div>` : ''}
      </div>

      <form id="hw-grade-form" class="hw-grade-side">
        <label class="form-field">
          <span>评分 / 等级</span>
          <input name="score" placeholder="如：95、A+、优秀" value="${esc(sub.score || '')}">
        </label>
        <label class="form-field">
          <span>批改评语</span>
          <textarea name="feedback" rows="6" placeholder="输入对学生作业的点评与修改建议…">${esc(sub.feedback || '')}</textarea>
        </label>
        ${(sub.gradedImages || []).length ? `
          <div class="form-field">
            <span>已保存的批改图（重新批注将更新对应页）</span>
            <div class="hw-thumb-grid">
              ${sub.gradedImages.map((g, i) => `
                <div class="hw-thumb-card">
                  <img src="${esc(hwSubmissionFileUrl(sub.id, g.id))}" alt="已批改 ${i + 1}" data-preview-img="${esc(hwSubmissionFileUrl(sub.id, g.id))}" data-preview-title="已批改图 ${i + 1}">
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
        <div id="hw-grade-err" class="message-bar is-error" hidden></div>
        <div class="form-actions">
          <button type="submit" class="primary-button" id="hw-grade-submit">保存批改</button>
          <button type="button" class="secondary-button" id="hw-grade-cancel">取消</button>
        </div>
      </form>
    </div>
  `);
  if (!body) return;

  bindImagePreviews(body);

  const baseImg = body.querySelector('#hw-grade-base-img');
  const canvas = body.querySelector('#hw-grade-canvas');
  const ctx = canvas.getContext('2d');
  const errEl = body.querySelector('#hw-grade-err');
  const submitBtn = body.querySelector('#hw-grade-submit');

  function redrawCanvas() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const strokes = strokesByIdx.get(activeIdx) || [];
    for (const st of strokes) {
      if (!st.points.length) continue;
      ctx.strokeStyle = st.color;
      ctx.lineWidth = st.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(st.points[0].x * canvas.width, st.points[0].y * canvas.height);
      for (let i = 1; i < st.points.length; i++) {
        ctx.lineTo(st.points[i].x * canvas.width, st.points[i].y * canvas.height);
      }
      ctx.stroke();
    }
  }

  function syncCanvasSize() {
    const rect = baseImg.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      canvas.width = Math.round(rect.width);
      canvas.height = Math.round(rect.height);
      redrawCanvas();
    }
  }

  function loadPage(idx) {
    activeIdx = idx;
    body.querySelectorAll('[data-page-idx]').forEach(b => {
      b.classList.toggle('is-active', Number(b.getAttribute('data-page-idx')) === idx);
    });
    const file = images[idx];
    if (!file) return;
    baseImg.onload = () => {
      imgElements.set(idx, baseImg.cloneNode());
      syncCanvasSize();
    };
    baseImg.src = hwSubmissionFileUrl(sub.id, file.id);
  }

  if (images.length) loadPage(0);

  let drawing = false;
  let currentStroke = null;
  function getRelPoint(ev) {
    const rect = canvas.getBoundingClientRect();
    const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
    const clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    };
  }

  function onPointerDown(ev) {
    if (!drawEnabled) return;
    ev.preventDefault();
    drawing = true;
    const pt = getRelPoint(ev);
    currentStroke = { color: penColor, width: penWidth, points: [pt] };
    if (!strokesByIdx.has(activeIdx)) strokesByIdx.set(activeIdx, []);
    strokesByIdx.get(activeIdx).push(currentStroke);
    redrawCanvas();
  }
  function onPointerMove(ev) {
    if (!drawing || !currentStroke) return;
    ev.preventDefault();
    currentStroke.points.push(getRelPoint(ev));
    redrawCanvas();
  }
  function onPointerUp() {
    drawing = false;
    currentStroke = null;
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  body.querySelectorAll('[data-page-idx]').forEach(btn => {
    btn.addEventListener('click', () => loadPage(Number(btn.getAttribute('data-page-idx'))));
  });

  const drawToggleBtn = body.querySelector('#hw-draw-toggle');
  drawToggleBtn.addEventListener('click', () => {
    drawEnabled = !drawEnabled;
    drawToggleBtn.textContent = drawEnabled ? '画笔批注: 开' : '画笔批注: 关';
    drawToggleBtn.classList.toggle('is-active', drawEnabled);
    canvas.style.pointerEvents = drawEnabled ? 'auto' : 'none';
  });

  body.querySelectorAll('[data-pen-color]').forEach(btn => {
    btn.addEventListener('click', () => {
      penColor = btn.getAttribute('data-pen-color');
      body.querySelectorAll('[data-pen-color]').forEach(b => b.classList.toggle('is-active', b === btn));
    });
  });

  body.querySelector('#hw-draw-undo').addEventListener('click', () => {
    const arr = strokesByIdx.get(activeIdx);
    if (arr && arr.length) {
      arr.pop();
      redrawCanvas();
    }
  });

  body.querySelector('#hw-draw-clear').addEventListener('click', () => {
    strokesByIdx.set(activeIdx, []);
    redrawCanvas();
  });

  body.querySelector('#hw-grade-cancel').addEventListener('click', () => closeModal());

  async function renderAnnotatedBlob(idx) {
    const strokes = strokesByIdx.get(idx) || [];
    if (!strokes.length) return null;
    const file = images[idx];
    const img = new Image();
    img.src = hwSubmissionFileUrl(sub.id, file.id);
    await new Promise((resolve, reject) => {
      if (img.complete && img.naturalWidth) return resolve();
      img.onload = resolve;
      img.onerror = () => reject(new Error('加载原图失败'));
    });
    const off = document.createElement('canvas');
    off.width = img.naturalWidth || 1200;
    off.height = img.naturalHeight || 900;
    const octx = off.getContext('2d');
    octx.drawImage(img, 0, 0, off.width, off.height);
    const scale = Math.max(1, off.width / Math.max(1, canvas.width));
    for (const st of strokes) {
      if (!st.points.length) continue;
      octx.strokeStyle = st.color;
      octx.lineWidth = st.width * scale;
      octx.lineCap = 'round';
      octx.lineJoin = 'round';
      octx.beginPath();
      octx.moveTo(st.points[0].x * off.width, st.points[0].y * off.height);
      for (let i = 1; i < st.points.length; i++) {
        octx.lineTo(st.points[i].x * off.width, st.points[i].y * off.height);
      }
      octx.stroke();
    }
    return new Promise((resolve) => off.toBlob(resolve, 'image/png'));
  }

  body.querySelector('#hw-grade-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = '保存中…';
    try {
      const nextGradedImages = [...(sub.gradedImages || [])];
      let hasNewAnnotations = false;
      for (let idx = 0; idx < images.length; idx++) {
        const strokes = strokesByIdx.get(idx) || [];
        if (strokes.length > 0) {
          hasNewAnnotations = true;
          const blob = await renderAnnotatedBlob(idx);
          if (blob) {
            const filename = `graded_p${idx + 1}_${images[idx].filename.replace(/\.[^.]+$/, '')}.png`;
            const fileObj = new File([blob], filename, { type: 'image/png' });
            const uploaded = await uploadFileWithProgress(
              `/api/homework/upload?courseId=${encodeURIComponent(hw.course_id)}&kind=graded&filename=${encodeURIComponent(filename)}`,
              fileObj
            );
            nextGradedImages[idx] = uploaded;
          }
        }
      }
      const compactGraded = hasNewAnnotations
        ? nextGradedImages.filter(Boolean)
        : (sub.gradedImages || []);

      const fd = new FormData(e.target);
      const res = await api(`/api/homework-submissions/${encodeURIComponent(sub.id)}/grade`, {
        method: 'POST',
        body: {
          score: String(fd.get('score') || '').trim(),
          feedback: String(fd.get('feedback') || '').trim(),
          gradedImages: compactGraded
        }
      });
      if (res.snapshot) app.state = res.snapshot;
      showToast('批改已保存');
      closeModal();
      onGraded?.();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '保存批改';
    }
  });
}

export function renderHomework(shell) {
  const state = app.state;
  const staff = isTeacher();
  const courses = state.courses || [];
  const homeworks = state.homeworks || [];
  const submissions = state.homeworkSubmissions || [];
  const enrollments = state.enrollments || [];

  const subsByHw = new Map();
  for (const s of submissions) {
    if (!subsByHw.has(s.homework_id)) subsByHw.set(s.homework_id, []);
    subsByHw.get(s.homework_id).push(s);
  }

  const enrolledCountByCourse = new Map();
  const enrolledStudentsByCourse = new Map();
  for (const e of enrollments) {
    if (e.status !== 'active') continue;
    enrolledCountByCourse.set(e.course_id, (enrolledCountByCourse.get(e.course_id) || 0) + 1);
    if (!enrolledStudentsByCourse.has(e.course_id)) enrolledStudentsByCourse.set(e.course_id, []);
    enrolledStudentsByCourse.get(e.course_id).push(e);
  }

  // Filter homeworks
  const kw = (app.hwSearch || '').trim().toLowerCase();
  const filtered = homeworks.filter(hw => {
    if (app.hwCourseFilter && hw.course_id !== app.hwCourseFilter) return false;
    if (kw && !`${hw.title} ${hw.course_name || ''} ${hw.content || ''}`.toLowerCase().includes(kw)) return false;
    const hwSubs = subsByHw.get(hw.id) || [];
    if (staff) {
      const pending = hwSubs.filter(s => s.status !== 'graded').length;
      if (app.hwStatusFilter === 'pending' && pending === 0) return false;
      if (app.hwStatusFilter === 'done' && (hwSubs.length === 0 || pending > 0)) return false;
    } else {
      const mySub = hwSubs[0] || null;
      if (app.hwStatusFilter === 'unsubmitted' && mySub) return false;
      if (app.hwStatusFilter === 'submitted' && (!mySub || mySub.status === 'graded')) return false;
      if (app.hwStatusFilter === 'graded' && mySub?.status !== 'graded') return false;
    }
    return true;
  });

  const activeHw = app.hwActiveId
    ? (filtered.find(h => h.id === app.hwActiveId) || homeworks.find(h => h.id === app.hwActiveId) || null)
    : null;

  const totalPendingGrade = staff
    ? submissions.filter(s => s.status !== 'graded').length
    : homeworks.filter(h => !(subsByHw.get(h.id) || []).length).length;

  shell.innerHTML = `
    <div class="page-heading">
      <div>
        <span class="page-eyebrow">${staff ? (isAdmin() ? '课程管理' : '我的课程') : '学习任务'}</span>
        <div class="page-title-row">
          <h1>${staff ? '作业列表' : '我的作业'}</h1>
          <span class="page-badge">${filtered.length} 份</span>
          ${totalPendingGrade > 0 ? `<span class="page-badge is-live">${staff ? `待批改 ${totalPendingGrade} 份` : `待提交 ${totalPendingGrade} 份`}</span>` : ''}
        </div>
      </div>
      <div class="page-actions">
        ${staff ? `<button type="button" class="primary-button" id="hw-create-btn">＋ 布置作业</button>` : ''}
      </div>
    </div>

    <div class="filter-bar">
      <label class="filter-search"><span>搜索</span><input id="hw-search-input" type="search" placeholder="作业标题、课程或内容…" value="${esc(app.hwSearch || '')}"></label>
      <label>
        <span>课程</span>
        <select id="hw-course-filter">
          <option value="">全部课程</option>
          ${courses.map(c => `<option value="${esc(c.id)}" ${c.id === app.hwCourseFilter ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </label>
      <label>
        <span>状态</span>
        <select id="hw-status-filter">
          <option value="">全部状态</option>
          ${staff ? `
            <option value="pending" ${app.hwStatusFilter === 'pending' ? 'selected' : ''}>有待批改</option>
            <option value="done" ${app.hwStatusFilter === 'done' ? 'selected' : ''}>已全部批改</option>
          ` : `
            <option value="unsubmitted" ${app.hwStatusFilter === 'unsubmitted' ? 'selected' : ''}>待提交</option>
            <option value="submitted" ${app.hwStatusFilter === 'submitted' ? 'selected' : ''}>已提交待批改</option>
            <option value="graded" ${app.hwStatusFilter === 'graded' ? 'selected' : ''}>已批改</option>
          `}
        </select>
      </label>
    </div>

    <div id="hw-main-content" style="display:grid;gap:16px"></div>
  `;

  shell.querySelector('#hw-create-btn')?.addEventListener('click', () => {
    openHomeworkEditorModal(null, (newId) => {
      if (newId) app.hwActiveId = newId;
      updateNavCounts();
      renderHomework(shell);
    });
  });

  shell.querySelector('#hw-course-filter').addEventListener('change', (e) => {
    app.hwCourseFilter = e.target.value;
    app.hwActiveId = '';
    renderHomework(shell);
  });
  shell.querySelector('#hw-status-filter').addEventListener('change', (e) => {
    app.hwStatusFilter = e.target.value;
    renderHomework(shell);
  });
  shell.querySelector('#hw-search-input').addEventListener('input', (e) => {
    app.hwSearch = e.target.value;
    renderHomework(shell);
  });

  const mainEl = shell.querySelector('#hw-main-content');

  if (staff && activeHw) {
    // 教师作业详情 + 学生提交批改列表
    const hwSubs = subsByHw.get(activeHw.id) || [];
    const subByStudent = new Map(hwSubs.map(s => [s.student_id, s]));
    const courseEnrollments = enrolledStudentsByCourse.get(activeHw.course_id) || [];
    const pendingCnt = hwSubs.filter(s => s.status !== 'graded').length;
    const gradedCnt = hwSubs.filter(s => s.status === 'graded').length;

    // 合并所有在读学生与已提交学生（以防有学生已退班但曾提交过）
    const studentRows = [];
    const seenStu = new Set();
    for (const s of hwSubs) {
      seenStu.add(s.student_id);
      studentRows.push({ studentId: s.student_id, studentName: s.student_name, grade: s.student_grade, sub: s });
    }
    for (const e of courseEnrollments) {
      if (!seenStu.has(e.student_id)) {
        seenStu.add(e.student_id);
        studentRows.push({ studentId: e.student_id, studentName: e.student_name, grade: e.student_grade, sub: null });
      }
    }

    mainEl.innerHTML = `
      <div class="panel">
        <div class="hw-detail-head">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <button type="button" class="secondary-button btn-sm" id="hw-back-list">← 返回列表</button>
            <span class="page-badge is-accent">${esc(activeHw.course_name || '')}</span>
            <h2 style="margin:0;font-size:18px">${esc(activeHw.title)}</h2>
          </div>
          <div class="row-actions">
            <button type="button" class="secondary-button btn-sm" id="hw-edit-btn">编辑</button>
            <button type="button" class="secondary-button btn-sm danger-button" id="hw-del-btn">删除</button>
          </div>
        </div>
        <div class="hw-detail-meta">
          <span>布置人：${esc(activeHw.creator_name || '老师')}</span>
          <span>发布时间：${esc(activeHw.created_at)}</span>
          ${activeHw.due_date ? `<span>截止日期：${esc(activeHw.due_date)}</span>` : ''}
          <span>已提交 ${hwSubs.length} / ${studentRows.length} · 已批改 ${gradedCnt} · 待批改 ${pendingCnt}</span>
        </div>
        ${renderHomeworkBodyHtml(activeHw)}
        ${renderAttachmentChips(activeHw.id, activeHw.attachments)}
      </div>

      <div class="panel">
        <div class="panel-head" style="margin-bottom:10px">
          <h3>学生提交与批改 (${studentRows.length})</h3>
        </div>
        ${studentRows.length ? `
          <div class="table-wrap">
            <table class="data-table mobile-cards-table">
              <thead>
                <tr>
                  <th>学生</th>
                  <th>提交状态</th>
                  <th>作业图片</th>
                  <th>评分 / 评语</th>
                  <th>提交时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${studentRows.map(row => {
                  const s = row.sub;
                  const statusBadge = !s
                    ? `<span class="status-pill">未提交</span>`
                    : s.status === 'graded'
                      ? `<span class="status-pill is-ok">已批改</span>`
                      : `<span class="status-pill is-warn">待批改</span>`;
                  return `
                    <tr>
                      <td class="mc-title"><strong>${esc(row.studentName)}</strong>${row.grade ? `<span style="color:var(--subtle);font-size:12px;margin-left:6px">${esc(row.grade)}</span>` : ''}</td>
                      <td data-label="提交状态">${statusBadge}</td>
                      <td data-label="作业图片">
                        ${s && (s.images || []).length ? `
                          <div class="hw-mini-thumbs">
                            ${s.images.map((img, i) => `
                              <img src="${esc(hwSubmissionFileUrl(s.id, img.id))}" alt="图片${i + 1}" class="hw-mini-thumb" data-preview-img="${esc(hwSubmissionFileUrl(s.id, img.id))}" data-preview-title="${esc(row.studentName)} - 第${i + 1}页">
                            `).join('')}
                          </div>
                        ` : '<span style="color:var(--subtle)">—</span>'}
                      </td>
                      <td data-label="评分 / 评语">
                        ${s && s.status === 'graded' ? `
                          <div>${s.score ? `<strong>${esc(s.score)}</strong>` : '<span style="color:var(--subtle)">已阅</span>'}</div>
                          ${s.feedback ? `<div style="font-size:12px;color:var(--subtle);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(s.feedback)}">${esc(s.feedback)}</div>` : ''}
                        ` : '<span style="color:var(--subtle)">—</span>'}
                      </td>
                      <td data-label="提交时间" style="font-size:12px;color:var(--subtle)">${s ? esc(s.submitted_at) : '—'}</td>
                      <td class="mc-actions">
                        <div class="row-actions">${s ? `<button type="button" class="primary-button btn-sm" data-grade-sub="${esc(s.id)}">${s.status === 'graded' ? '重新批改' : '批改'}</button>` : '<span style="color:var(--subtle);font-size:12px">等待提交</span>'}</div>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        ` : `<div class="empty-state">该课程暂无在读学生</div>`}
      </div>
    `;

    bindImagePreviews(mainEl);
    mainEl.querySelector('#hw-back-list').addEventListener('click', () => {
      app.hwActiveId = '';
      renderHomework(shell);
    });
    mainEl.querySelector('#hw-edit-btn').addEventListener('click', () => {
      openHomeworkEditorModal(activeHw, () => {
        updateNavCounts();
        renderHomework(shell);
      });
    });
    mainEl.querySelector('#hw-del-btn').addEventListener('click', async () => {
      if (!confirm(`确定删除作业「${activeHw.title}」吗？所有学生提交记录也将一并删除。`)) return;
      try {
        app.state = await api(`/api/homeworks/${encodeURIComponent(activeHw.id)}`, { method: 'DELETE' });
        app.hwActiveId = '';
        showToast('作业已删除');
        updateNavCounts();
        renderHomework(shell);
      } catch (err) {
        showToast(err.message, true);
      }
    });
    mainEl.querySelectorAll('[data-grade-sub]').forEach(btn => {
      btn.addEventListener('click', () => {
        const sub = hwSubs.find(s => s.id === btn.getAttribute('data-grade-sub'));
        if (sub) {
          openTeacherGradeModal(activeHw, sub, () => {
            updateNavCounts();
            renderHomework(shell);
          });
        }
      });
    });
    return;
  }

  // 列表视图（与课程列表/资料列表一致的表格视图）
  if (!filtered.length) {
    mainEl.innerHTML = `<div class="empty-state">${staff ? '暂无作业，点击右上角「＋ 布置作业」发布第一份作业。' : '当前筛选下暂无作业。'}</div>`;
    return;
  }

  if (staff) {
    mainEl.innerHTML = `
      <div class="table-wrap">
        <table class="data-table mobile-cards-table">
          <thead>
            <tr>
              <th>作业标题</th>
              <th>所属课程</th>
              <th>形式 / 附件</th>
              <th>截止日期</th>
              <th>提交与批改</th>
              <th>发布时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map(hw => {
              const hwSubs = subsByHw.get(hw.id) || [];
              const totalStu = enrolledCountByCourse.get(hw.course_id) || 0;
              const pendingCnt = hwSubs.filter(s => s.status !== 'graded').length;
              const gradedCnt = hwSubs.filter(s => s.status === 'graded').length;
              const attCnt = (hw.attachments || []).length;
              const statusHtml = pendingCnt > 0
                ? `<span class="status-pill is-warn">待批改 ${pendingCnt} · 已交 ${hwSubs.length}${totalStu ? `/${totalStu}` : ''}</span>`
                : hwSubs.length > 0
                  ? `<span class="status-pill is-ok">已批改 ${gradedCnt}/${hwSubs.length}</span>`
                  : `<span class="status-pill">已交 0${totalStu ? `/${totalStu}` : ''}</span>`;
              return `
                <tr>
                  <td class="mc-title">
                    <button type="button" class="outline-title-link" data-open-hw="${esc(hw.id)}" style="font-weight:600">${esc(hw.title)}</button>
                    <div style="font-size:12px;color:var(--subtle);margin-top:2px">布置人：${esc(hw.creator_name || '老师')}</div>
                  </td>
                  <td data-label="所属课程"><span class="page-badge is-accent">${esc(hw.course_name || '')}</span></td>
                  <td data-label="形式 / 附件">
                    <span><span class="page-badge">${hw.content_format === 'text' ? '文字' : 'Markdown'}</span>${attCnt > 0 ? `<span style="font-size:12px;color:var(--subtle);margin-left:4px">${attCnt} 个附件</span>` : ''}</span>
                  </td>
                  <td data-label="截止日期" style="font-size:12.5px;color:var(--subtle)">${hw.due_date ? esc(hw.due_date) : '不限'}</td>
                  <td data-label="提交与批改">${statusHtml}</td>
                  <td data-label="发布时间" style="font-size:12px;color:var(--subtle)">${esc(hw.created_at)}</td>
                  <td class="mc-actions">
                    <div class="row-actions">
                      <button type="button" class="primary-button btn-sm" data-open-hw="${esc(hw.id)}">查看与批改</button>
                      <button type="button" class="secondary-button btn-sm" data-edit-hw="${esc(hw.id)}">编辑</button>
                      <button type="button" class="secondary-button btn-sm danger-button" data-del-hw="${esc(hw.id)}">删除</button>
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  } else {
    mainEl.innerHTML = `
      <div class="table-wrap">
        <table class="data-table mobile-cards-table">
          <thead>
            <tr>
              <th>作业标题</th>
              <th>所属课程</th>
              <th>截止日期</th>
              <th>状态</th>
              <th>评分 / 评语</th>
              <th>发布时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map(hw => {
              const hwSubs = subsByHw.get(hw.id) || [];
              const mySub = hwSubs[0] || null;
              const attCnt = (hw.attachments || []).length;
              const statusBadge = !mySub
                ? `<span class="status-pill is-warn">待提交</span>`
                : mySub.status === 'graded'
                  ? `<span class="status-pill is-ok">已批改</span>`
                  : `<span class="status-pill is-active">已提交 · 待批改</span>`;
              return `
                <tr>
                  <td class="mc-title">
                    <button type="button" class="outline-title-link" data-stu-hw="${esc(hw.id)}" style="font-weight:600">${esc(hw.title)}</button>
                    ${attCnt > 0 ? `<div style="font-size:12px;color:var(--subtle);margin-top:2px">含 ${attCnt} 个附件</div>` : ''}
                  </td>
                  <td data-label="所属课程"><span class="page-badge is-accent">${esc(hw.course_name || '')}</span></td>
                  <td data-label="截止日期" style="font-size:12.5px;color:var(--subtle)">${hw.due_date ? esc(hw.due_date) : '不限'}</td>
                  <td data-label="状态">${statusBadge}</td>
                  <td data-label="评分 / 评语">
                    ${mySub && mySub.status === 'graded' ? `
                      <div>${mySub.score ? `<strong>${esc(mySub.score)}</strong>` : '<span style="color:var(--subtle)">已阅</span>'}</div>
                      ${mySub.feedback ? `<div style="font-size:12px;color:var(--subtle);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(mySub.feedback)}">${esc(mySub.feedback)}</div>` : ''}
                    ` : '<span style="color:var(--subtle)">—</span>'}
                  </td>
                  <td data-label="发布时间" style="font-size:12px;color:var(--subtle)">${esc(hw.created_at)}</td>
                  <td class="mc-actions">
                    <div class="row-actions">
                      <button type="button" class="${mySub ? 'secondary-button' : 'primary-button'} btn-sm" data-stu-hw="${esc(hw.id)}">
                        ${!mySub ? '查看与提交' : (mySub.status === 'graded' ? '查看批改' : '修改提交')}
                      </button>
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  bindImagePreviews(mainEl);
  mainEl.querySelectorAll('[data-open-hw]').forEach(btn => {
    btn.addEventListener('click', () => {
      app.hwActiveId = btn.getAttribute('data-open-hw');
      renderHomework(shell);
    });
  });
  mainEl.querySelectorAll('[data-edit-hw]').forEach(btn => {
    btn.addEventListener('click', () => {
      const hw = homeworks.find(h => h.id === btn.getAttribute('data-edit-hw'));
      if (hw) {
        openHomeworkEditorModal(hw, () => {
          updateNavCounts();
          renderHomework(shell);
        });
      }
    });
  });
  mainEl.querySelectorAll('[data-del-hw]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const hw = homeworks.find(h => h.id === btn.getAttribute('data-del-hw'));
      if (!hw) return;
      if (!confirm(`确定删除作业「${hw.title}」吗？所有学生提交记录也将一并删除。`)) return;
      try {
        app.state = await api(`/api/homeworks/${encodeURIComponent(hw.id)}`, { method: 'DELETE' });
        if (app.hwActiveId === hw.id) app.hwActiveId = '';
        showToast('作业已删除');
        updateNavCounts();
        renderHomework(shell);
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
  mainEl.querySelectorAll('[data-stu-hw]').forEach(btn => {
    btn.addEventListener('click', () => {
      const hw = homeworks.find(h => h.id === btn.getAttribute('data-stu-hw'));
      if (!hw) return;
      const mySub = (subsByHw.get(hw.id) || [])[0] || null;
      openStudentSubmitModal(hw, mySub, () => {
        updateNavCounts();
        renderHomework(shell);
      });
    });
  });
}

import { esc, formatSize, showToast } from '../utils.js';
import {
  app,
  api,
  loadState,
  persistNavState,
  bindPasswordToggles,
  switchView,
  renderView
} from '../state.js';

function parseIceServersDraft(raw) {
  if (!raw || !raw.trim()) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map(item => ({
      urls: Array.isArray(item.urls) ? item.urls.join(', ') : String(item.urls || ''),
      username: String(item.username || ''),
      credential: String(item.credential || '')
    })).filter(x => x.urls);
  } catch {
    return [];
  }
}

async function probeIceConnectivity(iceServers) {
  if (typeof RTCPeerConnection === 'undefined') {
    throw new Error('当前浏览器不支持 WebRTC 检测');
  }
  const servers = iceServers.length ? iceServers : [
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'stun:stun.qq.com:3478' }
  ];
  return new Promise((resolve) => {
    const pc = new RTCPeerConnection({ iceServers: servers });
    const counts = { host: 0, srflx: 0, relay: 0 };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { pc.close(); } catch {}
      resolve(counts);
    };
    const timer = setTimeout(finish, 4000);
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) {
        clearTimeout(timer);
        finish();
        return;
      }
      const c = ev.candidate.candidate || '';
      if (c.includes(' typ relay')) counts.relay += 1;
      else if (c.includes(' typ srflx')) counts.srflx += 1;
      else if (c.includes(' typ host')) counts.host += 1;
    };
    pc.createDataChannel('probe');
    pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => {
      clearTimeout(timer);
      finish();
    });
  });
}

export function renderSettings(shell) {
  const state = app.state;
  if (!['org', 'defaults', 'data', 'ai'].includes(app.settingsTab)) app.settingsTab = 'org';
  persistNavState();
  const titleMap = { org: '机构与课堂', defaults: '教学参数', data: '数据与备份', ai: '智能助手' };
  const tabNav = `
    <div class="page-heading">
      <div><span class="page-eyebrow">系统设置</span><div class="page-title-row"><h1>${titleMap[app.settingsTab]}</h1></div></div>
    </div>
  `;

  let tabBody = '';

  if (app.settingsTab === 'org') {
    const iceRows = parseIceServersDraft(state.org.ice_servers_json || '');
    const onlineHint = app.settingsStorageStats
      ? `在线：${app.settingsStorageStats.onlineRooms} 房间 · ${app.settingsStorageStats.onlineStudents} 学生`
      : '';
    tabBody = `
      <section class="section-card">
        <div class="section-card-head"><h2>机构品牌</h2></div>
        <div class="logo-upload-row">
          <div class="logo-preview has-logo">
            <img src="${state.org.logo_stored_name ? `/api/org/logo?v=${encodeURIComponent(state.org.logo_stored_name)}` : '/public/logo.jpg'}" alt="${esc(state.org.name)}">
          </div>
          <div style="display:grid;gap:6px">
            <div style="font-size:13px;font-weight:500">机构 Logo</div>
            <div class="row-actions">
              <input type="file" id="org-logo-input" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
              <button type="button" class="secondary-button btn-sm" id="org-logo-upload-btn">上传 Logo</button>
              ${state.org.logo_stored_name ? `<button type="button" class="secondary-button btn-sm danger-button" id="org-logo-reset-btn">恢复默认</button>` : ''}
            </div>
          </div>
        </div>
      </section>

      <section class="section-card">
        <div class="section-card-head">
          <h2>机构与实时课堂并发</h2>
          ${onlineHint ? `<span class="section-summary">${esc(onlineHint)}</span>` : ''}
        </div>
        <form id="org-settings-form">
          <div class="form-grid">
            <label class="form-field"><span>机构名称 *</span><input name="name" value="${esc(state.org.name)}" required></label>
            <label class="form-field"><span>线上课堂并发上限</span><input type="number" name="maxOnlineRooms" value="${state.org.max_online_rooms}" min="1" required></label>
            <label class="form-field"><span>线上学生并发上限</span><input type="number" name="maxOnlineStudents" value="${state.org.max_online_students}" min="1" required></label>
          </div>

          <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
              <div style="font-size:13px;font-weight:500">WebRTC STUN / TURN 服务器</div>
              <div class="row-actions">
                <button type="button" class="secondary-button btn-sm" id="ice-probe-btn">检测连通性</button>
                <button type="button" class="secondary-button btn-sm" id="ice-mode-toggle-btn">${app.settingsIceAdvanced ? '切回表单模式' : 'JSON 高级模式'}</button>
              </div>
            </div>
            <div id="ice-probe-result" style="font-size:12px;color:var(--muted);margin-bottom:8px" hidden></div>

            ${app.settingsIceAdvanced ? `
              <label class="form-field">
                <textarea name="iceServersJson" id="ice-json-input" rows="3" placeholder='例如：[{"urls":"stun:stun.miwifi.com:3478"},{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]'>${esc(state.org.ice_servers_json || '')}</textarea>
              </label>
            ` : `
              <div id="ice-rows-container" style="display:grid;gap:8px;margin-bottom:8px">
                ${iceRows.map(r => `
                  <div class="ice-row" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                    <input data-ice-url value="${esc(r.urls)}" placeholder="stun: 或 turn: 地址 *" style="flex:2;min-width:200px;padding:7px 10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--control);color:var(--ink)">
                    <input data-ice-user value="${esc(r.username)}" placeholder="用户名（TURN 可选）" style="flex:1;min-width:110px;padding:7px 10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--control);color:var(--ink)">
                    <input data-ice-cred value="${esc(r.credential)}" placeholder="凭证（TURN 可选）" style="flex:1;min-width:110px;padding:7px 10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--control);color:var(--ink)">
                    <button type="button" class="secondary-button btn-sm danger-button" data-del-ice-row>移除</button>
                  </div>
                `).join('')}
              </div>
              <button type="button" class="secondary-button btn-sm" id="add-ice-row-btn">＋ 添加服务器</button>
            `}
          </div>

          <div class="form-actions" style="margin-top:14px"><button type="submit" class="primary-button">保存设置</button></div>
        </form>
      </section>
    `;
  } else if (app.settingsTab === 'defaults') {
    const defCap = state.org.default_class_capacity || 30;
    const defMin = state.org.default_lesson_minutes || 180;
    const defWm = state.org.default_watermark !== 0;
    const defDraw = Boolean(state.org.default_student_draw);
    tabBody = `
      <section class="section-card">
        <div class="section-card-head"><h2>教学默认参数</h2></div>
        <form id="org-defaults-form" style="display:grid;gap:14px">
          <div class="form-grid">
            <label class="form-field">
              <span>默认单节课时长（分钟）</span>
              <input type="number" name="defaultLessonMinutes" value="${defMin}" min="15" max="600" required>
            </label>
            <label class="form-field">
              <span>默认课程人数上限</span>
              <input type="number" name="defaultClassCapacity" value="${defCap}" min="1" max="500" required>
            </label>
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
            <input type="checkbox" name="defaultWatermark" ${defWm ? 'checked' : ''}>
            <span>教师预览和直播回放显示动态水印（学生录播始终显示播放编号）</span>
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
            <input type="checkbox" name="defaultStudentDraw" ${defDraw ? 'checked' : ''}>
            <span>实时课堂默认允许学生白板书写</span>
          </label>
          <div class="form-actions"><button type="submit" class="primary-button">保存默认值</button></div>
        </form>
      </section>
    `;
  } else if (app.settingsTab === 'ai') {
    const hasKey = Boolean(state.org?.has_deepseek_api_key);
    const maskedKey = state.org?.deepseek_api_key_masked || '';
    tabBody = `
      <section class="section-card">
        <div class="section-card-head">
          <h2>DeepSeek API Key</h2>
          <span class="status-pill ${hasKey ? 'is-ok' : 'is-warn'}">${hasKey ? `已配置 (${esc(maskedKey)})` : '未配置'}</span>
        </div>
        <form id="org-ai-form" style="display:grid;gap:14px;max-width:480px">
          <label class="form-field">
            <div class="pw-field-wrap">
              <input type="password" name="deepseekApiKey" placeholder="${hasKey ? `已保存 ${esc(maskedKey)}，输入新密钥可覆盖` : '输入 sk-... 开头的 DeepSeek API Key'}" autocomplete="off">
              <button type="button" class="pw-toggle-btn" data-toggle-pw>显示</button>
            </div>
          </label>
          <div class="row-actions" style="flex-wrap:wrap">
            <button type="submit" class="primary-button">保存</button>
            <button type="button" class="secondary-button" id="test-deepseek-key-btn">测试连接</button>
            ${hasKey ? `<button type="button" class="secondary-button danger-button" id="clear-deepseek-key-btn">清空</button>` : ''}
            <button type="button" class="secondary-button" id="goto-assistant-btn">前往智能助手</button>
          </div>
          <div id="deepseek-key-test-result" style="font-size:12px;color:var(--muted)" hidden></div>
        </form>
      </section>
    `;
  } else {
    const st = app.settingsStorageStats;
    const backups = app.settingsBackups;
    const lastBackup = st?.lastBackupAt || state.org.last_backup_at || '';
    tabBody = `
      <section class="section-card">
        <div class="section-card-head">
          <h2>备份与导出</h2>
          ${lastBackup ? `<span class="section-summary">上次备份：${esc(lastBackup)}</span>` : ''}
        </div>
        <div class="row-actions" style="flex-wrap:wrap">
          <a class="primary-button" href="/api/system/backup" id="download-backup-link" style="text-decoration:none">下载数据库 (.db)</a>
          <button type="button" class="secondary-button" id="rotate-backup-btn">本地轮转备份</button>
          <input type="file" id="verify-backup-input" accept=".db,.sqlite" hidden>
          <button type="button" class="secondary-button" id="verify-backup-btn">校验备份文件</button>
          <a class="secondary-button" href="/api/system/export?type=students" style="text-decoration:none">导出学生 (CSV)</a>
          <a class="secondary-button" href="/api/system/export?type=lessons" style="text-decoration:none">导出排课 (CSV)</a>
          <a class="secondary-button" href="/api/system/export?type=enrollments" style="text-decoration:none">导出报名 (CSV)</a>
        </div>
        <div class="item-meta">迁机须配套备份数据库和 uploads/ 里的课件、回放、作业图片，操作见项目 README 的「备份与迁机恢复」。</div>
        <div id="verify-backup-result" style="font-size:12px;color:var(--muted)" hidden></div>
        ${backups ? `
          <div style="margin-top:6px;padding-top:10px;border-top:1px solid var(--line)">
            <div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px">本地轮转备份记录（${backups.length} 份）</div>
            ${backups.length === 0 ? `<div style="font-size:12px;color:var(--subtle)">暂无本地轮转备份</div>` : `
              <div class="item-list">
                ${backups.map(b => `
                  <div class="item-row" style="padding:7px 12px">
                    <span style="font-size:12px"><strong>${esc(b.name)}</strong></span>
                    <span style="font-size:12px;color:var(--subtle)">${formatSize(b.sizeBytes)} · ${esc(b.mtime || '')}</span>
                  </div>
                `).join('')}
              </div>
            `}
          </div>
        ` : ''}
      </section>

      <section class="section-card">
        <div class="section-card-head">
          <h2>存储与清理</h2>
          <div class="row-actions">
            <button type="button" class="secondary-button btn-sm" id="refresh-storage-btn">刷新</button>
            <button type="button" class="secondary-button btn-sm danger-button" id="cleanup-system-btn">一键清理</button>
          </div>
        </div>
        ${st ? `
          <div class="stat-grid" style="margin-bottom:4px">
            <div class="stat-card"><div class="stat-label"><span>数据库</span></div><div class="stat-value" style="font-size:20px">${formatSize(st.dbBytes)}</div><div class="stat-sub">活跃 ${st.activeSessions} · 过期 ${st.expiredSessions}</div></div>
            <div class="stat-card"><div class="stat-label"><span>回放录播</span></div><div class="stat-value" style="font-size:20px">${formatSize(st.recordingsBytes + st.vodBytes)}</div><div class="stat-sub">回放 ${st.recordingsCount} · 录播 ${st.vodCount}</div></div>
            <div class="stat-card"><div class="stat-label"><span>课程资料</span></div><div class="stat-value" style="font-size:20px">${formatSize(st.materialsBytes)}</div><div class="stat-sub">${st.materialsCount} 份资料</div></div>
            <div class="stat-card"><div class="stat-label"><span>孤儿文件</span></div><div class="stat-value" style="font-size:20px">${formatSize(st.orphanBytes)}</div><div class="stat-sub">${st.orphanCount} 个无引用</div></div>
          </div>
        ` : `<div style="font-size:13px;color:var(--muted);padding:12px 0">正在统计…</div>`}
      </section>
    `;
  }

  shell.innerHTML = tabNav + tabBody;
  bindPasswordToggles(shell);

  if ((app.settingsTab === 'data' || app.settingsTab === 'org') && !app.settingsStorageStats) {
    api('/api/system/storage').then(data => {
      app.settingsStorageStats = data;
      if (app.currentView === 'settings' && (app.settingsTab === 'data' || app.settingsTab === 'org')) renderView();
    }).catch(() => {});
  }
  if (app.settingsTab === 'data' && !app.settingsBackups) {
    api('/api/system/backups').then(data => {
      app.settingsBackups = data.backups || [];
      if (app.currentView === 'settings' && app.settingsTab === 'data') renderView();
    }).catch(() => {});
  }

  if (app.settingsTab === 'org') {
    const logoInput = shell.querySelector('#org-logo-input');
    shell.querySelector('#org-logo-upload-btn').addEventListener('click', () => logoInput.click());
    logoInput.addEventListener('change', async () => {
      const file = logoInput.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) { showToast('Logo 图片不能超过 5 MB', true); logoInput.value = ''; return; }
      const btn = shell.querySelector('#org-logo-upload-btn');
      btn.disabled = true; btn.textContent = '上传中…';
      try {
        const q = new URLSearchParams({ filename: file.name });
        app.state = await api(`/api/org/logo?${q}`, {
          method: 'POST', rawBody: file, headers: { 'Content-Type': file.type || 'image/png' }
        });
        showToast('Logo 已更新');
        renderView();
      } catch (err) {
        showToast(err.message, true);
        btn.disabled = false; btn.textContent = '上传 Logo';
      }
    });

    shell.querySelector('#org-logo-reset-btn')?.addEventListener('click', async () => {
      try {
        app.state = await api('/api/org/logo', { method: 'DELETE' });
        showToast('已恢复默认 Logo');
        renderView();
      } catch (err) { showToast(err.message, true); }
    });

    function collectIceConfigFromUi() {
      if (app.settingsIceAdvanced) {
        const raw = String(shell.querySelector('#ice-json-input')?.value || '').trim();
        if (!raw) return { raw: '', list: [] };
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('ICE 配置必须是 JSON 数组');
        return { raw, list: parsed };
      }
      const list = [];
      shell.querySelectorAll('.ice-row').forEach(row => {
        const urls = row.querySelector('[data-ice-url]').value.trim();
        const username = row.querySelector('[data-ice-user]').value.trim();
        const credential = row.querySelector('[data-ice-cred]').value.trim();
        if (!urls) return;
        const entry = { urls };
        if (username) entry.username = username;
        if (credential) entry.credential = credential;
        list.push(entry);
      });
      return { raw: list.length ? JSON.stringify(list) : '', list };
    }

    const bindDelIceRows = () => {
      shell.querySelectorAll('[data-del-ice-row]').forEach(btn => {
        btn.onclick = () => btn.closest('.ice-row')?.remove();
      });
    };
    bindDelIceRows();

    shell.querySelector('#add-ice-row-btn')?.addEventListener('click', () => {
      const wrap = shell.querySelector('#ice-rows-container');
      const row = document.createElement('div');
      row.className = 'ice-row';
      row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center';
      row.innerHTML = `
        <input data-ice-url placeholder="stun: 或 turn: 地址 *" style="flex:2;min-width:200px;padding:7px 10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--control);color:var(--ink)">
        <input data-ice-user placeholder="用户名（TURN 可选）" style="flex:1;min-width:110px;padding:7px 10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--control);color:var(--ink)">
        <input data-ice-cred placeholder="凭证（TURN 可选）" style="flex:1;min-width:110px;padding:7px 10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--control);color:var(--ink)">
        <button type="button" class="secondary-button btn-sm danger-button" data-del-ice-row>移除</button>
      `;
      wrap.append(row);
      bindDelIceRows();
    });

    shell.querySelector('#ice-mode-toggle-btn').addEventListener('click', () => {
      app.settingsIceAdvanced = !app.settingsIceAdvanced;
      renderView();
    });

    shell.querySelector('#ice-probe-btn').addEventListener('click', async () => {
      const btn = shell.querySelector('#ice-probe-btn');
      const out = shell.querySelector('#ice-probe-result');
      btn.disabled = true; btn.textContent = '检测中…';
      out.hidden = false; out.textContent = '正在采集 WebRTC ICE 候选地址（最多 4 秒）…';
      try {
        const { list } = collectIceConfigFromUi();
        const res = await probeIceConnectivity(list);
        const parts = [`本地 host: ${res.host}`, `公网反射 srflx: ${res.srflx}`, `中继 relay: ${res.relay}`];
        out.textContent = `检测完成 — ${parts.join(' · ')}${res.srflx > 0 || res.relay > 0 ? '（网络穿透正常）' : '（未获取到公网候选，请检查网络或 TURN 配置）'}`;
      } catch (err) { out.textContent = `检测失败：${err.message}`; }
      finally { btn.disabled = false; btn.textContent = '检测连通性'; }
    });

    shell.querySelector('#org-settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const fd = new FormData(e.target);
        const { raw } = collectIceConfigFromUi();
        app.state = await api('/api/org', {
          method: 'PUT',
          body: {
            name: fd.get('name'),
            maxOnlineRooms: Number(fd.get('maxOnlineRooms')),
            maxOnlineStudents: Number(fd.get('maxOnlineStudents')),
            iceServersJson: raw
          }
        });
        showToast('机构与课堂设置已保存');
        renderView();
      } catch (err) { showToast(err.message, true); }
    });
  }

  if (app.settingsTab === 'defaults') {
    shell.querySelector('#org-defaults-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const fd = new FormData(e.target);
        app.state = await api('/api/org', {
          method: 'PUT',
          body: {
            defaultLessonMinutes: Number(fd.get('defaultLessonMinutes')),
            defaultClassCapacity: Number(fd.get('defaultClassCapacity')),
            defaultWatermark: fd.get('defaultWatermark') === 'on',
            defaultStudentDraw: fd.get('defaultStudentDraw') === 'on'
          }
        });
        showToast('教学默认值已保存');
        renderView();
      } catch (err) { showToast(err.message, true); }
    });
  }

  if (app.settingsTab === 'data') {
    shell.querySelector('#download-backup-link').addEventListener('click', () => {
      setTimeout(() => { app.settingsStorageStats = null; loadState(); }, 1200);
    });
    shell.querySelector('#rotate-backup-btn').addEventListener('click', async () => {
      try {
        const res = await api('/api/system/backups', { method: 'POST' });
        app.settingsBackups = null;
        showToast(`已生成本地备份 ${res.created}（当前保留 ${res.totalBackups} 份）`);
        renderView();
      } catch (err) { showToast(err.message, true); }
    });
    const verifyInp = shell.querySelector('#verify-backup-input');
    const verifyBtn = shell.querySelector('#verify-backup-btn');
    const verifyResEl = shell.querySelector('#verify-backup-result');
    verifyBtn?.addEventListener('click', () => verifyInp.click());
    verifyInp?.addEventListener('change', async () => {
      const file = verifyInp.files[0];
      verifyInp.value = '';
      if (!file) return;
      verifyBtn.disabled = true; verifyBtn.textContent = '校验中…';
      verifyResEl.hidden = false; verifyResEl.style.color = 'var(--muted)';
      verifyResEl.textContent = `正在校验 ${file.name}…`;
      try {
        const res = await api('/api/system/backup/verify', {
          method: 'POST', rawBody: file, headers: { 'Content-Type': 'application/octet-stream' }
        });
        verifyResEl.style.color = res.ok ? 'var(--ok)' : 'var(--danger)';
        verifyResEl.textContent = res.ok
          ? `校验通过：包含 ${res.tableCount || 0} 张表，完整性检查正常`
          : `校验未通过：${res.error || '文件损坏或非有效备份'}`;
      } catch (err) {
        verifyResEl.style.color = 'var(--danger)';
        verifyResEl.textContent = `校验失败：${err.message}`;
      } finally {
        verifyBtn.disabled = false; verifyBtn.textContent = '校验备份文件';
      }
    });
    shell.querySelector('#refresh-storage-btn').addEventListener('click', async () => {
      try {
        app.settingsStorageStats = await api('/api/system/storage');
        showToast('存储统计已刷新');
        renderView();
      } catch (err) { showToast(err.message, true); }
    });
    shell.querySelector('#cleanup-system-btn').addEventListener('click', async () => {
      if (!confirm('确认清理所有过期登录会话与无引用的孤儿上传文件？')) return;
      try {
        const res = await api('/api/system/cleanup', { method: 'POST' });
        app.settingsStorageStats = res.stats;
        const { removedOrphans, freedBytes, removedSessions } = res.result;
        showToast(`清理完成：删除 ${removedOrphans} 个孤儿文件（释放 ${formatSize(freedBytes)}），清理 ${removedSessions} 个过期会话`);
        renderView();
      } catch (err) { showToast(err.message, true); }
    });
  }

  if (app.settingsTab === 'ai') {
    shell.querySelector('#org-ai-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const keyVal = String(fd.get('deepseekApiKey') || '').trim();
      if (!keyVal) { showToast('请输入有效的 DeepSeek API Key，如需清空请点击“清空”', true); return; }
      try {
        app.state = await api('/api/org', { method: 'PUT', body: { deepseekApiKey: keyVal } });
        showToast('DeepSeek API Key 已保存并同步至智能助手');
        renderView();
      } catch (err) { showToast(err.message, true); }
    });
    shell.querySelector('#clear-deepseek-key-btn')?.addEventListener('click', async () => {
      if (!confirm('确认清空已保存的 DeepSeek API Key？')) return;
      try {
        app.state = await api('/api/org', { method: 'PUT', body: { deepseekApiKey: '' } });
        showToast('已清空 DeepSeek API Key');
        renderView();
      } catch (err) { showToast(err.message, true); }
    });
    shell.querySelector('#test-deepseek-key-btn')?.addEventListener('click', async () => {
      const btn = shell.querySelector('#test-deepseek-key-btn');
      const resultEl = shell.querySelector('#deepseek-key-test-result');
      const inputVal = String(shell.querySelector('#org-ai-form input[name="deepseekApiKey"]')?.value || '').trim();
      btn.disabled = true; btn.textContent = '测试中…';
      if (resultEl) { resultEl.hidden = false; resultEl.style.color = 'var(--muted)'; resultEl.textContent = '正在连接 DeepSeek API…'; }
      try {
        const res = await api('/api/assistant/test-key', { method: 'POST', body: inputVal ? { apiKey: inputVal } : {} });
        if (resultEl) {
          resultEl.style.color = res.ok ? 'var(--ok)' : 'var(--danger)';
          resultEl.textContent = res.ok
            ? `连接成功（可用模型：${(res.models || []).slice(0, 4).join(', ') || 'deepseek-chat'}）`
            : `连接失败：${res.error || '请检查密钥'}`;
        }
      } catch (err) {
        if (resultEl) { resultEl.style.color = 'var(--danger)'; resultEl.textContent = `连接失败：${err.message}`; }
      } finally {
        btn.disabled = false; btn.textContent = '测试连接';
      }
    });
    shell.querySelector('#goto-assistant-btn').addEventListener('click', () => switchView('assistant'));
  }
}

export function esc(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

export function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

export function toLocalDatetime(ms) {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

export function nextWholeHourMs(offsetHours = 1) {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + offsetHours);
  return d.getTime();
}

export function formatLessonTime(startMs, endMs) {
  const d = new Date(startMs).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' });
  const s = new Date(startMs).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const e = new Date(endMs).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return `${d} ${s}–${e}`;
}

export function showToast(text, isError = false) {
  const el = document.querySelector('#toast');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-error', Boolean(isError));
  el.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.classList.remove('show'), isError ? 3400 : 2400);
}

export function openModal(title, html) {
  const modal = document.querySelector('#modal');
  const titleEl = document.querySelector('#modal-title');
  const bodyEl = document.querySelector('#modal-body');
  if (!modal || !titleEl || !bodyEl) return null;
  titleEl.textContent = title || '详情';
  bodyEl.innerHTML = html || '';
  if (!modal.open) modal.showModal();
  return bodyEl;
}

export function closeModal() {
  const modal = document.querySelector('#modal');
  if (modal && modal.open) modal.close();
}

export function uploadFileWithProgress(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && typeof onProgress === 'function') {
        onProgress(Math.round((ev.loaded / ev.total) * 100), ev.loaded, ev.total);
      }
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
      } else {
        reject(new Error(data.error || `上传失败 (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('网络错误，上传中断'));
    xhr.send(file);
  });
}

function renderLatexMath(expr, displayMode = false) {
  const clean = String(expr || '').trim();
  if (!clean) return '';
  if (typeof window !== 'undefined' && window.katex && typeof window.katex.renderToString === 'function') {
    try {
      return window.katex.renderToString(clean, { displayMode, throwOnError: false });
    } catch {}
  }
  return esc(displayMode ? `$$${clean}$$` : `$${clean}$`);
}

function formatInlineMarkdown(raw) {
  const tokens = [];
  const stash = (html) => {
    const idx = tokens.length;
    tokens.push(html);
    return `\x00MDTOK${idx}\x00`;
  };

  let s = String(raw || '');
  // 先保护行内代码，避免其中的 $ 被当成公式
  s = s.replace(/`([^`]+)`/g, (_, code) => stash(`<code>${esc(code)}</code>`));
  // 块级公式（单行内 $$...$$ 或 \[...\]）
  s = s.replace(/\$\$([^$]+)\$\$/g, (_, expr) => stash(renderLatexMath(expr, true)));
  s = s.replace(/\\\[(.+?)\\\]/g, (_, expr) => stash(renderLatexMath(expr, true)));
  // 行内公式 \(...\) 与 $...$
  s = s.replace(/\\\((.+?)\\\)/g, (_, expr) => stash(renderLatexMath(expr, false)));
  s = s.replace(/(^|[^\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$/g, (_, pre, expr) => `${pre}${stash(renderLatexMath(expr, false))}`);

  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\x00MDTOK(\d+)\x00/g, (_, idx) => tokens[Number(idx)] || '');
  return s;
}

export function renderMarkdown(rawText) {
  const lines = String(rawText || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(esc(lines[i]));
        i++;
      }
      i++;
      out.push(`<pre class="md-pre"><code>${codeLines.join('\n')}</code></pre>`);
      continue;
    }
    if (line.trim() === '$$' || line.trim() === '\\[') {
      const endTag = line.trim() === '$$' ? '$$' : '\\]';
      const mathLines = [];
      i++;
      while (i < lines.length && lines[i].trim() !== endTag) {
        mathLines.push(lines[i]);
        i++;
      }
      i++;
      out.push(`<div class="md-math-block">${renderLatexMath(mathLines.join('\n'), true)}</div>`);
      continue;
    }
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|/.test(lines[i + 1])) {
      const parseCells = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => formatInlineMarkdown(c.trim()));
      const headers = parseCells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(parseCells(lines[i]));
        i++;
      }
      out.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      const level = Math.min(4, hMatch[1].length + 1);
      out.push(`<h${level} class="md-h">${formatInlineMarkdown(hMatch[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(formatInlineMarkdown(lines[i].replace(/^\s*>\s?/, '')));
        i++;
      }
      out.push(`<blockquote class="md-quote">${quoteLines.join('<br>')}</blockquote>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li>${formatInlineMarkdown(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul class="md-ul">${items.join('')}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${formatInlineMarkdown(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ol class="md-ol">${items.join('')}</ol>`);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    out.push(`<p class="md-p">${formatInlineMarkdown(line)}</p>`);
    i++;
  }
  return out.join('');
}

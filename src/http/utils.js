import fs from 'node:fs';
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.svg': 'image/svg+xml'
};

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function isSecureRequest(req) {
  if (req?.socket?.encrypted) return true;
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

export function setSessionCookie(res, token, req = null) {
  const maxAge = token ? 7 * 24 * 3600 : 0;
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `wb_session=${encodeURIComponent(token || '')}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`
  );
}

export function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
}

export async function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  const contentLen = Number(req.headers['content-length']);
  if (Number.isFinite(contentLen) && contentLen > maxBytes) {
    const err = new Error('JSON 请求体超过上限');
    err.statusCode = 413;
    throw err;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error('JSON 请求体超过上限');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export function sendJson(res, status, payload, req = null) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const acceptEnc = String(req?.headers?.['accept-encoding'] || '');
  if (body.length > 1024 && /\bgzip\b/i.test(acceptEnc)) {
    const compressed = zlib.gzipSync(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Vary': 'Accept-Encoding',
      'Content-Length': compressed.length
    });
    res.end(compressed);
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length
  });
  res.end(body);
}

export async function sendStaticFile(req, res, filePath, contentType, { cacheControl = 'no-cache' } = {}) {
  const stat = await fsp.stat(filePath);
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  applySecurityHeaders(res);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', cacheControl);
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }
  const raw = await fsp.readFile(filePath);
  const acceptEnc = String(req.headers['accept-encoding'] || '');
  if (raw.length > 1024 && /\bgzip\b/i.test(acceptEnc)) {
    const compressed = zlib.gzipSync(raw);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Encoding': 'gzip',
      'Vary': 'Accept-Encoding',
      'Content-Length': compressed.length
    });
    res.end(compressed);
    return;
  }
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': raw.length
  });
  res.end(raw);
}

export async function streamRequestToFile(req, diskPath, { maxBytes, emptyError = '上传文件为空', limitError = '上传文件超过大小限制' } = {}) {
  const contentLen = Number(req.headers['content-length']);
  if (maxBytes && Number.isFinite(contentLen) && contentLen > maxBytes) {
    const err = new Error(limitError);
    err.statusCode = 413;
    throw err;
  }
  let total = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length;
      if (maxBytes && total > maxBytes) {
        const err = new Error(limitError);
        err.statusCode = 413;
        cb(err);
        return;
      }
      cb(null, chunk);
    }
  });
  try {
    await pipeline(req, counter, fs.createWriteStream(diskPath));
  } catch (err) {
    await fsp.unlink(diskPath).catch(() => {});
    throw err;
  }
  if (total === 0) {
    await fsp.unlink(diskPath).catch(() => {});
    throw new TypeError(emptyError);
  }
  return total;
}

export function createLoginRateLimiter({ windowMs = 5 * 60 * 1000, maxAttempts = 15 } = {}) {
  const attempts = new Map();
  function keyFor(req, username) {
    const ip = String(req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || 'local').split(',')[0].trim();
    return `${ip}:${String(username || '').trim().toLowerCase()}`;
  }
  function check(req, username) {
    const key = keyFor(req, username);
    const now = Date.now();
    const list = (attempts.get(key) || []).filter(ts => now - ts < windowMs);
    if (list.length >= maxAttempts) {
      const err = new Error('登录尝试过于频繁，请 5 分钟后再试');
      err.statusCode = 429;
      throw err;
    }
    attempts.set(key, list);
  }
  function recordFailure(req, username) {
    const key = keyFor(req, username);
    const now = Date.now();
    const list = (attempts.get(key) || []).filter(ts => now - ts < windowMs);
    list.push(now);
    attempts.set(key, list);
  }
  function clear(req, username) {
    attempts.delete(keyFor(req, username));
  }
  return { check, recordFailure, clear };
}

export function requireAuth(session) {
  if (!session) {
    const err = new Error('请先登录');
    err.statusCode = 401;
    throw err;
  }
  return session;
}

export function requireAdmin(session) {
  requireAuth(session);
  if (session.role !== 'admin') {
    const err = new Error('仅管理员有权限执行此操作');
    err.statusCode = 403;
    throw err;
  }
  return session;
}

export function requireTeacher(session) {
  requireAuth(session);
  if (session.role !== 'admin' && session.role !== 'teacher') {
    const err = new Error('仅教师或管理员有权限执行此操作');
    err.statusCode = 403;
    throw err;
  }
  return session;
}

const SAFE_INLINE_MIMES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/wav',
  'audio/webm'
]);

export async function streamMediaFile(req, res, diskPath, mimeType, filename, download = false, {
  noStore = false, sandboxInline = false, checkAccess
} = {}) {
  let stat;
  try {
    stat = await fsp.stat(diskPath);
  } catch {
    return sendJson(res, 404, { error: '媒体文件不存在或已被清理' });
  }
  const total = stat.size;
  const cleanMime = String(mimeType || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  const forceDownload = download || (sandboxInline && !SAFE_INLINE_MIMES.has(cleanMime));
  const disposition = `${forceDownload ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename)}`;
  const range = req.headers.range;
  const extraHeaders = {
    'X-Content-Type-Options': 'nosniff',
    ...(noStore ? { 'Cache-Control': 'no-store, private' } : {}),
    ...(sandboxInline && !forceDownload ? { 'Content-Security-Policy': 'sandbox' } : {})
  };
  function pipeFile(options) {
    if (res.destroyed) return;
    const stream = fs.createReadStream(diskPath, options);
    const accessTimer = checkAccess && setInterval(() => {
      try {
        if (checkAccess()) return;
      } catch {}
      res.destroy();
    }, 15000);
    accessTimer?.unref();
    res.once('close', () => {
      clearInterval(accessTimer);
      stream.destroy();
    });
    stream.once('error', err => res.destroy(err));
    stream.pipe(res);
  }

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (!match || (match[1] === '' && match[2] === '')) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    let start;
    let end;
    if (match[1] === '') {
      const suffix = parseInt(match[2], 10);
      if (!Number.isFinite(suffix) || suffix <= 0) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
      start = Math.max(0, total - suffix);
      end = total - 1;
    } else {
      start = parseInt(match[1], 10);
      end = match[2] ? parseInt(match[2], 10) : total - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= total || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    end = Math.min(end, total - 1);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': mimeType || 'application/octet-stream',
      'Content-Disposition': disposition,
      ...extraHeaders
    });
    pipeFile({ start, end });
  } else {
    res.writeHead(200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': total,
      'Content-Type': mimeType || 'application/octet-stream',
      'Content-Disposition': disposition,
      ...extraHeaders
    });
    pipeFile();
  }
}

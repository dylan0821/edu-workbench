import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { openWorkbenchDb } from './db.js';
import { DEFAULT_DATA_DIR, getActiveData } from './data-dir.js';
import { createDshManager, testDeepseekApiKey } from './dsh-manager.js';
import { createWorkbenchMcpHandler } from './mcp.js';
import {
  MIME_TYPES,
  parseCookies,
  setSessionCookie,
  applySecurityHeaders,
  readJsonBody,
  sendJson as sendJsonBase,
  sendStaticFile,
  streamRequestToFile,
  createLoginRateLimiter,
  requireAuth,
  requireAdmin,
  requireTeacher,
  streamMediaFile
} from './http/utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = path.join(DEFAULT_DATA_DIR, 'workbench.db');
const DEFAULT_UPLOAD_DIR = path.join(DEFAULT_DATA_DIR, 'uploads');
const VOD_PERMIT_TTL_MS = 10 * 60 * 1000;

export function createServer({ dbPath = DEFAULT_DB_PATH, uploadDir = DEFAULT_UPLOAD_DIR, dataInstance = 'original' } = {}) {
  fs.mkdirSync(uploadDir, { recursive: true });
  const backupDir = path.join(path.dirname(dbPath), 'backups');
  const store = openWorkbenchDb(dbPath);
  const loginLimiter = createLoginRateLimiter({ windowMs: 5 * 60 * 1000, maxAttempts: 15 });
  const internalMcpToken = crypto.randomBytes(24).toString('hex');
  const vodPermits = new Map();
  const vodPermitCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, permit] of vodPermits) {
      if (permit.expiresAt <= now) vodPermits.delete(key);
    }
  }, VOD_PERMIT_TTL_MS);
  vodPermitCleanup.unref();
  let lastAssistantMutationAt = 0;

  let server;
  let dshManager;
  const mcpHandler = createWorkbenchMcpHandler({
    store,
    onMutate: () => {
      lastAssistantMutationAt = Date.now();
      dshManager?.broadcast({ type: 'workbench_mutated', at: lastAssistantMutationAt });
    }
  });
  dshManager = createDshManager({
    dshHomeDir: path.join(path.dirname(dbPath), 'dsh-home'),
    store,
    getApiKey: () => store.getDeepseekApiKey(),
    getMcpEndpoint: () => {
      const addr = server?.address();
      const port = typeof addr === 'object' && addr ? addr.port : (Number(process.env.PORT) || 3000);
      return {
        url: `http://127.0.0.1:${port}/api/internal/mcp`,
        token: internalMcpToken
      };
    }
  });

  // 正在进行或中断待恢复的流式分片录制会话: recId -> { lessonId, title, filename, storedName, mimeType, diskPath, chunkDir, receivedSeqs, startedAt, lastActivityAt, status }
  const activeRecordings = new Map();

  // 启动时从数据库恢复尚未归档的持久化录制会话，并仅清理无数据库记录的真正孤儿分片目录
  try {
    store.markAllRecordingSessionsInterrupted();
    for (const row of store.listRecordingSessions()) {
      const chunkDir = path.join(uploadDir, `.chunks_${row.id}`);
      if (!fs.existsSync(chunkDir)) {
        store.deleteRecordingSession(row.id);
        continue;
      }
      const receivedSeqs = new Map();
      for (const entry of fs.readdirSync(chunkDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const m = entry.name.match(/^chunk_(\d+)\.part$/);
        if (!m) continue;
        const seq = Number(m[1]);
        const st = fs.statSync(path.join(chunkDir, entry.name));
        if (st.size > 0) receivedSeqs.set(seq, st.size);
      }
      store.updateRecordingSessionSeq(row.id, receivedSeqs, row.last_activity_at, 'interrupted');
      activeRecordings.set(row.id, {
        lessonId: row.lesson_id,
        title: row.title,
        filename: row.filename,
        storedName: row.stored_name,
        mimeType: row.mime_type,
        diskPath: path.join(uploadDir, row.stored_name),
        chunkDir,
        receivedSeqs,
        startedAt: row.started_at,
        lastActivityAt: row.last_activity_at,
        status: 'interrupted'
      });
    }
    for (const entry of fs.readdirSync(uploadDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('.chunks_')) {
        const recId = entry.name.slice('.chunks_'.length);
        if (!activeRecordings.has(recId)) {
          fs.rmSync(path.join(uploadDir, entry.name), { recursive: true, force: true });
        }
      }
    }
  } catch {}

  const STALE_REC_MS = 72 * 60 * 60 * 1000;
  const recCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [recId, recSession] of activeRecordings.entries()) {
      if (now - (recSession.lastActivityAt || recSession.startedAt) > STALE_REC_MS) {
        activeRecordings.delete(recId);
        store.deleteRecordingSession(recId);
        fsp.rm(recSession.chunkDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }, 30 * 60 * 1000);
  recCleanupTimer.unref?.();

  // 实时课堂房间连接池
  const liveRooms = new Map();

  function getRoom(lessonId) {
    if (!liveRooms.has(lessonId)) {
      const wb = store.getLessonWhiteboard(lessonId);
      const org = store.db.prepare('SELECT default_student_draw FROM org_settings LIMIT 1').get();
      liveRooms.set(lessonId, {
        clients: new Map(),
        whiteboard: wb,
        wbSaveTimer: null,
        allowStudentDraw: Boolean(org?.default_student_draw),
        chat: store.listClassroomMessages(lessonId, 100),
        sharingClientId: null,
        sharingStreamId: ''
      });
    }
    return liveRooms.get(lessonId);
  }

  function flushWhiteboard(lessonId) {
    const room = liveRooms.get(lessonId);
    if (!room) return;
    if (room.wbSaveTimer) {
      clearTimeout(room.wbSaveTimer);
      room.wbSaveTimer = null;
    }
    try { store.saveLessonWhiteboard(lessonId, room.whiteboard); } catch {}
  }

  function scheduleWhiteboardSave(lessonId) {
    const room = liveRooms.get(lessonId);
    if (!room) return;
    if (room.wbSaveTimer) clearTimeout(room.wbSaveTimer);
    room.wbSaveTimer = setTimeout(() => {
      room.wbSaveTimer = null;
      try { store.saveLessonWhiteboard(lessonId, room.whiteboard); } catch {}
    }, 800);
    room.wbSaveTimer.unref?.();
  }

  function broadcastRoom(lessonId, event, data, excludeClientId = null) {
    const room = liveRooms.get(lessonId);
    if (!room) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [cid, client] of room.clients.entries()) {
      if (cid === excludeClientId) continue;
      try { client.res.write(payload); } catch {}
    }
  }

  // 课程群实时 SSE 连接池
  const qaClients = new Map();

  function canSessionAccessCourse(session, courseId) {
    if (!session || !courseId) return false;
    if (session.role === 'admin') return true;
    if (session.role === 'teacher') return store.canTeacherAccessCourse(session.linkedId, courseId);
    if (session.role === 'student') return store.canStudentAccessCourse(session.linkedId, courseId);
    return false;
  }

  function broadcastQa(courseId, event, data) {
    if (!courseId || qaClients.size === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of qaClients.values()) {
      if (!canSessionAccessCourse(client.session, courseId)) continue;
      try { client.res.write(payload); } catch {}
    }
  }

  function getRoomRoster(room) {
    return [...room.clients.entries()].map(([clientId, c]) => ({
      clientId,
      name: c.name,
      role: c.role,
      handRaised: c.handRaised,
      handRaisedAt: c.handRaisedAt || null,
      handMode: c.handMode || 'audio',
      micAllowed: c.micAllowed,
      camAllowed: Boolean(c.camAllowed),
      camActive: Boolean(c.camActive),
      camStreamId: c.camStreamId || '',
      linkMode: c.linkMode || null,
      micMuted: Boolean(c.micMuted),
      drawAllowed: Boolean(c.drawAllowed)
    }));
  }

  function unlinkStoredFiles(storedNames) {
    if (!Array.isArray(storedNames) || !storedNames.length) return Promise.resolve();
    return Promise.all(
      storedNames.filter(Boolean).map(name => fsp.unlink(path.join(uploadDir, name)).catch(() => {}))
    );
  }

  server = http.createServer(async (req, res) => {
    const sendJson = (r, status, payload) => sendJsonBase(r, status, payload, req);
    try {
      applySecurityHeaders(res);
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = decodeURIComponent(url.pathname);
      const method = req.method || 'GET';

      const cookies = parseCookies(req);
      const session = store.getSession(cookies.wb_session);

      // --- 0.5 内部 MCP 服务（供 DeepSeek Harness 调用教务工作台能力） ---
      if (pathname === '/api/internal/mcp') {
        const authHeader = String(req.headers.authorization || '');
        if (authHeader !== `Bearer ${internalMcpToken}`) {
          return sendJson(res, 401, { error: 'Unauthorized MCP request' });
        }
        await mcpHandler(req, res);
        return;
      }

      // --- 1. 认证、初始化管理员与按角色隔离的状态快照 ---
      if (pathname === '/api/state' && method === 'GET') {
        return sendJson(res, 200, { ...store.getSnapshotForUser(session), dataInstance });
      }

      if (pathname === '/api/setup' && method === 'POST') {
        const body = await readJsonBody(req);
        const created = store.setupInitialAdmin(body);
        setSessionCookie(res, created.token, req);
        const newSession = store.getSession(created.token);
        return sendJson(res, 201, store.getSnapshotForUser(newSession));
      }

      if (pathname === '/api/login' && method === 'POST') {
        const body = await readJsonBody(req);
        loginLimiter.check(req, body?.username);
        let created;
        try {
          created = store.verifyLogin(body);
        } catch (err) {
          loginLimiter.recordFailure(req, body?.username);
          throw err;
        }
        loginLimiter.clear(req, body?.username);
        setSessionCookie(res, created.token, req);
        const newSession = store.getSession(created.token);
        return sendJson(res, 200, store.getSnapshotForUser(newSession));
      }

      if (pathname === '/api/logout' && method === 'POST') {
        if (session) store.deleteSession(session.token);
        setSessionCookie(res, '', req);
        return sendJson(res, 200, store.getSnapshotForUser(null));
      }

      if (pathname === '/api/auth/password' && method === 'POST') {
        requireAuth(session);
        const body = await readJsonBody(req);
        store.changeOwnPassword(session.accountId, session.token, body);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/auth/profile' && method === 'PUT') {
        requireAuth(session);
        const body = await readJsonBody(req);
        store.updateOwnProfile(session, body);
        const refreshed = store.getSession(session.token);
        return sendJson(res, 200, store.getSnapshotForUser(refreshed));
      }

      // --- 2. 机构设置与账号管理（仅管理员） ---
      if (pathname === '/api/org' && method === 'PUT') {
        requireAdmin(session);
        const body = await readJsonBody(req);
        store.updateOrgSettings(body);
        if (body.deepseekApiKey !== undefined) {
          await dshManager.syncCredentialsFile(store.getDeepseekApiKey());
        }
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      // --- 2.1 DeepSeek Harness 智能助手对话与控制（仅管理员） ---
      if (pathname === '/api/assistant/status' && method === 'GET') {
        requireAdmin(session);
        return sendJson(res, 200, { ...dshManager.getStatus(), lastMutationAt: lastAssistantMutationAt });
      }

      if (pathname === '/api/assistant/test-key' && method === 'POST') {
        requireAdmin(session);
        const body = await readJsonBody(req).catch(() => ({}));
        const key = body.apiKey !== undefined ? String(body.apiKey || '').trim() : store.getDeepseekApiKey();
        const result = await testDeepseekApiKey(key);
        return sendJson(res, 200, result);
      }

      if (pathname === '/api/assistant/start' && method === 'POST') {
        requireAdmin(session);
        const body = await readJsonBody(req).catch(() => ({}));
        const status = await dshManager.ensureStarted({ model: body.model, reasoningEffort: body.reasoningEffort });
        return sendJson(res, 200, { ...status, lastMutationAt: lastAssistantMutationAt });
      }

      if (pathname === '/api/assistant/restart' && method === 'POST') {
        requireAdmin(session);
        const body = await readJsonBody(req).catch(() => ({}));
        await dshManager.stop();
        const status = await dshManager.ensureStarted({ model: body.model, reasoningEffort: body.reasoningEffort });
        return sendJson(res, 200, { ...status, lastMutationAt: lastAssistantMutationAt });
      }

      if (pathname === '/api/assistant/upload' && method === 'POST') {
        requireAdmin(session);
        const rawName = path.basename(String(url.searchParams.get('filename') || 'file.bin')).slice(0, 120) || 'file.bin';
        const safeBase = rawName.replace(/[^A-Za-z0-9._\-\u4e00-\u9fa5]/g, '_');
        const storedName = `${Date.now()}_${crypto.randomUUID().slice(0, 6)}_${safeBase}`;
        const uploadsDir = dshManager.getStatus().uploadsDir;
        fs.mkdirSync(uploadsDir, { recursive: true });
        const diskPath = path.join(uploadsDir, storedName);
        const mimeType = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase();
        const size = await streamRequestToFile(req, diskPath, {
          maxBytes: 20 * 1024 * 1024,
          emptyError: '上传文件为空',
          limitError: '单个文件不能超过 20 MB'
        });
        const isImage = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType);
        return sendJson(res, 201, {
          name: rawName,
          storedName,
          relativePath: `uploads/${storedName}`,
          mimeType,
          size,
          isImage
        });
      }

      if (pathname === '/api/assistant/stop' && method === 'POST') {
        requireAdmin(session);
        await dshManager.stop();
        return sendJson(res, 200, { ...dshManager.getStatus(), lastMutationAt: lastAssistantMutationAt });
      }

      if (pathname === '/api/assistant/stream' && method === 'GET') {
        requireAdmin(session);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        res.write(': connected\n\n');
        const heartbeat = setInterval(() => {
          try { res.write(': ping\n\n'); } catch {}
        }, 25000);
        const unsub = dshManager.subscribe(ev => {
          try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {}
        });
        req.on('close', () => {
          clearInterval(heartbeat);
          unsub();
        });
        return;
      }

      if (pathname === '/api/assistant/conversations' && method === 'GET') {
        requireAdmin(session);
        return sendJson(res, 200, { conversations: store.listAssistantConversations() });
      }

      if (pathname === '/api/assistant/conversations' && method === 'POST') {
        requireAdmin(session);
        const body = await readJsonBody(req).catch(() => ({}));
        const conversation = store.createAssistantConversation(body);
        return sendJson(res, 201, { conversation });
      }

      const convMsgMatch = pathname.match(/^\/api\/assistant\/conversations\/([^/]+)\/messages$/);
      if (convMsgMatch && method === 'GET') {
        requireAdmin(session);
        const conv = store.getAssistantConversation(convMsgMatch[1]);
        if (!conv) return sendJson(res, 404, { error: '对话不存在' });
        return sendJson(res, 200, { conversation: conv, messages: store.listAssistantMessages(conv.id) });
      }

      if (convMsgMatch && method === 'POST') {
        requireAdmin(session);
        const body = await readJsonBody(req);
        const receipt = await dshManager.sendPrompt({
          conversationId: convMsgMatch[1],
          text: body.text,
          model: body.model,
          reasoningEffort: body.reasoningEffort,
          attachments: body.attachments
        });
        return sendJson(res, 201, {
          ...receipt,
          conversation: store.getAssistantConversation(convMsgMatch[1]),
          messages: store.listAssistantMessages(convMsgMatch[1])
        });
      }

      const convMatch = pathname.match(/^\/api\/assistant\/conversations\/([^/]+)$/);
      if (convMatch && method === 'PATCH') {
        requireAdmin(session);
        const body = await readJsonBody(req);
        const conversation = store.updateAssistantConversation(convMatch[1], body);
        return sendJson(res, 200, { conversation });
      }

      if (convMatch && method === 'DELETE') {
        requireAdmin(session);
        store.deleteAssistantConversation(convMatch[1]);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/org/logo' && method === 'GET') {
        const logo = store.getOrgLogo();
        if (!logo?.logo_stored_name) return sendJson(res, 404, { error: '未设置机构 Logo' });
        const diskPath = path.join(uploadDir, logo.logo_stored_name);
        if (!fs.existsSync(diskPath)) return sendJson(res, 404, { error: 'Logo 文件不存在' });
        res.setHeader('X-Content-Type-Options', 'nosniff');
        await streamMediaFile(req, res, diskPath, logo.logo_mime_type || 'image/png', logo.logo_stored_name, false);
        return;
      }

      if (pathname === '/api/org/logo' && method === 'POST') {
        requireAdmin(session);
        const mimeType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        const allowedLogoMimes = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
        if (!allowedLogoMimes.has(mimeType)) {
          throw new TypeError('请上传 PNG / JPG / WebP / GIF 格式的图片文件');
        }
        const safeExt = path.extname(path.basename(url.searchParams.get('filename') || 'logo.png')).slice(0, 10) || '.png';
        const storedName = `org_logo_${Date.now()}_${crypto.randomUUID().slice(0, 6)}${safeExt}`;
        const diskPath = path.join(uploadDir, storedName);
        await streamRequestToFile(req, diskPath, {
          maxBytes: 5 * 1024 * 1024,
          emptyError: '上传图片为空',
          limitError: 'Logo 图片不能超过 5 MB'
        });
        const oldName = store.updateOrgLogo({ storedName, mimeType });
        if (oldName) await fsp.unlink(path.join(uploadDir, oldName)).catch(() => {});
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      if (pathname === '/api/org/logo' && method === 'DELETE') {
        requireAdmin(session);
        const oldName = store.updateOrgLogo({ storedName: '', mimeType: '' });
        if (oldName) await fsp.unlink(path.join(uploadDir, oldName)).catch(() => {});
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      if (pathname === '/api/accounts' && method === 'POST') {
        requireAdmin(session);
        const body = await readJsonBody(req);
        const id = store.createAccount(body);
        return sendJson(res, 201, { id, state: store.getSnapshotForUser(session) });
      }

      if (pathname.startsWith('/api/accounts/') && method === 'PUT') {
        requireAdmin(session);
        const id = pathname.slice('/api/accounts/'.length);
        const body = await readJsonBody(req);
        store.updateAccount(id, body, session.accountId);
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      if (pathname.startsWith('/api/accounts/') && method === 'DELETE') {
        requireAdmin(session);
        const id = pathname.slice('/api/accounts/'.length);
        store.deleteAccount(id, session.accountId);
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      // --- 2.5 系统运维：存储统计、清理、数据库备份与 CSV 导出（仅管理员） ---
      if (pathname === '/api/system/storage' && method === 'GET') {
        requireAdmin(session);
        const stats = store.getStorageStats(uploadDir);
        let onlineRooms = 0;
        let onlineStudents = 0;
        for (const room of liveRooms.values()) {
          if (room.clients.size > 0) onlineRooms += 1;
          for (const client of room.clients.values()) {
            if (client.role === 'student') onlineStudents += 1;
          }
        }
        return sendJson(res, 200, { ...stats, onlineRooms, onlineStudents });
      }

      if (pathname === '/api/system/cleanup' && method === 'POST') {
        requireAdmin(session);
        const result = store.cleanupSystem(uploadDir);
        const stats = store.getStorageStats(uploadDir);
        return sendJson(res, 200, { result, stats });
      }

      if (pathname === '/api/system/backup' && method === 'GET') {
        requireAdmin(session);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const tmpFile = path.join(os.tmpdir(), `workbench_backup_${stamp}_${crypto.randomUUID().slice(0, 6)}.db`);
        try {
          store.createBackupSnapshot(tmpFile);
          const stat = await fsp.stat(tmpFile);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': stat.size,
            'Content-Disposition': `attachment; filename="workbench-backup-${stamp}.db"`,
            'Cache-Control': 'no-store'
          });
          await pipeline(fs.createReadStream(tmpFile), res);
        } finally {
          await fsp.unlink(tmpFile).catch(() => {});
        }
        return;
      }

      if (pathname === '/api/system/backups' && method === 'GET') {
        requireAdmin(session);
        return sendJson(res, 200, { backups: store.listLocalBackups(backupDir) });
      }

      if (pathname === '/api/system/backups' && method === 'POST') {
        requireAdmin(session);
        const result = store.rotateLocalBackups(backupDir, 5);
        return sendJson(res, 201, result);
      }

      if (pathname === '/api/system/backup/verify' && method === 'POST') {
        requireAdmin(session);
        const tmpFile = path.join(os.tmpdir(), `wb_verify_${crypto.randomUUID().slice(0, 8)}.db`);
        try {
          await streamRequestToFile(req, tmpFile, {
            maxBytes: 500 * 1024 * 1024,
            emptyError: '备份文件为空',
            limitError: '备份文件超过 500 MB 上限'
          });
          const check = store.verifyBackupFile(tmpFile);
          return sendJson(res, 200, check);
        } finally {
          await fsp.unlink(tmpFile).catch(() => {});
        }
      }

      if (pathname === '/api/system/export' && method === 'GET') {
        requireAdmin(session);
        const type = url.searchParams.get('type') || '';
        const csv = store.exportCsv(type);
        const stamp = new Date().toISOString().slice(0, 10);
        const buf = Buffer.from(csv, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Length': buf.length,
          'Content-Disposition': `attachment; filename="${type}-${stamp}.csv"`,
          'Cache-Control': 'no-store'
        });
        res.end(buf);
        return;
      }

      // --- 3. 教师管理（仅管理员） ---
      if (pathname === '/api/teachers' && method === 'POST') {
        requireAdmin(session);
        const body = await readJsonBody(req);
        const id = store.createTeacher(body);
        return sendJson(res, 201, { id, state: store.getSnapshotForUser(session) });
      }

      const teacherAccMatch = pathname.match(/^\/api\/teachers\/([^/]+)\/account$/);
      if (teacherAccMatch && method === 'POST') {
        requireAdmin(session);
        const body = await readJsonBody(req);
        store.upsertTeacherAccount(teacherAccMatch[1], body, session.accountId);
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      if (pathname.startsWith('/api/teachers/') && method === 'PUT') {
        requireAdmin(session);
        const id = pathname.slice('/api/teachers/'.length);
        const body = await readJsonBody(req);
        store.updateTeacher(id, body);
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      if (pathname.startsWith('/api/teachers/') && method === 'DELETE') {
        requireAdmin(session);
        const id = pathname.slice('/api/teachers/'.length);
        store.deleteTeacher(id, session.accountId);
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      // --- 4. 学生档案、跟进与学情记录（仅管理员） ---
      if (pathname === '/api/students' && method === 'POST') {
        requireAdmin(session);
        const body = await readJsonBody(req);
        const id = store.createStudent(body);
        return sendJson(res, 201, { id, state: store.getSnapshotForUser(session) });
      }

      const followupMatch = pathname.match(/^\/api\/students\/([^/]+)\/followups$/);
      if (followupMatch && method === 'POST') {
        requireAdmin(session);
        const body = await readJsonBody(req);
        store.addStudentFollowup({ studentId: followupMatch[1], content: body.content });
        return sendJson(res, 201, store.getSnapshotForUser(session));
      }

      if (pathname.startsWith('/api/students/') && method === 'PUT') {
        requireAdmin(session);
        const id = pathname.slice('/api/students/'.length);
        const body = await readJsonBody(req);
        store.updateStudent(id, body);
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      if (pathname.startsWith('/api/students/') && method === 'DELETE') {
        requireAdmin(session);
        const id = pathname.slice('/api/students/'.length);
        store.deleteStudent(id);
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      if (pathname === '/api/learning-records' && method === 'POST') {
        requireAdmin(session);
        const body = await readJsonBody(req);
        store.saveLearningRecord(body);
        return sendJson(res, 201, store.getSnapshotForUser(session));
      }

      if (pathname.startsWith('/api/learning-records/') && method === 'PUT') {
        requireAdmin(session);
        const id = pathname.slice('/api/learning-records/'.length);
        const body = await readJsonBody(req);
        store.saveLearningRecord({ ...body, id });
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      if (pathname.startsWith('/api/learning-records/') && method === 'DELETE') {
        requireAdmin(session);
        const id = pathname.slice('/api/learning-records/'.length);
        store.deleteLearningRecord(id);
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      // --- 5. 课程与报名（仅管理员） ---
      if (pathname === '/api/courses' && method === 'POST') {
        requireAdmin(session);
        const body = await readJsonBody(req);
        const id = store.createCourse(body);
        return sendJson(res, 201, { id, state: store.getSnapshotForUser(session) });
      }

      if (pathname.startsWith('/api/courses/') && method === 'PUT') {
        requireAdmin(session);
        const id = pathname.slice('/api/courses/'.length);
        const body = await readJsonBody(req);
        const result = store.updateCourse({ ...body, id });
        return sendJson(res, 200, { ...result, state: store.getSnapshotForUser(session) });
      }

      if (pathname.startsWith('/api/courses/') && method === 'DELETE') {
        requireAdmin(session);
        const id = pathname.slice('/api/courses/'.length);
        const storedNames = store.deleteCourse(id);
        await unlinkStoredFiles(storedNames);
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      // --- 5.5 课程大纲树节点（管理员与授课教师可维护） ---
      const copyOutlineMatch = pathname.match(/^\/api\/courses\/([^/]+)\/copy-outline$/);
      if (copyOutlineMatch && method === 'POST') {
        requireTeacher(session);
        const targetCourseId = copyOutlineMatch[1];
        if (session.role === 'teacher' && !store.canTeacherAccessCourse(session.linkedId, targetCourseId)) {
          return sendJson(res, 403, { error: '非本课程授课教师，无权复制课程大纲' });
        }
        const body = await readJsonBody(req);
        const sourceCourseId = String(body.sourceCourseId || '').trim();
        if (session.role === 'teacher' && !store.canTeacherAccessCourse(session.linkedId, sourceCourseId)) {
          return sendJson(res, 403, { error: '无权访问来源课程大纲' });
        }
        const copied = store.copyCourseOutline(targetCourseId, sourceCourseId);
        return sendJson(res, 200, { copied, state: store.getSnapshotForUser(session) });
      }

      if (pathname === '/api/course-nodes/batch' && method === 'POST') {
        requireTeacher(session);
        const body = await readJsonBody(req);
        if (session.role === 'teacher' && !store.canTeacherAccessCourse(session.linkedId, body.courseId)) {
          return sendJson(res, 403, { error: '非本课程授课教师，无权编辑课程大纲' });
        }
        const ids = store.createCourseNodesBatch(body);
        return sendJson(res, 201, { ids, state: store.getSnapshotForUser(session) });
      }

      if (pathname === '/api/course-nodes' && method === 'POST') {
        requireTeacher(session);
        const body = await readJsonBody(req);
        if (session.role === 'teacher' && !store.canTeacherAccessCourse(session.linkedId, body.courseId)) {
          return sendJson(res, 403, { error: '非本课程授课教师，无权编辑课程大纲' });
        }
        const id = store.createCourseNode(body);
        return sendJson(res, 201, { id, state: store.getSnapshotForUser(session) });
      }

      const moveNodeMatch = pathname.match(/^\/api\/course-nodes\/([^/]+)\/move$/);
      if (moveNodeMatch && method === 'POST') {
        requireTeacher(session);
        const node = store.getCourseNode(moveNodeMatch[1]);
        if (!node) return sendJson(res, 404, { error: '课程内容节点不存在' });
        if (session.role === 'teacher' && !store.canTeacherAccessCourse(session.linkedId, node.course_id)) {
          return sendJson(res, 403, { error: '非本课程授课教师，无权调整课程内容' });
        }
        const body = await readJsonBody(req);
        store.moveCourseNode(node.id, body.direction === 'up' ? 'up' : 'down');
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      const reorderNodeMatch = pathname.match(/^\/api\/course-nodes\/([^/]+)\/reorder$/);
      if (reorderNodeMatch && method === 'POST') {
        requireTeacher(session);
        const node = store.getCourseNode(reorderNodeMatch[1]);
        if (!node) return sendJson(res, 404, { error: '课程内容节点不存在' });
        if (session.role === 'teacher' && !store.canTeacherAccessCourse(session.linkedId, node.course_id)) {
          return sendJson(res, 403, { error: '非本课程授课教师，无权调整课程内容' });
        }
        const body = await readJsonBody(req);
        store.reorderCourseNode(node.id, String(body.targetId || ''), String(body.position || 'before'));
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      if (pathname.startsWith('/api/course-nodes/') && method === 'PUT') {
        requireTeacher(session);
        const id = pathname.slice('/api/course-nodes/'.length);
        const node = store.getCourseNode(id);
        if (!node) return sendJson(res, 404, { error: '大纲节点不存在' });
        if (session.role === 'teacher' && !store.canTeacherAccessCourse(session.linkedId, node.course_id)) {
          return sendJson(res, 403, { error: '非本课程授课教师，无权编辑课程大纲' });
        }
        const body = await readJsonBody(req);
        store.updateCourseNode(id, body);
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      if (pathname.startsWith('/api/course-nodes/') && method === 'DELETE') {
        requireTeacher(session);
        const id = pathname.slice('/api/course-nodes/'.length);
        const node = store.getCourseNode(id);
        if (!node) return sendJson(res, 404, { error: '大纲节点不存在' });
        if (session.role === 'teacher' && !store.canTeacherAccessCourse(session.linkedId, node.course_id)) {
          return sendJson(res, 403, { error: '非本课程授课教师，无权删除课程大纲节点' });
        }
        store.deleteCourseNode(id);
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      if (pathname === '/api/enrollments' && method === 'POST') {
        requireAdmin(session);
        const body = await readJsonBody(req);
        store.enrollStudent(body);
        return sendJson(res, 201, store.getSnapshotForUser(session));
      }

      if (pathname === '/api/enrollments/batch' && method === 'POST') {
        requireAdmin(session);
        const body = await readJsonBody(req);
        const result = store.enrollStudentsBatch(body);
        return sendJson(res, 201, { ...result, state: store.getSnapshotForUser(session) });
      }

      const transferMatch = pathname.match(/^\/api\/enrollments\/([^/]+)\/transfer$/);
      if (transferMatch && method === 'POST') {
        requireAdmin(session);
        const body = await readJsonBody(req);
        store.transferEnrollment({ enrollmentId: transferMatch[1], targetCourseId: body.targetCourseId });
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      if (pathname.startsWith('/api/enrollments/') && method === 'PATCH') {
        requireAdmin(session);
        const id = pathname.slice('/api/enrollments/'.length);
        const body = await readJsonBody(req);
        store.setEnrollmentStatus(id, body.status);
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      // --- 6. 课次与排课（仅管理员） ---
      if (pathname === '/api/lessons' && method === 'POST') {
        requireAdmin(session);
        const body = await readJsonBody(req);
        const id = store.saveLesson(body);
        return sendJson(res, 201, { id, state: store.getSnapshotForUser(session) });
      }

      if (pathname === '/api/lessons/batch' && method === 'POST') {
        requireAdmin(session);
        const body = await readJsonBody(req);
        if (body.dryRun) {
          const previewRes = store.saveLessonBatch({ ...body, dryRun: true });
          return sendJson(res, 200, previewRes);
        }
        const { ids, skipped } = store.saveLessonBatch(body);
        return sendJson(res, 201, { ids, skipped, state: store.getSnapshotForUser(session) });
      }

      const lesStatusMatch = pathname.match(/^\/api\/lessons\/([^/]+)\/status$/);
      if (lesStatusMatch && method === 'PATCH') {
        requireTeacher(session);
        const lessonId = lesStatusMatch[1];
        if (session.role === 'teacher' && !store.canTeacherAccessLesson(session.linkedId, lessonId)) {
          return sendJson(res, 403, { error: '仅本课授课教师或管理员可修改课次状态' });
        }
        const body = await readJsonBody(req);
        const row = store.db.prepare('SELECT course_id, start_ms, status FROM lessons WHERE id = ?').get(lessonId);
        if (body.status === 'in_progress') {
          if (!row) return sendJson(res, 404, { error: '课次不存在' });
          if (row.status === 'cancelled') return sendJson(res, 400, { error: '该课次已取消，无法上课' });
          if (row.status !== 'in_progress' && Date.now() < Number(row.start_ms) - 10 * 60 * 1000) {
            return sendJson(res, 400, { error: '距离约定上课时间超过 10 分钟，开课前 10 分钟起可点击上课' });
          }
        }
        store.updateLessonStatus(lessonId, body.status);
        broadcastRoom(lessonId, 'lesson-status', { status: body.status });
        if (row?.course_id) {
          broadcastQa(row.course_id, 'lesson_status', { lessonId, status: body.status });
        }
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      const lesNoteMatch = pathname.match(/^\/api\/lessons\/([^/]+)\/note$/);
      if (lesNoteMatch && method === 'PATCH') {
        requireTeacher(session);
        const lessonId = lesNoteMatch[1];
        if (session.role === 'teacher' && !store.canTeacherAccessLesson(session.linkedId, lessonId)) {
          return sendJson(res, 403, { error: '仅本课授课教师或管理员可修改课次备注' });
        }
        const body = await readJsonBody(req);
        store.updateLessonNote(lessonId, body.note);
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      if (pathname.startsWith('/api/lessons/') && method === 'PUT') {
        requireAdmin(session);
        const id = pathname.slice('/api/lessons/'.length);
        const body = await readJsonBody(req);
        store.saveLesson({ ...body, id });
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      if (pathname.startsWith('/api/lessons/') && method === 'DELETE') {
        requireAdmin(session);
        const id = pathname.slice('/api/lessons/'.length);
        const storedNames = store.deleteLesson(id);
        await unlinkStoredFiles(storedNames);
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      // --- 6b. 招生限时试听（仅管理员）与课次出勤点名（教师/管理员） ---
      if (pathname === '/api/trials' && method === 'POST') {
        requireAdmin(session);
        const body = await readJsonBody(req);
        const id = store.createTrialGrant(body);
        return sendJson(res, 201, { id, state: store.getSnapshotForUser(session) });
      }

      if (pathname.startsWith('/api/trials/') && method === 'DELETE') {
        requireAdmin(session);
        const id = pathname.slice('/api/trials/'.length);
        store.deleteTrialGrant(id);
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      if (pathname === '/api/attendance' && method === 'POST') {
        requireTeacher(session);
        const body = await readJsonBody(req);
        if (session.role === 'teacher' && !store.canTeacherAccessLesson(session.linkedId, body.lessonId)) {
          return sendJson(res, 403, { error: '仅本课授课教师或管理员可点名' });
        }
        store.setAttendance(body);
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      if (pathname === '/api/attendance/batch' && method === 'POST') {
        requireTeacher(session);
        const body = await readJsonBody(req);
        if (session.role === 'teacher' && !store.canTeacherAccessLesson(session.linkedId, body.lessonId)) {
          return sendJson(res, 403, { error: '仅本课授课教师或管理员可点名' });
        }
        store.setAttendanceBatch(body);
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      // --- 7. 实时课堂（按登录身份与班级/授课资格做服务端权限拦截） ---
      const streamMatch = pathname.match(/^\/api\/classroom\/([^/]+)\/stream$/);
      if (streamMatch && method === 'GET') {
        requireAuth(session);
        const lessonId = streamMatch[1];
        if (session.role === 'student' && !store.canStudentAccessLesson(session.linkedId, lessonId)) {
          return sendJson(res, 403, { error: '非本班在读学生，无权进入该课堂' });
        }
        if (session.role === 'teacher' && !store.canTeacherAccessLesson(session.linkedId, lessonId)) {
          return sendJson(res, 403, { error: '非本课授课教师，无权进入该课堂' });
        }
        const clientId = url.searchParams.get('clientId') || crypto.randomUUID().slice(0, 8);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });

        const room = getRoom(lessonId);
        const heartbeat = setInterval(() => {
          try { res.write(': ping\n\n'); } catch {}
        }, 25000);
        heartbeat.unref?.();

        room.clients.set(clientId, {
          res,
          heartbeat,
          name: session.name,
          role: session.role,
          linkedId: session.linkedId || null,
          handRaised: false,
          handRaisedAt: null,
          handMode: 'audio',
          micAllowed: session.role === 'admin' || session.role === 'teacher',
          camAllowed: session.role === 'admin' || session.role === 'teacher',
          camActive: false,
          camStreamId: '',
          linkMode: null,
          micMuted: false,
          drawAllowed: session.role === 'admin' || session.role === 'teacher' || Boolean(room.allowStudentDraw)
        });

        const curPage = room.whiteboard.pages[room.whiteboard.currentPage] || { strokes: [], bgUrl: '' };
        const lessonRow = store.db.prepare('SELECT status, start_ms FROM lessons WHERE id = ?').get(lessonId);
        const initData = {
          clientId,
          lessonStatus: lessonRow?.status || 'scheduled',
          lessonStartMs: Number(lessonRow?.start_ms || 0),
          pages: room.whiteboard.pages,
          currentPage: room.whiteboard.currentPage,
          strokes: curPage.strokes,
          bgUrl: curPage.bgUrl,
          allowStudentDraw: room.allowStudentDraw,
          roster: getRoomRoster(room),
          chat: room.chat.slice(-40),
          sharingClientId: room.sharingClientId,
          sharingStreamId: room.sharingStreamId || ''
        };
        res.write(`event: init\ndata: ${JSON.stringify(initData)}\n\n`);
        broadcastRoom(lessonId, 'roster', {
          roster: getRoomRoster(room),
          sharingClientId: room.sharingClientId,
          sharingStreamId: room.sharingStreamId || ''
        }, clientId);

        req.on('close', () => {
          clearInterval(heartbeat);
          if (room.clients.get(clientId)?.res === res) {
            room.clients.delete(clientId);
          }
          if (room.sharingClientId === clientId && !room.clients.has(clientId)) {
            room.sharingClientId = null;
            room.sharingStreamId = '';
          }
          if (room.clients.size === 0) {
            flushWhiteboard(lessonId);
            liveRooms.delete(lessonId);
          } else {
            broadcastRoom(lessonId, 'roster', {
              roster: getRoomRoster(room),
              sharingClientId: room.sharingClientId,
              sharingStreamId: room.sharingStreamId || ''
            });
          }
        });
        return;
      }

      const actionMatch = pathname.match(/^\/api\/classroom\/([^/]+)\/action$/);
      if (actionMatch && method === 'POST') {
        requireAuth(session);
        const lessonId = actionMatch[1];
        if (session.role === 'student' && !store.canStudentAccessLesson(session.linkedId, lessonId)) {
          return sendJson(res, 403, { error: '无权操作该课堂' });
        }
        if (session.role === 'teacher' && !store.canTeacherAccessLesson(session.linkedId, lessonId)) {
          return sendJson(res, 403, { error: '非本课授课教师，无权操作该课堂' });
        }
        const body = await readJsonBody(req);
        const room = getRoom(lessonId);
        const { type } = body;

        const teacherOnlyActions = new Set([
          'undo', 'clear', 'background', 'mic', 'hand-reject', 'share-state', 'lesson-status', 'start-class',
          'page-add', 'page-switch', 'page-delete', 'pages-import',
          'student-draw-toggle', 'student-draw-client'
        ]);
        if (teacherOnlyActions.has(type) && session.role !== 'admin' && session.role !== 'teacher') {
          return sendJson(res, 403, { error: '仅授课教师可执行该课堂控制操作' });
        }

        const curPage = room.whiteboard.pages[room.whiteboard.currentPage] || (room.whiteboard.pages[0] = { strokes: [], bgUrl: '' });
        const canClientDraw = () => {
          if (session.role !== 'student') return true;
          const client = body.clientId ? room.clients.get(body.clientId) : null;
          return client ? Boolean(client.drawAllowed) : Boolean(room.allowStudentDraw);
        };

        if (type === 'stroke-live') {
          if (!canClientDraw()) {
            return sendJson(res, 403, { error: '当前未开启学生白板书写权限' });
          }
          broadcastRoom(lessonId, 'stroke-live', {
            clientId: body.clientId,
            name: session.name,
            pageIndex: room.whiteboard.currentPage,
            stroke: body.stroke || null,
            delta: body.delta || null
          }, body.clientId);
        } else if (type === 'stroke') {
          if (!canClientDraw()) {
            return sendJson(res, 403, { error: '当前未开启学生白板书写权限' });
          }
          curPage.strokes.push(body.stroke);
          scheduleWhiteboardSave(lessonId);
          broadcastRoom(lessonId, 'stroke', {
            clientId: body.clientId,
            pageIndex: room.whiteboard.currentPage,
            stroke: body.stroke
          }, body.clientId);
        } else if (type === 'undo') {
          curPage.strokes.pop();
          scheduleWhiteboardSave(lessonId);
          broadcastRoom(lessonId, 'replace-strokes', {
            pageIndex: room.whiteboard.currentPage,
            strokes: curPage.strokes
          });
        } else if (type === 'clear') {
          curPage.strokes = [];
          flushWhiteboard(lessonId);
          broadcastRoom(lessonId, 'replace-strokes', {
            pageIndex: room.whiteboard.currentPage,
            strokes: []
          });
        } else if (type === 'background') {
          curPage.bgUrl = String(body.bgUrl || '');
          flushWhiteboard(lessonId);
          broadcastRoom(lessonId, 'background', {
            pageIndex: room.whiteboard.currentPage,
            bgUrl: curPage.bgUrl
          });
        } else if (type === 'page-add') {
          if (room.whiteboard.pages.length >= 50) {
            return sendJson(res, 400, { error: '单节课白板最多支持 50 页' });
          }
          const bgUrl = String(body.bgUrl || '');
          room.whiteboard.pages.push({ strokes: [], bgUrl });
          room.whiteboard.currentPage = room.whiteboard.pages.length - 1;
          flushWhiteboard(lessonId);
          broadcastRoom(lessonId, 'whiteboard-sync', {
            pages: room.whiteboard.pages,
            currentPage: room.whiteboard.currentPage
          });
        } else if (type === 'pages-import') {
          const incoming = Array.isArray(body.pages) ? body.pages : [];
          if (incoming.length === 0) {
            return sendJson(res, 400, { error: '没有可导入的白板页' });
          }
          if (room.whiteboard.pages.length + incoming.length > 50) {
            return sendJson(res, 400, { error: '导入后总页数不能超过 50 页' });
          }
          const startIdx = room.whiteboard.pages.length;
          for (const p of incoming) {
            room.whiteboard.pages.push({
              strokes: Array.isArray(p?.strokes) ? p.strokes : [],
              bgUrl: String(p?.bgUrl || '')
            });
          }
          room.whiteboard.currentPage = startIdx;
          flushWhiteboard(lessonId);
          broadcastRoom(lessonId, 'whiteboard-sync', {
            pages: room.whiteboard.pages,
            currentPage: room.whiteboard.currentPage
          });
        } else if (type === 'page-switch') {
          const idx = Number(body.pageIndex);
          if (Number.isInteger(idx) && idx >= 0 && idx < room.whiteboard.pages.length) {
            room.whiteboard.currentPage = idx;
            flushWhiteboard(lessonId);
            broadcastRoom(lessonId, 'whiteboard-sync', {
              pages: room.whiteboard.pages,
              currentPage: room.whiteboard.currentPage
            });
          }
        } else if (type === 'page-delete') {
          if (room.whiteboard.pages.length > 1) {
            room.whiteboard.pages.splice(room.whiteboard.currentPage, 1);
            room.whiteboard.currentPage = Math.min(room.whiteboard.currentPage, room.whiteboard.pages.length - 1);
            flushWhiteboard(lessonId);
            broadcastRoom(lessonId, 'whiteboard-sync', {
              pages: room.whiteboard.pages,
              currentPage: room.whiteboard.currentPage
            });
          }
        } else if (type === 'student-draw-toggle') {
          room.allowStudentDraw = Boolean(body.allowed);
          for (const c of room.clients.values()) {
            if (c.role === 'student') c.drawAllowed = room.allowStudentDraw;
          }
          broadcastRoom(lessonId, 'student-draw', { allowStudentDraw: room.allowStudentDraw });
          broadcastRoom(lessonId, 'roster', { roster: getRoomRoster(room), sharingClientId: room.sharingClientId });
        } else if (type === 'student-draw-client') {
          const target = room.clients.get(body.targetClientId);
          if (target && target.role === 'student') {
            target.drawAllowed = Boolean(body.allowed);
            broadcastRoom(lessonId, 'roster', { roster: getRoomRoster(room), sharingClientId: room.sharingClientId });
          }
        } else if (type === 'hand') {
          if (session.role === 'student') {
            const lessonRow = store.db.prepare('SELECT status FROM lessons WHERE id = ?').get(lessonId);
            if (lessonRow?.status !== 'in_progress') {
              return sendJson(res, 403, { error: lessonRow?.status === 'completed' ? '本课已下课，无法举手' : '老师尚未点击上课，开课后即可举手连线' });
            }
          }
          const client = room.clients.get(body.clientId);
          if (client) {
            client.handRaised = Boolean(body.raised);
            client.handRaisedAt = client.handRaised ? Date.now() : null;
            if (body.mode === 'av' || body.mode === 'audio') {
              client.handMode = body.mode;
            }
            broadcastRoom(lessonId, 'roster', {
              roster: getRoomRoster(room),
              sharingClientId: room.sharingClientId,
              sharingStreamId: room.sharingStreamId || ''
            });
          }
        } else if (type === 'hand-reject') {
          const target = room.clients.get(body.targetClientId);
          if (target) {
            target.handRaised = false;
            target.handRaisedAt = null;
            try {
              target.res.write(`event: hand-rejected\ndata: ${JSON.stringify({ by: session.name })}\n\n`);
            } catch {}
            broadcastRoom(lessonId, 'roster', {
              roster: getRoomRoster(room),
              sharingClientId: room.sharingClientId,
              sharingStreamId: room.sharingStreamId || ''
            });
          }
        } else if (type === 'mic') {
          const target = room.clients.get(body.targetClientId);
          if (target) {
            target.micAllowed = Boolean(body.allowed);
            if (target.micAllowed) {
              const withVideo = body.withVideo !== undefined ? Boolean(body.withVideo) : target.handMode === 'av';
              target.camAllowed = withVideo;
              target.linkMode = withVideo ? 'av' : 'audio';
              target.handRaised = false;
              target.handRaisedAt = null;
              target.micMuted = false;
            } else {
              target.camAllowed = false;
              target.camActive = false;
              target.camStreamId = '';
              target.linkMode = null;
              target.micMuted = false;
            }
            broadcastRoom(lessonId, 'roster', {
              roster: getRoomRoster(room),
              sharingClientId: room.sharingClientId,
              sharingStreamId: room.sharingStreamId || ''
            });
          }
        } else if (type === 'link-end') {
          const targetId = session.role === 'student' ? body.clientId : (body.targetClientId || body.clientId);
          const target = room.clients.get(targetId);
          if (target) {
            if (session.role === 'student' && target.linkedId !== session.linkedId) {
              return sendJson(res, 403, { error: '无权结束他人连线' });
            }
            target.micAllowed = false;
            target.camAllowed = false;
            target.camActive = false;
            target.camStreamId = '';
            target.linkMode = null;
            target.micMuted = false;
            target.handRaised = false;
            target.handRaisedAt = null;
            broadcastRoom(lessonId, 'roster', {
              roster: getRoomRoster(room),
              sharingClientId: room.sharingClientId,
              sharingStreamId: room.sharingStreamId || ''
            });
          }
        } else if (type === 'cam-state') {
          const client = room.clients.get(body.clientId);
          if (client) {
            if (session.role === 'student' && !client.micAllowed) {
              return sendJson(res, 403, { error: '连线后才可开启摄像头' });
            }
            client.camActive = Boolean(body.active);
            client.camStreamId = client.camActive ? String(body.streamId || '') : '';
            broadcastRoom(lessonId, 'roster', {
              roster: getRoomRoster(room),
              sharingClientId: room.sharingClientId,
              sharingStreamId: room.sharingStreamId || ''
            });
          }
        } else if (type === 'mic-mute') {
          const client = room.clients.get(body.clientId);
          if (client) {
            client.micMuted = Boolean(body.muted);
            broadcastRoom(lessonId, 'roster', {
              roster: getRoomRoster(room),
              sharingClientId: room.sharingClientId,
              sharingStreamId: room.sharingStreamId || ''
            });
          }
        } else if (type === 'chat') {
          if (session.role === 'student') {
            const lessonRow = store.db.prepare('SELECT status FROM lessons WHERE id = ?').get(lessonId);
            if (lessonRow?.status !== 'in_progress') {
              return sendJson(res, 403, { error: lessonRow?.status === 'completed' ? '本课已下课，无法继续发言' : '老师尚未点击上课，开课后即可发言' });
            }
          }
          const msg = {
            id: crypto.randomUUID().slice(0, 8),
            name: session.name,
            role: session.role,
            text: String(body.text || '').trim(),
            time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
          };
          if (msg.text) {
            store.addClassroomMessage(lessonId, msg);
            room.chat.push(msg);
            if (room.chat.length > 200) room.chat.splice(0, room.chat.length - 200);
            broadcastRoom(lessonId, 'chat', msg);
          }
        } else if (type === 'share-state') {
          room.sharingClientId = body.sharing ? body.clientId : null;
          room.sharingStreamId = body.sharing ? String(body.streamId || '') : '';
          broadcastRoom(lessonId, 'roster', {
            roster: getRoomRoster(room),
            sharingClientId: room.sharingClientId,
            sharingStreamId: room.sharingStreamId
          });
        } else if (type === 'rtc-signal') {
          if (body.toClientId) {
            const target = room.clients.get(body.toClientId);
            if (target) target.res.write(`event: rtc-signal\ndata: ${JSON.stringify(body)}\n\n`);
          } else {
            broadcastRoom(lessonId, 'rtc-signal', body, body.fromClientId);
          }
        } else if (type === 'start-class') {
          const row = store.db.prepare('SELECT course_id, start_ms, status FROM lessons WHERE id = ?').get(lessonId);
          if (!row) return sendJson(res, 404, { error: '课次不存在' });
          if (row.status === 'cancelled') return sendJson(res, 400, { error: '该课次已取消，无法上课' });
          if (row.status === 'completed') return sendJson(res, 400, { error: '该课次已完课' });
          if (row.status !== 'in_progress' && Date.now() < Number(row.start_ms) - 10 * 60 * 1000) {
            return sendJson(res, 400, { error: '距离约定上课时间超过 10 分钟，开课前 10 分钟起可点击上课' });
          }
          store.updateLessonStatus(lessonId, 'in_progress');
          broadcastRoom(lessonId, 'lesson-status', { status: 'in_progress' });
          if (row.course_id) broadcastQa(row.course_id, 'lesson_status', { lessonId, status: 'in_progress' });
        } else if (type === 'lesson-status') {
          const row = store.db.prepare('SELECT course_id FROM lessons WHERE id = ?').get(lessonId);
          store.updateLessonStatus(lessonId, body.status);
          broadcastRoom(lessonId, 'lesson-status', { status: body.status });
          if (row?.course_id) broadcastQa(row.course_id, 'lesson_status', { lessonId, status: body.status });
        }
        return sendJson(res, 200, { ok: true });
      }

      // --- 8. 直播回放：带序号校验的流式分片录制（丢片拒绝归档、支持重传补片、无内存上限）+ 原始二进制上传 ---
      if (pathname === '/api/recordings/init' && method === 'POST') {
        requireTeacher(session);
        const body = await readJsonBody(req);
        if (!body.lessonId) throw new TypeError('缺少关联课次 lessonId');
        if (session.role === 'teacher' && !store.canTeacherAccessLesson(session.linkedId, body.lessonId)) {
          return sendJson(res, 403, { error: '非本课授课教师，无权录制该课次' });
        }
        const id = `rec_${crypto.randomUUID().slice(0, 8)}`;
        const safeOriginal = path.basename(String(body.filename || 'live-recording.webm'));
        const storedName = `${id}_${Date.now()}_${safeOriginal}`;
        const diskPath = path.join(uploadDir, storedName);
        const chunkDir = path.join(uploadDir, `.chunks_${id}`);
        await fsp.mkdir(chunkDir, { recursive: true });
        const startedAt = Date.now();
        const recSession = {
          lessonId: body.lessonId,
          title: body.title || '直播自动录制回放',
          filename: safeOriginal,
          storedName,
          mimeType: body.mimeType || 'video/webm',
          diskPath,
          chunkDir,
          receivedSeqs: new Map(), // seq -> byteSize
          startedAt,
          lastActivityAt: startedAt,
          status: 'recording'
        };
        activeRecordings.set(id, recSession);
        store.createRecordingSession({
          id,
          lessonId: recSession.lessonId,
          title: recSession.title,
          filename: recSession.filename,
          storedName: recSession.storedName,
          mimeType: recSession.mimeType,
          startedAt
        });
        return sendJson(res, 201, { id });
      }

      const chunkMatch = pathname.match(/^\/api\/recordings\/([^/]+)\/chunk$/);
      if (chunkMatch && method === 'POST') {
        requireTeacher(session);
        const recSession = activeRecordings.get(chunkMatch[1]);
        if (!recSession) return sendJson(res, 404, { error: '录制会话不存在或已结束' });
        if (session.role === 'teacher' && !store.canTeacherAccessLesson(session.linkedId, recSession.lessonId)) {
          return sendJson(res, 403, { error: '无权上传该录制会话的分片' });
        }
        const seqParam = url.searchParams.get('seq');
        const seq = Number(seqParam);
        if (seqParam === null || !Number.isSafeInteger(seq) || seq < 0) {
          throw new TypeError('分片缺少有效的非负整数序号 seq');
        }
        const chunkPath = path.join(recSession.chunkDir, `chunk_${seq}.part`);
        const chunkBytes = await streamRequestToFile(req, chunkPath, {
          maxBytes: 128 * 1024 * 1024,
          emptyError: `分片 #${seq} 内容为空`,
          limitError: `分片 #${seq} 超过 128 MB 上限`
        });
        recSession.receivedSeqs.set(seq, chunkBytes);
        recSession.lastActivityAt = Date.now();
        recSession.status = 'recording';
        store.updateRecordingSessionSeq(chunkMatch[1], recSession.receivedSeqs, recSession.lastActivityAt, 'recording');
        let totalBytes = 0;
        for (const sz of recSession.receivedSeqs.values()) totalBytes += sz;
        return sendJson(res, 200, {
          ok: true,
          seq,
          receivedCount: recSession.receivedSeqs.size,
          sizeBytes: totalBytes
        });
      }

      const finishMatch = pathname.match(/^\/api\/recordings\/([^/]+)\/finish$/);
      if (finishMatch && method === 'POST') {
        requireTeacher(session);
        const id = finishMatch[1];
        const recSession = activeRecordings.get(id);
        const archived = !recSession && store.getRecording(id);
        if (!recSession && !archived) return sendJson(res, 404, { error: '录制会话不存在' });
        if (session.role === 'teacher' && !store.canTeacherAccessLesson(session.linkedId, recSession?.lessonId || archived.lesson_id)) {
          return sendJson(res, 403, { error: '无权归档该课次录制' });
        }
        if (archived) return sendJson(res, 200, { id, state: store.getSnapshotForUser(session) });
        const body = await readJsonBody(req);
        if (activeRecordings.get(id) !== recSession || recSession.finalizing) {
          return sendJson(res, 409, { error: '此录制已在归档，请刷新回放列表' });
        }
        const seqsToMerge = [];
        if (body.recoverPartial) {
          for (let seq = 0; recSession.receivedSeqs.has(seq); seq++) seqsToMerge.push(seq);
          if (!seqsToMerge.length) {
            throw new TypeError('缺少起始分片，无法恢复可播放的回放');
          }
        } else {
          const totalChunks = Number(body.totalChunks);
          if (!Number.isSafeInteger(totalChunks) || totalChunks < 1) {
            throw new TypeError('归档时必须提供有效的总分片数 totalChunks');
          }
          const missingSeqs = [];
          for (let i = 0; i < totalChunks; i++) {
            if (!recSession.receivedSeqs.has(i)) missingSeqs.push(i);
            else seqsToMerge.push(i);
          }
          if (missingSeqs.length > 0) {
            recSession.status = 'interrupted';
            store.updateRecordingSessionSeq(id, recSession.receivedSeqs, recSession.lastActivityAt, 'interrupted');
            return sendJson(res, 409, {
              error: `录制分片不完整，缺少分片 ${missingSeqs.map(n => `#${n}`).join('、')}，拒绝归档`,
              missingSeqs
            });
          }
        }

        // 按严格序号流式合并为完整成品文件（先写临时文件再原子重命名，避免半成品残留）
        const tmpMergePath = `${recSession.diskPath}.merging.tmp`;
        recSession.finalizing = true;
        const outStream = fs.createWriteStream(tmpMergePath);
        try {
          for (let idx = 0; idx < seqsToMerge.length; idx++) {
            const chunkPath = path.join(recSession.chunkDir, `chunk_${seqsToMerge[idx]}.part`);
            await pipeline(fs.createReadStream(chunkPath), outStream, { end: idx === seqsToMerge.length - 1 });
          }
          await fsp.rename(tmpMergePath, recSession.diskPath);
          const stat = await fsp.stat(recSession.diskPath);
          const durationSec = Number(body.durationSec) || (body.recoverPartial ? 0 : Math.max(1, Math.round(((recSession.lastActivityAt || Date.now()) - recSession.startedAt) / 1000)));
          const defaultTitle = body.recoverPartial ? `${recSession.title}（中断恢复）` : recSession.title;
          store.db.exec('BEGIN');
          try {
            store.createRecording({
              id,
              lessonId: recSession.lessonId,
              title: body.title || defaultTitle,
              filename: recSession.filename,
              storedName: recSession.storedName,
              mimeType: recSession.mimeType,
              sizeBytes: stat.size,
              durationSec,
              status: 'pending_review'
            });
            store.deleteRecordingSession(id);
            store.db.exec('COMMIT');
          } catch (err) {
            store.db.exec('ROLLBACK');
            throw err;
          }
          activeRecordings.delete(id);
          await fsp.rm(recSession.chunkDir, { recursive: true, force: true }).catch(() => {});
        } catch (mergeErr) {
          outStream.destroy();
          await fsp.unlink(tmpMergePath).catch(() => {});
          throw mergeErr;
        } finally {
          recSession.finalizing = false;
        }
        return sendJson(res, 201, {
          id,
          recoveredChunks: seqsToMerge.length,
          state: store.getSnapshotForUser(session)
        });
      }

      const delRecSessMatch = pathname.match(/^\/api\/recordings\/sessions\/([^/]+)$/);
      if (delRecSessMatch && method === 'DELETE') {
        requireTeacher(session);
        const id = delRecSessMatch[1];
        const recSession = activeRecordings.get(id);
        if (!recSession) return sendJson(res, 404, { error: '未归档录制会话不存在' });
        if (session.role === 'teacher' && !store.canTeacherAccessLesson(session.linkedId, recSession.lessonId)) {
          return sendJson(res, 403, { error: '无权删除该课次的未归档录制' });
        }
        if (recSession.finalizing) return sendJson(res, 409, { error: '此录制正在归档' });
        activeRecordings.delete(id);
        store.deleteRecordingSession(id);
        await fsp.rm(recSession.chunkDir, { recursive: true, force: true }).catch(() => {});
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      // 原始二进制流上传外部回放视频（无 Base64 开销、无 80MB 限制）
      if (pathname === '/api/recordings/upload' && method === 'POST') {
        requireTeacher(session);
        const lessonId = url.searchParams.get('lessonId');
        const title = url.searchParams.get('title') || '外部上传回放';
        const durationSec = Math.max(0, Math.round(Number(url.searchParams.get('durationSec')) || 0));
        const safeOriginal = path.basename(url.searchParams.get('filename') || 'recording.mp4');
        const mimeType = req.headers['content-type'] || 'video/mp4';
        if (!lessonId) throw new TypeError('缺少关联课次');
        if (session.role === 'teacher' && !store.canTeacherAccessLesson(session.linkedId, lessonId)) {
          return sendJson(res, 403, { error: '非本课授课教师，无权上传该课次回放' });
        }
        const storedName = `rec_${Date.now()}_${crypto.randomUUID().slice(0, 6)}_${safeOriginal}`;
        const diskPath = path.join(uploadDir, storedName);
        const recSize = await streamRequestToFile(req, diskPath, {
          maxBytes: 2 * 1024 * 1024 * 1024,
          emptyError: '上传文件为空',
          limitError: '回放文件不能超过 2 GB'
        });
        const id = store.createRecording({
          lessonId,
          title,
          filename: safeOriginal,
          storedName,
          mimeType,
          sizeBytes: recSize,
          durationSec,
          status: 'pending_review'
        });
        return sendJson(res, 201, { id, state: store.getSnapshotForUser(session) });
      }

      const recFileMatch = pathname.match(/^\/api\/recordings\/([^/]+)\/file$/);
      if (recFileMatch && method === 'GET') {
        requireAuth(session);
        const rec = store.getRecording(recFileMatch[1]);
        if (!rec) return sendJson(res, 404, { error: '回放不存在' });
        if (session.role === 'student' && !store.canStudentAccessRecording(session.linkedId, rec)) {
          return sendJson(res, 403, { error: '无权访问该回放（未发布、外班或已退班）' });
        }
        if (session.role === 'teacher' && !store.canTeacherAccessLesson(session.linkedId, rec.lesson_id)) {
          return sendJson(res, 403, { error: '无权访问其他教师课次的回放' });
        }
        if (session.role === 'student' && req.headers['sec-fetch-dest'] === 'document') {
          return sendJson(res, 403, { error: '请通过工作台播放器观看' });
        }
        const allowDownload = (session.role === 'admin' || session.role === 'teacher') && url.searchParams.get('download') === '1';
        const diskPath = path.join(uploadDir, rec.stored_name);
        await streamMediaFile(req, res, diskPath, rec.mime_type, rec.filename, allowDownload, { noStore: true });
        return;
      }

      if (pathname.startsWith('/api/recordings/') && method === 'PATCH') {
        requireTeacher(session);
        const id = pathname.slice('/api/recordings/'.length);
        const rec = store.getRecording(id);
        if (!rec) return sendJson(res, 404, { error: '回放不存在' });
        if (session.role === 'teacher' && !store.canTeacherAccessLesson(session.linkedId, rec.lesson_id)) {
          return sendJson(res, 403, { error: '无权修改其他教师课次的回放' });
        }
        const body = await readJsonBody(req);
        store.updateRecording(id, body);
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      if (pathname.startsWith('/api/recordings/') && method === 'DELETE') {
        requireTeacher(session);
        const id = pathname.slice('/api/recordings/'.length);
        const rec = store.getRecording(id);
        if (!rec) return sendJson(res, 404, { error: '回放不存在' });
        if (session.role === 'teacher' && !store.canTeacherAccessLesson(session.linkedId, rec.lesson_id)) {
          return sendJson(res, 403, { error: '无权删除其他教师课次的回放' });
        }
        const removed = store.deleteRecording(id);
        if (removed) await fsp.unlink(path.join(uploadDir, removed.stored_name)).catch(() => {});
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      // --- 9. 自制纯录播课（原始二进制流上传 + 权限校验读取 + 轻量进度保存） ---
      if (pathname === '/api/vod/upload' && method === 'POST') {
        requireTeacher(session);
        const courseId = url.searchParams.get('courseId');
        const chapterName = url.searchParams.get('chapterName') || '第一章';
        const title = url.searchParams.get('title');
        const sortOrder = Number(url.searchParams.get('sortOrder')) || 1;
        const durationSec = Math.max(0, Math.round(Number(url.searchParams.get('durationSec')) || 0));
        const safeOriginal = path.basename(url.searchParams.get('filename') || 'vod.mp4');
        const mimeType = req.headers['content-type'] || 'video/mp4';
        if (!courseId || !title) throw new TypeError('缺少课程或小节标题');
        if (session.role === 'teacher' && !store.canTeacherAccessCourse(session.linkedId, courseId)) {
          return sendJson(res, 403, { error: '无权向该课程上传录播课' });
        }
        const storedName = `vod_${Date.now()}_${crypto.randomUUID().slice(0, 6)}_${safeOriginal}`;
        const diskPath = path.join(uploadDir, storedName);
        const vodSize = await streamRequestToFile(req, diskPath, {
          maxBytes: 2 * 1024 * 1024 * 1024,
          emptyError: '上传视频为空',
          limitError: '录播视频不能超过 2 GB'
        });
        const id = store.createVodLesson({
          courseId,
          chapterName,
          title,
          sortOrder,
          filename: safeOriginal,
          storedName,
          mimeType,
          sizeBytes: vodSize,
          durationSec
        });
        return sendJson(res, 201, { id, state: store.getSnapshotForUser(session) });
      }

      const vodMediaMatch = pathname.match(/^\/api\/vod\/([^/]+)\/(file|playback)$/);
      if (vodMediaMatch && ((vodMediaMatch[2] === 'file' && method === 'GET') || (vodMediaMatch[2] === 'playback' && method === 'POST'))) {
        requireAuth(session);
        res.setHeader('Cache-Control', 'no-store, private');
        const vod = store.getVodLesson(vodMediaMatch[1]);
        if (!vod) return sendJson(res, 404, { error: '录播视频不存在' });
        if (session.role === 'student' && !store.canStudentAccessVod(session.linkedId, vod)) {
          return sendJson(res, 403, { error: '未报名该课程或已退班，无权观看录播视频' });
        }
        if (session.role === 'teacher' && !store.canTeacherAccessCourse(session.linkedId, vod.course_id)) {
          return sendJson(res, 403, { error: '无权访问其他课程的录播视频' });
        }
        const isStudent = session.role === 'student';
        const permitKey = `${session.token}:${vod.id}`;
        const validPermit = () => {
          const permit = vodPermits.get(permitKey);
          return permit && permit.expiresAt > Date.now() && permit.token === url.searchParams.get('permit');
        };
        if (vodMediaMatch[2] === 'playback') {
          if (req.headers['sec-fetch-site'] === 'cross-site') {
            return sendJson(res, 403, { error: '请通过工作台播放器观看' });
          }
          let fileUrl = `/api/vod/${encodeURIComponent(vod.id)}/file`;
          if (isStudent) {
            const now = Date.now();
            const previous = vodPermits.get(permitKey);
            const token = previous?.expiresAt > now ? previous.token : crypto.randomBytes(24).toString('base64url');
            vodPermits.set(permitKey, { token, expiresAt: now + VOD_PERMIT_TTL_MS });
            fileUrl += `?permit=${token}`;
          }
          return sendJson(res, 200, { url: fileUrl });
        }
        if (isStudent) {
          const dest = req.headers['sec-fetch-dest'];
          if (url.searchParams.get('download') === '1' || req.headers['sec-fetch-site'] === 'cross-site' || (dest && dest !== 'video')) {
            return sendJson(res, 403, { error: '请通过工作台播放器观看' });
          }
          if (!validPermit()) {
            return sendJson(res, 403, { error: '播放凭证已失效，请重新播放' });
          }
          res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        }
        const allowDownload = !isStudent && url.searchParams.get('download') === '1';
        const diskPath = path.join(uploadDir, vod.stored_name);
        const checkAccess = isStudent ? () => validPermit() && store.getSession(session.token)
          && store.canStudentAccessVod(session.linkedId, store.getVodLesson(vod.id)) : undefined;
        await streamMediaFile(req, res, diskPath, vod.mime_type, vod.filename, allowDownload, { noStore: true, checkAccess });
        return;
      }

      if (pathname.startsWith('/api/vod/') && method === 'PATCH') {
        requireTeacher(session);
        const id = pathname.slice('/api/vod/'.length);
        const vod = store.getVodLesson(id);
        if (!vod) return sendJson(res, 404, { error: '录播课不存在' });
        if (session.role === 'teacher' && !store.canTeacherAccessCourse(session.linkedId, vod.course_id)) {
          return sendJson(res, 403, { error: '无权修改该课程的录播课' });
        }
        const body = await readJsonBody(req);
        store.updateVodLesson(id, body);
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      if (pathname.startsWith('/api/vod/') && method === 'DELETE') {
        requireTeacher(session);
        const id = pathname.slice('/api/vod/'.length);
        const vod = store.getVodLesson(id);
        if (!vod) return sendJson(res, 404, { error: '录播课不存在' });
        if (session.role === 'teacher' && !store.canTeacherAccessCourse(session.linkedId, vod.course_id)) {
          return sendJson(res, 403, { error: '无权删除该课程的录播课' });
        }
        const removed = store.deleteVodLesson(id);
        if (removed) await fsp.unlink(path.join(uploadDir, removed.stored_name)).catch(() => {});
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      if (pathname === '/api/progress' && method === 'POST') {
        requireAuth(session);
        const body = await readJsonBody(req);
        const studentId = session.role === 'student' ? session.linkedId : body.studentId;
        if (!studentId) return sendJson(res, 200, { ok: true, progress: null, playbackProgress: store.getPlaybackProgressForUser(session) });
        const progress = store.savePlaybackProgress({ ...body, studentId });
        return sendJson(res, 200, {
          ok: true,
          progress,
          playbackProgress: store.getPlaybackProgressForUser(session)
        });
      }

      // --- 10. 讲义与板书资料（原始二进制流上传 + 权限校验读取） ---
      if (pathname === '/api/materials/upload' && method === 'POST') {
        requireTeacher(session);
        const scope = url.searchParams.get('scope') || 'lesson';
        const targetId = url.searchParams.get('targetId');
        const category = url.searchParams.get('category') || '课前讲义';
        const safeOriginal = path.basename(url.searchParams.get('filename') || 'material.pdf');
        const mimeType = req.headers['content-type'] || 'application/octet-stream';
        if (!targetId) throw new TypeError('缺少关联课程或课次');
        store.assertMaterialTargetExists(scope, targetId);
        if (session.role === 'teacher') {
          const allowed = scope === 'course'
            ? store.canTeacherAccessCourse(session.linkedId, targetId)
            : store.canTeacherAccessLesson(session.linkedId, targetId);
          if (!allowed) return sendJson(res, 403, { error: '无权向该课程或课次上传资料' });
        }
        const MAX_MATERIAL_BYTES = 100 * 1024 * 1024;
        const storedName = `${Date.now()}_${crypto.randomUUID().slice(0, 6)}_${safeOriginal}`;
        const diskPath = path.join(uploadDir, storedName);
        const matSize = await streamRequestToFile(req, diskPath, {
          maxBytes: MAX_MATERIAL_BYTES,
          emptyError: '上传文件为空',
          limitError: '单个资料文件不能超过 100 MB'
        });
        const id = store.createMaterial({
          scope,
          targetId,
          category,
          filename: safeOriginal,
          storedName,
          mimeType,
          sizeBytes: matSize
        });
        return sendJson(res, 201, { id, state: store.getSnapshotForUser(session) });
      }

      const fileMatch = pathname.match(/^\/api\/materials\/([^/]+)\/file$/);
      if (fileMatch && method === 'GET') {
        requireAuth(session);
        const mat = store.getMaterial(fileMatch[1]);
        if (!mat) return sendJson(res, 404, { error: '文件不存在' });
        if (session.role === 'student' && !store.canStudentAccessMaterial(session.linkedId, mat)) {
          return sendJson(res, 403, { error: '非本班/本课程在读学生，无权访问该讲义或板书' });
        }
        if (session.role === 'teacher' && !store.canTeacherAccessMaterial(session.linkedId, mat)) {
          return sendJson(res, 403, { error: '无权访问非本人授课的资料' });
        }
        const diskPath = path.join(uploadDir, mat.stored_name);
        await streamMediaFile(req, res, diskPath, mat.mime_type, mat.filename, url.searchParams.get('download') === '1', { sandboxInline: true });
        return;
      }

      if (pathname.startsWith('/api/materials/') && method === 'PATCH') {
        requireTeacher(session);
        const id = pathname.slice('/api/materials/'.length);
        const mat = store.getMaterial(id);
        if (!mat) return sendJson(res, 404, { error: '资料不存在' });
        if (session.role === 'teacher' && !store.canTeacherAccessMaterial(session.linkedId, mat)) {
          return sendJson(res, 403, { error: '无权修改非本人授课的资料' });
        }
        const body = await readJsonBody(req);
        store.updateMaterial({ id, category: body.category, filename: body.filename });
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      if (pathname.startsWith('/api/materials/') && method === 'DELETE') {
        requireTeacher(session);
        const id = pathname.slice('/api/materials/'.length);
        const mat = store.getMaterial(id);
        if (mat && session.role === 'teacher' && !store.canTeacherAccessMaterial(session.linkedId, mat)) {
          return sendJson(res, 403, { error: '无权删除非本人授课的资料' });
        }
        const removed = store.deleteMaterial(id);
        if (removed) await fsp.unlink(path.join(uploadDir, removed.stored_name)).catch(() => {});
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      // --- 11. 课程群（按课程在读/授课资格统一校验 + SSE 实时推送） ---
      if (pathname === '/api/qa/stream' && method === 'GET') {
        requireAuth(session);
        const clientId = url.searchParams.get('clientId') || crypto.randomUUID().slice(0, 8);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        const heartbeat = setInterval(() => {
          try { res.write(': ping\n\n'); } catch {}
        }, 25000);
        heartbeat.unref?.();
        qaClients.set(clientId, { res, heartbeat, session });
        res.write(`event: ready\ndata: ${JSON.stringify({ clientId })}\n\n`);
        req.on('close', () => {
          clearInterval(heartbeat);
          qaClients.delete(clientId);
        });
        return;
      }

      if (pathname === '/api/qa/members' && method === 'GET') {
        requireAuth(session);
        const courseId = String(url.searchParams.get('courseId') || '').trim();
        if (!courseId) return sendJson(res, 400, { error: '缺少 courseId' });
        if (!canSessionAccessCourse(session, courseId)) {
          return sendJson(res, 403, { error: '无权查看该课程群成员' });
        }
        return sendJson(res, 200, store.getCourseMembers(courseId));
      }

      if (pathname === '/api/qa/messages' && method === 'GET') {
        requireAuth(session);
        const courseId = String(url.searchParams.get('courseId') || '').trim();
        if (!courseId) return sendJson(res, 400, { error: '缺少 courseId' });
        if (!canSessionAccessCourse(session, courseId)) {
          return sendJson(res, 403, { error: '无权查看该课程群消息' });
        }
        const beforeMs = Number(url.searchParams.get('beforeMs') || 0);
        const limit = Number(url.searchParams.get('limit') || 40);
        return sendJson(res, 200, store.listQaPostsPage({ courseId, beforeMs, limit }));
      }

      if (pathname === '/api/qa/read' && method === 'POST') {
        requireAuth(session);
        const body = await readJsonBody(req);
        const courseId = String(body.courseId || '').trim();
        if (!courseId || !canSessionAccessCourse(session, courseId)) {
          return sendJson(res, 403, { error: '无权访问该课程群' });
        }
        const lastReadMs = Number(body.lastReadMs) || Date.now();
        store.markQaRead(session.accountId, courseId, lastReadMs);
        return sendJson(res, 200, { ok: true, courseId, lastReadMs });
      }

      if (pathname === '/api/qa/upload' && method === 'POST') {
        requireAuth(session);
        const courseId = String(url.searchParams.get('courseId') || '').trim();
        if (!courseId || !canSessionAccessCourse(session, courseId)) {
          return sendJson(res, 403, { error: '无权在该课程群上传文件' });
        }
        const rawFilename = url.searchParams.get('filename') || 'attachment';
        const safeOriginal = path.basename(String(rawFilename || 'attachment')).replace(/[\r\n\0]/g, '') || 'attachment';
        const mimeType = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
        const MAX_QA_BYTES = 20 * 1024 * 1024;
        const storedName = `qa_${Date.now()}_${crypto.randomUUID().slice(0, 6)}_${safeOriginal}`;
        const diskPath = path.join(uploadDir, storedName);
        const qaSize = await streamRequestToFile(req, diskPath, {
          maxBytes: MAX_QA_BYTES,
          emptyError: '上传文件为空',
          limitError: '单个附件不能超过 20 MB'
        });
        const isImage = mimeType.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(safeOriginal);
        return sendJson(res, 201, {
          id: `att_${crypto.randomUUID().slice(0, 8)}`,
          filename: safeOriginal,
          storedName,
          mimeType,
          sizeBytes: qaSize,
          isImage
        });
      }

      const qaAttMatch = pathname.match(/^\/api\/qa\/([^/]+)\/attachments\/([^/]+)$/);
      if (qaAttMatch && method === 'GET') {
        requireAuth(session);
        const post = store.getQaPost(qaAttMatch[1]);
        if (!post) return sendJson(res, 404, { error: '消息不存在' });
        if (!canSessionAccessCourse(session, post.course_id)) {
          return sendJson(res, 403, { error: '无权访问该课程群附件' });
        }
        const att = (post.attachments || []).find(a => a.id === qaAttMatch[2]);
        if (!att) return sendJson(res, 404, { error: '附件不存在' });
        const diskPath = path.join(uploadDir, att.storedName);
        const download = url.searchParams.get('download') === '1' || !att.isImage;
        await streamMediaFile(req, res, diskPath, att.mimeType, att.filename, download, { sandboxInline: true });
        return;
      }

      if (pathname === '/api/qa' && method === 'POST') {
        requireAuth(session);
        const body = await readJsonBody(req);
        if (session.role === 'student' && !store.canStudentAccessCourse(session.linkedId, body.courseId)) {
          return sendJson(res, 403, { error: '未在读或已退出该课程，无权在此课程群发言' });
        }
        if (session.role === 'teacher' && !store.canTeacherAccessCourse(session.linkedId, body.courseId)) {
          return sendJson(res, 403, { error: '非本课程授课教师，无权在此课程群发言' });
        }
        if ((body.msgType === 'announcement' || body.pinned) && session.role === 'student') {
          return sendJson(res, 403, { error: '仅教师或管理员可发布群公告或置顶消息' });
        }
        if (session.role === 'student' && body.card) {
          return sendJson(res, 403, { error: '学生暂不支持发送资源卡片' });
        }
        if (session.role === 'student') {
          const rl = store.checkStudentQaRateLimit(session.linkedId, 60000, 5);
          if (!rl.allowed) {
            return sendJson(res, 429, { error: `发言过于频繁：60 秒内最多发言 5 条，请约 ${rl.retryAfterSec} 秒后再试` });
          }
        }
        const normalizedMsgType = (session.role !== 'student' && body.msgType === 'question')
          ? 'chat'
          : body.msgType;
        const id = store.createQaPost({
          ...body,
          msgType: normalizedMsgType,
          card: session.role === 'student' ? null : body.card,
          authorName: session.name,
          authorRole: session.role,
          authorId: session.linkedId
        });
        const post = store.getQaPost(id);
        store.markQaRead(session.accountId, post.course_id, post.created_ms || Date.now());
        broadcastQa(post.course_id, 'qa_post', { post });
        if (url.searchParams.get('lite') === '1') {
          return sendJson(res, 201, { id, post });
        }
        return sendJson(res, 201, { id, post, state: store.getSnapshotForUser(session) });
      }

      const qaReplyMatch = pathname.match(/^\/api\/qa\/([^/]+)\/replies$/);
      if (qaReplyMatch && method === 'POST') {
        requireAuth(session);
        const post = store.getQaPost(qaReplyMatch[1]);
        if (!post) return sendJson(res, 404, { error: '消息不存在' });
        if (session.role === 'student' && !store.canStudentAccessCourse(session.linkedId, post.course_id)) {
          return sendJson(res, 403, { error: '无权回复该课程群消息' });
        }
        if (session.role === 'teacher' && !store.canTeacherAccessCourse(session.linkedId, post.course_id)) {
          return sendJson(res, 403, { error: '非本课程授课教师，无权回复该课程群消息' });
        }
        if (session.role === 'student') {
          const rl = store.checkStudentQaRateLimit(session.linkedId, 60000, 5);
          if (!rl.allowed) {
            return sendJson(res, 429, { error: `发言过于频繁：60 秒内最多发言 5 条，请约 ${rl.retryAfterSec} 秒后再试` });
          }
        }
        const body = await readJsonBody(req);
        const replyId = store.addQaReply({
          postId: post.id,
          authorName: session.name,
          authorRole: session.role,
          authorId: session.linkedId,
          content: body.content
        });
        const reply = store.getQaReply(replyId);
        broadcastQa(post.course_id, 'qa_reply', { courseId: post.course_id, reply });
        if (url.searchParams.get('lite') === '1') {
          return sendJson(res, 201, { reply });
        }
        return sendJson(res, 201, store.getSnapshotForUser(session));
      }

      const qaReplyDelMatch = pathname.match(/^\/api\/qa\/replies\/([^/]+)$/);
      if (qaReplyDelMatch && method === 'DELETE') {
        requireAuth(session);
        const reply = store.getQaReply(qaReplyDelMatch[1]);
        if (!reply) return sendJson(res, 404, { error: '回复不存在' });
        const post = store.getQaPost(reply.post_id);
        if (!post) return sendJson(res, 404, { error: '原消息不存在' });
        const isOwner = reply.author_id && reply.author_id === session.linkedId && reply.author_role === session.role;
        if (session.role === 'student' && !isOwner) {
          return sendJson(res, 403, { error: '仅可撤回本人回复' });
        }
        if (session.role === 'teacher') {
          if (!store.canTeacherAccessCourse(session.linkedId, post.course_id)) {
            return sendJson(res, 403, { error: '非本课程授课教师，无权删除该回复' });
          }
          if (reply.author_role !== 'student' && !isOwner) {
            return sendJson(res, 403, { error: '教师仅可删除学生回复或撤回本人回复' });
          }
        }
        store.deleteQaReply(reply.id);
        broadcastQa(post.course_id, 'qa_reply_delete', { courseId: post.course_id, postId: post.id, replyId: reply.id });
        if (url.searchParams.get('lite') === '1') {
          return sendJson(res, 200, { ok: true, replyId: reply.id });
        }
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      const qaResolveMatch = pathname.match(/^\/api\/qa\/([^/]+)\/resolve$/);
      if (qaResolveMatch && method === 'PATCH') {
        requireTeacher(session);
        const post = store.getQaPost(qaResolveMatch[1]);
        if (!post) return sendJson(res, 404, { error: '消息不存在' });
        if (session.role === 'teacher' && !store.canTeacherAccessCourse(session.linkedId, post.course_id)) {
          return sendJson(res, 403, { error: '非本课程授课教师，无权修改该课程群状态' });
        }
        const body = await readJsonBody(req);
        const updated = store.toggleQaResolved(post.id, body.resolved);
        broadcastQa(post.course_id, 'qa_update', { post: updated });
        if (url.searchParams.get('lite') === '1') {
          return sendJson(res, 200, { post: updated });
        }
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      const qaPinMatch = pathname.match(/^\/api\/qa\/([^/]+)\/pin$/);
      if (qaPinMatch && method === 'PATCH') {
        requireTeacher(session);
        const post = store.getQaPost(qaPinMatch[1]);
        if (!post) return sendJson(res, 404, { error: '消息不存在' });
        if (session.role === 'teacher' && !store.canTeacherAccessCourse(session.linkedId, post.course_id)) {
          return sendJson(res, 403, { error: '非本课程授课教师，无权置顶该消息' });
        }
        const body = await readJsonBody(req);
        const updated = store.toggleQaPinned(post.id, body.pinned);
        broadcastQa(post.course_id, 'qa_update', { post: updated });
        if (url.searchParams.get('lite') === '1') {
          return sendJson(res, 200, { post: updated });
        }
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      if (pathname === '/api/qa/batch-delete' && method === 'POST') {
        requireTeacher(session);
        const body = await readJsonBody(req);
        const courseId = String(body.courseId || '').trim();
        const postIds = Array.isArray(body.postIds) ? body.postIds : [];
        if (!courseId || !postIds.length) {
          return sendJson(res, 400, { error: '请选择课程和要删除的消息' });
        }
        if (session.role === 'teacher' && !store.canTeacherAccessCourse(session.linkedId, courseId)) {
          return sendJson(res, 403, { error: '非本课程授课教师，无权删除该课程群消息' });
        }
        if (session.role === 'teacher') {
          for (const pid of postIds) {
            const p = store.getQaPost(pid);
            if (p && p.course_id === courseId && !p.recall_kind && p.author_role !== 'student') {
              return sendJson(res, 403, { error: '教师仅可批量删除学生发送的消息' });
            }
          }
        }
        const results = store.deleteQaPostsBatch(courseId, postIds, {
          actorName: session.name,
          actorRole: session.role
        });
        const updatedPosts = [];
        for (const item of results) {
          if (item.removed && Array.isArray(item.removed.attachments)) {
            for (const att of item.removed.attachments) {
              if (att && att.storedName) {
                await fsp.unlink(path.join(uploadDir, att.storedName)).catch(() => {});
              }
            }
          }
          if (item.post) {
            updatedPosts.push(item.post);
            broadcastQa(courseId, 'qa_update', { post: item.post });
          }
        }
        return sendJson(res, 200, { ok: true, count: updatedPosts.length, posts: updatedPosts });
      }

        if (pathname.startsWith('/api/qa/') && method === 'DELETE') {
        requireAuth(session);
        const id = pathname.slice('/api/qa/'.length);
        const post = store.getQaPost(id);
        if (!post || post.recall_kind) return sendJson(res, 404, { error: '消息不存在' });
        const isSelfPost = post.author_id === session.linkedId && post.author_role === session.role;
        let kind = 'delete';
        if (session.role === 'student') {
          if (!isSelfPost) {
            return sendJson(res, 403, { error: '学生仅可撤回本人发送的消息' });
          }
          if (Date.now() - Number(post.created_ms || 0) > 2 * 60 * 1000) {
            return sendJson(res, 403, { error: '仅可撤回 2 分钟内发送的消息' });
          }
          kind = 'recall';
        } else if (session.role === 'teacher') {
          if (!store.canTeacherAccessCourse(session.linkedId, post.course_id)) {
            return sendJson(res, 403, { error: '非本课程授课教师，无权操作该课程群消息' });
          }
          if (isSelfPost) {
            kind = 'recall';
          } else if (post.author_role === 'student') {
            kind = 'delete';
          } else {
            return sendJson(res, 403, { error: '教师仅可删除学生的消息或撤回本人发送的消息' });
          }
        }
        const { removed, post: updatedPost } = store.deleteQaPost(id, {
          kind,
          actorName: session.name,
          actorRole: session.role
        });
        if (removed && Array.isArray(removed.attachments)) {
          for (const att of removed.attachments) {
            if (att && att.storedName) {
              await fsp.unlink(path.join(uploadDir, att.storedName)).catch(() => {});
            }
          }
        }
        if (updatedPost) {
          broadcastQa(post.course_id, 'qa_update', { post: updatedPost });
        }
        if (url.searchParams.get('lite') === '1') {
          return sendJson(res, 200, { ok: true, postId: id, post: updatedPost });
        }
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      // --- 8.5 课程作业与批改 ---
      if (pathname === '/api/homework/upload' && method === 'POST') {
        requireAuth(session);
        const courseId = String(url.searchParams.get('courseId') || '').trim();
        const kind = String(url.searchParams.get('kind') || 'attachment').trim();
        if (!courseId || !canSessionAccessCourse(session, courseId)) {
          return sendJson(res, 403, { error: '无权在该课程上传作业文件' });
        }
        if (kind === 'submission') {
          if (session.role !== 'student') {
            return sendJson(res, 403, { error: '仅学生可上传作业提交图片' });
          }
        } else if (kind === 'attachment' || kind === 'graded') {
          requireTeacher(session);
        } else {
          return sendJson(res, 400, { error: '不支持的上传类型' });
        }

        const rawFilename = url.searchParams.get('filename') || 'file';
        const safeOriginal = path.basename(String(rawFilename || 'file')).replace(/[\r\n\0]/g, '') || 'file';
        const mimeType = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
        const isImage = mimeType.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(safeOriginal);
        if ((kind === 'submission' || kind === 'graded') && !isImage) {
          return sendJson(res, 400, { error: '作业提交与批改仅支持图片文件' });
        }

        const MAX_HW_BYTES = 20 * 1024 * 1024;
        const storedName = `hw_${Date.now()}_${crypto.randomUUID().slice(0, 6)}_${safeOriginal}`;
        const diskPath = path.join(uploadDir, storedName);
        const hwSize = await streamRequestToFile(req, diskPath, {
          maxBytes: MAX_HW_BYTES,
          emptyError: '上传文件为空',
          limitError: '单个文件不能超过 20 MB'
        });
        return sendJson(res, 201, {
          id: `hwf_${crypto.randomUUID().slice(0, 8)}`,
          filename: safeOriginal,
          storedName,
          mimeType,
          sizeBytes: hwSize,
          isImage
        });
      }

      const hwAttMatch = pathname.match(/^\/api\/homework\/([^/]+)\/attachments\/([^/]+)$/);
      if (hwAttMatch && method === 'GET') {
        requireAuth(session);
        const hw = store.getHomework(hwAttMatch[1]);
        if (!hw) return sendJson(res, 404, { error: '作业不存在' });
        if (!canSessionAccessCourse(session, hw.course_id)) {
          return sendJson(res, 403, { error: '无权访问该作业附件' });
        }
        const att = (hw.attachments || []).find(a => a.id === hwAttMatch[2]);
        if (!att) return sendJson(res, 404, { error: '附件不存在' });
        const diskPath = path.join(uploadDir, att.storedName);
        const isInlineSafe = att.isImage || att.mimeType === 'application/pdf';
        const download = url.searchParams.get('download') === '1' || !isInlineSafe;
        await streamMediaFile(req, res, diskPath, att.mimeType, att.filename, download, { sandboxInline: true });
        return;
      }

      const hwSubFileMatch = pathname.match(/^\/api\/homework-submissions\/([^/]+)\/files\/([^/]+)$/);
      if (hwSubFileMatch && method === 'GET') {
        requireAuth(session);
        const sub = store.getHomeworkSubmission(hwSubFileMatch[1]);
        if (!sub) return sendJson(res, 404, { error: '提交记录不存在' });
        if (session.role === 'student') {
          if (sub.student_id !== session.linkedId) {
            return sendJson(res, 403, { error: '无权查看其他学生的作业' });
          }
        } else if (!canSessionAccessCourse(session, sub.course_id)) {
          return sendJson(res, 403, { error: '无权查看该课程的作业提交' });
        }
        const file = [...(sub.images || []), ...(sub.gradedImages || [])].find(f => f.id === hwSubFileMatch[2]);
        if (!file) return sendJson(res, 404, { error: '图片不存在' });
        const diskPath = path.join(uploadDir, file.storedName);
        const download = url.searchParams.get('download') === '1';
        await streamMediaFile(req, res, diskPath, file.mimeType, file.filename, download, { sandboxInline: true });
        return;
      }

      if (pathname === '/api/homeworks' && method === 'POST') {
        requireTeacher(session);
        const body = await readJsonBody(req);
        const courseId = String(body.courseId || '').trim();
        if (!courseId || !canSessionAccessCourse(session, courseId)) {
          return sendJson(res, 403, { error: '无权为该课程布置作业' });
        }
        const homework = store.createHomework({
          courseId,
          teacherId: session.role === 'teacher' ? session.linkedId : '',
          creatorName: session.name,
          title: body.title,
          content: body.content,
          contentFormat: body.contentFormat,
          attachments: body.attachments,
          dueDate: body.dueDate
        });
        return sendJson(res, 201, { homework, snapshot: store.getSnapshotForUser(session) });
      }

      const hwItemMatch = pathname.match(/^\/api\/homeworks\/([^/]+)$/);
      if (hwItemMatch && method === 'PATCH') {
        requireTeacher(session);
        const hw = store.getHomework(hwItemMatch[1]);
        if (!hw) return sendJson(res, 404, { error: '作业不存在' });
        if (!canSessionAccessCourse(session, hw.course_id)) {
          return sendJson(res, 403, { error: '无权修改该作业' });
        }
        const body = await readJsonBody(req);
        const { homework, removedStoredNames } = store.updateHomework(hw.id, body);
        await unlinkStoredFiles(removedStoredNames);
        return sendJson(res, 200, { homework, snapshot: store.getSnapshotForUser(session) });
      }

      if (hwItemMatch && method === 'DELETE') {
        requireTeacher(session);
        const hw = store.getHomework(hwItemMatch[1]);
        if (!hw) return sendJson(res, 404, { error: '作业不存在' });
        if (!canSessionAccessCourse(session, hw.course_id)) {
          return sendJson(res, 403, { error: '无权删除该作业' });
        }
        const { storedNames } = store.deleteHomework(hw.id);
        await unlinkStoredFiles(storedNames);
        return sendJson(res, 200, store.getSnapshotForUser(session));
      }

      const hwSubmitMatch = pathname.match(/^\/api\/homeworks\/([^/]+)\/submit$/);
      if (hwSubmitMatch && method === 'POST') {
        requireAuth(session);
        if (session.role !== 'student') {
          return sendJson(res, 403, { error: '仅学生可提交作业' });
        }
        const hw = store.getHomework(hwSubmitMatch[1]);
        if (!hw) return sendJson(res, 404, { error: '作业不存在' });
        if (!canSessionAccessCourse(session, hw.course_id)) {
          return sendJson(res, 403, { error: '无权提交该课程的作业' });
        }
        const body = await readJsonBody(req);
        const { submission, removedStoredNames } = store.upsertHomeworkSubmission({
          homeworkId: hw.id,
          studentId: session.linkedId,
          images: body.images,
          note: body.note
        });
        await unlinkStoredFiles(removedStoredNames);
        return sendJson(res, 200, { submission, snapshot: store.getSnapshotForUser(session) });
      }

      const hwGradeMatch = pathname.match(/^\/api\/homework-submissions\/([^/]+)\/grade$/);
      if (hwGradeMatch && method === 'POST') {
        requireTeacher(session);
        const sub = store.getHomeworkSubmission(hwGradeMatch[1]);
        if (!sub) return sendJson(res, 404, { error: '提交记录不存在' });
        if (!canSessionAccessCourse(session, sub.course_id)) {
          return sendJson(res, 403, { error: '无权批改该课程的作业' });
        }
        const body = await readJsonBody(req);
        const { submission, removedStoredNames } = store.gradeHomeworkSubmission(sub.id, {
          score: body.score,
          feedback: body.feedback,
          gradedImages: body.gradedImages,
          gradedBy: session.name
        });
        await unlinkStoredFiles(removedStoredNames);
        return sendJson(res, 200, { submission, snapshot: store.getSnapshotForUser(session) });
      }

      // --- 9. 回放/录播时间戳书签（关联讲义页码或题号） ---
      if (pathname === '/api/bookmarks' && method === 'GET') {
        requireAuth(session);
        const targetType = url.searchParams.get('targetType') || '';
        const targetId = url.searchParams.get('targetId') || '';
        if (targetType === 'recording') {
          if (session.role === 'teacher') {
            const rec = store.getRecording(targetId);
            if (!rec || !store.canTeacherAccessLesson(session.linkedId, rec.lesson_id)) {
              return sendJson(res, 403, { error: '无权查看该回放书签' });
            }
          } else if (session.role === 'student' && !store.canStudentAccessRecording(session.linkedId, targetId)) {
            return sendJson(res, 403, { error: '无权查看该回放书签' });
          }
        } else if (targetType === 'vod') {
          if (session.role === 'teacher') {
            const vod = store.getVodLesson(targetId);
            if (!vod || !store.canTeacherAccessCourse(session.linkedId, vod.course_id)) {
              return sendJson(res, 403, { error: '无权查看该录播书签' });
            }
          } else if (session.role === 'student' && !store.canStudentAccessVod(session.linkedId, targetId)) {
            return sendJson(res, 403, { error: '无权查看该录播书签' });
          }
        }
        return sendJson(res, 200, { bookmarks: store.listPlaybackBookmarks(targetType, targetId) });
      }

      if (pathname === '/api/bookmarks' && method === 'POST') {
        requireTeacher(session);
        const body = await readJsonBody(req);
        if (session.role === 'teacher') {
          if (body.targetType === 'recording') {
            const rec = store.getRecording(body.targetId);
            if (!rec || !store.canTeacherAccessLesson(session.linkedId, rec.lesson_id)) {
              return sendJson(res, 403, { error: '无权为该回放添加书签' });
            }
          } else if (body.targetType === 'vod') {
            const vod = store.getVodLesson(body.targetId);
            if (!vod || !store.canTeacherAccessCourse(session.linkedId, vod.course_id)) {
              return sendJson(res, 403, { error: '无权为该录播添加书签' });
            }
          }
        }
        const bookmark = store.createPlaybackBookmark({
          ...body,
          authorId: session.accountId,
          authorName: session.name
        });
        return sendJson(res, 201, { bookmark });
      }

      const bookmarkDelMatch = pathname.match(/^\/api\/bookmarks\/([^/]+)$/);
      if (bookmarkDelMatch && method === 'DELETE') {
        requireTeacher(session);
        const removed = store.deletePlaybackBookmark(bookmarkDelMatch[1]);
        if (session.role === 'teacher') {
          if (removed.target_type === 'recording') {
            const rec = store.getRecording(removed.target_id);
            if (rec && !store.canTeacherAccessLesson(session.linkedId, rec.lesson_id)) {
              return sendJson(res, 403, { error: '无权删除该书签' });
            }
          } else if (removed.target_type === 'vod') {
            const vod = store.getVodLesson(removed.target_id);
            if (vod && !store.canTeacherAccessCourse(session.linkedId, vod.course_id)) {
              return sendJson(res, 403, { error: '无权删除该书签' });
            }
          }
        }
        return sendJson(res, 200, { ok: true, id: removed.id });
      }

      // --- 静态页面服务（仅白名单公开前端入口，严禁暴露 data/、src/ 等项目文件） ---
      if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        await sendStaticFile(req, res, path.join(ROOT, 'index.html'), 'text/html; charset=utf-8');
        return;
      }
      if (method === 'GET' && pathname.startsWith('/public/')) {
        const publicRoot = path.join(ROOT, 'public');
        const rel = pathname.slice('/public/'.length);
        const targetPath = path.resolve(publicRoot, rel);
        if (targetPath.startsWith(publicRoot + path.sep)) {
          const ext = path.extname(targetPath).toLowerCase();
          const mime = MIME_TYPES[ext];
          if (mime && fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
            await sendStaticFile(req, res, targetPath, mime, { cacheControl: 'public, no-cache' });
            return;
          }
        }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (err) {
      const code = err.statusCode || (err instanceof TypeError || err instanceof RangeError ? 400 : 500);
      if (req.url?.startsWith('/api/')) {
        sendJson(res, code, { error: err.message || '操作失败' });
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
      }
    }
  });

  server.on('close', () => {
    dshManager.stop().catch(() => {});
    clearInterval(recCleanupTimer);
    clearInterval(vodPermitCleanup);
    for (const [lessonId, room] of liveRooms.entries()) {
      flushWhiteboard(lessonId);
      for (const client of room.clients.values()) {
        clearInterval(client.heartbeat);
        try { client.res.end(); } catch {}
      }
    }
    for (const client of qaClients.values()) {
      clearInterval(client.heartbeat);
      try { client.res.end(); } catch {}
    }
    qaClients.clear();
    liveRooms.clear();
    try { store.db.close(); } catch {}
  });

  server.store = store;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const { instance: dataInstance, dir: dataDir } = getActiveData();
  const host = process.env.WORKBENCH_HOST || undefined;
  const server = createServer({ dbPath: path.join(dataDir, 'workbench.db'), uploadDir: path.join(dataDir, 'uploads'), dataInstance });
  server.listen(port, host, () => {
    console.log(`教培工作台已启动: http://${host || 'localhost'}:${port}`);
  });
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`收到 ${signal}，正在保存白板并关闭服务...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

function withTempServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-opt-'));
  const dbPath = path.join(tmpDir, 'workbench.db');
  const uploadDir = path.join(tmpDir, 'uploads');
  const server = createServer({ dbPath, uploadDir });
  return { tmpDir, dbPath, uploadDir, server };
}

async function startServer(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function reqJson(base, p, { method = 'GET', body, cookie, headers = {} } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const setCookie = res.headers.get('set-cookie');
  const data = await res.json().catch(() => null);
  return { status: res.status, data, setCookie, headers: res.headers };
}

test('SQLite WAL、版本化迁移与高频索引已启用', async () => {
  const { tmpDir, server } = withTempServer();
  try {
    const { db } = server.store;
    const jm = db.prepare('PRAGMA journal_mode').get();
    assert.equal(jm.journal_mode, 'wal');
    const uv = db.prepare('PRAGMA user_version').get();
    assert.ok(uv.user_version >= 2);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all().map(r => r.name);
    assert.ok(indexes.includes('idx_sessions_expires_at'));
    assert.ok(indexes.includes('idx_lessons_org_start'));
    assert.ok(indexes.includes('idx_playback_bookmarks_target'));
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('前端拆分静态资源、ETag 缓存、gzip 压缩、安全响应头与防路径穿越', async () => {
  const { tmpDir, server } = withTempServer();
  try {
    const base = await startServer(server);
    const res = await fetch(`${base}/`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    const etag = res.headers.get('etag');
    assert.ok(etag);

    const notMod = await fetch(`${base}/`, { headers: { 'If-None-Match': etag } });
    assert.equal(notMod.status, 304);

    const cssRes = await fetch(`${base}/public/styles/app.css`);
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers.get('content-type') || '', /text\/css/);

    const jsRes = await fetch(`${base}/public/js/utils.js`);
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get('content-type') || '', /javascript/);

    const traversalRes = await fetch(`${base}/public/../src/server.js`);
    assert.equal(traversalRes.status, 404);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('登录防爆破限流、流式上传大小拦截、备份轮转校验、书签权限隔离与课程名额并发保护', async () => {
  const { tmpDir, uploadDir, server } = withTempServer();
  try {
    const base = await startServer(server);

    // 1. 初始化管理员
    const setup = await reqJson(base, '/api/setup', {
      method: 'POST',
      body: { name: '王老师', username: '13800000001', password: 'password123', subject: '数学' }
    });
    assert.equal(setup.status, 201);
    const adminCookie = setup.setCookie.split(';')[0];

    // 2. 登录限流测试（连续 15 次失败后第 16 次返回 429）
    for (let i = 0; i < 15; i++) {
      const bad = await reqJson(base, '/api/login', {
        method: 'POST',
        body: { username: '13800000001', password: 'wrong' }
      });
      assert.equal(bad.status, 401);
    }
    const throttled = await reqJson(base, '/api/login', {
      method: 'POST',
      body: { username: '13800000001', password: 'wrong' }
    });
    assert.equal(throttled.status, 429);

    // 3. 流式上传大小前置/中途拦截（超过 5MB Logo 返回 413 且无残留文件）
    const bigBuf = Buffer.alloc(5 * 1024 * 1024 + 64, 0x41);
    const logoRes = await fetch(`${base}/api/org/logo?filename=big.png`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'image/png' },
      body: bigBuf
    });
    assert.equal(logoRes.status, 413);
    assert.equal(fs.readdirSync(uploadDir).length, 0);

    // 4. 创建课程（人数上限 1）与并发报名竞态测试
    const courseRes = await reqJson(base, '/api/courses', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: '高三导数限额班', subject: '数学', mode: '直播课', capacity: 1 }
    });
    assert.equal(courseRes.status, 201);
    const courseId = courseRes.data.id;

    const s1 = await reqJson(base, '/api/students', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: '学生甲', phone: '13900000001', username: 'stu_alpha', password: 'password123' }
    });
    const s2 = await reqJson(base, '/api/students', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: '学生乙', phone: '13900000002', username: 'stu_beta', password: 'password123' }
    });
    const [e1, e2] = await Promise.all([
      reqJson(base, '/api/enrollments', { method: 'POST', cookie: adminCookie, body: { courseId, studentId: s1.data.id } }),
      reqJson(base, '/api/enrollments', { method: 'POST', cookie: adminCookie, body: { courseId, studentId: s2.data.id } })
    ]);
    const statuses = [e1.status, e2.status].sort();
    assert.deepEqual(statuses, [201, 409]);

    // 5. 录播与时间戳书签 + 学生权限隔离
    const vodUpload = await fetch(`${base}/api/vod/upload?courseId=${courseId}&chapterName=第一章&title=导数基础&filename=vod1.mp4`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'video/mp4' },
      body: Buffer.from('fake-mp4-content')
    });
    assert.equal(vodUpload.status, 201);
    const vodId = (await vodUpload.json()).id;

    const bmkCreate = await reqJson(base, '/api/bookmarks', {
      method: 'POST',
      cookie: adminCookie,
      body: { targetType: 'vod', targetId: vodId, timeSec: 125.4, label: '例题3 极值点偏移', refTag: '讲义P4 题3' }
    });
    assert.equal(bmkCreate.status, 201);
    assert.equal(bmkCreate.data.bookmark.time_sec, 125.4);

    // 未报名学生无权查看该录播书签
    const unEnrolledStudentId = e1.status === 201 ? s2.data.id : s1.data.id;
    const accRes = await reqJson(base, '/api/accounts', {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'stu_unenrolled', password: 'password123', role: 'student', linkedId: unEnrolledStudentId, name: '未报名学生' }
    });
    assert.equal(accRes.status, 201);
    const stuLogin = await reqJson(base, '/api/login', {
      method: 'POST',
      body: { username: 'stu_unenrolled', password: 'password123' }
    });
    assert.equal(stuLogin.status, 200);
    const stuCookie = stuLogin.setCookie.split(';')[0];
    const forbiddenBmk = await reqJson(base, `/api/bookmarks?targetType=vod&targetId=${vodId}`, { cookie: stuCookie });
    assert.equal(forbiddenBmk.status, 403);
    const grant = await reqJson(base, '/api/trials', {
      method: 'POST',
      cookie: adminCookie,
      body: { studentId: unEnrolledStudentId, targetType: 'vod', targetId: vodId, expiresAt: Date.now() + 60000 }
    });
    assert.equal(grant.status, 201);
    const trialPermit = await reqJson(base, `/api/vod/${vodId}/playback`, { method: 'POST', cookie: stuCookie });
    assert.equal(trialPermit.status, 200);
    const trialMedia = await fetch(base + trialPermit.data.url, { headers: { Cookie: stuCookie, Range: 'bytes=0-3' } });
    assert.equal(trialMedia.status, 206);
    assert.equal(await trialMedia.text(), 'fake');
    assert.equal((await reqJson(base, `/api/trials/${grant.data.id}`, { method: 'DELETE', cookie: adminCookie })).status, 200);
    assert.equal((await reqJson(base, trialPermit.data.url, { cookie: stuCookie })).status, 403);

    // 6. 本地备份轮转与备份文件完整性校验
    const rot = await reqJson(base, '/api/system/backups', { method: 'POST', cookie: adminCookie });
    assert.equal(rot.status, 201);
    assert.ok(rot.data.created.endsWith('.db'));

    const backupBin = await fetch(`${base}/api/system/backup`, { headers: { Cookie: adminCookie } });
    assert.equal(backupBin.status, 200);
    const buf = Buffer.from(await backupBin.arrayBuffer());
    const verifyRes = await fetch(`${base}/api/system/backup/verify`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/octet-stream' },
      body: buf
    });
    assert.equal(verifyRes.status, 200);
    const verifyData = await verifyRes.json();
    assert.equal(verifyData.ok, true);
    assert.equal(verifyData.counts.courses, 1);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

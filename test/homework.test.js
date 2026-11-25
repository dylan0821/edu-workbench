import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

function withTempServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-hw-'));
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

async function uploadRaw(base, p, bytes, contentType, cookie) {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: bytes
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function extractCookie(setCookie) {
  return String(setCookie || '').split(';')[0];
}

test('课程作业全链路：教师发布(Markdown/附件)、学生图片上传提交、教师系统批改、权限隔离与清理', async () => {
  const { tmpDir, uploadDir, server } = withTempServer();
  try {
    const base = await startServer(server);

    // 1. 初始化管理员
    const setupRes = await reqJson(base, '/api/setup', {
      method: 'POST',
      body: { name: '教务管理员', username: '13800138000', password: 'password123', subject: '数学' }
    });
    assert.equal(setupRes.status, 201);
    const adminCookie = extractCookie(setupRes.setCookie);

    // 2. 创建两位教师、两门课程、两位学生
    const t1Res = await reqJson(base, '/api/teachers', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: '张老师', subject: '数学', phone: '13800138001', password: 'password123' }
    });
    assert.equal(t1Res.status, 201);
    const t1 = { id: t1Res.data.id };

    const t2Res = await reqJson(base, '/api/teachers', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: '李老师', subject: '英语', phone: '13800138002', password: 'password123' }
    });
    assert.equal(t2Res.status, 201);
    const t2 = { id: t2Res.data.id };

    const c1Res = await reqJson(base, '/api/courses', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: '高一数学春季班', subject: '数学', teacherIds: [t1.id] }
    });
    assert.equal(c1Res.status, 201);
    const c1 = { id: c1Res.data.id };

    const c2Res = await reqJson(base, '/api/courses', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: '高一英语春季班', subject: '英语', teacherIds: [t2.id] }
    });
    assert.equal(c2Res.status, 201);
    const c2 = { id: c2Res.data.id };

    const s1Res = await reqJson(base, '/api/students', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: '小明', grade: '高一', phone: '13900139001', loginUsername: 'xiaoming01', password: 'password123', courseIds: [c1.id] }
    });
    assert.equal(s1Res.status, 201);

    const s2Res = await reqJson(base, '/api/students', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: '小红', grade: '高一', phone: '13900139002', loginUsername: 'xiaohong02', password: 'password123', courseIds: [c2.id] }
    });
    assert.equal(s2Res.status, 201);

    // 登录各角色
    const t1Login = await reqJson(base, '/api/login', { method: 'POST', body: { username: '13800138001', password: 'password123' } });
    assert.equal(t1Login.status, 200);
    const t1Cookie = extractCookie(t1Login.setCookie);
    const t2Login = await reqJson(base, '/api/login', { method: 'POST', body: { username: '13800138002', password: 'password123' } });
    assert.equal(t2Login.status, 200);
    const t2Cookie = extractCookie(t2Login.setCookie);
    const s1Login = await reqJson(base, '/api/login', { method: 'POST', body: { username: 'xiaoming01', password: 'password123' } });
    assert.equal(s1Login.status, 200);
    const s1Cookie = extractCookie(s1Login.setCookie);
    const s2Login = await reqJson(base, '/api/login', { method: 'POST', body: { username: 'xiaohong02', password: 'password123' } });
    assert.equal(s2Login.status, 200);
    const s2Cookie = extractCookie(s2Login.setCookie);

    // 3. 教师权限隔离：李老师不能给张老师的数学课布置作业
    const forbidCreate = await reqJson(base, '/api/homeworks', {
      method: 'POST',
      cookie: t2Cookie,
      body: { courseId: c1.id, title: '越权作业', content: 'test' }
    });
    assert.equal(forbidCreate.status, 403);

    // 4. 张老师上传附件并发布 Markdown 作业
    const attUpload = await uploadRaw(
      base,
      `/api/homework/upload?courseId=${encodeURIComponent(c1.id)}&kind=attachment&filename=guide.txt`,
      Buffer.from('导数练习题讲义'),
      'text/plain',
      t1Cookie
    );
    assert.equal(attUpload.status, 201);
    assert.ok(attUpload.data.storedName);

    const hwCreate = await reqJson(base, '/api/homeworks', {
      method: 'POST',
      cookie: t1Cookie,
      body: {
        courseId: c1.id,
        title: '第一讲：导数单调性练习',
        content: '# 作业要求\n- 完成讲义 **第 1-5 题**\n- 拍照上传解题过程',
        contentFormat: 'markdown',
        dueDate: '2026-12-01',
        attachments: [attUpload.data]
      }
    });
    assert.equal(hwCreate.status, 201);
    const hw = hwCreate.data.homework;
    assert.equal(hw.course_id, c1.id);
    assert.equal(hw.attachments.length, 1);

    // 5. 学生视角隔离：小明能看到数学作业，小红看不到
    const s1State = await reqJson(base, '/api/state', { cookie: s1Cookie });
    assert.equal(s1State.data.homeworks.length, 1);
    const s2State = await reqJson(base, '/api/state', { cookie: s2Cookie });
    assert.equal(s2State.data.homeworks.length, 0);

    // 小红不能下载数学作业附件或提交数学作业
    const s2AttRes = await fetch(`${base}/api/homework/${hw.id}/attachments/${hw.attachments[0].id}`, {
      headers: { Cookie: s2Cookie }
    });
    assert.equal(s2AttRes.status, 403);

    // 6. 小明下载附件成功，不能上传非图片作为作业提交，上传 PNG 图片成功并提交
    const s1AttRes = await fetch(`${base}/api/homework/${hw.id}/attachments/${hw.attachments[0].id}`, {
      headers: { Cookie: s1Cookie }
    });
    assert.equal(s1AttRes.status, 200);
    assert.equal(await s1AttRes.text(), '导数练习题讲义');

    const badSubUpload = await uploadRaw(
      base,
      `/api/homework/upload?courseId=${encodeURIComponent(c1.id)}&kind=submission&filename=note.txt`,
      Buffer.from('not an image'),
      'text/plain',
      s1Cookie
    );
    assert.equal(badSubUpload.status, 400);

    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    const subUpload = await uploadRaw(
      base,
      `/api/homework/upload?courseId=${encodeURIComponent(c1.id)}&kind=submission&filename=page1.png`,
      fakePng,
      'image/png',
      s1Cookie
    );
    assert.equal(subUpload.status, 201);
    assert.equal(subUpload.data.isImage, true);

    const submitRes = await reqJson(base, `/api/homeworks/${hw.id}/submit`, {
      method: 'POST',
      cookie: s1Cookie,
      body: { images: [subUpload.data], note: '第3题有点不确定' }
    });
    assert.equal(submitRes.status, 200);
    const sub = submitRes.data.submission;
    assert.equal(sub.status, 'submitted');
    assert.equal(sub.images.length, 1);

    // 小红不能看小明的提交图片
    const s2SubImg = await fetch(`${base}/api/homework-submissions/${sub.id}/files/${sub.images[0].id}`, {
      headers: { Cookie: s2Cookie }
    });
    assert.equal(s2SubImg.status, 403);

    // 7. 张老师上传批改后标注图片并批改，李老师不能批改
    const gradedImgUpload = await uploadRaw(
      base,
      `/api/homework/upload?courseId=${encodeURIComponent(c1.id)}&kind=graded&filename=graded_p1.png`,
      fakePng,
      'image/png',
      t1Cookie
    );
    assert.equal(gradedImgUpload.status, 201);

    const forbidGrade = await reqJson(base, `/api/homework-submissions/${sub.id}/grade`, {
      method: 'POST',
      cookie: t2Cookie,
      body: { score: '100', feedback: '越权' }
    });
    assert.equal(forbidGrade.status, 403);

    const gradeRes = await reqJson(base, `/api/homework-submissions/${sub.id}/grade`, {
      method: 'POST',
      cookie: t1Cookie,
      body: {
        score: '95',
        feedback: '步骤清晰，第3题符号已用红笔标注',
        gradedImages: [gradedImgUpload.data]
      }
    });
    assert.equal(gradeRes.status, 200);
    assert.equal(gradeRes.data.submission.status, 'graded');
    assert.equal(gradeRes.data.submission.score, '95');
    assert.equal(gradeRes.data.submission.gradedImages.length, 1);

    // 小明能在 state 中看到批改结果并访问批改图片
    const s1StateAfter = await reqJson(base, '/api/state', { cookie: s1Cookie });
    const mySub = s1StateAfter.data.homeworkSubmissions[0];
    assert.equal(mySub.status, 'graded');
    assert.equal(mySub.score, '95');
    const gradedImgFetch = await fetch(`${base}/api/homework-submissions/${mySub.id}/files/${mySub.gradedImages[0].id}`, {
      headers: { Cookie: s1Cookie }
    });
    assert.equal(gradedImgFetch.status, 200);

    // 8. 孤儿文件清理不会误删作业附件、学生提交图、批改图
    const cleanupRes = await reqJson(base, '/api/system/cleanup', { method: 'POST', cookie: adminCookie });
    assert.equal(cleanupRes.status, 200);
    assert.ok(fs.existsSync(path.join(uploadDir, attUpload.data.storedName)));
    assert.ok(fs.existsSync(path.join(uploadDir, subUpload.data.storedName)));
    assert.ok(fs.existsSync(path.join(uploadDir, gradedImgUpload.data.storedName)));

    // 9. 删除作业会级联清理磁盘文件
    const delRes = await reqJson(base, `/api/homeworks/${hw.id}`, { method: 'DELETE', cookie: t1Cookie });
    assert.equal(delRes.status, 200);
    assert.equal(fs.existsSync(path.join(uploadDir, attUpload.data.storedName)), false);
    assert.equal(fs.existsSync(path.join(uploadDir, subUpload.data.storedName)), false);
    assert.equal(fs.existsSync(path.join(uploadDir, gradedImgUpload.data.storedName)), false);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

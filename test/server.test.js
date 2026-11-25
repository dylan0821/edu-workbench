import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../src/server.js';
import { openWorkbenchDb } from '../src/db.js';

function extractSessionCookie(res) {
  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(/wb_session=([^;]+)/);
  return match ? `wb_session=${match[1]}` : '';
}

test('服务端真实权限隔离、流式分片录制、去重完课统计与排课冲突全链路测试', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-test-'));
  const server = createServer({
    dbPath: path.join(tmpDir, 'test.db'),
    uploadDir: path.join(tmpDir, 'uploads')
  });

  await new Promise(resolve => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function req(urlPath, { method = 'GET', body, rawBody, cookie = '', headers = {} } = {}) {
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(rawBody ? {} : (body ? { 'Content-Type': 'application/json' } : {})),
        ...headers
      },
      body: rawBody || (body ? JSON.stringify(body) : undefined)
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, cookie: extractSessionCookie(res), res };
  }

  // 1. 未登录时 /api/state 不返回任何业务数据
  const anonState = await req('/api/state');
  assert.equal(anonState.status, 200);
  assert.equal(anonState.data.authenticated, false);
  assert.equal(anonState.data.needsSetup, true);
  assert.equal(anonState.data.students, undefined);

  // 2. 初始化教师管理员账号并获取真实 HttpOnly Cookie
  const setupRes = await req('/api/setup', {
    method: 'POST',
    body: { name: '林老师', subject: '数学', username: '13800000001', password: 'pass' }
  });
  assert.equal(setupRes.status, 201);
  const teacherCookie = setupRes.cookie;
  assert.ok(teacherCookie.startsWith('wb_session='));
  const teacherId = setupRes.data.teachers[0].id;

  // 3. 创建两班、两名学生（带独立登录账号）并分别报名
  const s1 = await req('/api/students', {
    method: 'POST',
    cookie: teacherCookie,
    body: { name: '陈知行', grade: '高三', phone: '13900000001', password: 's1pass', status: '意向', note: '内部招生备注' }
  });
  const s2 = await req('/api/students', {
    method: 'POST',
    cookie: teacherCookie,
    body: { name: '刘子轩', grade: '高三', phone: '13900000002', password: 's2pass', status: '意向', note: '另一班学生' }
  });
  const c1 = await req('/api/courses', { method: 'POST', cookie: teacherCookie, body: { name: '高三数学培优', mode: '直播课', teacherIds: [teacherId] } });
  const cB = await req('/api/courses', { method: 'POST', cookie: teacherCookie, body: { name: '周六培优课', mode: '直播课', teacherIds: [teacherId] } });
  await req('/api/enrollments', { method: 'POST', cookie: teacherCookie, body: { courseId: c1.data.id, studentId: s1.data.id } });
  await req('/api/enrollments', { method: 'POST', cookie: teacherCookie, body: { courseId: cB.data.id, studentId: s2.data.id } });

  // 4. 排课与冲突拦截
  const lA = await req('/api/lessons', {
    method: 'POST',
    cookie: teacherCookie,
    body: { title: '导数专题第1讲', courseId: c1.data.id, teacherId, startMs: 1000, endMs: 4000 }
  });
  assert.equal(lA.status, 201);
  const overlap = await req('/api/lessons', {
    method: 'POST',
    cookie: teacherCookie,
    body: { title: '冲突课次', courseId: c1.data.id, teacherId, startMs: 2000, endMs: 5000 }
  });
  assert.equal(overlap.status, 409);

  // 5. 带序号流式分片录制：先故意丢弃中间分片 #1，验证归档被 409 拦截；补传 #1 后再按序合并成功
  const initRec = await req('/api/recordings/init', {
    method: 'POST',
    cookie: teacherCookie,
    body: { lessonId: lA.data.id, title: '导数流式回放', filename: 'stream.webm' }
  });
  assert.equal(initRec.status, 201);
  const recId = initRec.data.id;

  const ch0 = await req(`/api/recordings/${recId}/chunk?seq=0`, {
    method: 'POST',
    cookie: teacherCookie,
    rawBody: Buffer.from('PART0_'),
    headers: { 'Content-Type': 'application/octet-stream' }
  });
  assert.equal(ch0.status, 200);

  // 故意跳过 seq=1，直接上传 seq=2
  const ch2 = await req(`/api/recordings/${recId}/chunk?seq=2`, {
    method: 'POST',
    cookie: teacherCookie,
    rawBody: Buffer.from('PART2'),
    headers: { 'Content-Type': 'application/octet-stream' }
  });
  assert.equal(ch2.status, 200);

  // 缺片时调用 finish 必须返回 409 并明确报告缺少 #1，不得静默归档
  const missingFin = await req(`/api/recordings/${recId}/finish`, {
    method: 'POST',
    cookie: teacherCookie,
    body: { totalChunks: 3, durationSec: 120 }
  });
  assert.equal(missingFin.status, 409);
  assert.deepEqual(missingFin.data.missingSeqs, [1]);
  const pendingState = await req('/api/state', { cookie: teacherCookie });
  assert.equal(pendingState.data.pendingRecordings.find(r => r.id === recId).status, 'interrupted');

  // 补传缺失的 seq=1 后再归档，应 201 成功且合并字节严格按 0->1->2 顺序
  const ch1 = await req(`/api/recordings/${recId}/chunk?seq=1`, {
    method: 'POST',
    cookie: teacherCookie,
    rawBody: Buffer.from('PART1_'),
    headers: { 'Content-Type': 'application/octet-stream' }
  });
  assert.equal(ch1.status, 200);

  const finRec = await req(`/api/recordings/${recId}/finish`, {
    method: 'POST',
    cookie: teacherCookie,
    body: { totalChunks: 3, durationSec: 120 }
  });
  assert.equal(finRec.status, 201);
  assert.equal(finRec.data.state.recordings[0].status, 'pending_review');
  const repeatFinish = await req(`/api/recordings/${recId}/finish`, {
    method: 'POST',
    cookie: teacherCookie,
    body: { totalChunks: 3, durationSec: 120 }
  });
  assert.equal(repeatFinish.status, 200);
  assert.equal(repeatFinish.data.state.recordings.filter(r => r.id === recId).length, 1);

  // 5b. 静态文件安全回归：匿名用户无法通过静态路径读取数据库、上传原件或服务端源码
  const storedRec = server.store.getRecording(recId);
  for (const forbiddenPath of [
    '/data/workbench.db',
    `/data/uploads/${storedRec.stored_name}`,
    '/src/server.js',
    '/package.json'
  ]) {
    const probe = await fetch(baseUrl + forbiddenPath);
    assert.equal(probe.status, 404, `静态入口不应暴露 ${forbiddenPath}`);
  }
  const indexRes = await fetch(baseUrl + '/');
  assert.equal(indexRes.status, 200);

  // 6. 服务端严格学生权限隔离测试
  const s1Login = await req('/api/login', { method: 'POST', body: { username: '13900000001', password: 's1pass' } });
  const s1Cookie = s1Login.cookie;
  const s2Login = await req('/api/login', { method: 'POST', body: { username: '13900000002', password: 's2pass' } });
  const s2Cookie = s2Login.cookie;

  // 学生1 获取 /api/state：看不到学生2、看不到跟进备注、看不到未发布回放
  const s1State = await req('/api/state', { cookie: s1Cookie });
  assert.equal(s1State.data.students.length, 1);
  assert.equal(s1State.data.students[0].name, '陈知行');
  assert.equal(s1State.data.followups.length, 0);
  assert.equal(s1State.data.accounts.length, 0);
  assert.equal(s1State.data.recordings.length, 0); // 未发布

  // 学生尝试调用管理写接口被 403 拒绝
  const s1ForbiddenCreate = await req('/api/students', { method: 'POST', cookie: s1Cookie, body: { name: '非法创建' } });
  assert.equal(s1ForbiddenCreate.status, 403);

  // 未发布前，学生1 读取回放文件被 403 拒绝
  const s1BeforePub = await fetch(`${baseUrl}/api/recordings/${recId}/file`, { headers: { Cookie: s1Cookie } });
  assert.equal(s1BeforePub.status, 403);

  // 教师发布回放后：本班学生1可 206 分段读取，外班学生2被 403 拒绝，未登录被 401 拒绝
  await req(`/api/recordings/${recId}`, { method: 'PATCH', cookie: teacherCookie, body: { status: 'published' } });

  const s1AfterPub = await fetch(`${baseUrl}/api/recordings/${recId}/file`, {
    headers: { Cookie: s1Cookie }
  });
  assert.equal(s1AfterPub.status, 200);
  assert.equal(await s1AfterPub.text(), 'PART0_PART1_PART2');

  const s1Range = await fetch(`${baseUrl}/api/recordings/${recId}/file`, {
    headers: { Cookie: s1Cookie, Range: 'bytes=6-10' }
  });
  assert.equal(s1Range.status, 206);
  assert.equal(await s1Range.text(), 'PART1');

  const s2OtherClass = await fetch(`${baseUrl}/api/recordings/${recId}/file`, { headers: { Cookie: s2Cookie } });
  assert.equal(s2OtherClass.status, 403);

  const anonRec = await fetch(`${baseUrl}/api/recordings/${recId}/file`);
  assert.equal(anonRec.status, 401);

  // 7. 去重观看区间防拖拽刷完课测试
  // 直接把进度条拖到 95s（无真实连续观看区间）：不应记为完课
  const dragOnly = await req('/api/progress', {
    method: 'POST',
    cookie: s1Cookie,
    body: { targetType: 'recording', targetId: recId, positionSec: 95, durationSec: 100 }
  });
  assert.equal(dragOnly.data.playbackProgress[0].watched_sec, 0);
  assert.equal(dragOnly.data.playbackProgress[0].completed, 0);

  // 实际连续观看 [0, 50] 和 [45, 95] -> 去重后为 95 秒（≥90%），才记为已完课
  await req('/api/progress', {
    method: 'POST',
    cookie: s1Cookie,
    body: { targetType: 'recording', targetId: recId, positionSec: 50, durationSec: 100, watchedRange: [0, 50] }
  });
  const realWatch = await req('/api/progress', {
    method: 'POST',
    cookie: s1Cookie,
    body: { targetType: 'recording', targetId: recId, positionSec: 95, durationSec: 100, watchedRange: [45, 95] }
  });
  assert.equal(realWatch.data.playbackProgress[0].watched_sec, 95);
  assert.equal(realWatch.data.playbackProgress[0].completed, 1);

  // 8. 办理学生1退班后，立即失去该班回放访问权限（403）
  const teacherSnap = await req('/api/state', { cookie: teacherCookie });
  const s1Enroll = teacherSnap.data.enrollments.find(e => e.student_id === s1.data.id);
  await req(`/api/enrollments/${s1Enroll.id}`, { method: 'PATCH', cookie: teacherCookie, body: { status: 'withdrawn' } });
  const s1AfterWithdraw = await fetch(`${baseUrl}/api/recordings/${recId}/file`, { headers: { Cookie: s1Cookie } });
  assert.equal(s1AfterWithdraw.status, 403);

  // 9. 招生限时试听资格：向外班学生2发放课次 lA 的 24 小时试听资格，立即获得该课次与已发布回放访问权；收回后立即恢复 403
  const trialRes = await req('/api/trials', {
    method: 'POST',
    cookie: teacherCookie,
    body: { studentId: s2.data.id, targetType: 'lesson', targetId: lA.data.id, expiresAt: Date.now() + 86400000 }
  });
  assert.equal(trialRes.status, 201);
  const s2WithTrial = await fetch(`${baseUrl}/api/recordings/${recId}/file`, { headers: { Cookie: s2Cookie } });
  assert.equal(s2WithTrial.status, 200);

  await req(`/api/trials/${trialRes.data.id}`, { method: 'DELETE', cookie: teacherCookie });
  const s2AfterRevoke = await fetch(`${baseUrl}/api/recordings/${recId}/file`, { headers: { Cookie: s2Cookie } });
  assert.equal(s2AfterRevoke.status, 403);

  // 10. 周期批量排课（生成 3 节）与出勤点名持久化
  const batchRes = await req('/api/lessons/batch', {
    method: 'POST',
    cookie: teacherCookie,
    body: {
      titlePrefix: '周日导数集训',
      courseId: c1.data.id,
      teacherId,
      firstStartMs: 100000000,
      durationMs: 10800000,
      intervalDays: 7,
      count: 3
    }
  });
  assert.equal(batchRes.status, 201);
  assert.equal(batchRes.data.ids.length, 3);

  // 若周期内任意一节时间重叠，批量排课整体 409 拒绝
  const batchConflict = await req('/api/lessons/batch', {
    method: 'POST',
    cookie: teacherCookie,
    body: {
      titlePrefix: '冲突周期班',
      courseId: cB.data.id,
      teacherId,
      firstStartMs: 100000000,
      durationMs: 10800000,
      intervalDays: 7,
      count: 2
    }
  });
  assert.equal(batchConflict.status, 409);

  // 出勤点名落盘
  const attRes = await req('/api/attendance', {
    method: 'POST',
    cookie: teacherCookie,
    body: { lessonId: lA.data.id, studentId: s1.data.id, status: '请假' }
  });
  assert.equal(attRes.status, 200);
  assert.equal(attRes.data.attendance[0].status, '请假');

  // 11. 录播凭证绑定会话，支持续期和到期换发
  const vodUp = await req(`/api/vod/upload?courseId=${cB.data.id}&chapterName=CH1&title=防盗版测试&filename=demo.mp4`, {
    method: 'POST',
    cookie: teacherCookie,
    rawBody: Buffer.from('FAKE_MP4_DATA'),
    headers: { 'Content-Type': 'video/mp4' }
  });
  assert.equal(vodUp.status, 201);
  const vodId = vodUp.data.id;

  const playbackPath = `/api/vod/${vodId}/playback`;
  const { data: permit, status: permitStatus } = await req(playbackPath, { method: 'POST', cookie: s2Cookie });
  assert.equal(permitStatus, 200);
  assert.equal((await req(`/api/vod/${vodId}/file`, { cookie: s2Cookie })).status, 403);
  assert.equal((await req(playbackPath, { method: 'POST', cookie: s1Cookie })).status, 403);
  const docOpen = await fetch(baseUrl + permit.url, {
    headers: { Cookie: s2Cookie, 'Sec-Fetch-Dest': 'document' }
  });
  assert.equal(docOpen.status, 403);

  const stuDl = await fetch(baseUrl + permit.url + '&download=1', {
    headers: { Cookie: s2Cookie, 'Sec-Fetch-Dest': 'video' }
  });
  assert.equal(stuDl.status, 403);
  const media = await fetch(baseUrl + permit.url, { headers: { Cookie: s2Cookie, 'Sec-Fetch-Dest': 'video' } });
  assert.equal(media.status, 200);
  assert.match(media.headers.get('content-disposition'), /^inline;/);
  assert.match(media.headers.get('cache-control'), /no-store/);
  assert.equal(media.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(await media.text(), 'FAKE_MP4_DATA');
  const staffDownload = await fetch(`${baseUrl}/api/vod/${vodId}/file?download=1`, { headers: { Cookie: teacherCookie } });
  assert.equal(staffDownload.status, 200);
  assert.match(staffDownload.headers.get('content-disposition'), /^attachment;/);
  await staffDownload.arrayBuffer();

  const issuedAt = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: issuedAt });
  try {
    const renewed = await req(playbackPath, { method: 'POST', cookie: s2Cookie });
    assert.equal(renewed.data.url, permit.url);
    t.mock.timers.setTime(issuedAt + 10 * 60 * 1000 + 1);
    assert.equal((await req(permit.url, { cookie: s2Cookie })).status, 403);
    const reissued = await req(playbackPath, { method: 'POST', cookie: s2Cookie });
    assert.notEqual(reissued.data.url, permit.url);
  } finally {
    t.mock.timers.reset();
  }

  // 学生在另一台设备登录 -> 旧 Cookie 失效
  const s2SecondLogin = await req('/api/login', { method: 'POST', body: { username: '13900000002', password: 's2pass' } });
  assert.equal(s2SecondLogin.status, 200);
  const oldSessionCheck = await req('/api/state', { cookie: s2Cookie });
  assert.equal(oldSessionCheck.data.authenticated, false);
  const newSessionCheck = await req('/api/state', { cookie: s2SecondLogin.cookie });
  assert.equal(newSessionCheck.data.authenticated, true);
  const freshPermit = await req(playbackPath, { method: 'POST', cookie: s2SecondLogin.cookie });
  assert.equal((await req(freshPermit.data.url, { cookie: s2Cookie })).status, 401);
  assert.equal((await req(permit.url, { cookie: s2SecondLogin.cookie })).status, 403);
  assert.equal((await req(freshPermit.data.url, { cookie: s2SecondLogin.cookie })).status, 200);

  // 12. 手机号必填且必须为 11 位有效手机号
  const badStu = await req('/api/students', {
    method: 'POST',
    cookie: teacherCookie,
    body: { name: '非法手机号学生', phone: '12345' }
  });
  assert.equal(badStu.status, 400);
  const emptyPhoneTch = await req('/api/teachers', {
    method: 'POST',
    cookie: teacherCookie,
    body: { name: '无手机号教师', phone: '' }
  });
  assert.equal(emptyPhoneTch.status, 400);

  // 13. 机构名称与 Logo 自定义上传、公开读取与删除恢复
  const orgUpdate = await req('/api/org', {
    method: 'PUT',
    cookie: teacherCookie,
    body: { name: '启明数学工作室', maxOnlineRooms: 2, maxOnlineStudents: 60 }
  });
  assert.equal(orgUpdate.status, 200);
  assert.equal(orgUpdate.data.org.name, '启明数学工作室');

  const logoUp = await req('/api/org/logo?filename=brand.png', {
    method: 'POST',
    cookie: teacherCookie,
    rawBody: Buffer.from('PNG_LOGO_BYTES'),
    headers: { 'Content-Type': 'image/png' }
  });
  assert.equal(logoUp.status, 200);
  assert.ok(logoUp.data.org.logo_stored_name.endsWith('.png'));

  const logoGet = await fetch(`${baseUrl}/api/org/logo`);
  assert.equal(logoGet.status, 200);
  assert.equal(await logoGet.text(), 'PNG_LOGO_BYTES');

  const logoDel = await req('/api/org/logo', { method: 'DELETE', cookie: teacherCookie });
  assert.equal(logoDel.status, 200);
  assert.equal(logoDel.data.org.logo_stored_name, '');

  // 14. 三级身份权限校验：管理员（完全功能）vs 普通教师（仅上课/教学功能）
  assert.equal(setupRes.data.currentUser.role, 'admin');
  const t2Res = await req('/api/teachers', {
    method: 'POST',
    cookie: teacherCookie,
    body: { name: '王老师', subject: '物理', phone: '13800000002', password: 't2pass', role: 'teacher' }
  });
  assert.equal(t2Res.status, 201);
  const t2Login = await req('/api/login', { method: 'POST', body: { username: '13800000002', password: 't2pass' } });
  assert.equal(t2Login.status, 200);
  assert.equal(t2Login.data.currentUser.role, 'teacher');
  assert.equal(t2Login.data.students.length, 0);
  assert.equal(t2Login.data.accounts.length, 0);

  // 普通教师无权修改机构设置、新建学生或排课（403）
  const t2OrgDeny = await req('/api/org', {
    method: 'PUT',
    cookie: t2Login.cookie,
    body: { name: '越权修改', maxOnlineRooms: 1, maxOnlineStudents: 30 }
  });
  assert.equal(t2OrgDeny.status, 403);
  const t2StuDeny = await req('/api/students', {
    method: 'POST',
    cookie: t2Login.cookie,
    body: { name: '越权建档', phone: '13900000099' }
  });
  assert.equal(t2StuDeny.status, 403);

  // 普通教师无权对非本人授课的课次点名（403），但可对自己授课的课次点名与上传资料（200/201）
  const t2AttDeny = await req('/api/attendance', {
    method: 'POST',
    cookie: t2Login.cookie,
    body: { lessonId: lA.data.id, studentId: s2.data.id, status: '出勤' }
  });
  assert.equal(t2AttDeny.status, 403);

  const cT2 = await req('/api/courses', {
    method: 'POST',
    cookie: teacherCookie,
    body: { name: '物理实验课', mode: '直播课', teacherIds: [t2Res.data.id], capacity: 20 }
  });
  assert.equal(cT2.status, 201);
  const lesT2 = await req('/api/lessons', {
    method: 'POST',
    cookie: teacherCookie,
    body: { title: '力学专题', courseId: cT2.data.id, teacherId: t2Res.data.id, startMs: 80000, endMs: 84000 }
  });
  assert.equal(lesT2.status, 201);

  const t2Att = await req('/api/attendance', {
    method: 'POST',
    cookie: t2Login.cookie,
    body: { lessonId: lesT2.data.id, studentId: s2.data.id, status: '出勤' }
  });
  assert.equal(t2Att.status, 200);

  // 15. 课程管理增强：编辑课程、批量出勤、课次状态/备注、批量排课跳过冲突、资料安全预览与级联磁盘文件清理
  const editCourse = await req(`/api/courses/${c1.data.id}`, {
    method: 'PUT',
    cookie: teacherCookie,
    body: { name: '高三数学培优（秋季）', mode: '直播课', description: '导数与圆锥曲线专题', teacherIds: [teacherId] }
  });
  assert.equal(editCourse.status, 200);
  const updatedCourse = editCourse.data.state.courses.find(c => c.id === c1.data.id);
  assert.equal(updatedCourse.name, '高三数学培优（秋季）');
  assert.equal(updatedCourse.description, '导数与圆锥曲线专题');

  const batchAtt = await req('/api/attendance/batch', {
    method: 'POST',
    cookie: teacherCookie,
    body: {
      lessonId: lA.data.id,
      records: [
        { studentId: s1.data.id, status: '出勤' },
        { studentId: s2.data.id, status: '请假' }
      ]
    }
  });
  assert.equal(batchAtt.status, 200);

  const patchNote = await req(`/api/lessons/${lesT2.data.id}/note`, {
    method: 'PATCH',
    cookie: t2Login.cookie,
    body: { note: '课后完成教材第 12 页习题' }
  });
  assert.equal(patchNote.status, 200);
  assert.equal(patchNote.data.lessons.find(l => l.id === lesT2.data.id).note, '课后完成教材第 12 页习题');

  const patchStatus = await req(`/api/lessons/${lesT2.data.id}/status`, {
    method: 'PATCH',
    cookie: t2Login.cookie,
    body: { status: 'completed' }
  });
  assert.equal(patchStatus.status, 200);
  assert.equal(patchStatus.data.lessons.find(l => l.id === lesT2.data.id).status, 'completed');

  // 批量排课遇到冲突时支持 skipConflicts 跳过冲突讲次继续生成
  const skipBatch = await req('/api/lessons/batch', {
    method: 'POST',
    cookie: teacherCookie,
    body: {
      titlePrefix: '力学冲刺',
      courseId: cT2.data.id,
      teacherId: t2Res.data.id,
      firstStartMs: 80000,
      durationMs: 4000,
      intervalDays: 1,
      count: 3,
      skipConflicts: true
    }
  });
  assert.equal(skipBatch.status, 201);
  assert.equal(skipBatch.data.ids.length, 2);
  assert.equal(skipBatch.data.skipped.length, 1);

  // 资料安全预览（HTML 强制下载、PDF 带 CSP sandbox）及分类更新
  const htmlUp = await req(`/api/materials/upload?scope=lesson&targetId=${lesT2.data.id}&category=${encodeURIComponent('其他附件')}&filename=test.html`, {
    method: 'POST',
    cookie: t2Login.cookie,
    rawBody: Buffer.from('<script>alert(1)</script>'),
    headers: { 'Content-Type': 'text/html' }
  });
  assert.equal(htmlUp.status, 201);
  const htmlView = await req(`/api/materials/${htmlUp.data.id}/file`, { cookie: t2Login.cookie });
  assert.equal(htmlView.status, 200);
  assert.ok(htmlView.res.headers.get('content-disposition').startsWith('attachment'));

  const matPatch = await req(`/api/materials/${htmlUp.data.id}`, {
    method: 'PATCH',
    cookie: t2Login.cookie,
    body: { category: '课后板书' }
  });
  assert.equal(matPatch.status, 200);
  assert.equal(matPatch.data.materials.find(m => m.id === htmlUp.data.id).category, '课后板书');

  // 普通教师无权删除他人的课次资料
  const c2 = await req('/api/courses', { method: 'POST', cookie: teacherCookie, body: { name: '待清理测试课', mode: '直播课' } });
  const c2Mat = await req(`/api/materials/upload?scope=course&targetId=${c2.data.id}&category=${encodeURIComponent('通用讲义')}&filename=guide.pdf`, {
    method: 'POST',
    cookie: teacherCookie,
    rawBody: Buffer.from('%PDF-1.4-TEST'),
    headers: { 'Content-Type': 'application/pdf' }
  });
  assert.equal(c2Mat.status, 201);
  const pdfView = await req(`/api/materials/${c2Mat.data.id}/file`, { cookie: teacherCookie });
  assert.equal(pdfView.res.headers.get('content-security-policy'), 'sandbox');

  const t2DelOtherMat = await req(`/api/materials/${c2Mat.data.id}`, { method: 'DELETE', cookie: t2Login.cookie });
  assert.equal(t2DelOtherMat.status, 403);

  // 删除课程时自动清理孤儿资料记录与磁盘文件
  const beforeFiles = await fs.readdir(path.join(tmpDir, 'uploads'));
  const targetDiskFile = beforeFiles.find(f => f.endsWith('_guide.pdf'));
  assert.ok(targetDiskFile, '上传后磁盘应存在资料文件');
  const delC2 = await req(`/api/courses/${c2.data.id}`, { method: 'DELETE', cookie: teacherCookie });
  assert.equal(delC2.status, 200);
  assert.equal(delC2.data.materials.some(m => m.id === c2Mat.data.id), false);
  const afterFiles = await fs.readdir(path.join(tmpDir, 'uploads'));
  assert.equal(afterFiles.includes(targetDiskFile), false, '删除课程后磁盘上的关联资料文件应被清理');

  // 16. 课程学生管理增强：人数上限、重复报名拦截、批量报名、编辑课程并同步待开课教师、一键转课
  const s3 = await req('/api/students', {
    method: 'POST',
    cookie: teacherCookie,
    body: { name: '周明远', grade: '高三', phone: '13900000003', password: 's3pass' }
  });
  const cSmall = await req('/api/courses', {
    method: 'POST',
    cookie: teacherCookie,
    body: { name: '一对一精讲课', mode: '直播课', teacherIds: [teacherId], capacity: 1 }
  });
  assert.equal(cSmall.status, 201);

  // 批量报名超过容量应 409 拦截
  const batchOverCap = await req('/api/enrollments/batch', {
    method: 'POST',
    cookie: teacherCookie,
    body: { courseId: cSmall.data.id, studentIds: [s1.data.id, s3.data.id] }
  });
  assert.equal(batchOverCap.status, 409);

  // 正常批量报名 1 人成功，重复报名被 409 拦截
  const batchOk = await req('/api/enrollments/batch', {
    method: 'POST',
    cookie: teacherCookie,
    body: { courseId: cSmall.data.id, studentIds: [s3.data.id] }
  });
  assert.equal(batchOk.status, 201);
  assert.equal(batchOk.data.added, 1);

  const dupEnroll = await req('/api/enrollments', {
    method: 'POST',
    cookie: teacherCookie,
    body: { courseId: cSmall.data.id, studentId: s3.data.id }
  });
  assert.equal(dupEnroll.status, 409);

  // 满员后再报另一人被 409 拦截
  const capDeny = await req('/api/enrollments', {
    method: 'POST',
    cookie: teacherCookie,
    body: { courseId: cSmall.data.id, studentId: s2.data.id }
  });
  assert.equal(capDeny.status, 409);

  // 排一节待开课课次，编辑课程更换授课教师并勾选 syncFutureLessons 同步更新
  const lesSmall = await req('/api/lessons', {
    method: 'POST',
    cookie: teacherCookie,
    body: { title: '精讲第1次', courseId: cSmall.data.id, teacherId, startMs: 300000, endMs: 304000 }
  });
  assert.equal(lesSmall.status, 201);

  const editSmall = await req(`/api/courses/${cSmall.data.id}`, {
    method: 'PUT',
    cookie: teacherCookie,
    body: {
      name: '小班精讲课',
      mode: '直播课',
      teacherIds: [t2Res.data.id],
      capacity: 2,
      syncFutureLessons: true
    }
  });
  assert.equal(editSmall.status, 200);
  assert.equal(editSmall.data.syncedLessons, 1);
  assert.equal(editSmall.data.state.lessons.find(l => l.id === lesSmall.data.id).teacher_id, t2Res.data.id);

  // 一键转课：s3 从小班精讲课转入周六培优课
  const s3En = editSmall.data.state.enrollments.find(e => e.course_id === cSmall.data.id && e.student_id === s3.data.id);
  assert.ok(s3En);
  const transferRes = await req(`/api/enrollments/${s3En.id}/transfer`, {
    method: 'POST',
    cookie: teacherCookie,
    body: { targetCourseId: cB.data.id }
  });
  assert.equal(transferRes.status, 200);
  assert.equal(transferRes.data.enrollments.find(e => e.id === s3En.id).status, 'withdrawn');
  assert.equal(
    transferRes.data.enrollments.find(e => e.course_id === cB.data.id && e.student_id === s3.data.id).status,
    'active'
  );
  assert.ok(
    transferRes.data.followups.some(f => f.student_id === s3.data.id && f.content.includes('转课：从「小班精讲课」转入「周六培优课」'))
  );
});

test('实时课堂权限、多页白板、学生书写开关与录播编辑、Range、轻量进度与孤儿分片清理测试', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-live-vod-'));
  const uploadDir = path.join(tmpDir, 'uploads');
  await fs.mkdir(path.join(uploadDir, '.chunks_orphan_old'), { recursive: true });
  await fs.writeFile(path.join(uploadDir, '.chunks_orphan_old', 'chunk_0.part'), 'stale');

  const server = createServer({
    dbPath: path.join(tmpDir, 'test.db'),
    uploadDir
  });

  // 1. 启动时应自动清理孤儿分片目录
  await assert.rejects(() => fs.stat(path.join(uploadDir, '.chunks_orphan_old')));

  await new Promise(resolve => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function req(urlPath, { method = 'GET', body, rawBody, cookie = '', headers = {} } = {}) {
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(rawBody ? {} : (body ? { 'Content-Type': 'application/json' } : {})),
        ...headers
      },
      body: rawBody || (body ? JSON.stringify(body) : undefined)
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, cookie: extractSessionCookie(res), res };
  }

  // 初始化管理员教师 A、普通教师 B、学生 S1
  const setup = await req('/api/setup', {
    method: 'POST',
    body: { name: '张老师', subject: '数学', username: '13800001001', password: 'pass' }
  });
  const adminCookie = setup.cookie;
  const teacherAId = setup.data.teachers[0].id;

  const tB = await req('/api/teachers', {
    method: 'POST',
    cookie: adminCookie,
    body: { name: '李老师', subject: '英语', phone: '13800001002', password: 'pass', role: 'teacher' }
  });
  const tBLogin = await req('/api/login', { method: 'POST', body: { username: '13800001002', password: 'pass' } });
  const teacherBCookie = tBLogin.cookie;

  const s1 = await req('/api/students', {
    method: 'POST',
    cookie: adminCookie,
    body: { name: '王同学', grade: '高二', phone: '13900001001', password: 'pass' }
  });
  const s1Login = await req('/api/login', { method: 'POST', body: { username: '13900001001', password: 'pass' } });
  const studentCookie = s1Login.cookie;

  const cA = await req('/api/courses', { method: 'POST', cookie: adminCookie, body: { name: '数学拔高', mode: '直播课', teacherIds: [teacherAId] } });
  await req('/api/enrollments', { method: 'POST', cookie: adminCookie, body: { courseId: cA.data.id, studentId: s1.data.id } });
  const lesA = await req('/api/lessons', {
    method: 'POST',
    cookie: adminCookie,
    body: { title: '函数第1讲', courseId: cA.data.id, teacherId: teacherAId, startMs: 10000, endMs: 20000 }
  });

  // 2. 教师 B 不能越权进入/操作教师 A 的实时课堂或录制
  const tBStream = await fetch(`${baseUrl}/api/classroom/${lesA.data.id}/stream`, { headers: { Cookie: teacherBCookie } });
  assert.equal(tBStream.status, 403);
  const tBAction = await req(`/api/classroom/${lesA.data.id}/action`, {
    method: 'POST',
    cookie: teacherBCookie,
    body: { type: 'clear' }
  });
  assert.equal(tBAction.status, 403);
  const tBRecInit = await req('/api/recordings/init', {
    method: 'POST',
    cookie: teacherBCookie,
    body: { lessonId: lesA.data.id, title: '越权录制' }
  });
  assert.equal(tBRecInit.status, 403);

  // 3. 白板学生书写权限与多页白板
  const stuDrawDenied = await req(`/api/classroom/${lesA.data.id}/action`, {
    method: 'POST',
    cookie: studentCookie,
    body: { type: 'stroke', clientId: 's1', stroke: { kind: 'pen', points: [[0.1, 0.1], [0.2, 0.2]] } }
  });
  assert.equal(stuDrawDenied.status, 403);

  // 教师开启学生书写权限并新增第 2 页
  assert.equal((await req(`/api/classroom/${lesA.data.id}/action`, {
    method: 'POST',
    cookie: adminCookie,
    body: { type: 'student-draw-toggle', allowed: true }
  })).status, 200);
  assert.equal((await req(`/api/classroom/${lesA.data.id}/action`, {
    method: 'POST',
    cookie: adminCookie,
    body: { type: 'page-add' }
  })).status, 200);
  const stuDrawOk = await req(`/api/classroom/${lesA.data.id}/action`, {
    method: 'POST',
    cookie: studentCookie,
    body: { type: 'stroke', clientId: 's1', stroke: { kind: 'line', points: [[0.1, 0.1], [0.5, 0.5]] } }
  });
  assert.equal(stuDrawOk.status, 200);

  // 4. 录播课上传（携带 durationSec）、教师越权拦截、元数据编辑与下架、Range 健壮性
  const vodUpDenied = await req(`/api/vod/upload?courseId=${cA.data.id}&title=越权录播&filename=a.mp4`, {
    method: 'POST',
    cookie: teacherBCookie,
    rawBody: Buffer.from('0123456789ABCDEF'),
    headers: { 'Content-Type': 'video/mp4' }
  });
  assert.equal(vodUpDenied.status, 403);

  const vodUp = await req(`/api/vod/upload?courseId=${cA.data.id}&chapterName=第一章&title=第1节&durationSec=360&filename=v1.mp4`, {
    method: 'POST',
    cookie: adminCookie,
    rawBody: Buffer.from('0123456789ABCDEF'),
    headers: { 'Content-Type': 'video/mp4' }
  });
  assert.equal(vodUp.status, 201);
  const vodId = vodUp.data.id;
  assert.equal(vodUp.data.state.vodLessons[0].duration_sec, 360);

  // 后缀 Range 与非法 Range 测试
  const studentPermit = await req(`/api/vod/${vodId}/playback`, { method: 'POST', cookie: studentCookie });
  assert.equal(studentPermit.status, 200);
  const suffixRange = await fetch(baseUrl + studentPermit.data.url, {
    headers: { Cookie: studentCookie, Range: 'bytes=-4' }
  });
  assert.equal(suffixRange.status, 206);
  assert.equal(await suffixRange.text(), 'CDEF');

  const badRange = await fetch(baseUrl + studentPermit.data.url, {
    headers: { Cookie: studentCookie, Range: 'bytes=abc-def' }
  });
  assert.equal(badRange.status, 416);

  // 教师 B 无法编辑/删除该录播
  assert.equal((await req(`/api/vod/${vodId}`, {
    method: 'PATCH',
    cookie: teacherBCookie,
    body: { title: '越权改名' }
  })).status, 403);

  // 管理员编辑录播标题并下架 -> 学生访问变 403
  const vodEdit = await req(`/api/vod/${vodId}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { chapterName: '第二章', title: '修订版第1节', sortOrder: 2, status: 'withdrawn' }
  });
  assert.equal(vodEdit.status, 200);
  assert.equal(vodEdit.data.vodLessons[0].title, '修订版第1节');
  assert.equal(vodEdit.data.vodLessons[0].status, 'withdrawn');

  const stuAfterWithdraw = await fetch(baseUrl + studentPermit.data.url, { headers: { Cookie: studentCookie } });
  assert.equal(stuAfterWithdraw.status, 403);

  // 5. /api/progress 轻量化响应（不返回全库 students/lessons，仅返回 progress 与 playbackProgress）
  const progRes = await req('/api/progress', {
    method: 'POST',
    cookie: studentCookie,
    body: { targetType: 'vod', targetId: vodId, positionSec: 100, durationSec: 360, watchedRange: [0, 100] }
  });
  assert.equal(progRes.status, 200);
  assert.equal(progRes.data.ok, true);
  assert.equal(progRes.data.progress.watched_sec, 100);
  assert.equal(progRes.data.playbackProgress.length, 1);
  assert.equal(progRes.data.students, undefined);
  assert.equal(progRes.data.lessons, undefined);

  // 6. 自定义 WebRTC ICE/TURN 配置校验与保存
  const badIce = await req('/api/org', {
    method: 'PUT',
    cookie: adminCookie,
    body: { name: '教培工作台', maxOnlineRooms: 1, maxOnlineStudents: 30, iceServersJson: '{bad json' }
  });
  assert.equal(badIce.status, 400);

  const okIce = await req('/api/org', {
    method: 'PUT',
    cookie: adminCookie,
    body: { name: '教培工作台', maxOnlineRooms: 1, maxOnlineStudents: 30, iceServersJson: '[{"urls":"stun:stun.miwifi.com:3478"}]' }
  });
  assert.equal(okIce.status, 200);
  assert.equal(okIce.data.org.ice_servers_json, '[{"urls":"stun:stun.miwifi.com:3478"}]');
});

test('系统设置优化：教师编辑与补开账号、手机号冲突保护、账号停用与密码修改、教学默认值、备份导出与孤儿清理', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-settings-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const uploadDir = path.join(tmpDir, 'uploads');

  const server = createServer({ dbPath, uploadDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function req(pathname, { method = 'GET', body, cookie, rawBody, headers = {} } = {}) {
    const reqHeaders = { ...headers };
    if (cookie) reqHeaders.Cookie = cookie;
    let payload;
    if (rawBody !== undefined) {
      payload = rawBody;
    } else if (body !== undefined) {
      reqHeaders['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${pathname}`, { method, headers: reqHeaders, body: payload });
    const setCookie = res.headers.get('set-cookie');
    const nextCookie = setCookie ? setCookie.split(';')[0] : cookie;
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, data, cookie: nextCookie, headers: res.headers };
  }

  // 1. 初始化管理员，验证密码使用 scrypt 存储
  const setup = await req('/api/setup', {
    method: 'POST',
    body: { name: '主管理员', username: '13800001001', password: 'admin123', subject: '数学' }
  });
  assert.equal(setup.status, 201);
  const adminCookie = setup.cookie;
  const adminAccId = setup.data.currentUser.id;
  const checkStore = openWorkbenchDb(dbPath);
  const rawHash = checkStore.db.prepare('SELECT password_hash FROM accounts WHERE id = ?').get(adminAccId).password_hash;
  checkStore.db.close();
  assert.ok(rawHash.startsWith('scrypt$'));

  // 2. SVG Logo 被拒绝，PNG Logo 允许
  const svgDeny = await req('/api/org/logo?filename=x.svg', {
    method: 'POST',
    cookie: adminCookie,
    rawBody: Buffer.from('<svg></svg>'),
    headers: { 'Content-Type': 'image/svg+xml' }
  });
  assert.equal(svgDeny.status, 400);

  // 3. 新建无密码教师 -> 补开账号 -> 编辑教师姓名与手机号（自动同步账号）
  const tAdd = await req('/api/teachers', {
    method: 'POST',
    cookie: adminCookie,
    body: { name: '李老师', subject: '化学', phone: '13800001002' }
  });
  assert.equal(tAdd.status, 201);
  const teacherId = tAdd.data.id;

  const tOpenAcc = await req(`/api/teachers/${teacherId}/account`, {
    method: 'POST',
    cookie: adminCookie,
    body: { role: 'teacher', password: 'pass1234' }
  });
  assert.equal(tOpenAcc.status, 200);
  const teacherAcc = tOpenAcc.data.accounts.find(a => a.linked_id === teacherId);
  assert.ok(teacherAcc);
  assert.equal(teacherAcc.username, '13800001002');

  const tEdit = await req(`/api/teachers/${teacherId}`, {
    method: 'PUT',
    cookie: adminCookie,
    body: { name: '李明老师', subject: '有机化学', phone: '13800001003' }
  });
  assert.equal(tEdit.status, 200);
  const syncedAcc = tEdit.data.accounts.find(a => a.id === teacherAcc.id);
  assert.equal(syncedAcc.name, '李明老师');
  assert.equal(syncedAcc.username, '13800001003');

  // 4. 手机号冲突保护：新增学生或教师不能静默覆盖已有管理员账号
  const conflictStu = await req('/api/students', {
    method: 'POST',
    cookie: adminCookie,
    body: { name: '撞号学生', phone: '13800001001', password: 'hack1234' }
  });
  assert.equal(conflictStu.status, 409);

  // 5. 教师登录 -> 自助修改密码 -> 旧密码失效、新密码可登录
  const tLogin = await req('/api/login', {
    method: 'POST',
    body: { username: '13800001003', password: 'pass1234' }
  });
  assert.equal(tLogin.status, 200);

  const badOldPw = await req('/api/auth/password', {
    method: 'POST',
    cookie: tLogin.cookie,
    body: { oldPassword: 'wrong', newPassword: 'newpass123' }
  });
  assert.equal(badOldPw.status, 400);

  const okChangePw = await req('/api/auth/password', {
    method: 'POST',
    cookie: tLogin.cookie,
    body: { oldPassword: 'pass1234', newPassword: 'newpass123' }
  });
  assert.equal(okChangePw.status, 200);

  const oldPwLogin = await req('/api/login', {
    method: 'POST',
    body: { username: '13800001003', password: 'pass1234' }
  });
  assert.equal(oldPwLogin.status, 401);

  const newPwLogin = await req('/api/login', {
    method: 'POST',
    body: { username: '13800001003', password: 'newpass123' }
  });
  assert.equal(newPwLogin.status, 200);

  // 6. 账号停用：旧会话立刻失效且拒绝再次登录；不能停用或删除当前管理员自身
  const selfDisableDeny = await req(`/api/accounts/${adminAccId}`, {
    method: 'PUT',
    cookie: adminCookie,
    body: { disabled: true }
  });
  assert.equal(selfDisableDeny.status, 400);

  const disableT = await req(`/api/accounts/${teacherAcc.id}`, {
    method: 'PUT',
    cookie: adminCookie,
    body: { disabled: true }
  });
  assert.equal(disableT.status, 200);

  const disabledSessionState = await req('/api/state', { cookie: newPwLogin.cookie });
  assert.equal(disabledSessionState.data.authenticated, false);

  const disabledLoginDeny = await req('/api/login', {
    method: 'POST',
    body: { username: '13800001003', password: 'newpass123' }
  });
  assert.equal(disabledLoginDeny.status, 403);

  // 7. 教学默认值读写
  const saveDefaults = await req('/api/org', {
    method: 'PUT',
    cookie: adminCookie,
    body: {
      defaultClassCapacity: 24,
      defaultLessonMinutes: 120,
      defaultWatermark: false,
      defaultStudentDraw: true
    }
  });
  assert.equal(saveDefaults.status, 200);
  assert.equal(saveDefaults.data.org.default_class_capacity, 24);
  assert.equal(saveDefaults.data.org.default_lesson_minutes, 120);
  assert.equal(saveDefaults.data.org.default_watermark, 0);
  assert.equal(saveDefaults.data.org.default_student_draw, 1);

  // 8. 存储统计、孤儿文件清理、数据库备份与 CSV 导出
  await fs.writeFile(path.join(uploadDir, 'orphan_unused_test.bin'), Buffer.alloc(1024, 7));
  const stBefore = await req('/api/system/storage', { cookie: adminCookie });
  assert.equal(stBefore.status, 200);
  assert.equal(stBefore.data.orphanCount, 1);
  assert.equal(stBefore.data.orphanBytes, 1024);

  const cleanRes = await req('/api/system/cleanup', { method: 'POST', cookie: adminCookie });
  assert.equal(cleanRes.status, 200);
  assert.equal(cleanRes.data.result.removedOrphans, 1);
  assert.equal(cleanRes.data.stats.orphanCount, 0);

  const backupRes = await fetch(`${baseUrl}/api/system/backup`, { headers: { Cookie: adminCookie } });
  assert.equal(backupRes.status, 200);
  const backupBuf = Buffer.from(await backupRes.arrayBuffer());
  assert.equal(backupBuf.subarray(0, 16).toString('utf8'), 'SQLite format 3\0');

  const csvRawRes = await fetch(`${baseUrl}/api/system/export?type=students`, { headers: { Cookie: adminCookie } });
  assert.equal(csvRawRes.status, 200);
  const csvBuf = Buffer.from(await csvRawRes.arrayBuffer());
  assert.deepEqual([...csvBuf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(csvBuf.subarray(3).toString('utf8').startsWith('姓名/昵称,年级,手机号'));
});

test('评审专项验收：录制中途重启恢复与导出、多孩共用家长手机号独立开号、双教师双课程答疑权限隔离', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-review-fix-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const uploadDir = path.join(tmpDir, 'uploads');

  let server = createServer({ dbPath, uploadDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    try { server.close(); } catch {}
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function req(pathname, { method = 'GET', body, cookie, rawBody, headers = {} } = {}) {
    const reqHeaders = { ...headers };
    if (cookie) reqHeaders.Cookie = cookie;
    let payload;
    if (rawBody !== undefined) payload = rawBody;
    else if (body !== undefined) {
      reqHeaders['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${pathname}`, { method, headers: reqHeaders, body: payload });
    const setCookie = res.headers.get('set-cookie');
    const nextCookie = setCookie ? setCookie.split(';')[0] : cookie;
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, data, cookie: nextCookie };
  }

  // 初始化管理员与两位普通教师、两门课程
  const setup = await req('/api/setup', {
    method: 'POST',
    body: { name: '管理员', username: '13800002000', password: 'pass', subject: '综合' }
  });
  assert.equal(setup.status, 201);
  const adminCookie = setup.cookie;

  const tA = await req('/api/teachers', {
    method: 'POST',
    cookie: adminCookie,
    body: { name: '数学张老师', subject: '数学', phone: '13800002001', password: 'pass', role: 'teacher' }
  });
  const tB = await req('/api/teachers', {
    method: 'POST',
    cookie: adminCookie,
    body: { name: '物理李老师', subject: '物理', phone: '13800002002', password: 'pass', role: 'teacher' }
  });
  const cA = await req('/api/courses', { method: 'POST', cookie: adminCookie, body: { name: '高三数学', mode: '直播课', teacherIds: [tA.data.id] } });
  const cB = await req('/api/courses', { method: 'POST', cookie: adminCookie, body: { name: '高三物理', mode: '直播课', teacherIds: [tB.data.id] } });
  const lesA = await req('/api/lessons', {
    method: 'POST',
    cookie: adminCookie,
    body: { title: '导数第一讲', courseId: cA.data.id, teacherId: tA.data.id, startMs: 100000, endMs: 110800 }
  });
  assert.equal(lesA.status, 201);

  const tALogin = await req('/api/login', { method: 'POST', body: { username: '13800002001', password: 'pass' } });
  const tBLogin = await req('/api/login', { method: 'POST', body: { username: '13800002002', password: 'pass' } });
  assert.equal(tALogin.status, 200);
  assert.equal(tBLogin.status, 200);

  // --- 验收 1：录制中途服务重启，已上传分片不丢失，可继续传片并导出已有部分 ---
  const initRec = await req('/api/recordings/init', {
    method: 'POST',
    cookie: tALogin.cookie,
    body: { lessonId: lesA.data.id, title: '导数直播录制', filename: 'deriv.webm', mimeType: 'video/webm' }
  });
  assert.equal(initRec.status, 201);
  const recId = initRec.data.id;

  assert.equal((await req(`/api/recordings/${recId}/chunk?seq=0`, {
    method: 'POST', cookie: tALogin.cookie, rawBody: Buffer.from('CHUNK_0_')
  })).status, 200);
  assert.equal((await req(`/api/recordings/${recId}/chunk?seq=1`, {
    method: 'POST', cookie: tALogin.cookie, rawBody: Buffer.from('CHUNK_1_')
  })).status, 200);

  // 制造一个无数据库记录的真正孤儿分片目录，验证重启后孤儿被删、持久化录制被保留
  await fs.mkdir(path.join(uploadDir, '.chunks_real_orphan'), { recursive: true });
  await fs.writeFile(path.join(uploadDir, '.chunks_real_orphan', 'chunk_0.part'), 'junk');

  // 模拟服务中途重启
  await new Promise((resolve) => server.close(resolve));
  server = createServer({ dbPath, uploadDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // 孤儿目录已清理，持久化录制目录完好
  await assert.rejects(() => fs.stat(path.join(uploadDir, '.chunks_real_orphan')));
  await fs.stat(path.join(uploadDir, `.chunks_${recId}`));

  // 重启后教师 A 在状态快照中可见“中断待恢复”的录制，教师 B 不可见
  const tAStateAfterRestart = await req('/api/state', { cookie: tALogin.cookie });
  assert.equal(tAStateAfterRestart.data.pendingRecordings.length, 1);
  assert.equal(tAStateAfterRestart.data.pendingRecordings[0].id, recId);
  assert.equal(tAStateAfterRestart.data.pendingRecordings[0].status, 'interrupted');
  assert.equal(tAStateAfterRestart.data.pendingRecordings[0].received_count, 2);

  const tBStateAfterRestart = await req('/api/state', { cookie: tBLogin.cookie });
  assert.equal(tBStateAfterRestart.data.pendingRecordings.length, 0);

  // 重启后可继续补传分片 #2，并支持 recoverPartial 归档已有部分
  assert.equal((await req(`/api/recordings/${recId}/chunk?seq=2`, {
    method: 'POST', cookie: tALogin.cookie, rawBody: Buffer.from('CHUNK_2')
  })).status, 200);
  // #3 缺失，恢复仅归档从开头连续收到的部分。
  assert.equal((await req(`/api/recordings/${recId}/chunk?seq=4`, {
    method: 'POST', cookie: tALogin.cookie, rawBody: Buffer.from('CHUNK_4')
  })).status, 200);

  const recoverFinish = await req(`/api/recordings/${recId}/finish`, {
    method: 'POST',
    cookie: tALogin.cookie,
    body: { recoverPartial: true }
  });
  assert.equal(recoverFinish.status, 201);
  assert.equal(recoverFinish.data.recoveredChunks, 3);
  assert.equal(recoverFinish.data.state.pendingRecordings.length, 0);

  const recFileRes = await fetch(`${baseUrl}/api/recordings/${recId}/file`, { headers: { Cookie: tALogin.cookie } });
  assert.equal(recFileRes.status, 200);
  assert.equal(await recFileRes.text(), 'CHUNK_0_CHUNK_1_CHUNK_2');

  // --- 验收 2：兄妹共用家长联系电话，登录账号独立且撞号不覆盖原账号 ---
  const bro = await req('/api/students', {
    method: 'POST',
    cookie: adminCookie,
    body: { name: '哥哥', phone: '13900008888', password: 'bro123' }
  });
  assert.equal(bro.status, 201);

  const sis = await req('/api/students', {
    method: 'POST',
    cookie: adminCookie,
    body: { name: '妹妹', phone: '13900008888' } // 联系电话重复，允许建档
  });
  assert.equal(sis.status, 201);

  // 试图用同一登录名给妹妹开号 -> 409 拦截，保留哥哥账号
  const sisDupAcc = await req('/api/accounts', {
    method: 'POST',
    cookie: adminCookie,
    body: { username: '13900008888', password: 'sis123', role: 'student', linkedId: sis.data.id, name: '妹妹' }
  });
  assert.equal(sisDupAcc.status, 409);

  // 使用独立登录账号 13900008888_2 给妹妹开号 -> 成功，兄妹各自独立登录
  const sisOkAcc = await req('/api/accounts', {
    method: 'POST',
    cookie: adminCookie,
    body: { username: '13900008888_2', password: 'sis123', role: 'student', linkedId: sis.data.id, name: '妹妹' }
  });
  assert.equal(sisOkAcc.status, 201);

  const broLogin = await req('/api/login', { method: 'POST', body: { username: '13900008888', password: 'bro123' } });
  const sisLogin = await req('/api/login', { method: 'POST', body: { username: '13900008888_2', password: 'sis123' } });
  assert.equal(broLogin.status, 200);
  assert.equal(broLogin.data.currentUser.name, '哥哥');
  assert.equal(sisLogin.status, 200);
  assert.equal(sisLogin.data.currentUser.name, '妹妹');

  // --- 验收 3：两位教师、两门课程的答疑权限隔离 ---
  const qaA = await req('/api/qa', {
    method: 'POST',
    cookie: tALogin.cookie,
    body: { courseId: cA.data.id, title: '数学导数答疑', content: '极值点偏移问题' }
  });
  assert.equal(qaA.status, 201);
  const qaAId = qaA.data.id;

  // 教师 B 对非本人教授的课程 A：发帖、回复、标记解决、删除全部 403
  assert.equal((await req('/api/qa', {
    method: 'POST', cookie: tBLogin.cookie, body: { courseId: cA.data.id, title: '越权发帖', content: 'x' }
  })).status, 403);
  assert.equal((await req(`/api/qa/${qaAId}/replies`, {
    method: 'POST', cookie: tBLogin.cookie, body: { content: '越权回复' }
  })).status, 403);
  assert.equal((await req(`/api/qa/${qaAId}/resolve`, {
    method: 'PATCH', cookie: tBLogin.cookie, body: { resolved: true }
  })).status, 403);
  assert.equal((await req(`/api/qa/${qaAId}`, {
    method: 'DELETE', cookie: tBLogin.cookie
  })).status, 403);

  // 教师 A 对自己教授的课程 A：回复、标记解决、删除全部允许
  assert.equal((await req(`/api/qa/${qaAId}/replies`, {
    method: 'POST', cookie: tALogin.cookie, body: { content: '教师A正常解答' }
  })).status, 201);
  assert.equal((await req(`/api/qa/${qaAId}/resolve`, {
    method: 'PATCH', cookie: tALogin.cookie, body: { resolved: true }
  })).status, 200);
  assert.equal((await req(`/api/qa/${qaAId}`, {
    method: 'DELETE', cookie: tALogin.cookie
  })).status, 200);
});

test('学生属性与权限：用户名登录、昵称与选填手机号自助修改、手机号登录、多选班级与账号有效期拦截', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-student-attrs-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const uploadDir = path.join(tmpDir, 'uploads');

  const server = createServer({ dbPath, uploadDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function req(pathname, { method = 'GET', body, cookie } = {}) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const setCookie = res.headers.get('set-cookie');
    const nextCookie = setCookie ? setCookie.split(';')[0] : cookie;
    const data = await res.json();
    return { status: res.status, data, cookie: nextCookie };
  }

  const setup = await req('/api/setup', {
    method: 'POST',
    body: { name: '教务管理员', username: '13800003000', password: 'pass', subject: '数学' }
  });
  assert.equal(setup.status, 201);
  const adminCookie = setup.cookie;
  const teacherId = setup.data.teachers[0].id;

  const c1 = await req('/api/courses', { method: 'POST', cookie: adminCookie, body: { name: '数学培优', mode: '直播课', teacherIds: [teacherId] } });
  const c2 = await req('/api/courses', { method: 'POST', cookie: adminCookie, body: { name: '物理拔高', mode: '直播课', teacherIds: [teacherId] } });

  // 1. 建档：不填手机号、填用户名 + 多选两门课程 + 账号有效期
  const stuRes = await req('/api/students', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      name: '小爱',
      loginUsername: 'stu_alice',
      password: 'alice123',
      phone: '',
      validUntil: '2099-12-31',
      courseIds: [c1.data.id, c2.data.id]
    }
  });
  assert.equal(stuRes.status, 201);
  const stuId = stuRes.data.id;
  const activeEnrolls = stuRes.data.state.enrollments.filter(e => e.student_id === stuId && e.status === 'active');
  assert.equal(activeEnrolls.length, 2);

  // 2. 用用户名登录
  const loginByUsername = await req('/api/login', {
    method: 'POST',
    body: { username: 'stu_alice', password: 'alice123' }
  });
  assert.equal(loginByUsername.status, 200);
  assert.equal(loginByUsername.data.currentUser.name, '小爱');
  assert.equal(loginByUsername.data.courses.length, 2);

  // 3. 学生自助修改昵称和绑定手机号（夹带 validUntil/courseIds 无效；直接改 /api/students 返回 403）
  const stuAdminApiDeny = await req(`/api/students/${stuId}`, {
    method: 'PUT',
    cookie: loginByUsername.cookie,
    body: { name: '越权', validUntil: '2099-01-01', courseIds: [] }
  });
  assert.equal(stuAdminApiDeny.status, 403);

  const selfUpdate = await req('/api/auth/profile', {
    method: 'PUT',
    cookie: loginByUsername.cookie,
    body: { name: '爱丽丝同学', phone: '13911112222', validUntil: '2099-01-01', courseIds: [] }
  });
  assert.equal(selfUpdate.status, 200);
  assert.equal(selfUpdate.data.currentUser.name, '爱丽丝同学');
  assert.equal(selfUpdate.data.students[0].phone, '13911112222');
  assert.equal(selfUpdate.data.students[0].valid_until, '2099-12-31'); // 未被学生篡改
  assert.equal(selfUpdate.data.courses.length, 2); // 课程未被学生篡改

  // 4. 设置手机号后，可直接用手机号登录
  const loginByPhone = await req('/api/login', {
    method: 'POST',
    body: { username: '13911112222', password: 'alice123' }
  });
  assert.equal(loginByPhone.status, 200);
  assert.equal(loginByPhone.data.currentUser.username, 'stu_alice');
  assert.equal(loginByPhone.data.currentUser.name, '爱丽丝同学');

  // 5. 管理员多选调整课程（只保留数学培优）并设置过期有效期 -> 立即踢下线且拒绝登录
  const adminUpdate = await req(`/api/students/${stuId}`, {
    method: 'PUT',
    cookie: adminCookie,
    body: {
      name: '爱丽丝同学',
      phone: '13911112222',
      validUntil: '2020-01-01',
      courseIds: [c1.data.id]
    }
  });
  assert.equal(adminUpdate.status, 200);
  const afterEnrolls = adminUpdate.data.enrollments.filter(e => e.student_id === stuId && e.status === 'active');
  assert.equal(afterEnrolls.length, 1);
  assert.equal(afterEnrolls[0].course_id, c1.data.id);

  // 原登录会话已失效
  const expiredSession = await req('/api/state', { cookie: loginByPhone.cookie });
  assert.equal(expiredSession.data.authenticated, false);

  // 再次用用户名或手机号登录均返回 403
  const expiredLogin = await req('/api/login', {
    method: 'POST',
    body: { username: 'stu_alice', password: 'alice123' }
  });
  assert.equal(expiredLogin.status, 403);
});

test('课程多选授课教师、可选人数上限与按课程直接管理学生权限', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-course-teachers-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const uploadDir = path.join(tmpDir, 'uploads');

  const server = createServer({ dbPath, uploadDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function req(pathname, { method = 'GET', body, cookie, rawBody, headers = {} } = {}) {
    const reqHeaders = { ...headers };
    if (cookie) reqHeaders.Cookie = cookie;
    let payload;
    if (rawBody !== undefined) payload = rawBody;
    else if (body !== undefined) {
      reqHeaders['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${pathname}`, { method, headers: reqHeaders, body: payload });
    const setCookie = res.headers.get('set-cookie');
    const nextCookie = setCookie ? setCookie.split(';')[0] : cookie;
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, data, cookie: nextCookie };
  }

  const setup = await req('/api/setup', {
    method: 'POST',
    body: { name: '管理员', username: '13800004000', password: 'pass', subject: '综合' }
  });
  const adminCookie = setup.cookie;

  const t1 = await req('/api/teachers', {
    method: 'POST', cookie: adminCookie,
    body: { name: '授课张老师', subject: '数学', phone: '13800004001', password: 'pass', role: 'teacher' }
  });
  const t2 = await req('/api/teachers', {
    method: 'POST', cookie: adminCookie,
    body: { name: '授课李老师', subject: '物理', phone: '13800004002', password: 'pass', role: 'teacher' }
  });
  const t3 = await req('/api/teachers', {
    method: 'POST', cookie: adminCookie,
    body: { name: '未分配王老师', subject: '化学', phone: '13800004003', password: 'pass', role: 'teacher' }
  });

  // 1. 创建课程：多选 2 位授课教师 + 人数上限留空（默认不限）
  const cMath = await req('/api/courses', {
    method: 'POST',
    cookie: adminCookie,
    body: { name: '高三数学', mode: '直播课', teacherIds: [t1.data.id, t2.data.id] }
  });
  assert.equal(cMath.status, 201);
  const createdMath = cMath.data.state.courses.find(c => c.id === cMath.data.id);
  assert.equal(createdMath.capacity, null);
  assert.equal(createdMath.teacher_ids.length, 2);
  assert.ok(createdMath.teacher_ids.includes(t1.data.id));
  assert.ok(createdMath.teacher_ids.includes(t2.data.id));

  const cChem = await req('/api/courses', {
    method: 'POST',
    cookie: adminCookie,
    body: { name: '高三化学', mode: '直播课', teacherIds: [t3.data.id], capacity: 1 }
  });
  assert.equal(cChem.status, 201);

  // 2. 两位授课教师均可查看课程、上传资料、编辑大纲、群内发言与进入实时课堂；未分配教师 t3 均被 403 拦截
  const t1Login = await req('/api/login', { method: 'POST', body: { username: '13800004001', password: 'pass' } });
  const t2Login = await req('/api/login', { method: 'POST', body: { username: '13800004002', password: 'pass' } });
  const t3Login = await req('/api/login', { method: 'POST', body: { username: '13800004003', password: 'pass' } });
  assert.equal(t1Login.data.courses.some(c => c.id === cMath.data.id), true);
  assert.equal(t2Login.data.courses.some(c => c.id === cMath.data.id), true);
  assert.equal(t3Login.data.courses.some(c => c.id === cMath.data.id), false);

  const matByT2 = await req(`/api/materials/upload?scope=course&targetId=${cMath.data.id}&category=讲义&filename=math.pdf`, {
    method: 'POST', cookie: t2Login.cookie, rawBody: Buffer.from('MATH_PDF'), headers: { 'Content-Type': 'application/pdf' }
  });
  assert.equal(matByT2.status, 201);
  const matByT3Deny = await req(`/api/materials/upload?scope=course&targetId=${cMath.data.id}&category=讲义&filename=deny.pdf`, {
    method: 'POST', cookie: t3Login.cookie, rawBody: Buffer.from('DENY'), headers: { 'Content-Type': 'application/pdf' }
  });
  assert.equal(matByT3Deny.status, 403);

  const nodeByT2 = await req('/api/course-nodes', {
    method: 'POST', cookie: t2Login.cookie, body: { courseId: cMath.data.id, nodeType: 'folder', title: '第一章 函数' }
  });
  assert.equal(nodeByT2.status, 201);
  const nodeByT3Deny = await req('/api/course-nodes', {
    method: 'POST', cookie: t3Login.cookie, body: { courseId: cMath.data.id, nodeType: 'folder', title: '越权目录' }
  });
  assert.equal(nodeByT3Deny.status, 403);

  // 为高三数学排一节由 t1 主讲的课，同为本课授课教师的 t2 也可以授课（发送白板动作）
  const lesMath = await req('/api/lessons', {
    method: 'POST', cookie: adminCookie,
    body: { title: '函数第1讲', courseId: cMath.data.id, teacherId: t1.data.id, startMs: 100000, endMs: 103600 }
  });
  assert.equal(lesMath.status, 201);
  assert.equal((await req(`/api/classroom/${lesMath.data.id}/action`, {
    method: 'POST', cookie: t2Login.cookie, body: { type: 'clear' }
  })).status, 200);
  assert.equal((await req(`/api/classroom/${lesMath.data.id}/action`, {
    method: 'POST', cookie: t3Login.cookie, body: { type: 'clear' }
  })).status, 403);

  // 3. 不限人数上限的课程可自由报入多名学生；设置了 capacity=1 的课程超员拦截
  const stu1 = await req('/api/students', {
    method: 'POST', cookie: adminCookie,
    body: { name: '小明', loginUsername: 'stu_ming', password: 'pass', courseIds: [cMath.data.id, cChem.data.id] }
  });
  const stu2 = await req('/api/students', {
    method: 'POST', cookie: adminCookie,
    body: { name: '小红', loginUsername: 'stu_hong', password: 'pass', courseIds: [cMath.data.id] }
  });
  assert.equal(stu1.status, 201);
  assert.equal(stu2.status, 201);
  const overChem = await req('/api/enrollments', {
    method: 'POST', cookie: adminCookie, body: { courseId: cChem.data.id, studentId: stu2.data.id }
  });
  assert.equal(overChem.status, 409);

  // 学生权限隔离：stu2 可下载数学资料，无权访问未报名的化学群
  const stu2Login = await req('/api/login', { method: 'POST', body: { username: 'stu_hong', password: 'pass' } });
  assert.equal((await fetch(`${baseUrl}/api/materials/${matByT2.data.id}/file`, { headers: { Cookie: stu2Login.cookie } })).status, 200);
  assert.equal((await req('/api/qa', {
    method: 'POST', cookie: stu2Login.cookie, body: { courseId: cChem.data.id, title: '越权', content: 'no' }
  })).status, 403);
});

test('课程群升级：实时 SSE、未读游标、群公告/置顶、图片附件与权限隔离、引用回复、资源卡片、本人撤回与群成员', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-qa-group-'));
  const dbPath = path.join(tmpDir, 'workbench.db');
  const uploadDir = path.join(tmpDir, 'uploads');
  const server = createServer({ dbPath, uploadDir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(async () => {
    server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function req(p, { method = 'GET', body, cookie } = {}) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${baseUrl}${p}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, cookie: extractSessionCookie(res) };
  }

  // 初始化管理员、课程 A/B、教师、学生 A（在读 A）、学生 B（在读 B）
  const setup = await req('/api/setup', {
    method: 'POST',
    body: { name: '管理员', username: '13800005000', password: 'pass', subject: '教务' }
  });
  assert.equal(setup.status, 201);
  const adminCookie = setup.cookie;

  const tA = await req('/api/teachers', {
    method: 'POST', cookie: adminCookie,
    body: { name: '张老师', subject: '数学', phone: '13800005001', password: 'pass' }
  });
  const cA = await req('/api/courses', { method: 'POST', cookie: adminCookie, body: { name: '高数精讲', subject: '数学', teacherIds: [tA.data.id] } });
  const cB = await req('/api/courses', { method: 'POST', cookie: adminCookie, body: { name: '英语写作', subject: '英语', teacherIds: [tA.data.id] } });

  const stuA = await req('/api/students', {
    method: 'POST', cookie: adminCookie,
    body: { name: '同学甲', phone: '13800005011', password: 'pass', courseIds: [cA.data.id] }
  });
  const stuB = await req('/api/students', {
    method: 'POST', cookie: adminCookie,
    body: { name: '同学乙', phone: '13800005012', password: 'pass', courseIds: [cB.data.id] }
  });

  const teacherLogin = await req('/api/login', { method: 'POST', body: { username: '13800005001', password: 'pass' } });
  const stuALogin = await req('/api/login', { method: 'POST', body: { username: '13800005011', password: 'pass' } });
  const stuBLogin = await req('/api/login', { method: 'POST', body: { username: '13800005012', password: 'pass' } });

  // 1. 群成员列表 & 权限隔离
  const membersA = await req(`/api/qa/members?courseId=${cA.data.id}`, { cookie: stuALogin.cookie });
  assert.equal(membersA.status, 200);
  assert.equal(membersA.data.teachers.length, 1);
  assert.equal(membersA.data.teachers[0].name, '张老师');
  assert.equal(membersA.data.students.length, 1);
  assert.equal(membersA.data.students[0].name, '同学甲');
  assert.equal((await req(`/api/qa/members?courseId=${cA.data.id}`, { cookie: stuBLogin.cookie })).status, 403);

  // 2. 学生不能发群公告或置顶，教师可以发群公告（自动置顶）并切换置顶
  assert.equal((await req('/api/qa?lite=1', {
    method: 'POST', cookie: stuALogin.cookie,
    body: { courseId: cA.data.id, msgType: 'announcement', content: '越权公告' }
  })).status, 403);

  const ann = await req('/api/qa?lite=1', {
    method: 'POST', cookie: teacherLogin.cookie,
    body: { courseId: cA.data.id, msgType: 'announcement', content: '本周六提前 10 分钟进教室' }
  });
  assert.equal(ann.status, 201);
  assert.equal(ann.data.post.msg_type, 'announcement');
  assert.equal(ann.data.post.pinned, 1);

  const unpin = await req(`/api/qa/${ann.data.id}/pin?lite=1`, {
    method: 'PATCH', cookie: teacherLogin.cookie, body: { pinned: false }
  });
  assert.equal(unpin.status, 200);
  assert.equal(unpin.data.post.pinned, 0);

  // 3. 图片附件上传 + 发送带图片/资源卡片/引用/@提醒的消息 + 附件权限隔离
  const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  const upRes = await fetch(`${baseUrl}/api/qa/upload?courseId=${cA.data.id}&filename=q1.png`, {
    method: 'POST',
    headers: { Cookie: stuALogin.cookie, 'Content-Type': 'image/png' },
    body: fakePng
  });
  assert.equal(upRes.status, 201);
  const attMeta = await upRes.json();
  assert.equal(attMeta.isImage, true);
  await fs.access(path.join(uploadDir, attMeta.storedName));

  // 订阅 SSE（同学甲在线监听课程群实时推送）
  const sseAbort = new AbortController();
  const sseRes = await fetch(`${baseUrl}/api/qa/stream`, {
    headers: { Cookie: teacherLogin.cookie },
    signal: sseAbort.signal
  });
  assert.equal(sseRes.status, 200);
  const sseReader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let sseBuf = '';
  const readUntil = async (needle) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (sseBuf.includes(needle)) return sseBuf;
      const { value, done } = await sseReader.read();
      if (done) break;
      sseBuf += decoder.decode(value, { stream: true });
    }
    return sseBuf;
  };
  await readUntil('event: ready');

  // 学生不可发送资源卡片（403）
  const stuCardDeny = await req('/api/qa?lite=1', {
    method: 'POST', cookie: stuALogin.cookie,
    body: {
      courseId: cA.data.id,
      msgType: 'chat',
      card: { type: 'course', id: cA.data.id, title: '高数精讲', subtitle: '课程卡片' },
      content: '越权卡片'
    }
  });
  assert.equal(stuCardDeny.status, 403);

  // 教师可发送资源卡片
  const teacherCardPost = await req('/api/qa?lite=1', {
    method: 'POST', cookie: teacherLogin.cookie,
    body: {
      courseId: cA.data.id,
      msgType: 'chat',
      card: { type: 'course', id: cA.data.id, title: '高数精讲', subtitle: '课程卡片' },
      content: '请预习本课程资料'
    }
  });
  assert.equal(teacherCardPost.status, 201);
  assert.equal(teacherCardPost.data.post.card.title, '高数精讲');

  const stuPost = await req('/api/qa?lite=1', {
    method: 'POST', cookie: stuALogin.cookie,
    body: {
      courseId: cA.data.id,
      msgType: 'question',
      replyToId: ann.data.id,
      mentions: [{ id: tA.data.id, name: '张老师', role: 'teacher' }],
      attachments: [attMeta],
      content: '@张老师 这道题怎么做？'
    }
  });
  assert.equal(stuPost.status, 201);
  assert.equal(stuPost.data.post.reply_to_id, ann.data.id);
  assert.equal(stuPost.data.post.attachments.length, 1);

  // 验证 SSE 实时收到 qa_post 推送
  const received = await readUntil(stuPost.data.id);
  assert.ok(received.includes('event: qa_post'));
  sseAbort.abort();

  // 附件访问权限：同课教师可读，外课学生 B 被 403 拦截
  assert.equal((await fetch(`${baseUrl}/api/qa/${stuPost.data.id}/attachments/${attMeta.id}`, {
    headers: { Cookie: teacherLogin.cookie }
  })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/qa/${stuPost.data.id}/attachments/${attMeta.id}`, {
    headers: { Cookie: stuBLogin.cookie }
  })).status, 403);

  // 4. 已读游标与分页接口
  const readRes = await req('/api/qa/read', {
    method: 'POST', cookie: teacherLogin.cookie,
    body: { courseId: cA.data.id, lastReadMs: Date.now() + 1000 }
  });
  assert.equal(readRes.status, 200);
  const teacherState = await req('/api/state', { cookie: teacherLogin.cookie });
  assert.ok(teacherState.data.qaReadCursors[cA.data.id] > 0);

  const pageRes = await req(`/api/qa/messages?courseId=${cA.data.id}&limit=1`, { cookie: stuALogin.cookie });
  assert.equal(pageRes.status, 200);
  assert.equal(pageRes.data.posts.length, 1);
  assert.equal(pageRes.data.hasMore, true);

  // 5. 楼中楼回复与本人撤回权限（学生可撤回自己的回复和消息，不可删教师的）
  const rep = await req(`/api/qa/${stuPost.data.id}/replies?lite=1`, {
    method: 'POST', cookie: stuALogin.cookie, body: { content: '补充说明' }
  });
  assert.equal(rep.status, 201);
  const delRep = await req(`/api/qa/replies/${rep.data.reply.id}?lite=1`, {
    method: 'DELETE', cookie: stuALogin.cookie
  });
  assert.equal(delRep.status, 200);

  // 学生不能删教师的公告，但可以撤回自己 2 分钟内发的消息（留下撤回提示且磁盘附件同步清理）
  assert.equal((await req(`/api/qa/${ann.data.id}?lite=1`, { method: 'DELETE', cookie: stuALogin.cookie })).status, 403);
  const recallOwn = await req(`/api/qa/${stuPost.data.id}?lite=1`, { method: 'DELETE', cookie: stuALogin.cookie });
  assert.equal(recallOwn.status, 200);
  assert.equal(recallOwn.data.post.recall_kind, 'recall');
  assert.equal(recallOwn.data.post.recalled_by_name, '同学甲');
  await assert.rejects(() => fs.access(path.join(uploadDir, attMeta.storedName)));

  // 教师可多选批量删除学生消息（留下删除提示），不可删管理员或他人的教师消息；可撤回自己的消息；管理员可删任何人的消息
  const adminMsg = await req('/api/qa?lite=1', {
    method: 'POST', cookie: adminCookie, body: { courseId: cA.data.id, msgType: 'chat', content: '管理员通知' }
  });
  const stuMsg2 = await req('/api/qa?lite=1', {
    method: 'POST', cookie: stuALogin.cookie, body: { courseId: cA.data.id, msgType: 'chat', content: '学生消息2' }
  });
  assert.equal((await req(`/api/qa/${adminMsg.data.id}?lite=1`, { method: 'DELETE', cookie: teacherLogin.cookie })).status, 403);
  assert.equal((await req('/api/qa/batch-delete', {
    method: 'POST', cookie: teacherLogin.cookie, body: { courseId: cA.data.id, postIds: [adminMsg.data.id] }
  })).status, 403);

  const teacherRecallOwn = await req(`/api/qa/${teacherCardPost.data.id}?lite=1`, { method: 'DELETE', cookie: teacherLogin.cookie });
  assert.equal(teacherRecallOwn.status, 200);
  assert.equal(teacherRecallOwn.data.post.recall_kind, 'recall');
  assert.equal(teacherRecallOwn.data.post.recalled_by_name, '张老师');

  assert.equal((await req('/api/qa/batch-delete', {
    method: 'POST', cookie: stuALogin.cookie, body: { courseId: cA.data.id, postIds: [stuMsg2.data.id] }
  })).status, 403);
  const batchDelStu = await req('/api/qa/batch-delete', {
    method: 'POST', cookie: teacherLogin.cookie, body: { courseId: cA.data.id, postIds: [stuMsg2.data.id] }
  });
  assert.equal(batchDelStu.status, 200);
  assert.equal(batchDelStu.data.count, 1);
  assert.equal(batchDelStu.data.posts[0].recall_kind, 'delete');
  assert.equal(batchDelStu.data.posts[0].recalled_by_name, '张老师');

  const adminBatchDel = await req('/api/qa/batch-delete', {
    method: 'POST', cookie: adminCookie, body: { courseId: cA.data.id, postIds: [ann.data.id, adminMsg.data.id] }
  });
  assert.equal(adminBatchDel.status, 200);
  assert.equal(adminBatchDel.data.count, 2);
  assert.equal(adminBatchDel.data.posts[0].recall_kind, 'delete');
});

test('课程大纲树：多级目录/小节/内容编排、排序、防环与角色权限', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-outline-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const uploadDir = path.join(tmpDir, 'uploads');

  const server = createServer({ dbPath, uploadDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function req(pathname, { method = 'GET', body, cookie, rawBody, headers = {} } = {}) {
    const reqHeaders = { ...headers };
    if (cookie) reqHeaders.Cookie = cookie;
    let payload;
    if (rawBody !== undefined) {
      payload = rawBody;
    } else if (body !== undefined) {
      reqHeaders['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${pathname}`, { method, headers: reqHeaders, body: payload });
    const setCookie = res.headers.get('set-cookie');
    const nextCookie = setCookie ? setCookie.split(';')[0] : cookie;
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, data, cookie: nextCookie, headers: res.headers };
  }

  const setup = await req('/api/setup', {
    method: 'POST',
    body: { name: '管理员', username: '13800004000', password: 'password123', subject: '数学' }
  });
  assert.equal(setup.status, 201);
  const adminCookie = setup.cookie;

  const cA = await req('/api/courses', { method: 'POST', cookie: adminCookie, body: { name: '概率统计', subject: '数学', mode: '直播课' } });
  const cB = await req('/api/courses', { method: 'POST', cookie: adminCookie, body: { name: '线性代数', subject: '数学', mode: '直播课' } });
  assert.equal(cA.status, 201);
  assert.equal(cB.status, 201);

  const tA = await req('/api/teachers', { method: 'POST', cookie: adminCookie, body: { name: '王老师', subject: '数学', phone: '13800004001', password: 'pass1234' } });
  const tB = await req('/api/teachers', { method: 'POST', cookie: adminCookie, body: { name: '赵老师', subject: '数学', phone: '13800004002', password: 'pass1234' } });
  await req(`/api/courses/${cA.data.id}`, { method: 'PUT', cookie: adminCookie, body: { name: '概率统计', subject: '数学', teacherIds: [tA.data.id] } });
  await req(`/api/courses/${cB.data.id}`, { method: 'PUT', cookie: adminCookie, body: { name: '线性代数', subject: '数学', teacherIds: [tB.data.id] } });
  const stuA = await req('/api/students', { method: 'POST', cookie: adminCookie, body: { name: '小明', loginUsername: 'stu_outline', password: 'pass1234', courseIds: [cA.data.id] } });
  assert.equal(stuA.status, 201);

  const tALogin = await req('/api/login', { method: 'POST', body: { username: '13800004001', password: 'pass1234' } });
  const tBLogin = await req('/api/login', { method: 'POST', body: { username: '13800004002', password: 'pass1234' } });
  const stuLogin = await req('/api/login', { method: 'POST', body: { username: 'stu_outline', password: 'pass1234' } });

  // 上传一份课程资料用于挂载
  const matUp = await req(`/api/materials/upload?scope=course&targetId=${cA.data.id}&category=讲义&filename=notes.pdf`, {
    method: 'POST',
    cookie: adminCookie,
    rawBody: Buffer.from('%PDF-1.4 test'),
    headers: { 'Content-Type': 'application/pdf' }
  });
  assert.equal(matUp.status, 201);
  const matId = matUp.data.id;

  // 1. 管理员与任课教师均可创建章、节与内容；非任课教师和学生被拒 403
  const ch1 = await req('/api/course-nodes', {
    method: 'POST',
    cookie: adminCookie,
    body: { courseId: cA.data.id, nodeType: 'folder', title: '概率统计I：计数与概率' }
  });
  assert.equal(ch1.status, 201);
  const ch2 = await req('/api/course-nodes', {
    method: 'POST',
    cookie: tALogin.cookie,
    body: { courseId: cA.data.id, nodeType: 'folder', title: '概率统计II：随机变量' }
  });
  assert.equal(ch2.status, 201);

  const sec1 = await req('/api/course-nodes', {
    method: 'POST',
    cookie: tALogin.cookie,
    body: { courseId: cA.data.id, parentId: ch1.data.id, nodeType: 'folder', title: '1 计数原理与组合数' }
  });
  assert.equal(sec1.status, 201);

  const matNode = await req('/api/course-nodes', {
    method: 'POST',
    cookie: tALogin.cookie,
    body: { courseId: cA.data.id, parentId: sec1.data.id, nodeType: 'material', title: '课程讲义_2027版.pdf', refId: matId }
  });
  assert.equal(matNode.status, 201);

  const noteNode = await req('/api/course-nodes', {
    method: 'POST',
    cookie: adminCookie,
    body: { courseId: cA.data.id, parentId: sec1.data.id, nodeType: 'note', title: '学习说明', content: '先看讲义再做例题' }
  });
  assert.equal(noteNode.status, 201);

  // 非任课教师 B 与学生均不可写
  assert.equal((await req('/api/course-nodes', {
    method: 'POST', cookie: tBLogin.cookie,
    body: { courseId: cA.data.id, nodeType: 'folder', title: '越权目录' }
  })).status, 403);
  assert.equal((await req('/api/course-nodes', {
    method: 'POST', cookie: stuLogin.cookie,
    body: { courseId: cA.data.id, nodeType: 'folder', title: '学生越权' }
  })).status, 403);

  // 2. 排序上移/下移与拖拽重排（含跨目录移入与防环）
  const moveUp = await req(`/api/course-nodes/${ch2.data.id}/move`, {
    method: 'POST', cookie: tALogin.cookie, body: { direction: 'up' }
  });
  assert.equal(moveUp.status, 200);
  const rootNodes = moveUp.data.courseNodes.filter(n => n.course_id === cA.data.id && !n.parent_id);
  assert.equal(rootNodes[0].id, ch2.data.id);
  assert.equal(rootNodes[1].id, ch1.data.id);

  const dragBefore = await req(`/api/course-nodes/${ch1.data.id}/reorder`, {
    method: 'POST', cookie: tALogin.cookie, body: { targetId: ch2.data.id, position: 'before' }
  });
  assert.equal(dragBefore.status, 200);
  const rootAfterDrag = dragBefore.data.courseNodes.filter(n => n.course_id === cA.data.id && !n.parent_id);
  assert.equal(rootAfterDrag[0].id, ch1.data.id);
  assert.equal(rootAfterDrag[1].id, ch2.data.id);

  // 将 noteNode 拖入 ch2 目录下
  const dragInside = await req(`/api/course-nodes/${noteNode.data.id}/reorder`, {
    method: 'POST', cookie: tALogin.cookie, body: { targetId: ch2.data.id, position: 'inside' }
  });
  assert.equal(dragInside.status, 200);
  assert.equal(dragInside.data.courseNodes.find(n => n.id === noteNode.data.id).parent_id, ch2.data.id);

  // 拖回 sec1 下保持后续删除断言一致
  const dragBack = await req(`/api/course-nodes/${noteNode.data.id}/reorder`, {
    method: 'POST', cookie: tALogin.cookie, body: { targetId: sec1.data.id, position: 'inside' }
  });
  assert.equal(dragBack.status, 200);

  // 禁止拖拽目录进入自身子目录
  assert.equal((await req(`/api/course-nodes/${ch1.data.id}/reorder`, {
    method: 'POST', cookie: tALogin.cookie, body: { targetId: sec1.data.id, position: 'inside' }
  })).status, 400);

  // 3. 禁止将目录移动到自身或子孙目录下（防环）
  const selfCycle = await req(`/api/course-nodes/${ch1.data.id}`, {
    method: 'PUT', cookie: adminCookie,
    body: { parentId: sec1.data.id, title: ch1.data.title }
  });
  assert.equal(selfCycle.status, 400);

  // 4. 角色快照可见性：学生在读课程可见，非任课教师 B 不可见
  const stuState = await req('/api/state', { cookie: stuLogin.cookie });
  assert.equal(stuState.data.courseNodes.filter(n => n.course_id === cA.data.id).length, 5);
  const tBState = await req('/api/state', { cookie: tBLogin.cookie });
  assert.equal(tBState.data.courseNodes.filter(n => n.course_id === cA.data.id).length, 0);

  // 5. 删除目录递归移除子孙节点，但保留底层已上传资料
  const delRes = await req(`/api/course-nodes/${ch1.data.id}`, { method: 'DELETE', cookie: adminCookie });
  assert.equal(delRes.status, 200);
  assert.equal(delRes.data.courseNodes.filter(n => n.course_id === cA.data.id).length, 1);
  assert.equal(delRes.data.materials.some(m => m.id === matId), true);
});

test('课程管理与课程内容优化：学生大纲权限隔离、删除级联清理、批量导入、复制大纲与按星期预排', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-course-opt-'));
  const dbPath = path.join(tmpDir, 'workbench.db');
  const uploadDir = path.join(tmpDir, 'uploads');
  const server = createServer({ dbPath, uploadDir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(async () => {
    server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function req(p, { method = 'GET', body, cookie } = {}) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${baseUrl}${p}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, cookie: extractSessionCookie(res) };
  }

  const setup = await req('/api/setup', {
    method: 'POST',
    body: { name: '管理员', username: '13800007000', password: 'pass', subject: '教务' }
  });
  const adminCookie = setup.cookie;

  const t1 = await req('/api/teachers', {
    method: 'POST', cookie: adminCookie,
    body: { name: '王老师', subject: '数学', phone: '13800007001', password: 'pass' }
  });
  const c1 = await req('/api/courses', { method: 'POST', cookie: adminCookie, body: { name: '导数专题', subject: '数学' } });
  const c2 = await req('/api/courses', { method: 'POST', cookie: adminCookie, body: { name: '导数专题-春季班', subject: '数学', teacherIds: [t1.data.id] } });
  await req('/api/students', {
    method: 'POST', cookie: adminCookie,
    body: { name: '一班学生', phone: '13800007011', password: 'pass', courseIds: [c1.data.id] }
  });
  const stu1Login = await req('/api/login', { method: 'POST', body: { username: '13800007011', password: 'pass' } });

  // 创建 c1 课次、c2 课次、c1 课程通用资料、c2 专属课次资料、撤回态录播
  const baseStart = Date.UTC(2027, 3, 5, 2, 0, 0); // 2027-04-05 (Mon) 10:00 UTC+8
  const les1 = await req('/api/lessons', {
    method: 'POST', cookie: adminCookie,
    body: { courseId: c1.data.id, teacherId: t1.data.id, title: '一班第1讲', startMs: baseStart, endMs: baseStart + 3600000 }
  });
  const les2 = await req('/api/lessons', {
    method: 'POST', cookie: adminCookie,
    body: { courseId: c2.data.id, teacherId: t1.data.id, title: '二班第1讲', startMs: baseStart + 7200000, endMs: baseStart + 10800000 }
  });

  const upCourseMat = await fetch(`${baseUrl}/api/materials/upload?scope=course&targetId=${c1.data.id}&category=通用讲义&filename=common.pdf`, {
    method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/pdf' }, body: Buffer.from('%PDF-1.4')
  });
  const courseMatId = (await upCourseMat.json()).id;

  const upLes2Mat = await fetch(`${baseUrl}/api/materials/upload?scope=lesson&targetId=${les2.data.id}&category=课后板书&filename=cls2.pdf`, {
    method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/pdf' }, body: Buffer.from('%PDF-1.4')
  });
  const les2MatId = (await upLes2Mat.json()).id;

  const upVod = await fetch(`${baseUrl}/api/vod/upload?courseId=${c1.data.id}&chapterName=第一章&title=未发布录播&sortOrder=1&filename=v.mp4`, {
    method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'video/mp4' }, body: Buffer.from('0000')
  });
  const vodId = (await upVod.json()).id;
  await req(`/api/vod/${vodId}`, { method: 'PATCH', cookie: adminCookie, body: { status: 'withdrawn' } });

  // 1. 建立目录 + 批量导入节点
  const folder = await req('/api/course-nodes', {
    method: 'POST', cookie: adminCookie,
    body: { courseId: c1.data.id, nodeType: 'folder', title: '第一章 导数概念' }
  });
  const note = await req('/api/course-nodes', {
    method: 'POST', cookie: adminCookie,
    body: { courseId: c1.data.id, parentId: folder.data.id, nodeType: 'note', title: '预习要求', content: '先看讲义前3页' }
  });
  assert.equal(note.status, 201);

  const batchImport = await req('/api/course-nodes/batch', {
    method: 'POST', cookie: adminCookie,
    body: {
      courseId: c1.data.id,
      parentId: folder.data.id,
      items: [
        { nodeType: 'lesson', refId: les1.data.id, title: '一班第1讲' },
        { nodeType: 'lesson', refId: les2.data.id, title: '二班第1讲' },
        { nodeType: 'material', refId: courseMatId, title: 'common.pdf' },
        { nodeType: 'material', refId: les2MatId, title: 'cls2.pdf' },
        { nodeType: 'vod', refId: vodId, title: '未发布录播' }
      ]
    }
  });
  assert.equal(batchImport.status, 201);
  assert.equal(batchImport.data.ids.length, 5);

  // 2. 验证一班学生只能看到目录、说明、一班课次、课程通用资料，绝不泄露二班课次/二班板书/已撤回录播
  const stu1State = await req('/api/state', { cookie: stu1Login.cookie });
  const visibleTitles = stu1State.data.courseNodes.map(n => n.title);
  assert.ok(visibleTitles.includes('第一章 导数概念'));
  assert.ok(visibleTitles.includes('预习要求'));
  assert.ok(visibleTitles.includes('一班第1讲'));
  assert.ok(visibleTitles.includes('common.pdf'));
  assert.ok(!visibleTitles.includes('二班第1讲'));
  assert.ok(!visibleTitles.includes('cls2.pdf'));
  assert.ok(!visibleTitles.includes('未发布录播'));

  // 3. 复制大纲结构到课程 c2（仅复制目录与说明层级）
  const copyRes = await req(`/api/courses/${c2.data.id}/copy-outline`, {
    method: 'POST', cookie: adminCookie,
    body: { sourceCourseId: c1.data.id }
  });
  assert.equal(copyRes.status, 200);
  assert.equal(copyRes.data.copied, 2);
  const c2Nodes = copyRes.data.state.courseNodes.filter(n => n.course_id === c2.data.id);
  assert.equal(c2Nodes.length, 2);
  const c2Folder = c2Nodes.find(n => n.node_type === 'folder');
  const c2Note = c2Nodes.find(n => n.node_type === 'note');
  assert.equal(c2Note.parent_id, c2Folder.id);

  // 4. 删除底层资料 / 录播 / 课次后，大纲中的孤儿引用自动清理
  const afterDelMat = await req(`/api/materials/${courseMatId}`, { method: 'DELETE', cookie: adminCookie });
  assert.equal(afterDelMat.status, 200);
  assert.equal(afterDelMat.data.courseNodes.some(n => n.ref_id === courseMatId), false);

  const afterDelVod = await req(`/api/vod/${vodId}`, { method: 'DELETE', cookie: adminCookie });
  assert.equal(afterDelVod.status, 200);
  assert.equal(afterDelVod.data.courseNodes.some(n => n.ref_id === vodId), false);

  const afterDelLes = await req(`/api/lessons/${les2.data.id}`, { method: 'DELETE', cookie: adminCookie });
  assert.equal(afterDelLes.status, 200);
  assert.equal(afterDelLes.data.courseNodes.some(n => n.ref_id === les2.data.id), false);
  assert.equal(afterDelLes.data.courseNodes.some(n => n.ref_id === les2MatId), false);

  // 5. 批量排课支持按星期多选 + dryRun 冲突预览
  const dryRes = await req('/api/lessons/batch', {
    method: 'POST', cookie: adminCookie,
    body: {
      titlePrefix: '周中冲刺',
      courseId: c1.data.id,
      teacherId: t1.data.id,
      firstStartMs: baseStart, // 周一（与 les1 冲突）
      durationMs: 3600000,
      weekdays: [1, 3, 5],
      count: 3,
      dryRun: true
    }
  });
  assert.equal(dryRes.status, 200);
  assert.equal(dryRes.data.preview.length, 3);
  assert.equal(dryRes.data.conflictCount, 1);
  assert.ok(dryRes.data.preview[0].conflict.length > 0);
  assert.equal(dryRes.data.preview[1].conflict, '');
  assert.equal(dryRes.data.preview[2].conflict, '');
  assert.equal(new Date(dryRes.data.preview[1].startMs).getDay(), 3);
  assert.equal(new Date(dryRes.data.preview[2].startMs).getDay(), 5);
});

test('实时课堂升级：PDF.js 静态资源、讨论持久化、按人授权板书、批量导入白板页与软静音状态', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-classroom-up-'));
  const dbPath = path.join(tmpDir, 'workbench.db');
  const uploadDir = path.join(tmpDir, 'uploads');
  const server = createServer({ dbPath, uploadDir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(async () => {
    server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function req(p, { method = 'GET', body, cookie } = {}) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${baseUrl}${p}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, cookie: extractSessionCookie(res) };
  }

  const setup = await req('/api/setup', {
    method: 'POST',
    body: { name: '管理员', username: '13800008000', password: 'pass', subject: '教务' }
  });
  const adminCookie = setup.cookie;

  const t1 = await req('/api/teachers', { method: 'POST', cookie: adminCookie, body: { name: '张老师', subject: '数学', phone: '13800001201', password: 'pass' } });
  const c1 = await req('/api/courses', { method: 'POST', cookie: adminCookie, body: { name: '函数专题', teacherIds: [t1.data.id] } });
  await req('/api/students', { method: 'POST', cookie: adminCookie, body: { name: '李小明', phone: '13900001201', courseIds: [c1.data.id], password: 'pass' } });
  await req('/api/students', { method: 'POST', cookie: adminCookie, body: { name: '王小红', phone: '13900001202', courseIds: [c1.data.id], password: 'pass' } });
  const futureStartMs = Date.now() + 3 * 3600 * 1000;
  const futureLes = await req('/api/lessons', {
    method: 'POST', cookie: adminCookie,
    body: { title: '未到开课时间的课', courseId: c1.data.id, teacherId: t1.data.id, startMs: futureStartMs, endMs: futureStartMs + 3600000 }
  });
  const startTooEarly = await req(`/api/lessons/${futureLes.data.id}/status`, {
    method: 'PATCH', cookie: adminCookie,
    body: { status: 'in_progress' }
  });
  assert.equal(startTooEarly.status, 400);

  const startMs = Date.now() + 5 * 60 * 1000;
  const les = await req('/api/lessons', {
    method: 'POST', cookie: adminCookie,
    body: { title: '函数单调性', courseId: c1.data.id, teacherId: t1.data.id, startMs, endMs: startMs + 3600000 }
  });

  const s1Cookie = (await req('/api/login', { method: 'POST', body: { username: '13900001201', password: 'pass' } })).cookie;
  const s2Cookie = (await req('/api/login', { method: 'POST', body: { username: '13900001202', password: 'pass' } })).cookie;

  // 1. pdf.min.mjs 静态资源可访问
  const pdfJsRes = await fetch(`${baseUrl}/public/vendor/pdfjs/pdf.min.mjs`);
  assert.equal(pdfJsRes.status, 200);
  assert.ok((pdfJsRes.headers.get('content-type') || '').includes('javascript'));

  // 2. 开课前学生不可发言或举手；开课前10分钟内教师点击上课后即可发言并持久化
  const ac1 = new AbortController();
  const s1Stream = await fetch(`${baseUrl}/api/classroom/${les.data.id}/stream?clientId=stu1`, {
    headers: { Cookie: s1Cookie },
    signal: ac1.signal
  });
  assert.equal(s1Stream.status, 200);

  const chatBeforeStart = await req(`/api/classroom/${les.data.id}/action`, {
    method: 'POST', cookie: s1Cookie,
    body: { type: 'chat', text: '开课前发言应被拦截' }
  });
  assert.equal(chatBeforeStart.status, 403);

  const handBeforeStart = await req(`/api/classroom/${les.data.id}/action`, {
    method: 'POST', cookie: s1Cookie,
    body: { type: 'hand', clientId: 'stu1', raised: true }
  });
  assert.equal(handBeforeStart.status, 403);

  const startOk = await req(`/api/lessons/${les.data.id}/status`, {
    method: 'PATCH', cookie: adminCookie,
    body: { status: 'in_progress' }
  });
  assert.equal(startOk.status, 200);

  const chatRes = await req(`/api/classroom/${les.data.id}/action`, {
    method: 'POST', cookie: s1Cookie,
    body: { type: 'chat', text: '老师，第2题定义域怎么看？' }
  });
  assert.equal(chatRes.status, 200);
  ac1.abort();
  await new Promise(r => setTimeout(r, 40));

  // 重新进入课堂，读取 init 事件（断开重连不会下课，lessonStatus 仍为 in_progress）
  const ac2 = new AbortController();
  const s1Stream2 = await fetch(`${baseUrl}/api/classroom/${les.data.id}/stream?clientId=stu1`, {
    headers: { Cookie: s1Cookie },
    signal: ac2.signal
  });
  const reader = s1Stream2.body.getReader();
  const { value } = await reader.read();
  const firstChunk = Buffer.from(value).toString('utf8');
  assert.ok(firstChunk.includes('老师，第2题定义域怎么看？'));
  assert.ok(firstChunk.includes('"lessonStatus":"in_progress"'));

  // 3. 按人授权板书：默认禁止学生书写，单独授权 stu1 后 stu1 可写、stu2 仍被拒
  const ac3 = new AbortController();
  const s2Stream = await fetch(`${baseUrl}/api/classroom/${les.data.id}/stream?clientId=stu2`, {
    headers: { Cookie: s2Cookie },
    signal: ac3.signal
  });
  assert.equal(s2Stream.status, 200);

  const grantRes = await req(`/api/classroom/${les.data.id}/action`, {
    method: 'POST', cookie: adminCookie,
    body: { type: 'student-draw-client', targetClientId: 'stu1', allowed: true }
  });
  assert.equal(grantRes.status, 200);

  const s1DrawOk = await req(`/api/classroom/${les.data.id}/action`, {
    method: 'POST', cookie: s1Cookie,
    body: { type: 'stroke', clientId: 'stu1', stroke: { kind: 'pen', points: [[0.1, 0.1], [0.3, 0.3]] } }
  });
  assert.equal(s1DrawOk.status, 200);

  const s2DrawDenied = await req(`/api/classroom/${les.data.id}/action`, {
    method: 'POST', cookie: s2Cookie,
    body: { type: 'stroke', clientId: 'stu2', stroke: { kind: 'pen', points: [[0.2, 0.2], [0.4, 0.4]] } }
  });
  assert.equal(s2DrawDenied.status, 403);

  // 4. 软静音状态上报
  const muteRes = await req(`/api/classroom/${les.data.id}/action`, {
    method: 'POST', cookie: s1Cookie,
    body: { type: 'mic-mute', clientId: 'stu1', muted: true }
  });
  assert.equal(muteRes.status, 200);

  // 5. 批量导入白板页权限与结果校验
  const stuImportDenied = await req(`/api/classroom/${les.data.id}/action`, {
    method: 'POST', cookie: s1Cookie,
    body: { type: 'pages-import', pages: [{ strokes: [], bgUrl: 'preset:coord' }] }
  });
  assert.equal(stuImportDenied.status, 403);

  const adminImportOk = await req(`/api/classroom/${les.data.id}/action`, {
    method: 'POST', cookie: adminCookie,
    body: { type: 'pages-import', pages: [{ strokes: [], bgUrl: 'preset:coord' }, { strokes: [], bgUrl: 'preset:grid' }] }
  });
  assert.equal(adminImportOk.status, 200);

  ac2.abort();
  ac3.abort();
  const ac4 = new AbortController();
  const verifyStream = await fetch(`${baseUrl}/api/classroom/${les.data.id}/stream?clientId=stu1`, {
    headers: { Cookie: s1Cookie },
    signal: ac4.signal
  });
  const vReader = verifyStream.body.getReader();
  const { value: vVal } = await vReader.read();
  const vText = Buffer.from(vVal).toString('utf8');
  const dataLine = vText.split('\n').find(l => l.startsWith('data: '));
  const initPayload = JSON.parse(dataLine.slice(6));
  ac4.abort();
  assert.equal(initPayload.pages.length, 3);
  assert.equal(initPayload.pages[1].bgUrl, 'preset:coord');
  assert.equal(initPayload.pages[2].bgUrl, 'preset:grid');

  // 6. 举手后连线全流程：举手 -> 教师暂不连线 -> 再举手 -> 教师接通音视频连线 -> 摄像头状态 -> 越权拦截 -> 学生自助挂断
  const acHand1 = new AbortController();
  const s1HandStream = await fetch(`${baseUrl}/api/classroom/${les.data.id}/stream?clientId=stu1`, {
    headers: { Cookie: s1Cookie },
    signal: acHand1.signal
  });
  assert.equal(s1HandStream.status, 200);

  const acHand2 = new AbortController();
  const s2HandStream = await fetch(`${baseUrl}/api/classroom/${les.data.id}/stream?clientId=stu2`, {
    headers: { Cookie: s2Cookie },
    signal: acHand2.signal
  });
  assert.equal(s2HandStream.status, 200);

  assert.equal((await req(`/api/classroom/${les.data.id}/action`, {
    method: 'POST', cookie: s1Cookie,
    body: { type: 'hand', clientId: 'stu1', raised: true }
  })).status, 200);

  assert.equal((await req(`/api/classroom/${les.data.id}/action`, {
    method: 'POST', cookie: s2Cookie,
    body: { type: 'hand-reject', targetClientId: 'stu1' }
  })).status, 403);

  assert.equal((await req(`/api/classroom/${les.data.id}/action`, {
    method: 'POST', cookie: adminCookie,
    body: { type: 'hand-reject', targetClientId: 'stu1' }
  })).status, 200);

  assert.equal((await req(`/api/classroom/${les.data.id}/action`, {
    method: 'POST', cookie: s1Cookie,
    body: { type: 'hand', clientId: 'stu1', raised: true }
  })).status, 200);
  assert.equal((await req(`/api/classroom/${les.data.id}/action`, {
    method: 'POST', cookie: adminCookie,
    body: { type: 'mic', targetClientId: 'stu1', allowed: true, withVideo: true }
  })).status, 200);

  assert.equal((await req(`/api/classroom/${les.data.id}/action`, {
    method: 'POST', cookie: s2Cookie,
    body: { type: 'cam-state', clientId: 'stu2', active: true, streamId: 'cam_bad' }
  })).status, 403);

  assert.equal((await req(`/api/classroom/${les.data.id}/action`, {
    method: 'POST', cookie: s1Cookie,
    body: { type: 'cam-state', clientId: 'stu1', active: true, streamId: 'cam_stu1' }
  })).status, 200);

  const acCheck = new AbortController();
  const checkStream = await fetch(`${baseUrl}/api/classroom/${les.data.id}/stream?clientId=adm1`, {
    headers: { Cookie: adminCookie },
    signal: acCheck.signal
  });
  const cReader = checkStream.body.getReader();
  const { value: cVal } = await cReader.read();
  const cText = Buffer.from(cVal).toString('utf8');
  const cDataLine = cText.split('\n').find(l => l.startsWith('data: '));
  const cInit = JSON.parse(cDataLine.slice(6));
  acCheck.abort();
  const stu1State = cInit.roster.find(r => r.clientId === 'stu1');
  assert.equal(stu1State.micAllowed, true);
  assert.equal(stu1State.camAllowed, true);
  assert.equal(stu1State.camActive, true);
  assert.equal(stu1State.camStreamId, 'cam_stu1');
  assert.equal(stu1State.linkMode, 'av');
  assert.equal(stu1State.handRaised, false);

  assert.equal((await req(`/api/classroom/${les.data.id}/action`, {
    method: 'POST', cookie: s2Cookie,
    body: { type: 'link-end', clientId: 'stu1' }
  })).status, 403);

  assert.equal((await req(`/api/classroom/${les.data.id}/action`, {
    method: 'POST', cookie: s1Cookie,
    body: { type: 'link-end', clientId: 'stu1' }
  })).status, 200);

  acHand1.abort();
  acHand2.abort();
});

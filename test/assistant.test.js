import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../src/server.js';

function extractSessionCookie(res) {
  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(/wb_session=([^;]+)/);
  return match ? `wb_session=${match[1]}` : '';
}

test('DeepSeek Harness 智能助手：原生对话列表、SDK 运行时、工作区隔离、MCP 全量教务工具与静态缓存策略', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-dsh-test-'));
  const server = createServer({
    dbPath: path.join(tmpDir, 'test.db'),
    uploadDir: path.join(tmpDir, 'uploads')
  });

  await new Promise(resolve => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await new Promise(resolve => server.close(() => resolve()));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function req(urlPath, { method = 'GET', body, cookie = '', headers = {} } = {}) {
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, cookie: extractSessionCookie(res), res };
  }

  // 0. 静态资源使用 no-cache + ETag 协商缓存，避免更新后看到旧界面
  const jsRes = await fetch(baseUrl + '/public/js/app.js');
  assert.equal(jsRes.status, 200);
  assert.equal(jsRes.headers.get('cache-control'), 'public, no-cache');

  // 1. 初始化管理员
  const setupRes = await req('/api/setup', {
    method: 'POST',
    body: { name: '管理员', subject: '教务', username: '13800000001', password: 'pass' }
  });
  assert.equal(setupRes.status, 201);
  const adminCookie = setupRes.cookie;
  assert.equal(setupRes.data.org.has_deepseek_api_key, false);

  // 2. 创建普通教师与学生账号用于验证权限隔离
  await req('/api/teachers', {
    method: 'POST',
    cookie: adminCookie,
    body: { name: '张老师', subject: '物理', phone: '13800000002', password: 'pass', role: 'teacher' }
  });
  await req('/api/students', {
    method: 'POST',
    cookie: adminCookie,
    body: { name: '李同学', grade: '高一', phone: '13900000003', password: 'pass' }
  });

  const teacherCookie = (await req('/api/login', {
    method: 'POST',
    body: { username: '13800000002', password: 'pass' }
  })).cookie;
  const studentCookie = (await req('/api/login', {
    method: 'POST',
    body: { username: '13900000003', password: 'pass' }
  })).cookie;

  // 3. 管理员保存 DeepSeek API Key，脱敏返回且不泄露给教师/学生
  const saveKeyRes = await req('/api/org', {
    method: 'PUT',
    cookie: adminCookie,
    body: { deepseekApiKey: 'sk-test-1234567890abcdef' }
  });
  assert.equal(saveKeyRes.status, 200);
  assert.equal(saveKeyRes.data.org.has_deepseek_api_key, true);
  assert.equal(saveKeyRes.data.org.deepseek_api_key_masked, 'sk-t****cdef');
  assert.equal(saveKeyRes.data.org.deepseek_api_key, undefined);

  const tchState = await req('/api/state', { cookie: teacherCookie });
  assert.equal(tchState.data.org.deepseek_api_key, undefined);
  assert.equal(tchState.data.org.has_deepseek_api_key, undefined);

  // 检查 .credentials.yaml 已写入且权限为 0600
  const credPath = path.join(tmpDir, 'dsh-home', '.credentials.yaml');
  const credContent = await fs.readFile(credPath, 'utf8');
  assert.match(credContent, /version:\s*1/);
  assert.match(credContent, /DEEPSEEK_API_KEY:\s*"sk-test-1234567890abcdef"/);
  assert.equal((await fs.stat(credPath)).mode & 0o777, 0o600);

  // 4. 非管理员禁止访问 /api/assistant/*
  assert.equal((await req('/api/assistant/status')).status, 401);
  assert.equal((await req('/api/assistant/status', { cookie: teacherCookie })).status, 403);
  assert.equal((await req('/api/assistant/status', { cookie: studentCookie })).status, 403);
  assert.equal((await req('/api/assistant/conversations', { cookie: teacherCookie })).status, 403);
  assert.equal((await req('/api/assistant/start', { method: 'POST', cookie: teacherCookie })).status, 403);
  assert.equal((await req('/api/assistant/test-key', { method: 'POST', cookie: studentCookie })).status, 403);

  // 5. 对话列表 CRUD
  const convCreate = await req('/api/assistant/conversations', {
    method: 'POST',
    cookie: adminCookie,
    body: { title: '教务排课助手', model: 'deepseek-flash' }
  });
  assert.equal(convCreate.status, 201);
  const convId = convCreate.data.conversation.id;

  const convList = await req('/api/assistant/conversations', { cookie: adminCookie });
  assert.equal(convList.status, 200);
  assert.ok(convList.data.conversations.some(c => c.id === convId && c.title === '教务排课助手'));

  const convRename = await req(`/api/assistant/conversations/${convId}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { title: '高二排课', model: 'deepseek-v4-pro' }
  });
  assert.equal(convRename.status, 200);
  assert.equal(convRename.data.conversation.title, '高二排课');
  assert.equal(convRename.data.conversation.model, 'deepseek-v4-pro');

  const convMsgs = await req(`/api/assistant/conversations/${convId}/messages`, { cookie: adminCookie });
  assert.equal(convMsgs.status, 200);
  assert.deepEqual(convMsgs.data.messages, []);

  // 6. 启动真实 DeepSeek Harness SDK 运行时并验证工作目录隔离
  const startRes = await req('/api/assistant/start', { method: 'POST', cookie: adminCookie });
  assert.equal(startRes.status, 200);
  assert.equal(startRes.data.running, true);
  assert.equal(startRes.data.hasApiKey, true);
  assert.equal(startRes.data.workspaceDir, path.join(tmpDir, 'dsh-home', 'workspace'));

  // 7. 读取生成的 workbench-patch.yml 并验证全部 MCP 工具
  const patchText = await fs.readFile(path.join(tmpDir, 'dsh-home', 'workbench-patch.yml'), 'utf8');
  const tokenMatch = patchText.match(/Bearer\s+([a-f0-9]+)/);
  assert.ok(tokenMatch, 'workbench-patch.yml should contain internal MCP Bearer token');
  const mcpToken = tokenMatch[1];

  const unauthMcp = await req('/api/internal/mcp', {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }
  });
  assert.equal(unauthMcp.status, 401);

  async function callMcp(methodName, params = {}, id = 1) {
    const r = await req('/api/internal/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${mcpToken}` },
      body: { jsonrpc: '2.0', id, method: methodName, params }
    });
    assert.equal(r.status, 200);
    return r.data.result;
  }

  const toolsRes = await callMcp('tools/list');
  const toolNames = toolsRes.tools.map(x => x.name);
  for (const expected of [
    'workbench_get_overview',
    'workbench_create_teacher',
    'workbench_create_student',
    'workbench_create_course',
    'workbench_update_course',
    'workbench_create_course_node',
    'workbench_create_course_nodes_batch',
    'workbench_copy_course_outline',
    'workbench_schedule_lesson',
    'workbench_schedule_lessons_batch',
    'workbench_update_lesson_status',
    'workbench_create_trial_grant',
    'workbench_add_student_followup',
    'workbench_delete_entity'
  ]) {
    assert.ok(toolNames.includes(expected), `Missing MCP tool: ${expected}`);
  }

  const mcpTch = JSON.parse((await callMcp('tools/call', {
    name: 'workbench_create_teacher',
    arguments: { name: '王老师', subject: '化学', phone: '13800000099', password: 'pass' }
  })).content[0].text);
  assert.equal(mcpTch.ok, true);

  const mcpStu = JSON.parse((await callMcp('tools/call', {
    name: 'workbench_create_student',
    arguments: { name: '赵同学', grade: '高二', loginUsername: 'zhao_stu', password: 'pass' }
  })).content[0].text);
  assert.equal(mcpStu.ok, true);

  const mcpCourse = JSON.parse((await callMcp('tools/call', {
    name: 'workbench_create_course',
    arguments: { name: '高二化学冲刺', subject: '化学', mode: '直播课', teacherIds: [mcpTch.teacherId], capacity: 25 }
  })).content[0].text);
  assert.equal(mcpCourse.ok, true);

  const mcpNode = JSON.parse((await callMcp('tools/call', {
    name: 'workbench_create_course_node',
    arguments: { courseId: mcpCourse.courseId, title: '第一章 化学反应速率', nodeType: 'folder' }
  })).content[0].text);
  assert.equal(mcpNode.ok, true);

  const mcpLesson = JSON.parse((await callMcp('tools/call', {
    name: 'workbench_schedule_lesson',
    arguments: {
      courseId: mcpCourse.courseId,
      teacherId: mcpTch.teacherId,
      title: '第1讲：化学平衡',
      startTime: '2026-12-01T19:00:00+08:00',
      endTime: '2026-12-01T21:00:00+08:00'
    }
  })).content[0].text);
  assert.equal(mcpLesson.ok, true);

  const mcpTrial = JSON.parse((await callMcp('tools/call', {
    name: 'workbench_create_trial_grant',
    arguments: {
      studentId: mcpStu.studentId,
      targetType: 'lesson',
      targetId: mcpLesson.lessonId,
      expiresAt: '2026-12-31T23:59:59+08:00'
    }
  })).content[0].text);
  assert.equal(mcpTrial.ok, true);

  const mcpStatusUpd = JSON.parse((await callMcp('tools/call', {
    name: 'workbench_update_lesson_status',
    arguments: { id: mcpLesson.lessonId, status: 'completed', note: '已结课' }
  })).content[0].text);
  assert.equal(mcpStatusUpd.ok, true);

  // 删除对话
  const convDel = await req(`/api/assistant/conversations/${convId}`, {
    method: 'DELETE',
    cookie: adminCookie
  });
  assert.equal(convDel.status, 200);

  const stAfter = await req('/api/assistant/status', { cookie: adminCookie });
  assert.ok(stAfter.data.lastMutationAt > 0);
});

import { findScheduleConflicts } from './schedule.mjs';

const { roles, anchor, members } = await (await fetch('./demo/sample.json')).json();
const { admin, teacher, student } = roles;
const course = teacher.courses[0];
const uploads = new Map();
let role = 'teacher';
const today = new Date().setHours(18, 30, 0, 0);
const offset = today - anchor;
for (const snapshot of Object.values(roles)) {
  snapshot.dataInstance = 'pages-demo';
}
const lessons = admin.lessons;
for (const lesson of lessons) {
  lesson.start_ms += offset;
  lesson.end_ms += offset;
}

const submissions = teacher.homeworkSubmissions;
const homeworks = teacher.homeworks;
const posts = teacher.qaPosts;
const replies = teacher.qaReplies;
const cursors = { admin: {}, teacher: {}, student: {} };
const now = () => new Date().toISOString();

function snapshot() {
  const visibleSubmissions = role === 'student' ? submissions.filter(s => s.student_id === student.currentUser.linkedId) : submissions;
  return { ...roles[role], lessons, homeworks, homeworkSubmissions: visibleSubmissions,
    qaPosts: posts, qaReplies: replies, qaReadCursors: cursors[role] };
}

function messageAuthor() {
  const user = roles[role].currentUser;
  return { author_id: user.linkedId, author_name: user.name, author_role: role,
    created_ms: Date.now(), created_at: now() };
}

window.workbenchDemoImage = fileId => uploads.get(fileId) || './demo/solution.png';
window.workbenchDemoUpload = async (url, file, onProgress) => {
  const endpoint = new URL(url, location.href);
  if (endpoint.pathname !== '/api/homework/upload' || !file.type.startsWith('image/') || file.size > 5_000_000) {
    throw new Error('演示版只处理 5 MB 内的作业图片，文件保留在当前页面。');
  }
  const id = crypto.randomUUID();
  uploads.set(id, URL.createObjectURL(file));
  onProgress?.(100, file.size, file.size);
  return { id, filename: file.name, storedName: id, mimeType: file.type, isImage: true, sizeBytes: file.size };
};

const browserFetch = window.fetch.bind(window);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const unavailable = () => json({ error: '此操作请在自行部署的完整版中使用。' }, 405);

function saveDemoLesson(body, id) {
  const assignedTeacher = admin.teachers.find(item => item.id === body.teacherId);
  if (!assignedTeacher || body.courseId !== course.id || !body.title?.trim()) {
    return json({ error: '请填写课次名称、课程和授课教师。' }, 400);
  }
  if (!Number.isSafeInteger(body.startMs) || !Number.isSafeInteger(body.endMs) || body.endMs <= body.startMs) {
    return json({ error: '结束时间必须晚于开始时间。' }, 400);
  }
  const previous = id && lessons.find(item => item.id === id);
  if (id && !previous) return json({ error: '课次不存在。' }, 404);
  const lesson = { id: id || crypto.randomUUID(), org_id: course.org_id, title: body.title.trim(),
    course_id: course.id, course_name: course.name, teacher_id: assignedTeacher.id, teacher_name: assignedTeacher.name,
    start_ms: body.startMs, end_ms: body.endMs, physical_room: body.physicalRoom?.trim() || null,
    external_room_url: '', status: body.status || 'scheduled', note: body.note || '' };
  const studentIds = admin.enrollments.filter(item => item.course_id === course.id && item.status === 'active').map(item => item.student_id);
  const forConflictCheck = item => ({ orgId: item.org_id, id: item.id, teacherId: item.teacher_id,
    start: item.start_ms, end: item.end_ms, physicalRoomId: item.physical_room, studentIds });
  const conflicts = lesson.status === 'cancelled' ? [] : findScheduleConflicts(forConflictCheck(lesson),
    lessons.filter(item => item.status !== 'cancelled').map(forConflictCheck));
  if (conflicts.length) {
    const title = lessons.find(item => item.id === conflicts[0].lessonId).title;
    return json({ error: `排课时间冲突，和「${title}」重叠。` }, 409);
  }
  if (previous) Object.assign(previous, lesson);
  else lessons.push(lesson);
  lessons.sort((a, b) => a.start_ms - b.start_ms);
  return previous ? json(snapshot()) : json({ id: lesson.id, state: snapshot() }, 201);
}

window.fetch = async (resource, options = {}) => {
  if (typeof resource !== 'string' || !resource.startsWith('/api/')) return browserFetch(resource, options);
  const url = new URL(resource, location.href);
  const endpoint = url.pathname;
  const method = options.method || 'GET';
  const body = typeof options.body === 'string' ? JSON.parse(options.body) : {};
  if (method === 'GET') {
    if (endpoint === '/api/state') return json(snapshot());
    if (endpoint === '/api/qa/members') return json(members);
    if (endpoint === '/api/qa/messages') return json({ posts, replies, hasMore: false });
    return unavailable();
  }
  if (role === 'admin') {
    const account = method === 'PUT' && endpoint.match(/^\/api\/accounts\/([^/]+)$/);
    if (account && typeof body.disabled === 'boolean') {
      const target = admin.accounts.find(item => item.id === account[1] && item.role !== 'admin');
      if (target) {
        target.disabled = Number(body.disabled);
        return json(snapshot());
      }
    }
    if (method === 'POST' && endpoint === '/api/lessons') return saveDemoLesson(body);
    const lesson = method === 'PUT' && endpoint.match(/^\/api\/lessons\/([^/]+)$/);
    if (lesson) return saveDemoLesson(body, lesson[1]);
  }
  if (endpoint === '/api/qa/read') {
    cursors[role][body.courseId] = body.lastReadMs;
    return json({ ok: true, courseId: body.courseId, lastReadMs: body.lastReadMs });
  }
  if (endpoint === '/api/qa' && method === 'POST') {
    const post = { ...messageAuthor(), id: crypto.randomUUID(), course_id: course.id, course_name: course.name,
      content: body.content, title: body.content.slice(0, 32), msg_type: body.msgType, ref_tag: body.refTag,
      lesson_id: body.lessonId, pinned: Number(Boolean(body.pinned)), reply_to_id: body.replyToId,
      mentions: body.mentions, attachments: [], resolved: 0 };
    posts.unshift(post);
    return json({ id: post.id, post }, 201);
  }
  const qa = endpoint.match(/^\/api\/qa\/([^/]+)\/(replies|resolve|pin)$/);
  if (qa) {
    const post = posts.find(item => item.id === qa[1]);
    if (!post) return json({ error: '消息不存在' }, 404);
    if (qa[2] === 'replies') {
      const reply = { ...messageAuthor(), id: crypto.randomUUID(), post_id: post.id, content: body.content };
      replies.push(reply);
      return json({ reply }, 201);
    }
    if (qa[2] === 'resolve') post.resolved = Number(Boolean(body.resolved));
    if (qa[2] === 'pin') post.pinned = Number(Boolean(body.pinned));
    return json({ post });
  }
  const grading = endpoint.match(/^\/api\/homework-submissions\/([^/]+)\/grade$/);
  if (grading && role !== 'student') {
    const submission = submissions.find(item => item.id === grading[1]);
    if (!submission) return json({ error: '提交记录不存在' }, 404);
    Object.assign(submission, { status: 'graded', score: body.score, feedback: body.feedback,
      gradedImages: body.gradedImages, graded_by: roles[role].currentUser.name, graded_at: now() });
    return json({ submission, snapshot: snapshot() });
  }
  const submitting = endpoint.match(/^\/api\/homeworks\/([^/]+)\/submit$/);
  if (submitting && role === 'student') {
    const submission = submissions.find(item => item.homework_id === submitting[1] && item.student_id === student.currentUser.linkedId);
    if (!submission) return unavailable();
    Object.assign(submission, { status: 'submitted', images: body.images, note: body.note, submitted_at: now(), submitted_ms: Date.now() });
    return json({ submission, snapshot: snapshot() });
  }
  return unavailable();
};

// The regular UI registers stream handlers. No requests or cross-browser messages are sent in the demo.
window.EventSource = class DemoStream extends EventTarget { close() {} };
if (!/^#(?:overview|courses|homework|qa)(?:\?|$)/.test(location.hash)) {
  history.replaceState(null, '', '#overview');
}
const { app, loadState } = await import('../public/js/state.js');
await import('../public/js/app.js');
const roleButtons = document.querySelectorAll('[data-demo-role]');
for (const button of roleButtons) {
  button.addEventListener('click', async () => {
    if (role === button.dataset.demoRole) return;
    role = button.dataset.demoRole;
    for (const item of roleButtons) item.setAttribute('aria-pressed', String(item === button));
    document.querySelector('#modal').close();
    app.hwActiveId = '';
    app.showCreatePanel = false;
    app.editingLessonId = null;
    await loadState();
  });
}

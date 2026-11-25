import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openWorkbenchDb } from '../src/db.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(process.argv[2] || '.demo-site');
await mkdir(output);
await cp(path.join(root, 'public'), path.join(output, 'public'), { recursive: true });
await mkdir(path.join(output, 'demo'));
for (const file of ['app.mjs', 'styles.css', 'solution.png']) {
  await cp(path.join(root, 'demo', file), path.join(output, 'demo', file));
}

const index = await readFile(path.join(root, 'index.html'), 'utf8');
const banner = `<aside class="demo-bar" aria-label="在线演示">
      <strong>在线演示</strong><span class="demo-note">虚构数据 · 刷新重置</span>
      <div class="demo-roles" role="group" aria-label="切换视角">
        <button class="secondary-button btn-sm" data-demo-role="teacher" aria-pressed="true">教师视角</button>
        <button class="secondary-button btn-sm" data-demo-role="student" aria-pressed="false">学生视角</button>
      </div>
      <a href="https://github.com/dylan0821/edu-workbench#快速开始人类开发者--运维">部署完整版</a>
    </aside>`;
await writeFile(path.join(output, 'index.html'), index
  .replaceAll('="/public/', '="./public/')
  .replace('<body>', '<body data-demo>')
  .replace('</head>', '  <link rel="stylesheet" href="./demo/styles.css">\n</head>')
  .replace('<div id="workspace"', `${banner}\n    <div id="workspace"`)
  .replace(/src="\.\/public\/js\/app\.js[^"]*"/, 'src="./demo/app.mjs"'));

const statePath = path.join(output, 'public/js/state.js');
const state = await readFile(statePath, 'utf8');
await writeFile(statePath, state.replaceAll("'/public/logo.jpg'", "'./public/logo.jpg'"));
const homeworkPath = path.join(output, 'public/js/views/homework.js');
const homework = await readFile(homeworkPath, 'utf8');
await writeFile(homeworkPath, homework.replace(/function hwSubmissionFileUrl\([^)]*\) \{[^}]*?return `[^`]+`;\n\}/s,
  'function hwSubmissionFileUrl(subId, fileId) { return window.workbenchDemoImage(fileId); }'));
const utilsPath = path.join(output, 'public/js/utils.js');
const utils = await readFile(utilsPath, 'utf8');
await writeFile(utilsPath, utils.replace(/export function uploadFileWithProgress\([^)]*\) \{.*?\n\}/s,
  'export const uploadFileWithProgress = window.workbenchDemoUpload;'));

// The Pages build never opens the configured instance directory.
const store = openWorkbenchDb(':memory:');
const anchor = new Date();
anchor.setHours(18, 30, 0, 0);
const day = 86_400_000;
const teacher = '周老师';
const student = '小禾';
const teacherId = store.createTeacher({ name: teacher, subject: '高中数学', phone: '10000000000' });
const courseId = store.createCourse({ name: '高中数学 · 导数小班', subject: '数学', mode: '直播课', teacherId, capacity: 8,
  description: '从导数符号判断单调性，再用单调性处理最值问题。' });
const studentId = store.createStudent({ name: student, grade: '高二', courseIds: [courseId] });
store.createStudent({ name: '小满', grade: '高二', courseIds: [courseId] });
const unit = store.createCourseNode({ courseId, nodeType: 'folder', title: '第一单元 · 导数与单调性' });
store.createCourseNode({ courseId, parentId: unit, nodeType: 'note', title: '课前阅读',
  content: '先找定义域，再按导数的零点分区间判断符号。' });
for (const [offset, title, status] of [[-2, '第 1 讲 · 由导数判单调', 'completed'], [0, '第 2 讲 · 极值与最值', 'scheduled'], [3, '第 3 讲 · 含参数的单调性', 'scheduled']]) {
  const startMs = anchor.getTime() + offset * day;
  const id = store.saveLesson({ courseId, teacherId, title, startMs, endMs: startMs + 90 * 60_000, status });
  store.createCourseNode({ courseId, parentId: unit, nodeType: 'lesson', title, refId: id });
}

const homeworkSample = store.createHomework({ courseId, teacherId, creatorName: teacher,
  title: '第 1 讲作业 · 单调区间', content: '设 $f(x)=x^3-3x$。\n\n1. 求 $f\'(x)$ 并写出它的零点。\n2. 列符号表，写出 $f$ 的单调区间。' });
store.upsertHomeworkSubmission({ homeworkId: homeworkSample.id, studentId,
  note: '我先求了导数，再分三个区间判断符号。',
  images: [{ filename: '答题示例.png', storedName: 'demo-solution.png', mimeType: 'image/png', isImage: true }] });

store.createQaPost({ courseId, authorName: teacher, authorRole: 'teacher', authorId: teacherId,
  msgType: 'announcement', content: '本周先完成第 1 讲作业。写单调区间时，请一起给出导数的符号。' });
store.createQaPost({ courseId, authorName: student, authorRole: 'student', authorId: studentId,
  msgType: 'question', refTag: '第 2 题', content: '老师，导数在 $x=1$ 处等于零，可以把它写进单调区间吗？' });

const roles = Object.fromEntries(Object.entries({ teacher: [teacher, teacherId], student: [student, studentId] })
  .map(([role, [name, linkedId]]) => [role, store.getSnapshotForUser({ role, name, linkedId,
    accountId: `demo-${role}`, username: `demo-${role}` })]));
await writeFile(path.join(output, 'demo/sample.json'), JSON.stringify({ roles, anchor: Number(anchor), members: store.getCourseMembers(courseId) }));
store.db.close();

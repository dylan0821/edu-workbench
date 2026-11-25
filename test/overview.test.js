import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../public/js/state.js';
import { renderOverview } from '../public/js/views/overview.js';

test('概览优先展示实际进行中的课堂，并按角色显示作业入口', () => {
  const now = Date.now();
  app.state = {
    org: { name: '测试机构' },
    currentUser: { name: '张老师', role: 'teacher' },
    lessons: [
      { id: 'scheduled', title: '仍在候课', status: 'scheduled', start_ms: now - 60000, end_ms: now + 60000 },
      { id: 'active', title: '仍在授课', status: 'in_progress', start_ms: now - 180000, end_ms: now - 60000 },
      { id: 'completed', title: '提前下课', status: 'completed', start_ms: now - 60000, end_ms: now + 60000 }
    ],
    courses: [], recordings: [], vodLessons: [], qaPosts: [], qaReadCursors: {}, materials: [], teachers: [], students: [],
    homeworks: [
      { id: 'pending', title: '待交的作业' },
      { id: 'submitted', title: '已交的作业' },
      { id: 'graded', title: '看批改的作业' }
    ],
    homeworkSubmissions: [
      { homework_id: 'submitted', status: 'submitted' },
      { homework_id: 'graded', status: 'graded' }
    ]
  };
  const shell = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
  renderOverview(shell);
  assert.match(shell.innerHTML, /data-enter-live="active">进入正在进行的课堂/);
  assert.match(shell.innerHTML, /仍在候课<\/a>\s*<span[^>]*>待开课/);
  assert.doesNotMatch(shell.innerHTML, /提前下课/);
  assert.match(shell.innerHTML, /data-ov-homework="submitted">去批改/);

  app.state.currentUser = { name: '小李', role: 'student', linkedId: 'student' };
  renderOverview(shell);
  assert.match(shell.innerHTML, /data-ov-homework="pending">查看与提交/);
  assert.match(shell.innerHTML, /data-ov-homework="graded">查看批改/);
  assert.doesNotMatch(shell.innerHTML, /去批改/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { findScheduleConflicts, checkOnlineConcurrency } from '../src/schedule.js';

const proposed = { orgId: 'org', id: 'new', teacherId: 'T1', physicalRoomId: 'A',
  start: 100, end: 200, studentIds: ['S1', 'S2'] };
const other = { ...proposed, id: 'existing', start: 130, end: 160, studentIds: ['S2'] };

test('时间包含时返回所有冲突原因', () => {
  assert.deepEqual(findScheduleConflicts(proposed, [other]), [
    { lessonId: 'existing', teacher: true, room: true, studentIds: ['S2'] }
  ]);
});
test('首尾相接、修改自身及其他机构均可安排', () => {
  assert.deepEqual(findScheduleConflicts(proposed, [
    { ...other, end: 100, start: 10 }, { ...other, start: 200, end: 230 },
    proposed, { ...other, orgId: 'elsewhere' }
  ]), []);
});
test('线上课可同时进行，但同一学生不能同时上两节课', () => {
  const online = { ...proposed, physicalRoomId: null };
  const second = { ...other, physicalRoomId: null, teacherId: 'T2' };
  assert.deepEqual(findScheduleConflicts(online, [second])[0],
    { lessonId: 'existing', teacher: false, room: false, studentIds: ['S2'] });
  assert.deepEqual(findScheduleConflicts(online, [{ ...second, studentIds: [] }]), []);
});
test('上课时间无效、漏传报名名单或已排列表含非法记录时提示错误', () => {
  assert.throws(() => findScheduleConflicts({ ...proposed, end: 100 }, []), RangeError);
  assert.throws(() => findScheduleConflicts({ ...proposed, studentIds: undefined }, []), TypeError);
  assert.throws(() => findScheduleConflicts(proposed, null), TypeError);
  assert.throws(() => findScheduleConflicts(proposed, [{ ...other, orgId: 'elsewhere', end: 50 }]), RangeError);
});
test('线上课按时间轴峰值核对套餐并发，首尾相接子课次不虚增并发', () => {
  const candidate = { orgId: 'org', id: 'L0', teacherId: 'T1', physicalRoomId: null,
    start: 100, end: 300, studentIds: ['S1', 'S2'] };
  const part1 = { orgId: 'org', id: 'L1', teacherId: 'T2', physicalRoomId: null,
    start: 100, end: 200, studentIds: ['S3', 'S4'] };
  const part2 = { orgId: 'org', id: 'L2', teacherId: 'T3', physicalRoomId: null,
    start: 200, end: 300, studentIds: ['S5', 'S6', 'S7'] };

  // L1 与 L2 在 200 时刻首尾相接，全程最多只有 2 间线上课堂同时进行，峰值学生席位为 2 + 3 = 5
  assert.deepEqual(
    checkOnlineConcurrency(candidate, [part1, part2], { maxRooms: 2, maxStudents: 5 }),
    { peakRooms: 2, peakStudents: 5, exceededRooms: false, exceededStudents: false, lessonIds: [] }
  );

  // 若单教室套餐（maxRooms: 1）或学生并发上限为 4，则识别出超限及对应课次
  assert.deepEqual(
    checkOnlineConcurrency(candidate, [part1, part2], { maxRooms: 1, maxStudents: 4 }),
    { peakRooms: 2, peakStudents: 5, exceededRooms: true, exceededStudents: true, lessonIds: ['L1', 'L2'] }
  );
});

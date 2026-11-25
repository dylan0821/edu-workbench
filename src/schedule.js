// 时间由调用方转换为 Unix 毫秒。studentIds 为排课时的有效报名名单。
function validate(lesson) {
  if (!lesson || typeof lesson !== 'object') {
    throw new TypeError('课次必须为对象');
  }
  for (const key of ['orgId', 'id', 'teacherId']) {
    if (typeof lesson[key] !== 'string' || !lesson[key].trim()) {
      throw new TypeError('课次缺少有效的 ' + key);
    }
  }
  if (!Number.isSafeInteger(lesson.start) || !Number.isSafeInteger(lesson.end)
      || lesson.end <= lesson.start) {
    throw new RangeError('课次结束时间必须晚于开始时间，且均为整数毫秒');
  }
  if (!Array.isArray(lesson.studentIds) || lesson.studentIds.some(
    id => typeof id !== 'string' || !id.trim()
  )) throw new TypeError('学生名单应为标识列表');
  if (lesson.physicalRoomId != null && (typeof lesson.physicalRoomId !== 'string'
      || !lesson.physicalRoomId.trim())) throw new TypeError('物理教室标识无效');
}

function validateInput(candidate, existing) {
  validate(candidate);
  if (!Array.isArray(existing)) {
    throw new TypeError('已排课次列表必须为数组');
  }
  for (const lesson of existing) validate(lesson);
}

// existing 只传有效课次；线上课省略 physicalRoomId。此函数用于保存前预检。
export function findScheduleConflicts(candidate, existing) {
  validateInput(candidate, existing);
  const students = new Set(candidate.studentIds);
  const conflicts = [];
  for (const lesson of existing) {
    if (lesson.orgId !== candidate.orgId || lesson.id === candidate.id) continue;
    if (lesson.end <= candidate.start || candidate.end <= lesson.start) continue;
    const teacher = candidate.teacherId === lesson.teacherId;
    const room = !!candidate.physicalRoomId && candidate.physicalRoomId === lesson.physicalRoomId;
    const studentIds = [...new Set(lesson.studentIds.filter(id => students.has(id)))];
    if (teacher || room || studentIds.length) {
      conflicts.push({ lessonId: lesson.id, teacher, room, studentIds });
    }
  }
  return conflicts;
}

// 按时间轴峰值核对线上课套餐并发（同时在线课堂数与同时在线学生席位数），首尾相接不计入重叠峰值。
export function checkOnlineConcurrency(candidate, existing, limits = {}) {
  validateInput(candidate, existing);
  if (!limits || typeof limits !== 'object') {
    throw new TypeError('并发限制参数必须为对象');
  }
  const { maxRooms = Infinity, maxStudents = Infinity } = limits;
  if (maxRooms !== Infinity && (!Number.isSafeInteger(maxRooms) || maxRooms < 1)) {
    throw new RangeError('maxRooms 必须为正整数');
  }
  if (maxStudents !== Infinity && (!Number.isSafeInteger(maxStudents) || maxStudents < 1)) {
    throw new RangeError('maxStudents 必须为正整数');
  }
  if (candidate.physicalRoomId != null) {
    return {
      peakRooms: 0,
      peakStudents: 0,
      exceededRooms: false,
      exceededStudents: false,
      lessonIds: []
    };
  }

  const overlapping = [candidate];
  for (const lesson of existing) {
    if (lesson.orgId !== candidate.orgId || lesson.id === candidate.id) continue;
    if (lesson.physicalRoomId != null) continue;
    if (lesson.end <= candidate.start || candidate.end <= lesson.start) continue;
    overlapping.push(lesson);
  }

  const events = [];
  for (const lesson of overlapping) {
    const start = Math.max(lesson.start, candidate.start);
    const end = Math.min(lesson.end, candidate.end);
    const seats = new Set(lesson.studentIds).size;
    events.push({ time: start, delta: 1, lesson, seats });
    events.push({ time: end, delta: -1, lesson, seats });
  }
  // 同一时间点先处理下课(-1)再处理上课(+1)，确保首尾相接不会虚增并发峰值
  events.sort((a, b) => a.time - b.time || a.delta - b.delta);

  const active = new Map();
  let activeStudents = 0;
  let peakRooms = 0;
  let peakStudents = 0;
  const conflictIds = new Set();

  for (const ev of events) {
    if (ev.delta === 1) {
      active.set(ev.lesson.id, ev.seats);
      activeStudents += ev.seats;
      if (active.size > peakRooms) peakRooms = active.size;
      if (activeStudents > peakStudents) peakStudents = activeStudents;
      if (active.size > maxRooms || activeStudents > maxStudents) {
        for (const id of active.keys()) {
          if (id !== candidate.id) conflictIds.add(id);
        }
      }
    } else {
      active.delete(ev.lesson.id);
      activeStudents -= ev.seats;
    }
  }

  return {
    peakRooms,
    peakStudents,
    exceededRooms: peakRooms > maxRooms,
    exceededStudents: peakStudents > maxStudents,
    lessonIds: [...conflictIds]
  };
}

import crypto from 'node:crypto';
import { readJsonBody, sendJson } from './http/utils.js';

function parseDateTimeMs(value, fieldName) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const raw = String(value ?? '').trim();
  if (!raw) throw new TypeError(`${fieldName}不能为空`);
  if (/^\d{10,13}$/.test(raw)) {
    const num = Number(raw);
    return raw.length === 10 ? num * 1000 : num;
  }
  const normalized = raw.includes(' ') && !raw.includes('T') ? raw.replace(' ', 'T') : raw;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) {
    throw new TypeError(`${fieldName}时间格式无效：${raw}，请使用如 2026-11-25T19:00:00+08:00 或毫秒时间戳`);
  }
  return ms;
}

function fmtLocalTime(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

const TOOL_DEFINITIONS = [
  {
    name: 'workbench_get_overview',
    description: '获取教培工作台当前全量概览：机构信息、教师列表、学生列表、课程列表（含授课教师与报名人数）、账号列表以及近期排课。在执行创建、编辑、排课前建议先调用以确认准确 ID 与现存数据。',
    inputSchema: {
      type: 'object',
      properties: {
        includeLessons: { type: 'boolean', description: '是否包含排课列表，默认 true' }
      }
    }
  },
  {
    name: 'workbench_create_teacher',
    description: '创建教师档案；若提供手机号与密码，同时为该教师开通登录账号。',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: '教师姓名（必填）' },
        subject: { type: 'string', description: '任教科目，如 高中数学' },
        phone: { type: 'string', description: '11 位手机号（开通登录账号时必填）' },
        password: { type: 'string', description: '登录密码（至少 4 位；不传则仅建档不开号）' },
        role: { type: 'string', enum: ['teacher', 'admin'], description: '账号角色，默认 teacher' }
      }
    }
  },
  {
    name: 'workbench_update_teacher',
    description: '编辑已有教师的信息（姓名、任教科目、手机号）。',
    inputSchema: {
      type: 'object',
      required: ['id', 'name'],
      properties: {
        id: { type: 'string', description: '教师 ID' },
        name: { type: 'string', description: '教师姓名' },
        subject: { type: 'string', description: '任教科目' },
        phone: { type: 'string', description: '11 位手机号' }
      }
    }
  },
  {
    name: 'workbench_upsert_teacher_account',
    description: '为已有教师补开登录账号，或重置其密码/角色。',
    inputSchema: {
      type: 'object',
      required: ['teacherId'],
      properties: {
        teacherId: { type: 'string', description: '教师 ID' },
        password: { type: 'string', description: '新密码（至少 4 位；新开号时必填）' },
        role: { type: 'string', enum: ['teacher', 'admin'], description: '账号角色，默认 teacher' }
      }
    }
  },
  {
    name: 'workbench_create_student',
    description: '创建学生档案；若提供 password（以及 loginUsername 或 11 位 phone），同时开通学生登录账号；也可同时报名课程。',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: '学生姓名或昵称（必填）' },
        grade: { type: 'string', description: '年级，如 高二' },
        phone: { type: 'string', description: '11 位手机号（选填）' },
        loginUsername: { type: 'string', description: '登录用户名（4-32位字母数字下划线或横线；未填则回退使用手机号）' },
        password: { type: 'string', description: '登录密码（至少 4 位；不传则仅建档不开通登录账号）' },
        status: { type: 'string', enum: ['意向', '在读', '试听', '停课', '结课'], description: '学生状态，默认 意向' },
        validUntil: { type: 'string', description: '账号有效期 YYYY-MM-DD（选填）' },
        note: { type: 'string', description: '建档备注' },
        courseIds: { type: 'array', items: { type: 'string' }, description: '创建时同步报名的课程 ID 列表' }
      }
    }
  },
  {
    name: 'workbench_update_student',
    description: '编辑学生档案信息及所属课程。',
    inputSchema: {
      type: 'object',
      required: ['id', 'name'],
      properties: {
        id: { type: 'string', description: '学生 ID' },
        name: { type: 'string', description: '学生姓名/昵称' },
        grade: { type: 'string', description: '年级' },
        phone: { type: 'string', description: '手机号' },
        status: { type: 'string', description: '状态：意向/在读/试听/停课/结课' },
        validUntil: { type: 'string', description: '有效期 YYYY-MM-DD' },
        note: { type: 'string', description: '备注' },
        courseIds: { type: 'array', items: { type: 'string' }, description: '若传入则同步更新报名课程列表' }
      }
    }
  },
  {
    name: 'workbench_manage_account',
    description: '管理登录账号：创建账号、修改密码/姓名/角色/停用状态。',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['create', 'update'], description: '操作类型' },
        id: { type: 'string', description: '账号 ID（update 时必填）' },
        username: { type: 'string', description: '登录账号（create 时必填）' },
        password: { type: 'string', description: '密码（create 时必填，update 时选填重置）' },
        role: { type: 'string', enum: ['admin', 'teacher', 'student'], description: '角色' },
        linkedId: { type: 'string', description: '关联的教师或学生 ID' },
        name: { type: 'string', description: '显示名称' },
        disabled: { type: 'boolean', description: '是否停用账号（update 时可用）' }
      }
    }
  },
  {
    name: 'workbench_create_course',
    description: '创建新课程。支持指定授课教师（可多选 teacherIds）、教学模式与人数上限。',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: '课程名称（必填）' },
        subject: { type: 'string', description: '科目，如 数学' },
        mode: { type: 'string', enum: ['直播课', '线下面授', '录播课'], description: '授课模式，默认 直播课' },
        description: { type: 'string', description: '课程简介' },
        teacherId: { type: 'string', description: '主授课教师 ID' },
        teacherIds: { type: 'array', items: { type: 'string' }, description: '授课教师 ID 列表（支持多教师）' },
        capacity: { type: 'integer', description: '课程人数上限（正整数，不填表示不限）' }
      }
    }
  },
  {
    name: 'workbench_update_course',
    description: '编辑课程信息（名称、科目、模式、简介、授课教师、人数上限），可选同步更新未来未开始课次的教师。',
    inputSchema: {
      type: 'object',
      required: ['id', 'name'],
      properties: {
        id: { type: 'string', description: '课程 ID（必填）' },
        name: { type: 'string', description: '课程名称（必填）' },
        subject: { type: 'string', description: '科目' },
        mode: { type: 'string', enum: ['直播课', '线下面授', '录播课'], description: '授课模式' },
        description: { type: 'string', description: '课程简介' },
        teacherId: { type: 'string', description: '主授课教师 ID' },
        teacherIds: { type: 'array', items: { type: 'string' }, description: '授课教师 ID 列表' },
        capacity: { type: 'integer', description: '课程人数上限（null 表示不限）' },
        syncFutureLessons: { type: 'boolean', description: '是否将主授课教师同步到该课程未开始的未来课次' }
      }
    }
  },
  {
    name: 'workbench_enroll_students',
    description: '为课程批量报名学生或更新报名状态。',
    inputSchema: {
      type: 'object',
      required: ['courseId', 'studentIds'],
      properties: {
        courseId: { type: 'string', description: '课程 ID' },
        studentIds: { type: 'array', items: { type: 'string' }, description: '学生 ID 列表' }
      }
    }
  },
  {
    name: 'workbench_list_lessons',
    description: '查询课表/排课记录，可按课程、教师、日期或状态筛选。',
    inputSchema: {
      type: 'object',
      properties: {
        courseId: { type: 'string', description: '按课程 ID 筛选' },
        teacherId: { type: 'string', description: '按教师 ID 筛选' },
        status: { type: 'string', enum: ['scheduled', 'completed', 'cancelled'], description: '按课次状态筛选' },
        fromTime: { type: 'string', description: '起始时间（ISO 或 YYYY-MM-DD HH:mm）' },
        toTime: { type: 'string', description: '结束时间（ISO 或 YYYY-MM-DD HH:mm）' }
      }
    }
  },
  {
    name: 'workbench_schedule_lesson',
    description: '创建或修改单节排课（自动检测教师、教室、学生时间冲突及线上并发上限）。',
    inputSchema: {
      type: 'object',
      required: ['courseId', 'teacherId', 'title', 'startTime', 'endTime'],
      properties: {
        id: { type: 'string', description: '课次 ID（修改已有排课时传入，新建留空）' },
        courseId: { type: 'string', description: '课程 ID' },
        teacherId: { type: 'string', description: '授课教师 ID' },
        title: { type: 'string', description: '课次标题，如 第1讲：函数单调性' },
        startTime: { type: 'string', description: '开始时间（如 2026-11-25T19:00:00+08:00 或毫秒时间戳）' },
        endTime: { type: 'string', description: '结束时间（如 2026-11-25T21:00:00+08:00 或毫秒时间戳）' },
        physicalRoom: { type: 'string', description: '线下教室名称（线下面授课必填，线上课留空）' },
        externalRoomUrl: { type: 'string', description: '外部会议链接（可选）' },
        status: { type: 'string', enum: ['scheduled', 'completed', 'cancelled'], description: '课次状态，默认 scheduled' },
        note: { type: 'string', description: '课次备注' }
      }
    }
  },
  {
    name: 'workbench_schedule_lessons_batch',
    description: '周期批量排课（支持按间隔天数或按星期几重复生成 1-52 节课，支持 dryRun 预演冲突检测）。',
    inputSchema: {
      type: 'object',
      required: ['courseId', 'teacherId', 'titlePrefix', 'firstStartTime', 'durationMinutes', 'count'],
      properties: {
        courseId: { type: 'string', description: '课程 ID' },
        teacherId: { type: 'string', description: '授课教师 ID' },
        titlePrefix: { type: 'string', description: '课次标题前缀，系统会自动拼接 第1讲、第2讲…' },
        firstStartTime: { type: 'string', description: '首节开始时间（如 2026-11-25T19:00:00+08:00）' },
        durationMinutes: { type: 'integer', description: '单节时长（分钟），如 120' },
        intervalDays: { type: 'integer', description: '间隔天数，默认 7（与 weekdays 二选一）' },
        weekdays: { type: 'array', items: { type: 'integer' }, description: '每周几上课（0=周日, 1=周一 ... 6=周六）' },
        count: { type: 'integer', description: '生成总节数（1-52）' },
        physicalRoom: { type: 'string', description: '线下教室名称（线上课留空）' },
        externalRoomUrl: { type: 'string', description: '外部会议链接（可选）' },
        skipConflicts: { type: 'boolean', description: '是否自动跳过冲突时间段，默认 false' },
        dryRun: { type: 'boolean', description: '仅预演检测冲突不写入数据库，默认 false' }
      }
    }
  },
  {
    name: 'workbench_delete_lesson',
    description: '删除指定 ID 的排课记录。',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: '课次 ID' }
      }
    }
  },
  {
    name: 'workbench_update_lesson_status',
    description: '更新课次状态（scheduled / completed / cancelled）或备注。',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: '课次 ID' },
        status: { type: 'string', enum: ['scheduled', 'completed', 'cancelled'], description: '课次状态' },
        note: { type: 'string', description: '课次备注' }
      }
    }
  },
  {
    name: 'workbench_update_enrollment',
    description: '更新学生报名状态（active 在读 / paused 停课 / completed 结课 / dropped 退班）。',
    inputSchema: {
      type: 'object',
      required: ['enrollmentId', 'status'],
      properties: {
        enrollmentId: { type: 'string', description: '报名记录 ID' },
        status: { type: 'string', enum: ['active', 'paused', 'completed', 'dropped'], description: '报名状态' }
      }
    }
  },
  {
    name: 'workbench_create_course_node',
    description: '为课程创建单个大纲目录或小节节点。',
    inputSchema: {
      type: 'object',
      required: ['courseId', 'title'],
      properties: {
        courseId: { type: 'string', description: '课程 ID' },
        parentId: { type: 'string', description: '父节点 ID（根目录留空）' },
        nodeType: { type: 'string', enum: ['folder', 'section', 'text'], description: '节点类型，默认 folder' },
        title: { type: 'string', description: '节点标题' },
        content: { type: 'string', description: '文本内容（nodeType=text 时可用）' }
      }
    }
  },
  {
    name: 'workbench_create_course_nodes_batch',
    description: '批量创建课程大纲目录/小节节点（按行或数组一键导入课程结构）。',
    inputSchema: {
      type: 'object',
      required: ['courseId', 'items'],
      properties: {
        courseId: { type: 'string', description: '课程 ID' },
        parentId: { type: 'string', description: '父节点 ID（根目录留空）' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['title'],
            properties: {
              title: { type: 'string' },
              nodeType: { type: 'string', enum: ['folder', 'section', 'text'] },
              content: { type: 'string' }
            }
          }
        }
      }
    }
  },
  {
    name: 'workbench_copy_course_outline',
    description: '从另一门课程复制完整大纲目录树到目标课程。',
    inputSchema: {
      type: 'object',
      required: ['sourceCourseId', 'targetCourseId'],
      properties: {
        sourceCourseId: { type: 'string', description: '源课程 ID' },
        targetCourseId: { type: 'string', description: '目标课程 ID' }
      }
    }
  },
  {
    name: 'workbench_create_trial_grant',
    description: '为学生发放指定课次或录播的限时试听权限。',
    inputSchema: {
      type: 'object',
      required: ['studentId', 'targetType', 'targetId', 'expiresAt'],
      properties: {
        studentId: { type: 'string', description: '学生 ID' },
        targetType: { type: 'string', enum: ['lesson', 'vod'], description: '试听目标类型：lesson（课次）或 vod（录播）' },
        targetId: { type: 'string', description: '课次 ID 或录播 ID' },
        expiresAt: { type: 'string', description: '到期时间（如 2026-12-31T23:59:59+08:00 或毫秒时间戳）' },
        note: { type: 'string', description: '试听备注' }
      }
    }
  },
  {
    name: 'workbench_add_student_followup',
    description: '为学生添加一条跟进记录。',
    inputSchema: {
      type: 'object',
      required: ['studentId', 'content'],
      properties: {
        studentId: { type: 'string', description: '学生 ID' },
        content: { type: 'string', description: '跟进内容' }
      }
    }
  },
  {
    name: 'workbench_delete_entity',
    description: '删除教师、学生或课程（高危操作，执行前请向管理员确认）。',
    inputSchema: {
      type: 'object',
      required: ['entityType', 'id'],
      properties: {
        entityType: { type: 'string', enum: ['teacher', 'student', 'course'], description: '删除对象类型' },
        id: { type: 'string', description: '对象 ID' }
      }
    }
  }
];

export function createWorkbenchMcpHandler({ store, onMutate }) {
  const adminSession = { role: 'admin', accountId: 'mcp-assistant', linkedId: 'mcp-assistant' };
  const sessions = new Set();

  function executeTool(name, args = {}) {
    switch (name) {
      case 'workbench_get_overview': {
        const snap = store.getSnapshotForUser(adminSession);
        const includeLessons = args.includeLessons !== false;
        const enrollCountByCourse = new Map();
        for (const e of snap.enrollments || []) {
          if (e.status === 'active') {
            enrollCountByCourse.set(e.course_id, (enrollCountByCourse.get(e.course_id) || 0) + 1);
          }
        }
        return {
          org: {
            name: snap.org?.name,
            maxOnlineRooms: snap.org?.max_online_rooms,
            maxOnlineStudents: snap.org?.max_online_students,
            defaultLessonMinutes: snap.org?.default_lesson_minutes
          },
          teachers: (snap.teachers || []).map(t => ({
            id: t.id, name: t.name, subject: t.subject, phone: t.phone
          })),
          students: (snap.students || []).map(s => ({
            id: s.id, name: s.name, grade: s.grade, phone: s.phone, status: s.status, validUntil: s.valid_until
          })),
          courses: (snap.courses || []).map(c => ({
            id: c.id,
            name: c.name,
            subject: c.subject,
            mode: c.mode,
            description: c.description,
            teacherId: c.teacher_id,
            teacherIds: c.teacher_ids,
            teacherNames: c.teacher_names || c.teacher_name,
            capacity: c.capacity,
            activeStudents: enrollCountByCourse.get(c.id) || 0
          })),
          accounts: (snap.accounts || []).map(a => ({
            id: a.id, username: a.username, name: a.name, role: a.role, linkedId: a.linked_id, disabled: Boolean(a.disabled)
          })),
          lessons: includeLessons
            ? (snap.lessons || []).slice(0, 120).map(l => ({
                id: l.id,
                courseId: l.course_id,
                courseName: l.course_name,
                teacherId: l.teacher_id,
                teacherName: l.teacher_name,
                title: l.title,
                startMs: l.start_ms,
                endMs: l.end_ms,
                startTime: fmtLocalTime(l.start_ms),
                endTime: fmtLocalTime(l.end_ms),
                physicalRoom: l.physical_room,
                status: l.status
              }))
            : undefined
        };
      }

      case 'workbench_create_teacher': {
        const id = store.createTeacher({
          name: args.name,
          subject: args.subject ?? '',
          phone: args.phone ?? '',
          password: args.password ?? '',
          role: args.role ?? 'teacher'
        });
        onMutate?.();
        return { ok: true, teacherId: id, message: `已创建教师「${args.name}」(${id})` };
      }

      case 'workbench_update_teacher': {
        store.updateTeacher(args.id, {
          name: args.name,
          subject: args.subject ?? '',
          phone: args.phone ?? ''
        });
        onMutate?.();
        return { ok: true, teacherId: args.id, message: `已更新教师「${args.name}」信息` };
      }

      case 'workbench_upsert_teacher_account': {
        store.upsertTeacherAccount(args.teacherId, {
          password: args.password ?? '',
          role: args.role ?? 'teacher'
        }, '');
        onMutate?.();
        return { ok: true, teacherId: args.teacherId, message: '已更新教师登录账号' };
      }

      case 'workbench_create_student': {
        const id = store.createStudent({
          name: args.name,
          grade: args.grade ?? '',
          phone: args.phone ?? '',
          loginUsername: args.loginUsername ?? '',
          password: args.password ?? '',
          status: args.status ?? '意向',
          validUntil: args.validUntil ?? '',
          note: args.note ?? '',
          courseIds: Array.isArray(args.courseIds) ? args.courseIds : []
        });
        onMutate?.();
        return { ok: true, studentId: id, message: `已创建学生「${args.name}」(${id})` };
      }

      case 'workbench_update_student': {
        store.updateStudent(args.id, {
          name: args.name,
          grade: args.grade ?? '',
          phone: args.phone ?? '',
          status: args.status ?? '意向',
          validUntil: args.validUntil ?? '',
          note: args.note ?? '',
          courseIds: args.courseIds
        });
        onMutate?.();
        return { ok: true, studentId: args.id, message: `已更新学生「${args.name}」信息` };
      }

      case 'workbench_manage_account': {
        if (args.action === 'create') {
          const id = store.createAccount({
            username: args.username,
            password: args.password,
            role: args.role,
            linkedId: args.linkedId,
            name: args.name
          });
          onMutate?.();
          return { ok: true, accountId: id, message: `已创建账号 ${args.username}` };
        }
        if (args.action === 'update') {
          store.updateAccount(args.id, {
            password: args.password,
            name: args.name,
            role: args.role,
            disabled: args.disabled
          }, '');
          onMutate?.();
          return { ok: true, accountId: args.id, message: '已更新账号信息' };
        }
        throw new TypeError(`不支持的账号操作：${args.action}`);
      }

      case 'workbench_create_course': {
        const id = store.createCourse({
          name: args.name,
          subject: args.subject ?? '',
          mode: args.mode ?? '直播课',
          description: args.description ?? '',
          teacherId: args.teacherId ?? '',
          teacherIds: args.teacherIds,
          capacity: args.capacity ?? null
        });
        onMutate?.();
        return { ok: true, courseId: id, message: `已创建课程「${args.name}」(${id})` };
      }

      case 'workbench_update_course': {
        const res = store.updateCourse({
          id: args.id,
          name: args.name,
          subject: args.subject ?? '',
          mode: args.mode ?? '直播课',
          description: args.description ?? '',
          teacherId: args.teacherId,
          teacherIds: args.teacherIds,
          capacity: args.capacity,
          syncFutureLessons: Boolean(args.syncFutureLessons)
        });
        onMutate?.();
        return { ok: true, courseId: args.id, ...res, message: `已更新课程「${args.name}」` };
      }

      case 'workbench_enroll_students': {
        const res = store.enrollStudentsBatch({
          courseId: args.courseId,
          studentIds: args.studentIds || []
        });
        onMutate?.();
        return { ok: true, ...res };
      }

      case 'workbench_list_lessons': {
        const snap = store.getSnapshotForUser(adminSession);
        let list = snap.lessons || [];
        if (args.courseId) list = list.filter(l => l.course_id === args.courseId);
        if (args.teacherId) list = list.filter(l => l.teacher_id === args.teacherId);
        if (args.status) list = list.filter(l => l.status === args.status);
        if (args.fromTime) {
          const fromMs = parseDateTimeMs(args.fromTime, 'fromTime');
          list = list.filter(l => l.end_ms >= fromMs);
        }
        if (args.toTime) {
          const toMs = parseDateTimeMs(args.toTime, 'toTime');
          list = list.filter(l => l.start_ms <= toMs);
        }
        return {
          total: list.length,
          lessons: list.map(l => ({
            id: l.id,
            courseId: l.course_id,
            courseName: l.course_name,
            teacherId: l.teacher_id,
            teacherName: l.teacher_name,
            title: l.title,
            startMs: l.start_ms,
            endMs: l.end_ms,
            startTime: fmtLocalTime(l.start_ms),
            endTime: fmtLocalTime(l.end_ms),
            physicalRoom: l.physical_room,
            status: l.status,
            note: l.note
          }))
        };
      }

      case 'workbench_schedule_lesson': {
        const startMs = parseDateTimeMs(args.startTime, 'startTime');
        const endMs = parseDateTimeMs(args.endTime, 'endTime');
        const id = store.saveLesson({
          id: args.id || null,
          courseId: args.courseId,
          teacherId: args.teacherId,
          title: args.title,
          startMs,
          endMs,
          physicalRoom: args.physicalRoom ?? null,
          externalRoomUrl: args.externalRoomUrl ?? '',
          status: args.status ?? 'scheduled',
          note: args.note ?? ''
        });
        onMutate?.();
        return {
          ok: true,
          lessonId: id,
          startTime: fmtLocalTime(startMs),
          endTime: fmtLocalTime(endMs),
          message: `已${args.id ? '更新' : '安排'}课次「${args.title}」`
        };
      }

      case 'workbench_schedule_lessons_batch': {
        const firstStartMs = parseDateTimeMs(args.firstStartTime, 'firstStartTime');
        const durationMinutes = Number(args.durationMinutes);
        if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
          throw new TypeError('durationMinutes 必须为正数');
        }
        const res = store.saveLessonBatch({
          courseId: args.courseId,
          teacherId: args.teacherId,
          titlePrefix: args.titlePrefix,
          firstStartMs,
          durationMs: Math.round(durationMinutes * 60 * 1000),
          intervalDays: args.intervalDays ?? 7,
          weekdays: args.weekdays ?? null,
          count: args.count,
          physicalRoom: args.physicalRoom ?? null,
          externalRoomUrl: args.externalRoomUrl ?? '',
          skipConflicts: Boolean(args.skipConflicts),
          dryRun: Boolean(args.dryRun)
        });
        if (!args.dryRun) onMutate?.();
        return { ok: true, ...res };
      }

      case 'workbench_delete_lesson': {
        store.deleteLesson(args.id);
        onMutate?.();
        return { ok: true, lessonId: args.id, message: `已删除课次 ${args.id}` };
      }

      case 'workbench_update_lesson_status': {
        if (args.status !== undefined) store.updateLessonStatus(args.id, args.status);
        if (args.note !== undefined) store.updateLessonNote(args.id, args.note);
        onMutate?.();
        return { ok: true, lessonId: args.id, message: '已更新课次状态/备注' };
      }

      case 'workbench_update_enrollment': {
        store.setEnrollmentStatus(args.enrollmentId, args.status);
        onMutate?.();
        return { ok: true, enrollmentId: args.enrollmentId, status: args.status };
      }

      case 'workbench_create_course_node': {
        const id = store.createCourseNode({
          courseId: args.courseId,
          parentId: args.parentId ?? '',
          nodeType: args.nodeType ?? 'folder',
          title: args.title,
          content: args.content ?? ''
        });
        onMutate?.();
        return { ok: true, nodeId: id, message: `已创建大纲节点「${args.title}」` };
      }

      case 'workbench_create_course_nodes_batch': {
        const ids = store.createCourseNodesBatch({
          courseId: args.courseId,
          parentId: args.parentId ?? '',
          items: args.items || []
        });
        onMutate?.();
        return { ok: true, count: ids.length, ids };
      }

      case 'workbench_copy_course_outline': {
        const res = store.copyCourseOutline(args.sourceCourseId, args.targetCourseId);
        onMutate?.();
        return { ok: true, ...res };
      }

      case 'workbench_create_trial_grant': {
        const expMs = parseDateTimeMs(args.expiresAt, 'expiresAt');
        const id = store.createTrialGrant({
          studentId: args.studentId,
          targetType: args.targetType,
          targetId: args.targetId,
          expiresAt: expMs,
          note: args.note ?? ''
        });
        onMutate?.();
        return { ok: true, trialId: id, message: '已发放限时试听权限' };
      }

      case 'workbench_add_student_followup': {
        store.addStudentFollowup({ studentId: args.studentId, content: args.content });
        onMutate?.();
        return { ok: true, studentId: args.studentId, message: '已记录学生跟进' };
      }

      case 'workbench_delete_entity': {
        if (args.entityType === 'teacher') {
          store.deleteTeacher(args.id, '');
          onMutate?.();
          return { ok: true, message: `已删除教师 ${args.id}` };
        }
        if (args.entityType === 'student') {
          store.deleteStudent(args.id);
          onMutate?.();
          return { ok: true, message: `已删除学生 ${args.id}` };
        }
        if (args.entityType === 'course') {
          store.deleteCourse(args.id);
          onMutate?.();
          return { ok: true, message: `已删除课程 ${args.id}` };
        }
        throw new TypeError(`不支持的删除类型：${args.entityType}`);
      }

      default:
        throw new Error(`未知工具：${name}`);
    }
  }

  return async function handleMcpRequest(req, res) {
    if (req.method === 'DELETE') {
      const sid = req.headers['mcp-session-id'];
      if (sid) sessions.delete(String(sid));
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET') {
      res.writeHead(405, { Allow: 'POST, DELETE' });
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, DELETE' });
      res.end();
      return;
    }

    let msg;
    try {
      msg = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: err.message || 'Parse error' }
      });
    }

    // Notifications (no id) return 202 Accepted
    if (msg.id === undefined || msg.id === null) {
      res.writeHead(202);
      res.end();
      return;
    }

    const sidHeader = req.headers['mcp-session-id'];
    if (msg.method === 'initialize') {
      const sessionId = crypto.randomUUID();
      sessions.add(sessionId);
      res.setHeader('Mcp-Session-Id', sessionId);
      return sendJson(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion || '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'teaching-workbench-mcp', version: '1.0.0' },
          instructions: '这是「教培工作台」的官方教务管理 MCP 服务。你可以使用这些工具为管理员查询数据、创建和编辑教师与学生账号、创建和编辑课程、为学生报名课程以及排课/批量排课。所有修改都会立即生效到教培工作台数据库。'
        }
      });
    }

    if (sidHeader && !sessions.has(String(sidHeader))) {
      // Allow stateless or re-initialized sessions gracefully in local single-process mode
      sessions.add(String(sidHeader));
    }

    if (msg.method === 'ping') {
      return sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: {} });
    }

    if (msg.method === 'tools/list') {
      return sendJson(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: TOOL_DEFINITIONS }
      });
    }

    if (msg.method === 'tools/call') {
      const toolName = msg.params?.name;
      const toolArgs = msg.params?.arguments || {};
      try {
        const result = executeTool(toolName, toolArgs);
        return sendJson(res, 200, {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError: false
          }
        });
      } catch (err) {
        return sendJson(res, 200, {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: `执行失败：${err.message || String(err)}` }],
            isError: true
          }
        });
      }
    }

    return sendJson(res, 200, {
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` }
    });
  };
}

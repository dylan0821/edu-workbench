import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { findScheduleConflicts, checkOnlineConcurrency } from './schedule.js';

const ORG_ID = 'org_default';

function parseJsonSafe(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function getReferencedFilesByCategory(db) {
  const recSet = new Set(
    db.prepare("SELECT stored_name FROM recordings WHERE org_id = ? AND stored_name != ''").all(ORG_ID).map(r => r.stored_name)
  );
  const vodSet = new Set(
    db.prepare("SELECT stored_name FROM vod_lessons WHERE org_id = ? AND stored_name != ''").all(ORG_ID).map(r => r.stored_name)
  );
  const matSet = new Set(
    db.prepare("SELECT stored_name FROM materials WHERE org_id = ? AND stored_name != ''").all(ORG_ID).map(r => r.stored_name)
  );
  const qaAttRows = db.prepare("SELECT attachments_json FROM qa_posts WHERE org_id = ? AND attachments_json != '[]'").all(ORG_ID);
  for (const row of qaAttRows) {
    for (const att of parseJsonSafe(row.attachments_json, [])) {
      if (att && att.storedName) matSet.add(att.storedName);
    }
  }
  const hwAttRows = db.prepare("SELECT attachments_json FROM homeworks WHERE org_id = ? AND attachments_json != '[]'").all(ORG_ID);
  for (const row of hwAttRows) {
    for (const att of parseJsonSafe(row.attachments_json, [])) {
      if (att && att.storedName) matSet.add(att.storedName);
    }
  }
  const hwSubRows = db.prepare('SELECT images_json, graded_images_json FROM homework_submissions WHERE org_id = ?').all(ORG_ID);
  for (const row of hwSubRows) {
    for (const img of parseJsonSafe(row.images_json, [])) {
      if (img && img.storedName) matSet.add(img.storedName);
    }
    for (const img of parseJsonSafe(row.graded_images_json, [])) {
      if (img && img.storedName) matSet.add(img.storedName);
    }
  }
  const logoRow = db.prepare('SELECT logo_stored_name FROM org_settings WHERE org_id = ?').get(ORG_ID);
  const logoSet = new Set(logoRow?.logo_stored_name ? [logoRow.logo_stored_name] : []);
  return { recSet, vodSet, matSet, logoSet };
}

export function verifyBackupFile(filePath, uploadDir) {
  const testDb = new DatabaseSync(filePath, { readOnly: true });
  try {
    const integrity = testDb.prepare('PRAGMA integrity_check').get();
    const org = testDb.prepare('SELECT name FROM org_settings LIMIT 1').get();
    const counts = {
      courses: Number(testDb.prepare('SELECT COUNT(*) AS c FROM courses').get()?.c || 0),
      students: Number(testDb.prepare('SELECT COUNT(*) AS c FROM students').get()?.c || 0),
      lessons: Number(testDb.prepare('SELECT COUNT(*) AS c FROM lessons').get()?.c || 0)
    };
    const files = uploadDir ? new Set(Object.values(getReferencedFilesByCategory(testDb)).flatMap(set => [...set])) : null;
    const missingFiles = files ? [...files].filter(name =>
      path.basename(name) !== name || name === '..' ||
      !fs.lstatSync(path.join(uploadDir, name), { throwIfNoEntry: false })?.isFile()
    ) : [];
    if (files) {
      for (const { id, received_seqs_json } of testDb.prepare('SELECT id, received_seqs_json FROM recording_sessions WHERE org_id = ?').all(ORG_ID)) {
        const folder = `.chunks_${id}`;
        if (path.basename(folder) !== folder) {
          missingFiles.push(folder);
          continue;
        }
        const chunkDir = path.join(uploadDir, folder);
        for (const seq of Object.keys(parseJsonSafe(received_seqs_json, {}))) {
          const name = `chunk_${seq}.part`;
          files.add(`${folder}/${name}`);
          if (!/^\d+$/.test(seq) || !fs.lstatSync(chunkDir, { throwIfNoEntry: false })?.isDirectory()
            || !fs.lstatSync(path.join(chunkDir, name), { throwIfNoEntry: false })?.isFile()) {
            missingFiles.push(`${folder}/${name}`);
          }
        }
      }
    }
    return {
      ok: integrity?.integrity_check === 'ok' && missingFiles.length === 0,
      orgName: org?.name || '',
      counts,
      ...(files ? { checkedFiles: files.size, missingFiles } : {})
    };
  } finally {
    testDb.close();
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, storedHash) {
  const raw = String(storedHash || '');
  if (raw.startsWith('scrypt$')) {
    const parts = raw.split('$');
    if (parts.length !== 3) return false;
    const [, salt, hex] = parts;
    const derived = crypto.scryptSync(String(password), salt, 32);
    const expected = Buffer.from(hex, 'hex');
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  }
  const legacy = crypto.createHash('sha256').update(String(password)).digest('hex');
  return legacy === raw;
}

function isLegacyPasswordHash(storedHash) {
  return !String(storedHash || '').startsWith('scrypt$');
}

function assertValidPhone(phone) {
  const clean = String(phone || '').trim();
  if (!/^1\d{10}$/.test(clean)) {
    throw new TypeError('请输入 11 位有效手机号');
  }
  return clean;
}

function assertOptionalPhone(phone) {
  const clean = String(phone || '').trim();
  if (!clean) return '';
  return assertValidPhone(clean);
}

function assertOptionalDate(dateStr) {
  const clean = String(dateStr || '').trim();
  if (!clean) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    throw new TypeError('日期格式必须为 YYYY-MM-DD');
  }
  return clean;
}

function todayDateStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isDateExpired(validUntil) {
  const clean = String(validUntil || '').trim();
  if (!clean || !/^\d{4}-\d{2}-\d{2}$/.test(clean)) return false;
  return todayDateStr() > clean;
}

function assertValidUsername(username) {
  const clean = String(username || '').trim();
  if (!/^[a-zA-Z0-9_-]{4,32}$/.test(clean)) {
    throw new TypeError('登录用户名需为 4–32 位字母、数字、下划线或短横线');
  }
  return clean;
}

export function openWorkbenchDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS org_settings (
      org_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      max_online_rooms INTEGER NOT NULL DEFAULT 1,
      max_online_students INTEGER NOT NULL DEFAULT 30
    );

    CREATE TABLE IF NOT EXISTS teachers (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      name TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      name TEXT NOT NULL,
      grade TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '意向',
      next_followup_date TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      linked_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      linked_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS student_followups (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS student_learning_records (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      course_id TEXT NOT NULL DEFAULT '',
      item_title TEXT NOT NULL,
      pass1 TEXT NOT NULL DEFAULT '待做',
      pass2 TEXT NOT NULL DEFAULT '待做',
      pass3 TEXT NOT NULL DEFAULT '待做',
      score TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      name TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT '直播课',
      description TEXT NOT NULL DEFAULT '',
      teacher_id TEXT NOT NULL DEFAULT '',
      capacity INTEGER
    );

    CREATE TABLE IF NOT EXISTS course_teachers (
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
      org_id TEXT NOT NULL,
      PRIMARY KEY (course_id, teacher_id)
    );

    CREATE TABLE IF NOT EXISTS course_nodes (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      parent_id TEXT NOT NULL DEFAULT '',
      node_type TEXT NOT NULL DEFAULT 'folder',
      title TEXT NOT NULL,
      ref_id TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS enrollments (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at TEXT NOT NULL,
      UNIQUE(course_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS lessons (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      teacher_id TEXT NOT NULL REFERENCES teachers(id),
      title TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      physical_room TEXT,
      external_room_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'scheduled',
      whiteboard_json TEXT NOT NULL DEFAULT '[]',
      note TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
      segment INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL,
      filename TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      duration_sec INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending_review',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vod_lessons (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      chapter_name TEXT NOT NULL,
      title TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 1,
      filename TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      duration_sec INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'published',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS playback_progress (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      last_position_sec REAL NOT NULL DEFAULT 0,
      watched_sec REAL NOT NULL DEFAULT 0,
      watched_ranges_json TEXT NOT NULL DEFAULT '[]',
      duration_sec REAL NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      UNIQUE(student_id, target_type, target_id)
    );

    CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      target_id TEXT NOT NULL,
      category TEXT NOT NULL,
      filename TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS qa_posts (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      lesson_id TEXT NOT NULL DEFAULT '',
      author_name TEXT NOT NULL,
      author_role TEXT NOT NULL,
      author_id TEXT NOT NULL,
      ref_tag TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      msg_type TEXT NOT NULL DEFAULT 'chat',
      pinned INTEGER NOT NULL DEFAULT 0,
      reply_to_id TEXT NOT NULL DEFAULT '',
      mentions_json TEXT NOT NULL DEFAULT '[]',
      attachments_json TEXT NOT NULL DEFAULT '[]',
      card_json TEXT NOT NULL DEFAULT '',
      created_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      recall_kind TEXT NOT NULL DEFAULT '',
      recalled_by_name TEXT NOT NULL DEFAULT '',
      recalled_by_role TEXT NOT NULL DEFAULT '',
      recalled_at_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS qa_replies (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      post_id TEXT NOT NULL REFERENCES qa_posts(id) ON DELETE CASCADE,
      author_name TEXT NOT NULL,
      author_role TEXT NOT NULL,
      author_id TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      created_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS qa_read_cursors (
      org_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      last_read_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, course_id)
    );

    CREATE TABLE IF NOT EXISTS trial_grants (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
      student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT '出勤',
      note TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      UNIQUE(lesson_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS recording_sessions (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      filename TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'recording',
      received_seqs_json TEXT NOT NULL DEFAULT '{}',
      started_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS playback_bookmarks (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      time_sec REAL NOT NULL,
      label TEXT NOT NULL,
      ref_tag TEXT NOT NULL DEFAULT '',
      author_id TEXT NOT NULL DEFAULT '',
      author_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);

  const currentVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (currentVersion < 1) {
    // Safe schema migrations for existing DBs
    try { db.exec("ALTER TABLE lessons ADD COLUMN whiteboard_json TEXT NOT NULL DEFAULT '[]'"); } catch {}
  try { db.exec("ALTER TABLE lessons ADD COLUMN external_room_url TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE playback_progress ADD COLUMN watched_sec REAL NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE playback_progress ADD COLUMN watched_ranges_json TEXT NOT NULL DEFAULT '[]'"); } catch {}
  try { db.exec("ALTER TABLE org_settings ADD COLUMN logo_stored_name TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE org_settings ADD COLUMN logo_mime_type TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE org_settings ADD COLUMN ice_servers_json TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE org_settings ADD COLUMN default_class_capacity INTEGER NOT NULL DEFAULT 30"); } catch {}
  try { db.exec("ALTER TABLE org_settings ADD COLUMN default_lesson_minutes INTEGER NOT NULL DEFAULT 180"); } catch {}
  try { db.exec("ALTER TABLE org_settings ADD COLUMN default_watermark INTEGER NOT NULL DEFAULT 1"); } catch {}
  try { db.exec("ALTER TABLE org_settings ADD COLUMN default_student_draw INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE org_settings ADD COLUMN last_backup_at TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE org_settings ADD COLUMN deepseek_api_key TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE accounts ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE students ADD COLUMN valid_until TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE courses ADD COLUMN subject TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE courses ADD COLUMN teacher_id TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE courses ADD COLUMN capacity INTEGER"); } catch {}
  try { db.exec("ALTER TABLE qa_posts ADD COLUMN msg_type TEXT NOT NULL DEFAULT 'question'"); } catch {}
  try { db.exec("ALTER TABLE qa_posts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE qa_posts ADD COLUMN reply_to_id TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE qa_posts ADD COLUMN mentions_json TEXT NOT NULL DEFAULT '[]'"); } catch {}
  try { db.exec("ALTER TABLE qa_posts ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'"); } catch {}
  try { db.exec("ALTER TABLE qa_posts ADD COLUMN card_json TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE qa_posts ADD COLUMN created_ms INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE qa_posts ADD COLUMN recall_kind TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE qa_posts ADD COLUMN recalled_by_name TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE qa_posts ADD COLUMN recalled_by_role TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE qa_posts ADD COLUMN recalled_at_ms INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE qa_replies ADD COLUMN author_id TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE qa_replies ADD COLUMN created_ms INTEGER NOT NULL DEFAULT 0"); } catch {}

  // 兼容旧库：将基于「班级」的 enrollments / lessons 自动迁移为直接关联「课程」
  {
    const enCols = db.prepare('PRAGMA table_info(enrollments)').all().map(c => c.name);
    const lesCols = db.prepare('PRAGMA table_info(lessons)').all().map(c => c.name);
    const hasLegacyClasses = Boolean(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='classes'").get()
    );
    if (hasLegacyClasses && (!enCols.includes('course_id') || !lesCols.includes('course_id'))) {
      db.exec('PRAGMA foreign_keys = OFF;');
      db.exec('BEGIN');
      try {
        // 将旧班级班主任回填到对应课程主讲老师（仅当课程尚未设置主讲老师）
        db.exec(`
          UPDATE courses
          SET teacher_id = COALESCE(
            (SELECT c.teacher_id FROM classes c WHERE c.course_id = courses.id AND c.org_id = courses.org_id LIMIT 1),
            ''
          )
          WHERE (teacher_id IS NULL OR teacher_id = '')
        `);

        if (!enCols.includes('course_id')) {
          db.exec(`
            CREATE TABLE enrollments_new (
              id TEXT PRIMARY KEY,
              org_id TEXT NOT NULL,
              course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
              student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
              status TEXT NOT NULL DEFAULT 'active',
              updated_at TEXT NOT NULL,
              UNIQUE(course_id, student_id)
            )
          `);
          const hasClassCourses = Boolean(
            db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='class_courses'").get()
          );
          const legacyEnRows = hasClassCourses
            ? db.prepare(`
                SELECT e.id, e.org_id, COALESCE(cc.course_id, c.course_id) AS course_id,
                       e.student_id, e.status, e.updated_at
                FROM enrollments e
                JOIN classes c ON c.id = e.class_id
                LEFT JOIN class_courses cc ON cc.class_id = e.class_id AND cc.org_id = e.org_id
                WHERE COALESCE(cc.course_id, c.course_id) IS NOT NULL
                ORDER BY CASE WHEN e.status = 'active' THEN 0 ELSE 1 END, e.updated_at DESC
              `).all()
            : db.prepare(`
                SELECT e.id, e.org_id, c.course_id, e.student_id, e.status, e.updated_at
                FROM enrollments e
                JOIN classes c ON c.id = e.class_id
                ORDER BY CASE WHEN e.status = 'active' THEN 0 ELSE 1 END, e.updated_at DESC
              `).all();
          const seenPairs = new Set();
          const insEn = db.prepare(
            'INSERT INTO enrollments_new (id, org_id, course_id, student_id, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
          );
          let seq = 0;
          for (const r of legacyEnRows) {
            const pairKey = `${r.course_id}:${r.student_id}`;
            if (seenPairs.has(pairKey)) continue;
            seenPairs.add(pairKey);
            insEn.run(`${r.id}_${seq++}`, r.org_id, r.course_id, r.student_id, r.status, r.updated_at);
          }
          db.exec('DROP TABLE enrollments; ALTER TABLE enrollments_new RENAME TO enrollments;');
        }

        if (!lesCols.includes('course_id')) {
          db.exec(`
            CREATE TABLE lessons_new (
              id TEXT PRIMARY KEY,
              org_id TEXT NOT NULL,
              course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
              teacher_id TEXT NOT NULL REFERENCES teachers(id),
              title TEXT NOT NULL,
              start_ms INTEGER NOT NULL,
              end_ms INTEGER NOT NULL,
              physical_room TEXT,
              external_room_url TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL DEFAULT 'scheduled',
              whiteboard_json TEXT NOT NULL DEFAULT '[]',
              note TEXT NOT NULL DEFAULT ''
            )
          `);
          db.exec(`
            INSERT INTO lessons_new (id, org_id, course_id, teacher_id, title, start_ms, end_ms, physical_room, external_room_url, status, whiteboard_json, note)
            SELECT l.id, l.org_id, c.course_id, l.teacher_id, l.title, l.start_ms, l.end_ms,
                   l.physical_room, COALESCE(l.external_room_url, ''), l.status,
                   COALESCE(l.whiteboard_json, '[]'), COALESCE(l.note, '')
            FROM lessons l
            JOIN classes c ON c.id = l.class_id
          `);
          db.exec('DROP TABLE lessons; ALTER TABLE lessons_new RENAME TO lessons;');
        }

        db.exec('DROP TABLE IF EXISTS class_courses; DROP TABLE IF EXISTS classes;');
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        db.exec('PRAGMA foreign_keys = ON;');
      }
    }
  }
  // 将 courses.teacher_id 同步到 course_teachers 多对多表
  try {
    db.exec(`
      INSERT OR IGNORE INTO course_teachers (course_id, teacher_id, org_id)
      SELECT co.id, co.teacher_id, co.org_id
      FROM courses co
      JOIN teachers t ON t.id = co.teacher_id
      WHERE co.teacher_id IS NOT NULL AND co.teacher_id != ''
    `);
  } catch {}
  }

  if (currentVersion < 2) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_account_id ON sessions(account_id);
      CREATE INDEX IF NOT EXISTS idx_enrollments_student_status ON enrollments(student_id, status);
      CREATE INDEX IF NOT EXISTS idx_enrollments_course_status ON enrollments(course_id, status);
      CREATE INDEX IF NOT EXISTS idx_lessons_org_start ON lessons(org_id, start_ms);
      CREATE INDEX IF NOT EXISTS idx_lessons_course ON lessons(course_id, start_ms);
      CREATE INDEX IF NOT EXISTS idx_course_nodes_tree ON course_nodes(course_id, parent_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_recordings_lesson ON recordings(lesson_id, segment);
      CREATE INDEX IF NOT EXISTS idx_vod_lessons_course ON vod_lessons(course_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_materials_target ON materials(org_id, scope, target_id);
      CREATE INDEX IF NOT EXISTS idx_qa_posts_course_created ON qa_posts(course_id, created_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_qa_replies_post_created ON qa_replies(post_id, created_ms ASC);
      CREATE INDEX IF NOT EXISTS idx_playback_progress_student ON playback_progress(student_id, target_type, target_id);
      CREATE INDEX IF NOT EXISTS idx_playback_bookmarks_target ON playback_bookmarks(org_id, target_type, target_id, time_sec);
      CREATE INDEX IF NOT EXISTS idx_trial_grants_student ON trial_grants(student_id, expires_at);
    `);
    db.exec('PRAGMA user_version = 2;');
  }
  if (currentVersion < 3) {
    try { db.exec("ALTER TABLE org_settings ADD COLUMN deepseek_api_key TEXT NOT NULL DEFAULT ''"); } catch {}
    db.exec('PRAGMA user_version = 3;');
  }
  if (currentVersion < 4) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS assistant_conversations (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        title TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'deepseek-chat',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS assistant_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        thinking TEXT NOT NULL DEFAULT '',
        tool_calls_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'done',
        created_at TEXT NOT NULL,
        created_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_assistant_conv_org ON assistant_conversations(org_id, updated_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_assistant_msg_conv ON assistant_messages(conversation_id, created_ms ASC);
    `);
    db.exec('PRAGMA user_version = 4;');
  }
  if (currentVersion < 5) {
    try { db.exec("ALTER TABLE assistant_conversations ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'high'"); } catch {}
    try { db.exec("ALTER TABLE assistant_conversations ADD COLUMN metrics_json TEXT NOT NULL DEFAULT '{}'"); } catch {}
    db.exec('PRAGMA user_version = 5;');
  }
  if (currentVersion < 6) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS classroom_messages (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        lesson_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        user_role TEXT NOT NULL,
        text TEXT NOT NULL,
        time_label TEXT NOT NULL,
        created_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_classroom_messages_lesson ON classroom_messages(org_id, lesson_id, created_ms ASC);
    `);
    db.exec('PRAGMA user_version = 6;');
  }
  if (currentVersion < 7) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS homeworks (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        teacher_id TEXT NOT NULL DEFAULT '',
        creator_name TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        content_format TEXT NOT NULL DEFAULT 'markdown',
        attachments_json TEXT NOT NULL DEFAULT '[]',
        due_date TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_homeworks_org_course ON homeworks(org_id, course_id, created_ms DESC);

      CREATE TABLE IF NOT EXISTS homework_submissions (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        homework_id TEXT NOT NULL REFERENCES homeworks(id) ON DELETE CASCADE,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        images_json TEXT NOT NULL DEFAULT '[]',
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'submitted',
        score TEXT NOT NULL DEFAULT '',
        feedback TEXT NOT NULL DEFAULT '',
        graded_images_json TEXT NOT NULL DEFAULT '[]',
        graded_by TEXT NOT NULL DEFAULT '',
        graded_at TEXT NOT NULL DEFAULT '',
        submitted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        submitted_ms INTEGER NOT NULL DEFAULT 0,
        UNIQUE(homework_id, student_id)
      );
      CREATE INDEX IF NOT EXISTS idx_hw_submissions_hw ON homework_submissions(org_id, homework_id, submitted_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_hw_submissions_student ON homework_submissions(org_id, student_id);
    `);
    db.exec('PRAGMA user_version = 7;');
  }

  const orgRow = db.prepare('SELECT org_id FROM org_settings WHERE org_id = ?').get(ORG_ID);
  if (!orgRow) {
    db.prepare(
      'INSERT INTO org_settings (org_id, name, max_online_rooms, max_online_students) VALUES (?, ?, 1, 30)'
    ).run(ORG_ID, '教培工作台');
  }

  // 兼容旧库：若尚无管理员账号但已有教师账号，将最早创建的教师账号升级为管理员
  const existingAdmin = db.prepare("SELECT id FROM accounts WHERE role = 'admin' AND org_id = ? LIMIT 1").get(ORG_ID);
  if (!existingAdmin) {
    const firstTeacherAcc = db.prepare(
      "SELECT id FROM accounts WHERE role = 'teacher' AND org_id = ? ORDER BY created_at ASC LIMIT 1"
    ).get(ORG_ID);
    if (firstTeacherAcc) {
      db.prepare("UPDATE accounts SET role = 'admin' WHERE id = ?").run(firstTeacherAcc.id);
      db.prepare("UPDATE sessions SET role = 'admin' WHERE account_id = ?").run(firstTeacherAcc.id);
    }
  }

  function uid(prefix) {
    return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
  }

  function nowStr() {
    return new Date().toISOString().slice(0, 16).replace('T', ' ');
  }

  // --- 权限与会话管理 ---
  function hasAnyTeacherAccount() {
    const row = db.prepare("SELECT id FROM accounts WHERE role IN ('admin', 'teacher') AND org_id = ? LIMIT 1").get(ORG_ID);
    return Boolean(row);
  }

  function setupInitialAdmin({ name, username, password, subject = '' }) {
    if (hasAnyTeacherAccount()) {
      const err = new Error('管理员账号已存在，请直接登录');
      err.statusCode = 409;
      throw err;
    }
    const cleanName = String(name || '').trim();
    const cleanUser = assertValidPhone(username);
    const cleanPass = String(password || '').trim();
    if (!cleanName || cleanPass.length < 4) {
      throw new TypeError('请填写姓名及至少 4 位密码');
    }
    const teacherId = createTeacher({ name: cleanName, subject, phone: cleanUser });
    const accountId = createAccount({
      username: cleanUser,
      password: cleanPass,
      role: 'admin',
      linkedId: teacherId,
      name: cleanName
    });
    return createSession(accountId);
  }

  function createSession(accountId, ttlMs = 7 * 24 * 3600 * 1000) {
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ? AND org_id = ?').get(accountId, ORG_ID);
    if (!acc) throw new Error('账号不存在');
    // 学生账号强制单端登录，防止多人共享同一账号观看录播
    if (acc.role === 'student') {
      db.prepare('DELETE FROM sessions WHERE account_id = ? AND org_id = ?').run(acc.id, ORG_ID);
    }
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = Date.now() + ttlMs;
    db.prepare(`
      INSERT INTO sessions (token, org_id, account_id, username, name, role, linked_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(token, ORG_ID, acc.id, acc.username, acc.name, acc.role, acc.linked_id, nowStr(), expiresAt);
      return {
      token,
      account: {
        id: acc.id,
        username: acc.username,
        name: acc.name,
        role: acc.role,
        linkedId: acc.linked_id
      }
    };
  }

  function getSession(token) {
    if (!token) return null;
    const row = db.prepare(`
      SELECT s.*, a.disabled AS account_disabled
      FROM sessions s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.token = ? AND s.org_id = ?
    `).get(token, ORG_ID);
    if (!row) return null;
    if (row.expires_at <= Date.now() || row.account_disabled) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return null;
    }
    if (row.role === 'student') {
      const stu = db.prepare('SELECT valid_until FROM students WHERE id = ? AND org_id = ?').get(row.linked_id, ORG_ID);
      if (stu && isDateExpired(stu.valid_until)) {
        db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
        return null;
      }
    }
      return {
      token: row.token,
      accountId: row.account_id,
      username: row.username,
      name: row.name,
      role: row.role,
      linkedId: row.linked_id
    };
  }

  function deleteSession(token) {
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  // --- 学生权限判定辅助函数（服务端强制校验） ---
  function getStudentActiveCourseIds(studentId) {
    return new Set(
      db.prepare("SELECT course_id FROM enrollments WHERE student_id = ? AND status = 'active' AND org_id = ?")
        .all(studentId, ORG_ID)
        .map(r => r.course_id)
    );
  }

  function getStudentActiveTrialLessonIds(studentId, now = Date.now()) {
    return new Set(
      db.prepare("SELECT target_id FROM trial_grants WHERE student_id = ? AND target_type = 'lesson' AND expires_at > ? AND org_id = ?")
        .all(studentId, now, ORG_ID)
        .map(r => r.target_id)
    );
  }

  function getStudentActiveTrialVodIds(studentId, now = Date.now()) {
    return new Set(
      db.prepare("SELECT target_id FROM trial_grants WHERE student_id = ? AND target_type = 'vod' AND expires_at > ? AND org_id = ?")
        .all(studentId, now, ORG_ID)
        .map(r => r.target_id)
    );
  }

  function canStudentAccessLesson(studentId, lessonId) {
    const lesson = db.prepare('SELECT course_id FROM lessons WHERE id = ? AND org_id = ?').get(lessonId, ORG_ID);
    if (!lesson) return false;
    if (getStudentActiveCourseIds(studentId).has(lesson.course_id)) return true;
    return getStudentActiveTrialLessonIds(studentId).has(lessonId);
  }

  function canStudentAccessCourse(studentId, courseId) {
    return getStudentActiveCourseIds(studentId).has(courseId);
  }

  function canStudentAccessRecording(studentId, rec) {
    if (!rec || rec.status !== 'published') return false;
    return canStudentAccessLesson(studentId, rec.lesson_id);
  }

  function canStudentAccessVod(studentId, vod) {
    if (!vod || vod.status !== 'published') return false;
    if (canStudentAccessCourse(studentId, vod.course_id)) return true;
    return getStudentActiveTrialVodIds(studentId).has(vod.id);
  }

  function canStudentAccessMaterial(studentId, mat) {
    if (!mat) return false;
    if (mat.scope === 'course') return canStudentAccessCourse(studentId, mat.target_id);
    if (mat.scope === 'lesson') return canStudentAccessLesson(studentId, mat.target_id);
    return false;
  }

  function canTeacherAccessLesson(teacherId, lessonId) {
    const row = db.prepare('SELECT id, course_id, teacher_id FROM lessons WHERE id = ? AND org_id = ?').get(lessonId, ORG_ID);
    if (!row) return false;
    if (row.teacher_id === teacherId) return true;
    return canTeacherAccessCourse(teacherId, row.course_id);
  }

  function canTeacherAccessCourse(teacherId, courseId) {
    const ctRow = db.prepare(
      'SELECT course_id FROM course_teachers WHERE course_id = ? AND teacher_id = ? AND org_id = ? LIMIT 1'
    ).get(courseId, teacherId, ORG_ID);
    if (ctRow) return true;
    const coRow = db.prepare(
      'SELECT id FROM courses WHERE id = ? AND teacher_id = ? AND org_id = ? LIMIT 1'
    ).get(courseId, teacherId, ORG_ID);
    if (coRow) return true;
    const lesRow = db.prepare(
      'SELECT id FROM lessons WHERE course_id = ? AND teacher_id = ? AND org_id = ? LIMIT 1'
    ).get(courseId, teacherId, ORG_ID);
    return Boolean(lesRow);
  }

  function attachCourseTeachers(courseRows) {
    if (!courseRows.length) return courseRows;
    const links = db.prepare(`
      SELECT ct.course_id, ct.teacher_id, t.name AS teacher_name
      FROM course_teachers ct
      JOIN teachers t ON t.id = ct.teacher_id
      WHERE ct.org_id = ?
      ORDER BY t.name
    `).all(ORG_ID);
    const byCourse = new Map();
    for (const l of links) {
      if (!byCourse.has(l.course_id)) byCourse.set(l.course_id, []);
      byCourse.get(l.course_id).push(l);
    }
    return courseRows.map(row => {
      const items = byCourse.get(row.id) || [];
      const teacherIds = items.length
        ? items.map(i => i.teacher_id)
        : (row.teacher_id ? [row.teacher_id] : []);
      const teacherNames = items.length
        ? items.map(i => i.teacher_name)
        : (row.teacher_name ? [row.teacher_name] : []);
        return {
        ...row,
        teacher_id: teacherIds[0] || '',
        teacher_ids: teacherIds,
        teacher_names: teacherNames,
        teacher_name: teacherNames.join('、')
      };
    });
  }

  function canTeacherAccessMaterial(teacherId, mat) {
    if (!mat) return false;
    if (mat.scope === 'course') return canTeacherAccessCourse(teacherId, mat.target_id);
    if (mat.scope === 'lesson') return canTeacherAccessLesson(teacherId, mat.target_id);
    return false;
  }

  // --- 按登录身份隔离的数据快照 ---
  function resolveCreatedMs(row) {
    const ms = Number(row?.created_ms || 0);
    if (Number.isFinite(ms) && ms > 0) return ms;
    const raw = String(row?.created_at || '').trim();
    if (!raw) return 0;
    const parsed = Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T') + ':00Z');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function hydrateQaPost(row) {
    if (!row) return null;
    const attachments = parseJsonSafe(row.attachments_json, []);
    const mentions = parseJsonSafe(row.mentions_json, []);
    const card = parseJsonSafe(row.card_json, null);
      return {
      ...row,
      msg_type: row.msg_type || 'chat',
      pinned: row.pinned ? 1 : 0,
      reply_to_id: row.reply_to_id || '',
      created_ms: resolveCreatedMs(row),
      mentions: Array.isArray(mentions) ? mentions : [],
      attachments: Array.isArray(attachments) ? attachments : [],
      card: card && typeof card === 'object' ? card : null,
      recall_kind: row.recall_kind || '',
      recalled_by_name: row.recalled_by_name || '',
      recalled_by_role: row.recalled_by_role || '',
      recalled_at_ms: Number(row.recalled_at_ms || 0)
    };
  }

  function hydrateHomework(row) {
    if (!row) return null;
    const attachments = parseJsonSafe(row.attachments_json, []);
      return {
      ...row,
      content_format: row.content_format === 'text' ? 'text' : 'markdown',
      attachments: Array.isArray(attachments) ? attachments : []
    };
  }

  function hydrateHomeworkSubmission(row) {
    if (!row) return null;
    const images = parseJsonSafe(row.images_json, []);
    const gradedImages = parseJsonSafe(row.graded_images_json, []);
      return {
      ...row,
      images: Array.isArray(images) ? images : [],
      gradedImages: Array.isArray(gradedImages) ? gradedImages : []
    };
  }

  function getQaReadCursors(accountId) {
    if (!accountId) return {};
    const rows = db.prepare(
      'SELECT course_id, last_read_ms FROM qa_read_cursors WHERE org_id = ? AND account_id = ?'
    ).all(ORG_ID, accountId);
    const map = {};
    for (const r of rows) map[r.course_id] = Number(r.last_read_ms || 0);
    return map;
  }

  function queryIn(prefixSql, ids, suffixSql = '', prefixParams = [], suffixParams = []) {
    const arr = Array.isArray(ids) ? ids : [...ids];
    if (!arr.length) return [];
    const placeholders = arr.map(() => '?').join(',');
    return db.prepare(`${prefixSql} (${placeholders}) ${suffixSql}`).all(...prefixParams, ...arr, ...suffixParams);
  }

  function maskApiKey(key) {
    const clean = String(key || '').trim();
    if (!clean) return '';
    if (clean.length <= 8) return `${clean.slice(0, 2)}****`;
    return `${clean.slice(0, 4)}****${clean.slice(-4)}`;
  }

  function sanitizeOrgForSession(rawOrg, role) {
    if (!rawOrg) return rawOrg;
    const { deepseek_api_key: rawKey, ...rest } = rawOrg;
    if (role === 'admin') {
        return {
        ...rest,
        has_deepseek_api_key: Boolean(String(rawKey || '').trim()),
        deepseek_api_key_masked: maskApiKey(rawKey)
      };
    }
    return rest;
  }

  function getDeepseekApiKey() {
    const row = db.prepare('SELECT deepseek_api_key FROM org_settings WHERE org_id = ?').get(ORG_ID);
    return String(row?.deepseek_api_key || '').trim();
  }

  function getSnapshotForUser(session) {
    const rawOrg = db.prepare('SELECT * FROM org_settings WHERE org_id = ?').get(ORG_ID);
    const org = sanitizeOrgForSession(rawOrg, session?.role);
    if (!session) {
        return { authenticated: false, needsSetup: !hasAnyTeacherAccount(), org };
    }

    if (session.role === 'admin') {
      const teachers = db.prepare('SELECT * FROM teachers WHERE org_id = ? ORDER BY name').all(ORG_ID);
      const students = db.prepare('SELECT * FROM students WHERE org_id = ? ORDER BY created_at DESC').all(ORG_ID);
      const accounts = db.prepare(
        'SELECT id, org_id, username, name, role, linked_id, disabled, created_at FROM accounts WHERE org_id = ? ORDER BY created_at DESC'
      ).all(ORG_ID);
      const followups = db.prepare('SELECT * FROM student_followups WHERE org_id = ? ORDER BY created_at DESC').all(ORG_ID);
      const learningRecords = db.prepare('SELECT * FROM student_learning_records WHERE org_id = ? ORDER BY updated_at DESC').all(ORG_ID);
      const courses = attachCourseTeachers(db.prepare(`
        SELECT co.*, COALESCE(t.name, '') AS teacher_name
        FROM courses co
        LEFT JOIN teachers t ON t.id = co.teacher_id
        WHERE co.org_id = ?
        ORDER BY co.name
      `).all(ORG_ID));
      const courseNodes = db.prepare(
        'SELECT * FROM course_nodes WHERE org_id = ? ORDER BY course_id, parent_id, sort_order ASC, created_at ASC'
      ).all(ORG_ID);
      const enrollments = db.prepare(`
        SELECT e.*, s.name AS student_name, s.grade AS student_grade, co.name AS course_name
        FROM enrollments e
        JOIN students s ON s.id = e.student_id
        JOIN courses co ON co.id = e.course_id
        WHERE e.org_id = ?
        ORDER BY e.updated_at DESC
      `).all(ORG_ID);
      const lessons = db.prepare(`
        SELECT l.id, l.org_id, l.course_id, l.teacher_id, l.title, l.start_ms, l.end_ms,
               l.physical_room, l.external_room_url, l.status, l.note,
               co.name AS course_name, t.name AS teacher_name
        FROM lessons l
        JOIN courses co ON co.id = l.course_id
        JOIN teachers t ON t.id = l.teacher_id
        WHERE l.org_id = ?
        ORDER BY l.start_ms ASC
      `).all(ORG_ID);
      const recordings = db.prepare(`
        SELECT r.id, r.org_id, r.lesson_id, r.segment, r.title, r.filename, r.mime_type,
               r.size_bytes, r.duration_sec, r.status, r.created_at,
               l.title AS lesson_title, l.course_id, co.name AS course_name
        FROM recordings r
        JOIN lessons l ON l.id = r.lesson_id
        JOIN courses co ON co.id = l.course_id
        WHERE r.org_id = ?
        ORDER BY r.created_at DESC, r.segment ASC
      `).all(ORG_ID);
      const vodLessons = db.prepare(`
        SELECT v.id, v.org_id, v.course_id, v.chapter_name, v.title, v.sort_order,
               v.filename, v.mime_type, v.size_bytes, v.duration_sec, v.status, v.created_at,
               co.name AS course_name
        FROM vod_lessons v
        JOIN courses co ON co.id = v.course_id
        WHERE v.org_id = ?
        ORDER BY v.course_id, v.sort_order ASC, v.created_at ASC
      `).all(ORG_ID);
      const playbackProgress = db.prepare('SELECT * FROM playback_progress WHERE org_id = ?').all(ORG_ID);
      const materials = db.prepare(`
        SELECT id, org_id, scope, target_id, category, filename, mime_type, size_bytes, created_at
        FROM materials
        WHERE org_id = ?
        ORDER BY created_at DESC
      `).all(ORG_ID);
      const qaPosts = db.prepare(`
        SELECT p.*, co.name AS course_name
        FROM qa_posts p
        JOIN courses co ON co.id = p.course_id
        WHERE p.org_id = ?
        ORDER BY p.created_ms DESC, p.created_at DESC
      `).all(ORG_ID).map(hydrateQaPost);
      const qaReplies = db.prepare('SELECT * FROM qa_replies WHERE org_id = ? ORDER BY created_ms ASC, created_at ASC').all(ORG_ID);
      const qaReadCursors = getQaReadCursors(session.accountId);
      const homeworks = db.prepare(`
        SELECT h.*, co.name AS course_name
        FROM homeworks h
        JOIN courses co ON co.id = h.course_id
        WHERE h.org_id = ?
        ORDER BY h.created_ms DESC, h.created_at DESC
      `).all(ORG_ID).map(hydrateHomework);
      const homeworkSubmissions = db.prepare(`
        SELECT hs.*, s.name AS student_name, s.grade AS student_grade
        FROM homework_submissions hs
        JOIN students s ON s.id = hs.student_id
        WHERE hs.org_id = ?
        ORDER BY hs.submitted_ms DESC, hs.submitted_at DESC
      `).all(ORG_ID).map(hydrateHomeworkSubmission);
      const trialGrants = db.prepare(`
        SELECT tg.*, s.name AS student_name
        FROM trial_grants tg
        JOIN students s ON s.id = tg.student_id
        WHERE tg.org_id = ?
        ORDER BY tg.created_at DESC
      `).all(ORG_ID);
      const attendance = db.prepare('SELECT * FROM attendance WHERE org_id = ?').all(ORG_ID);

        return {
        authenticated: true,
        needsSetup: false,
        currentUser: {
          id: session.accountId,
          username: session.username,
          name: session.name,
          role: session.role,
          linkedId: session.linkedId
        },
        org,
        teachers,
        students,
        accounts,
        followups,
        learningRecords,
        courses,
        courseNodes,
        enrollments,
        lessons,
        recordings,
        pendingRecordings: listPendingRecordingsForSnapshot(null),
        vodLessons,
        playbackProgress,
        materials,
        qaPosts,
        qaReplies,
        qaReadCursors,
        homeworks,
        homeworkSubmissions,
        trialGrants,
        attendance
      };
    }

    // 教师视角：返回自己担任授课教师的课程、课次及关联教学数据（不含教务管理、学生档案、系统设置）
    if (session.role === 'teacher') {
      const teacherId = session.linkedId;
      const teacherCourseRows = db.prepare(`
        SELECT DISTINCT id FROM (
          SELECT id FROM courses WHERE org_id = ? AND teacher_id = ?
          UNION
          SELECT course_id AS id FROM course_teachers WHERE org_id = ? AND teacher_id = ?
          UNION
          SELECT course_id AS id FROM lessons WHERE org_id = ? AND teacher_id = ?
        )
      `).all(ORG_ID, teacherId, ORG_ID, teacherId, ORG_ID, teacherId);
      const courseIdList = teacherCourseRows.map(r => r.id);
      const courses = attachCourseTeachers(queryIn(`
        SELECT co.*, COALESCE(t.name, '') AS teacher_name
        FROM courses co
        LEFT JOIN teachers t ON t.id = co.teacher_id
        WHERE co.org_id = ? AND co.id IN
      `, courseIdList, 'ORDER BY co.name', [ORG_ID]));
      const lessons = courseIdList.length
        ? db.prepare(`
            SELECT l.id, l.org_id, l.course_id, l.teacher_id, l.title, l.start_ms, l.end_ms,
                   l.physical_room, l.external_room_url, l.status, l.note,
                   co.name AS course_name, t.name AS teacher_name
            FROM lessons l
            JOIN courses co ON co.id = l.course_id
            JOIN teachers t ON t.id = l.teacher_id
            WHERE l.org_id = ? AND (l.teacher_id = ? OR l.course_id IN (${courseIdList.map(() => '?').join(',')}))
            ORDER BY l.start_ms ASC
          `).all(ORG_ID, teacherId, ...courseIdList)
        : db.prepare(`
            SELECT l.id, l.org_id, l.course_id, l.teacher_id, l.title, l.start_ms, l.end_ms,
                   l.physical_room, l.external_room_url, l.status, l.note,
                   co.name AS course_name, t.name AS teacher_name
            FROM lessons l
            JOIN courses co ON co.id = l.course_id
            JOIN teachers t ON t.id = l.teacher_id
            WHERE l.org_id = ? AND l.teacher_id = ?
            ORDER BY l.start_ms ASC
          `).all(ORG_ID, teacherId);
      const lessonIdList = lessons.map(l => l.id);
      const courseNodes = queryIn(
        'SELECT * FROM course_nodes WHERE org_id = ? AND course_id IN',
        courseIdList,
        'ORDER BY course_id, parent_id, sort_order ASC, created_at ASC',
        [ORG_ID]
      );

      const enrollments = queryIn(`
        SELECT e.*, s.name AS student_name, s.grade AS student_grade, co.name AS course_name
        FROM enrollments e
        JOIN students s ON s.id = e.student_id
        JOIN courses co ON co.id = e.course_id
        WHERE e.org_id = ? AND e.status = 'active' AND e.course_id IN
      `, courseIdList, 'ORDER BY e.updated_at DESC', [ORG_ID]);

      const recordings = queryIn(`
        SELECT r.id, r.org_id, r.lesson_id, r.segment, r.title, r.filename, r.mime_type,
               r.size_bytes, r.duration_sec, r.status, r.created_at,
               l.title AS lesson_title, l.course_id, co.name AS course_name
        FROM recordings r
        JOIN lessons l ON l.id = r.lesson_id
        JOIN courses co ON co.id = l.course_id
        WHERE r.org_id = ? AND r.lesson_id IN
      `, lessonIdList, 'ORDER BY r.created_at DESC, r.segment ASC', [ORG_ID]);

      const vodLessons = queryIn(`
        SELECT v.id, v.org_id, v.course_id, v.chapter_name, v.title, v.sort_order,
               v.filename, v.mime_type, v.size_bytes, v.duration_sec, v.status, v.created_at,
               co.name AS course_name
        FROM vod_lessons v
        JOIN courses co ON co.id = v.course_id
        WHERE v.org_id = ? AND v.course_id IN
      `, courseIdList, 'ORDER BY v.course_id, v.sort_order ASC, v.created_at ASC', [ORG_ID]);

      const courseMaterials = queryIn(`
        SELECT id, org_id, scope, target_id, category, filename, mime_type, size_bytes, created_at
        FROM materials
        WHERE org_id = ? AND scope = 'course' AND target_id IN
      `, courseIdList, '', [ORG_ID]);
      const lessonMaterials = queryIn(`
        SELECT id, org_id, scope, target_id, category, filename, mime_type, size_bytes, created_at
        FROM materials
        WHERE org_id = ? AND scope = 'lesson' AND target_id IN
      `, lessonIdList, '', [ORG_ID]);
      const materials = [...courseMaterials, ...lessonMaterials].sort((a, b) => b.created_at.localeCompare(a.created_at));

      const qaPosts = queryIn(`
        SELECT p.*, co.name AS course_name
        FROM qa_posts p
        JOIN courses co ON co.id = p.course_id
        WHERE p.org_id = ? AND p.course_id IN
      `, courseIdList, 'ORDER BY p.created_ms DESC, p.created_at DESC', [ORG_ID]).map(hydrateQaPost);

      const postIds = qaPosts.map(p => p.id);
      const qaReplies = queryIn(
        'SELECT * FROM qa_replies WHERE org_id = ? AND post_id IN',
        postIds,
        'ORDER BY created_ms ASC, created_at ASC',
        [ORG_ID]
      );
      const qaReadCursors = getQaReadCursors(session.accountId);
      const homeworks = queryIn(`
        SELECT h.*, co.name AS course_name
        FROM homeworks h
        JOIN courses co ON co.id = h.course_id
        WHERE h.org_id = ? AND h.course_id IN
      `, courseIdList, 'ORDER BY h.created_ms DESC, h.created_at DESC', [ORG_ID]).map(hydrateHomework);
      const homeworkSubmissions = queryIn(`
        SELECT hs.*, s.name AS student_name, s.grade AS student_grade
        FROM homework_submissions hs
        JOIN students s ON s.id = hs.student_id
        WHERE hs.org_id = ? AND hs.course_id IN
      `, courseIdList, 'ORDER BY hs.submitted_ms DESC, hs.submitted_at DESC', [ORG_ID]).map(hydrateHomeworkSubmission);

      const attendance = queryIn(
        'SELECT * FROM attendance WHERE org_id = ? AND lesson_id IN',
        lessonIdList,
        '',
        [ORG_ID]
      );

        return {
        authenticated: true,
        currentUser: {
          id: session.accountId,
          username: session.username,
          name: session.name,
          role: session.role,
          linkedId: session.linkedId
        },
        org,
        teachers: [],
        students: [],
        accounts: [],
        followups: [],
        learningRecords: [],
        courses,
        courseNodes,
        enrollments,
        lessons,
        recordings,
        pendingRecordings: listPendingRecordingsForSnapshot(session.linkedId),
        vodLessons,
        playbackProgress: [],
        materials,
        qaPosts,
        qaReplies,
        qaReadCursors,
        homeworks,
        homeworkSubmissions,
        trialGrants: [],
        attendance
      };
    }

    // 学生视角：严格按本人在读课程与有效限时试听资格做服务端数据隔离
    const sid = session.linkedId;
    const activeCourseIds = getStudentActiveCourseIds(sid);
    const trialLessonIds = getStudentActiveTrialLessonIds(sid);
    const trialVodIds = getStudentActiveTrialVodIds(sid);

    const students = db.prepare(
      'SELECT id, org_id, name, grade, phone, status, valid_until, next_followup_date, created_at FROM students WHERE id = ? AND org_id = ?'
    ).all(sid, ORG_ID);
    const enrollments = db.prepare(`
      SELECT e.*, s.name AS student_name, s.grade AS student_grade, co.name AS course_name
      FROM enrollments e
      JOIN students s ON s.id = e.student_id
      JOIN courses co ON co.id = e.course_id
      WHERE e.student_id = ? AND e.org_id = ?
      ORDER BY e.updated_at DESC
    `).all(sid, ORG_ID);
    const activeCourseIdList = [...activeCourseIds];
    const trialLessonIdList = [...trialLessonIds];
    const trialVodIdList = [...trialVodIds];

    const courses = attachCourseTeachers(queryIn(`
      SELECT co.*, COALESCE(t.name, '') AS teacher_name
      FROM courses co
      LEFT JOIN teachers t ON t.id = co.teacher_id
      WHERE co.org_id = ? AND co.id IN
    `, activeCourseIdList, 'ORDER BY co.name', [ORG_ID]));

    let lessons = [];
    if (activeCourseIdList.length && trialLessonIdList.length) {
      lessons = db.prepare(`
        SELECT l.id, l.org_id, l.course_id, l.teacher_id, l.title, l.start_ms, l.end_ms,
               l.physical_room, l.external_room_url, l.status, l.note,
               co.name AS course_name, t.name AS teacher_name
        FROM lessons l
        JOIN courses co ON co.id = l.course_id
        JOIN teachers t ON t.id = l.teacher_id
        WHERE l.org_id = ? AND (l.course_id IN (${activeCourseIdList.map(() => '?').join(',')}) OR l.id IN (${trialLessonIdList.map(() => '?').join(',')}))
        ORDER BY l.start_ms ASC
      `).all(ORG_ID, ...activeCourseIdList, ...trialLessonIdList);
    } else if (activeCourseIdList.length) {
      lessons = queryIn(`
        SELECT l.id, l.org_id, l.course_id, l.teacher_id, l.title, l.start_ms, l.end_ms,
               l.physical_room, l.external_room_url, l.status, l.note,
               co.name AS course_name, t.name AS teacher_name
        FROM lessons l
        JOIN courses co ON co.id = l.course_id
        JOIN teachers t ON t.id = l.teacher_id
        WHERE l.org_id = ? AND l.course_id IN
      `, activeCourseIdList, 'ORDER BY l.start_ms ASC', [ORG_ID]);
    } else if (trialLessonIdList.length) {
      lessons = queryIn(`
        SELECT l.id, l.org_id, l.course_id, l.teacher_id, l.title, l.start_ms, l.end_ms,
               l.physical_room, l.external_room_url, l.status, l.note,
               co.name AS course_name, t.name AS teacher_name
        FROM lessons l
        JOIN courses co ON co.id = l.course_id
        JOIN teachers t ON t.id = l.teacher_id
        WHERE l.org_id = ? AND l.id IN
      `, trialLessonIdList, 'ORDER BY l.start_ms ASC', [ORG_ID]);
    }
    const allowedLessonIds = new Set(lessons.map(l => l.id));
    const allowedLessonIdList = [...allowedLessonIds];

    const recordings = queryIn(`
      SELECT r.id, r.org_id, r.lesson_id, r.segment, r.title, r.filename, r.mime_type,
             r.size_bytes, r.duration_sec, r.status, r.created_at,
             l.title AS lesson_title, l.course_id, co.name AS course_name
      FROM recordings r
      JOIN lessons l ON l.id = r.lesson_id
      JOIN courses co ON co.id = l.course_id
      WHERE r.org_id = ? AND r.status = 'published' AND r.lesson_id IN
    `, allowedLessonIdList, 'ORDER BY r.created_at DESC, r.segment ASC', [ORG_ID]);

    let vodLessons = [];
    if (activeCourseIdList.length && trialVodIdList.length) {
      vodLessons = db.prepare(`
        SELECT v.id, v.org_id, v.course_id, v.chapter_name, v.title, v.sort_order,
               v.filename, v.mime_type, v.size_bytes, v.duration_sec, v.status, v.created_at,
               co.name AS course_name
        FROM vod_lessons v
        JOIN courses co ON co.id = v.course_id
        WHERE v.org_id = ? AND v.status = 'published' AND (v.course_id IN (${activeCourseIdList.map(() => '?').join(',')}) OR v.id IN (${trialVodIdList.map(() => '?').join(',')}))
        ORDER BY v.course_id, v.sort_order ASC, v.created_at ASC
      `).all(ORG_ID, ...activeCourseIdList, ...trialVodIdList);
    } else if (activeCourseIdList.length) {
      vodLessons = queryIn(`
        SELECT v.id, v.org_id, v.course_id, v.chapter_name, v.title, v.sort_order,
               v.filename, v.mime_type, v.size_bytes, v.duration_sec, v.status, v.created_at,
               co.name AS course_name
        FROM vod_lessons v
        JOIN courses co ON co.id = v.course_id
        WHERE v.org_id = ? AND v.status = 'published' AND v.course_id IN
      `, activeCourseIdList, 'ORDER BY v.course_id, v.sort_order ASC, v.created_at ASC', [ORG_ID]);
    } else if (trialVodIdList.length) {
      vodLessons = queryIn(`
        SELECT v.id, v.org_id, v.course_id, v.chapter_name, v.title, v.sort_order,
               v.filename, v.mime_type, v.size_bytes, v.duration_sec, v.status, v.created_at,
               co.name AS course_name
        FROM vod_lessons v
        JOIN courses co ON co.id = v.course_id
        WHERE v.org_id = ? AND v.status = 'published' AND v.id IN
      `, trialVodIdList, 'ORDER BY v.course_id, v.sort_order ASC, v.created_at ASC', [ORG_ID]);
    }
    const allowedVodIds = new Set(vodLessons.map(v => v.id));

    const stuCourseMaterials = queryIn(`
      SELECT id, org_id, scope, target_id, category, filename, mime_type, size_bytes, created_at
      FROM materials
      WHERE org_id = ? AND scope = 'course' AND target_id IN
    `, activeCourseIdList, '', [ORG_ID]);
    const stuLessonMaterials = queryIn(`
      SELECT id, org_id, scope, target_id, category, filename, mime_type, size_bytes, created_at
      FROM materials
      WHERE org_id = ? AND scope = 'lesson' AND target_id IN
    `, allowedLessonIdList, '', [ORG_ID]);
    const materials = [...stuCourseMaterials, ...stuLessonMaterials].sort((a, b) => b.created_at.localeCompare(a.created_at));
    const allowedMaterialIds = new Set(materials.map(m => m.id));

    const courseNodes = queryIn(
      'SELECT * FROM course_nodes WHERE org_id = ? AND course_id IN',
      activeCourseIdList,
      'ORDER BY course_id, parent_id, sort_order ASC, created_at ASC',
      [ORG_ID]
    ).filter(n => {
      if (n.node_type === 'material') return allowedMaterialIds.has(n.ref_id);
      if (n.node_type === 'vod') return allowedVodIds.has(n.ref_id);
      if (n.node_type === 'lesson') return allowedLessonIds.has(n.ref_id);
      return true;
    });

    const qaPosts = queryIn(`
      SELECT p.*, co.name AS course_name
      FROM qa_posts p
      JOIN courses co ON co.id = p.course_id
      WHERE p.org_id = ? AND p.course_id IN
    `, activeCourseIdList, 'ORDER BY p.created_ms DESC, p.created_at DESC', [ORG_ID]).map(hydrateQaPost);
    const allowedPostIdList = qaPosts.map(p => p.id);
    const qaReplies = queryIn(
      'SELECT * FROM qa_replies WHERE org_id = ? AND post_id IN',
      allowedPostIdList,
      'ORDER BY created_ms ASC, created_at ASC',
      [ORG_ID]
    );
    const qaReadCursors = getQaReadCursors(session.accountId);
    const homeworks = queryIn(`
      SELECT h.*, co.name AS course_name
      FROM homeworks h
      JOIN courses co ON co.id = h.course_id
      WHERE h.org_id = ? AND h.course_id IN
    `, activeCourseIdList, 'ORDER BY h.created_ms DESC, h.created_at DESC', [ORG_ID]).map(hydrateHomework);
    const homeworkSubmissions = db.prepare(`
      SELECT hs.*, s.name AS student_name, s.grade AS student_grade
      FROM homework_submissions hs
      JOIN students s ON s.id = hs.student_id
      WHERE hs.student_id = ? AND hs.org_id = ?
      ORDER BY hs.submitted_ms DESC, hs.submitted_at DESC
    `).all(sid, ORG_ID).map(hydrateHomeworkSubmission);

    const learningRecords = db.prepare(
      'SELECT * FROM student_learning_records WHERE student_id = ? AND org_id = ? ORDER BY updated_at DESC'
    ).all(sid, ORG_ID);
    const playbackProgress = db.prepare(
      'SELECT * FROM playback_progress WHERE student_id = ? AND org_id = ?'
    ).all(sid, ORG_ID);
    const trialGrants = db.prepare(
      'SELECT * FROM trial_grants WHERE student_id = ? AND expires_at > ? AND org_id = ?'
    ).all(sid, Date.now(), ORG_ID);
    const attendance = db.prepare(
      'SELECT * FROM attendance WHERE student_id = ? AND org_id = ?'
    ).all(sid, ORG_ID);

      return {
      authenticated: true,
      needsSetup: false,
      currentUser: {
        id: session.accountId,
        username: session.username,
        name: session.name,
        role: session.role,
        linkedId: session.linkedId
      },
      org,
      teachers: [],
      students,
      accounts: [],
      followups: [],
      learningRecords,
      courses,
      courseNodes,
      enrollments,
      lessons,
      recordings,
      pendingRecordings: [],
      vodLessons,
      playbackProgress,
      materials,
      qaPosts,
      qaReplies,
      qaReadCursors,
      homeworks,
      homeworkSubmissions,
      trialGrants,
      attendance
    };
  }

  // --- 机构设置 ---
  function updateOrgSettings({
    name,
    maxOnlineRooms,
    maxOnlineStudents,
    iceServersJson,
    defaultClassCapacity,
    defaultLessonMinutes,
    defaultWatermark,
    defaultStudentDraw,
    deepseekApiKey
  }) {
    const cur = db.prepare('SELECT * FROM org_settings WHERE org_id = ?').get(ORG_ID);
    const cleanName = name !== undefined ? (String(name || '').trim() || '教培工作台') : cur.name;
    const rooms = maxOnlineRooms !== undefined ? Number(maxOnlineRooms) : cur.max_online_rooms;
    const seats = maxOnlineStudents !== undefined ? Number(maxOnlineStudents) : cur.max_online_students;
    if (!Number.isInteger(rooms) || rooms < 1 || !Number.isInteger(seats) || seats < 1) {
      throw new RangeError('并发上限必须为正整数');
    }
    const capacity = defaultClassCapacity !== undefined ? Number(defaultClassCapacity) : (cur.default_class_capacity || 30);
    const minutes = defaultLessonMinutes !== undefined ? Number(defaultLessonMinutes) : (cur.default_lesson_minutes || 180);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 500) {
      throw new RangeError('默认班级容量必须为 1–500 的正整数');
    }
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 600) {
      throw new RangeError('默认单节课时长必须为 15–600 分钟');
    }
    const watermark = defaultWatermark !== undefined ? (defaultWatermark ? 1 : 0) : (cur.default_watermark ?? 1);
    const studentDraw = defaultStudentDraw !== undefined ? (defaultStudentDraw ? 1 : 0) : (cur.default_student_draw ?? 0);

    let cleanIce = cur.ice_servers_json || '';
    if (iceServersJson !== undefined) {
      cleanIce = String(iceServersJson || '').trim();
      if (cleanIce) {
        let parsed;
        try { parsed = JSON.parse(cleanIce); } catch { throw new TypeError('ICE/TURN 服务器配置必须是合法的 JSON 数组'); }
        if (!Array.isArray(parsed)) throw new TypeError('ICE/TURN 服务器配置必须是 JSON 数组，例如 [{"urls":"stun:..."}]');
      }
    }

    const cleanDeepseekKey = deepseekApiKey !== undefined
      ? String(deepseekApiKey || '').trim()
      : String(cur.deepseek_api_key || '').trim();

    db.prepare(`
      UPDATE org_settings
      SET name = ?, max_online_rooms = ?, max_online_students = ?, ice_servers_json = ?,
          default_class_capacity = ?, default_lesson_minutes = ?, default_watermark = ?, default_student_draw = ?,
          deepseek_api_key = ?
      WHERE org_id = ?
    `).run(cleanName, rooms, seats, cleanIce, capacity, minutes, watermark, studentDraw, cleanDeepseekKey, ORG_ID);
  }

  function getOrgLogo() {
    return db.prepare('SELECT logo_stored_name, logo_mime_type FROM org_settings WHERE org_id = ?').get(ORG_ID);
  }

  function updateOrgLogo({ storedName = '', mimeType = '' }) {
    const prev = getOrgLogo();
    db.prepare(
      'UPDATE org_settings SET logo_stored_name = ?, logo_mime_type = ? WHERE org_id = ?'
    ).run(String(storedName || ''), String(mimeType || ''), ORG_ID);
    return prev?.logo_stored_name || '';
  }

  // --- 账号注册与登录校验 ---
  function countActiveAdmins(excludeAccountId = '') {
    const row = db.prepare(
      "SELECT COUNT(*) AS cnt FROM accounts WHERE org_id = ? AND role = 'admin' AND disabled = 0 AND id != ?"
    ).get(ORG_ID, excludeAccountId);
    return Number(row?.cnt || 0);
  }

  function createAccount({ username, password, role, linkedId, name }) {
    const cleanUser = assertValidUsername(username);
    const cleanPass = String(password || '').trim();
    if (cleanPass.length < 4) {
      throw new TypeError('密码至少 4 位');
    }
    if (role !== 'admin' && role !== 'teacher' && role !== 'student') {
      throw new TypeError('账号角色必须为 admin、teacher 或 student');
    }
    const existing = db.prepare('SELECT * FROM accounts WHERE username = ?').get(cleanUser);
    if (existing) {
      const sameOwner = existing.linked_id === linkedId && (
        existing.role === role ||
        (existing.role !== 'student' && role !== 'student')
      );
      if (!sameOwner) {
        const err = new Error(`登录账号「${cleanUser}」已被「${existing.name}」绑定，请更换其他登录账号`);
        err.statusCode = 409;
        throw err;
      }
      db.prepare(
        'UPDATE accounts SET password_hash = ?, name = ?, role = ?, linked_id = ?, disabled = 0 WHERE id = ?'
      ).run(hashPassword(cleanPass), String(name || cleanUser).trim(), role, linkedId, existing.id);
      db.prepare('DELETE FROM sessions WHERE account_id = ? AND org_id = ?').run(existing.id, ORG_ID);
      return existing.id;
    }
    const id = uid('acc');
    db.prepare(`
      INSERT INTO accounts (id, org_id, username, password_hash, name, role, linked_id, disabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(id, ORG_ID, cleanUser, hashPassword(cleanPass), String(name || cleanUser).trim(), role, linkedId, nowStr());
    return id;
  }

  function verifyLogin({ username, password }) {
    const cleanInput = assertValidUsername(username);
    let row = db.prepare('SELECT * FROM accounts WHERE username = ? AND org_id = ?').get(cleanInput, ORG_ID);
    if (!row && /^1\d{10}$/.test(cleanInput)) {
      const phoneMatches = db.prepare(`
        SELECT a.* FROM accounts a
        JOIN students s ON s.id = a.linked_id AND a.role = 'student'
        WHERE s.phone = ? AND a.org_id = ?
        UNION
        SELECT a.* FROM accounts a
        JOIN teachers t ON t.id = a.linked_id AND a.role IN ('teacher', 'admin')
        WHERE t.phone = ? AND a.org_id = ?
      `).all(cleanInput, ORG_ID, cleanInput, ORG_ID);
      if (phoneMatches.length > 1) {
        const err = new Error('该手机号关联了多个账号，请使用各自的用户名登录');
        err.statusCode = 409;
        throw err;
      }
      if (phoneMatches.length === 1) {
        row = phoneMatches[0];
      }
    }
    if (!row || !verifyPassword(password || '', row.password_hash)) {
      const err = new Error('用户名/手机号或密码错误');
      err.statusCode = 401;
      throw err;
    }
    if (row.disabled) {
      const err = new Error('该账号已被停用，请联系管理员');
      err.statusCode = 403;
      throw err;
    }
    if (row.role === 'student') {
      const stu = db.prepare('SELECT valid_until FROM students WHERE id = ? AND org_id = ?').get(row.linked_id, ORG_ID);
      if (stu && isDateExpired(stu.valid_until)) {
        const err = new Error(`该学生账号已超过有效期（${stu.valid_until}），请联系管理员续期`);
        err.statusCode = 403;
        throw err;
      }
    }
    // 旧 SHA-256 密码登录成功后无感升级为带盐 scrypt
    if (isLegacyPasswordHash(row.password_hash)) {
      db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(hashPassword(password || ''), row.id);
    }
    return createSession(row.id);
  }

  function updateOwnProfile(session, { name, phone }) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new TypeError('姓名 / 昵称不能为空');
    if (session.role === 'student') {
      const cleanPhone = assertOptionalPhone(phone);
      db.prepare('UPDATE students SET name = ?, phone = ? WHERE id = ? AND org_id = ?')
        .run(cleanName, cleanPhone, session.linkedId, ORG_ID);
    } else {
      db.prepare('UPDATE teachers SET name = ? WHERE id = ? AND org_id = ?')
        .run(cleanName, session.linkedId, ORG_ID);
    }
    db.prepare('UPDATE accounts SET name = ? WHERE id = ? AND org_id = ?')
      .run(cleanName, session.accountId, ORG_ID);
    db.prepare('UPDATE sessions SET name = ? WHERE account_id = ? AND org_id = ?')
      .run(cleanName, session.accountId, ORG_ID);
  }

  function updateAccount(id, { role, disabled, password }, currentAccountId = '') {
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ? AND org_id = ?').get(id, ORG_ID);
    if (!acc) {
      const err = new Error('账号不存在');
      err.statusCode = 404;
      throw err;
    }
    const nextRole = role !== undefined ? role : acc.role;
    if (nextRole !== 'admin' && nextRole !== 'teacher' && nextRole !== 'student') {
      throw new TypeError('账号角色必须为 admin、teacher 或 student');
    }
    if (acc.role === 'student' && nextRole !== 'student') {
      throw new TypeError('学生账号不能直接修改为教师或管理员');
    }
    if (acc.role !== 'student' && nextRole === 'student') {
      throw new TypeError('教师/管理员账号不能修改为学生');
    }
    const nextDisabled = disabled !== undefined ? (disabled ? 1 : 0) : acc.disabled;
    if (acc.id === currentAccountId && nextDisabled) {
      throw new TypeError('不能停用当前登录账号');
    }
    if (acc.role === 'admin' && (nextRole !== 'admin' || nextDisabled) && countActiveAdmins(acc.id) === 0) {
      throw new TypeError('至少需要保留一个启用状态的管理员账号');
    }

    let nextHash = acc.password_hash;
    let passwordChanged = false;
    if (password !== undefined && String(password).trim() !== '') {
      const cleanPass = String(password).trim();
      if (cleanPass.length < 4) throw new TypeError('密码至少 4 位');
      nextHash = hashPassword(cleanPass);
      passwordChanged = true;
    }

    db.prepare(
      'UPDATE accounts SET role = ?, disabled = ?, password_hash = ? WHERE id = ? AND org_id = ?'
    ).run(nextRole, nextDisabled, nextHash, acc.id, ORG_ID);

    if (nextDisabled || passwordChanged) {
      db.prepare('DELETE FROM sessions WHERE account_id = ? AND org_id = ?').run(acc.id, ORG_ID);
    } else if (nextRole !== acc.role) {
      db.prepare('UPDATE sessions SET role = ? WHERE account_id = ? AND org_id = ?').run(nextRole, acc.id, ORG_ID);
    }
  }

  function changeOwnPassword(accountId, currentToken, { oldPassword, newPassword }) {
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ? AND org_id = ?').get(accountId, ORG_ID);
    if (!acc) {
      const err = new Error('账号不存在');
      err.statusCode = 404;
      throw err;
    }
    if (!verifyPassword(oldPassword || '', acc.password_hash)) {
      const err = new Error('原密码不正确');
      err.statusCode = 400;
      throw err;
    }
    const cleanNew = String(newPassword || '').trim();
    if (cleanNew.length < 4) {
      throw new TypeError('新密码至少 4 位');
    }
    db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ? AND org_id = ?')
      .run(hashPassword(cleanNew), acc.id, ORG_ID);
    // 清理该账号在其他设备上的旧会话，保留当前会话
    db.prepare('DELETE FROM sessions WHERE account_id = ? AND org_id = ? AND token != ?')
      .run(acc.id, ORG_ID, currentToken || '');
  }

  function deleteAccount(id, currentAccountId = '') {
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ? AND org_id = ?').get(id, ORG_ID);
    if (!acc) return;
    if (acc.id === currentAccountId) {
      throw new TypeError('不能删除当前登录账号');
    }
    if (acc.role === 'admin' && countActiveAdmins(acc.id) === 0) {
      throw new TypeError('至少需要保留一个启用状态的管理员账号');
    }
    db.prepare('DELETE FROM accounts WHERE id = ? AND org_id = ?').run(id, ORG_ID);
  }

  // --- 教师管理 ---
  function createTeacher({ name, subject = '', phone = '', password = '', role = 'teacher' }) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new TypeError('教师姓名不能为空');
    const cleanPhone = assertValidPhone(phone);
    const accRole = role === 'admin' ? 'admin' : 'teacher';
    if (password) {
      const conflict = db.prepare('SELECT name FROM accounts WHERE username = ?').get(cleanPhone);
      if (conflict) {
        const err = new Error(`该手机号已被账号「${conflict.name}」使用，请更换手机号`);
        err.statusCode = 409;
        throw err;
      }
    }
    const id = uid('t');
    db.prepare(
      'INSERT INTO teachers (id, org_id, name, subject, phone) VALUES (?, ?, ?, ?, ?)'
    ).run(id, ORG_ID, cleanName, String(subject).trim(), cleanPhone);
    if (password) {
      createAccount({ username: cleanPhone, password, role: accRole, linkedId: id, name: cleanName });
    }
    return id;
  }

  function updateTeacher(id, { name, subject = '', phone = '' }) {
    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ? AND org_id = ?').get(id, ORG_ID);
    if (!teacher) {
      const err = new Error('教师不存在');
      err.statusCode = 404;
      throw err;
    }
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new TypeError('教师姓名不能为空');
    const cleanPhone = assertValidPhone(phone);
    const linkedAcc = db.prepare(
      "SELECT * FROM accounts WHERE linked_id = ? AND role IN ('teacher', 'admin') AND org_id = ?"
    ).get(id, ORG_ID);
    if (linkedAcc && cleanPhone !== linkedAcc.username) {
      const conflict = db.prepare('SELECT name FROM accounts WHERE username = ? AND id != ?').get(cleanPhone, linkedAcc.id);
      if (conflict) {
        const err = new Error(`该手机号已被账号「${conflict.name}」使用，请更换手机号`);
        err.statusCode = 409;
        throw err;
      }
    }
    db.prepare('UPDATE teachers SET name = ?, subject = ?, phone = ? WHERE id = ? AND org_id = ?')
      .run(cleanName, String(subject).trim(), cleanPhone, id, ORG_ID);
    if (linkedAcc) {
      db.prepare('UPDATE accounts SET name = ?, username = ? WHERE id = ? AND org_id = ?')
        .run(cleanName, cleanPhone, linkedAcc.id, ORG_ID);
      db.prepare('UPDATE sessions SET name = ?, username = ? WHERE account_id = ? AND org_id = ?')
        .run(cleanName, cleanPhone, linkedAcc.id, ORG_ID);
    }
  }

  function upsertTeacherAccount(teacherId, { password = '', role = 'teacher' }, currentAccountId = '') {
    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ? AND org_id = ?').get(teacherId, ORG_ID);
    if (!teacher) {
      const err = new Error('教师不存在');
      err.statusCode = 404;
      throw err;
    }
    const cleanRole = role === 'admin' ? 'admin' : 'teacher';
    const existing = db.prepare(
      "SELECT * FROM accounts WHERE linked_id = ? AND role IN ('teacher', 'admin') AND org_id = ?"
    ).get(teacherId, ORG_ID);
    if (existing) {
      updateAccount(existing.id, { role: cleanRole, password: password || undefined, disabled: 0 }, currentAccountId);
      return existing.id;
    }
    const cleanPass = String(password || '').trim();
    if (cleanPass.length < 4) {
      throw new TypeError('首次开通账号请设置至少 4 位密码');
    }
    return createAccount({
      username: teacher.phone,
      password: cleanPass,
      role: cleanRole,
      linkedId: teacher.id,
      name: teacher.name
    });
  }

  function deleteTeacher(id, currentAccountId = '') {
    const usedInCourse = db.prepare('SELECT id FROM courses WHERE teacher_id = ? LIMIT 1').get(id)
      || db.prepare('SELECT course_id FROM course_teachers WHERE teacher_id = ? LIMIT 1').get(id);
    const usedInLesson = db.prepare('SELECT id FROM lessons WHERE teacher_id = ? LIMIT 1').get(id);
    if (usedInCourse || usedInLesson) {
      throw new Error('该教师已关联课程或课次，请先调整关联后再删除');
    }
    const linkedAcc = db.prepare(
      "SELECT * FROM accounts WHERE linked_id = ? AND role IN ('teacher', 'admin') AND org_id = ?"
    ).get(id, ORG_ID);
    if (linkedAcc) {
      if (linkedAcc.id === currentAccountId) {
        throw new TypeError('不能删除当前登录账号对应的教师');
      }
      if (linkedAcc.role === 'admin' && countActiveAdmins(linkedAcc.id) === 0) {
        throw new TypeError('至少需要保留一个启用状态的管理员账号');
      }
      db.prepare('DELETE FROM accounts WHERE id = ? AND org_id = ?').run(linkedAcc.id, ORG_ID);
    }
    db.prepare('DELETE FROM teachers WHERE id = ? AND org_id = ?').run(id, ORG_ID);
  }

  // --- 学生档案、跟进与学情记录 ---
  function syncStudentCourses(studentId, courseIds) {
    if (!Array.isArray(courseIds)) return;
    const desired = new Set(courseIds.map(x => String(x || '').trim()).filter(Boolean));
    const existing = db.prepare('SELECT * FROM enrollments WHERE student_id = ? AND org_id = ?').all(studentId, ORG_ID);
    const existingMap = new Map(existing.map(e => [e.course_id, e]));
    for (const cid of desired) {
      const row = existingMap.get(cid);
      if (!row) {
        enrollStudent({ courseId: cid, studentId });
      } else if (row.status !== 'active') {
        setEnrollmentStatus(row.id, 'active');
      }
    }
    for (const row of existing) {
      if (row.status === 'active' && !desired.has(row.course_id)) {
        setEnrollmentStatus(row.id, 'withdrawn');
      }
    }
  }

  function createStudent({
    name,
    grade = '',
    phone = '',
    status = '意向',
    validUntil = '',
    nextFollowupDate = '',
    note = '',
    password = '',
    loginUsername = '',
    courseIds = []
  }) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new TypeError('学生姓名/昵称不能为空');
    const cleanPhone = assertOptionalPhone(phone);
    const cleanValidUntil = assertOptionalDate(validUntil || nextFollowupDate || '');
    const accUser = String(loginUsername || '').trim() || cleanPhone;
    if (password) {
      if (!accUser) {
        throw new TypeError('设置登录密码时请填写登录用户名或手机号');
      }
      assertValidUsername(accUser);
      const conflict = db.prepare('SELECT name FROM accounts WHERE username = ?').get(accUser);
      if (conflict) {
        const err = new Error(`登录用户名「${accUser}」已被「${conflict.name}」绑定，请更换其他用户名`);
        err.statusCode = 409;
        throw err;
      }
    }
    const id = uid('s');
    const createdAt = nowStr();
    db.prepare(`
      INSERT INTO students (id, org_id, name, grade, phone, status, next_followup_date, valid_until, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      ORG_ID,
      cleanName,
      String(grade).trim(),
      cleanPhone,
      String(status).trim() || '意向',
      cleanValidUntil,
      cleanValidUntil,
      String(note).trim(),
      createdAt
    );
    if (String(note).trim()) {
      addStudentFollowup({ studentId: id, content: `建档备注：${String(note).trim()}` });
    }
    if (password) {
      createAccount({ username: accUser, password, role: 'student', linkedId: id, name: cleanName });
    }
    if (Array.isArray(courseIds) && courseIds.length) {
      syncStudentCourses(id, courseIds);
    }
    return id;
  }

  function updateStudent(id, { name, grade, phone, status, validUntil, nextFollowupDate, note, courseIds }) {
    const cur = db.prepare('SELECT * FROM students WHERE id = ? AND org_id = ?').get(id, ORG_ID);
    if (!cur) {
      const err = new Error('学生不存在');
      err.statusCode = 404;
      throw err;
    }
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new TypeError('学生姓名/昵称不能为空');
    const cleanPhone = assertOptionalPhone(phone);
    const rawValid = validUntil !== undefined ? validUntil : (nextFollowupDate !== undefined ? nextFollowupDate : cur.valid_until);
    const cleanValidUntil = assertOptionalDate(rawValid);
    db.prepare(`
      UPDATE students
      SET name = ?, grade = ?, phone = ?, status = ?, next_followup_date = ?, valid_until = ?, note = ?
      WHERE id = ? AND org_id = ?
    `).run(
      cleanName,
      String(grade ?? cur.grade).trim(),
      cleanPhone,
      String(status || cur.status || '意向').trim(),
      cleanValidUntil,
      cleanValidUntil,
      String(note ?? cur.note).trim(),
      id,
      ORG_ID
    );
    const linkedAcc = db.prepare('SELECT id FROM accounts WHERE linked_id = ? AND role = ? AND org_id = ?').get(id, 'student', ORG_ID);
    if (linkedAcc) {
      db.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(cleanName, linkedAcc.id);
      db.prepare('UPDATE sessions SET name = ? WHERE account_id = ?').run(cleanName, linkedAcc.id);
      if (isDateExpired(cleanValidUntil)) {
        db.prepare('DELETE FROM sessions WHERE account_id = ? AND org_id = ?').run(linkedAcc.id, ORG_ID);
      }
    }
    if (Array.isArray(courseIds)) {
      syncStudentCourses(id, courseIds);
    }
  }

  function addStudentFollowup({ studentId, content }) {
    const cleanContent = String(content || '').trim();
    if (!cleanContent) throw new TypeError('跟进内容不能为空');
    const id = uid('f');
    db.prepare(
      'INSERT INTO student_followups (id, org_id, student_id, content, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, ORG_ID, studentId, cleanContent, nowStr());
    return id;
  }

  function saveLearningRecord({ id = null, studentId, courseId = '', itemTitle, pass1 = '待做', pass2 = '待做', pass3 = '待做', score = '', note = '' }) {
    const cleanTitle = String(itemTitle || '').trim();
    if (!studentId || !cleanTitle) throw new TypeError('学生与题目/作业名称不能为空');
    const updatedAt = nowStr();
    if (id) {
      db.prepare(`
        UPDATE student_learning_records
        SET course_id = ?, item_title = ?, pass1 = ?, pass2 = ?, pass3 = ?, score = ?, note = ?, updated_at = ?
        WHERE id = ? AND org_id = ?
      `).run(courseId, cleanTitle, pass1, pass2, pass3, String(score).trim(), String(note).trim(), updatedAt, id, ORG_ID);
      return id;
    }
    const newId = uid('lr');
    db.prepare(`
      INSERT INTO student_learning_records (id, org_id, student_id, course_id, item_title, pass1, pass2, pass3, score, note, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(newId, ORG_ID, studentId, courseId, cleanTitle, pass1, pass2, pass3, String(score).trim(), String(note).trim(), updatedAt);
    return newId;
  }

  function deleteLearningRecord(id) {
    db.prepare('DELETE FROM student_learning_records WHERE id = ? AND org_id = ?').run(id, ORG_ID);
  }

  function deleteStudent(id) {
    db.prepare('DELETE FROM accounts WHERE linked_id = ? AND role = ?').run(id, 'student');
    db.prepare('DELETE FROM students WHERE id = ? AND org_id = ?').run(id, ORG_ID);
  }

  // --- 课程大纲树节点（章节 / 小节 / 内容） ---
  const VALID_NODE_TYPES = new Set(['folder', 'material', 'vod', 'lesson', 'note']);

  function getCourseNode(id) {
    return db.prepare('SELECT * FROM course_nodes WHERE id = ? AND org_id = ?').get(id, ORG_ID);
  }

  function createCourseNode({ courseId, parentId = '', nodeType = 'folder', title, refId = '', content = '' }) {
    const cleanCourseId = String(courseId || '').trim();
    const cleanParentId = String(parentId || '').trim();
    const cleanType = VALID_NODE_TYPES.has(nodeType) ? nodeType : 'folder';
    const cleanTitle = String(title || '').trim();
    if (!cleanCourseId || !cleanTitle) throw new TypeError('所属课程与节点名称不能为空');
    const courseExists = db.prepare('SELECT id FROM courses WHERE id = ? AND org_id = ?').get(cleanCourseId, ORG_ID);
    if (!courseExists) throw new TypeError('所属课程不存在');
    if (cleanParentId) {
      const parent = getCourseNode(cleanParentId);
      if (!parent || parent.course_id !== cleanCourseId || parent.node_type !== 'folder') {
        throw new TypeError('上级目录不存在或不是目录类型');
      }
    }
    const maxRow = db.prepare(
      'SELECT COALESCE(MAX(sort_order), 0) AS mx FROM course_nodes WHERE org_id = ? AND course_id = ? AND parent_id = ?'
    ).get(ORG_ID, cleanCourseId, cleanParentId);
    const id = uid('cn');
    db.prepare(`
      INSERT INTO course_nodes (id, org_id, course_id, parent_id, node_type, title, ref_id, content, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      ORG_ID,
      cleanCourseId,
      cleanParentId,
      cleanType,
      cleanTitle,
      String(refId || '').trim(),
      String(content || '').trim(),
      Number(maxRow?.mx || 0) + 1,
      nowStr()
    );
    return id;
  }

  function updateCourseNode(id, { title, parentId, nodeType, refId, content }) {
    const cur = getCourseNode(id);
    if (!cur) {
      const err = new Error('大纲节点不存在');
      err.statusCode = 404;
      throw err;
    }
    const cleanTitle = title !== undefined ? String(title || '').trim() : cur.title;
    if (!cleanTitle) throw new TypeError('节点名称不能为空');
    const nextType = nodeType !== undefined && VALID_NODE_TYPES.has(nodeType) ? nodeType : cur.node_type;
    const nextParentId = parentId !== undefined ? String(parentId || '').trim() : cur.parent_id;
    if (nextParentId) {
      if (nextParentId === id) throw new TypeError('不能将目录移动到自身之下');
      const parent = getCourseNode(nextParentId);
      if (!parent || parent.course_id !== cur.course_id || parent.node_type !== 'folder') {
        throw new TypeError('目标上级目录无效');
      }
      // 防止循环嵌套
      let walk = parent;
      while (walk && walk.parent_id) {
        if (walk.parent_id === id) throw new TypeError('不能将目录移动到自己的子目录下');
        walk = getCourseNode(walk.parent_id);
      }
    }
    let nextSort = cur.sort_order;
    if (nextParentId !== cur.parent_id) {
      const maxRow = db.prepare(
        'SELECT COALESCE(MAX(sort_order), 0) AS mx FROM course_nodes WHERE org_id = ? AND course_id = ? AND parent_id = ?'
      ).get(ORG_ID, cur.course_id, nextParentId);
      nextSort = Number(maxRow?.mx || 0) + 1;
    }
    db.prepare(`
      UPDATE course_nodes
      SET title = ?, parent_id = ?, node_type = ?, ref_id = ?, content = ?, sort_order = ?
      WHERE id = ? AND org_id = ?
    `).run(
      cleanTitle,
      nextParentId,
      nextType,
      refId !== undefined ? String(refId || '').trim() : cur.ref_id,
      content !== undefined ? String(content || '').trim() : cur.content,
      nextSort,
      id,
      ORG_ID
    );
  }

  function moveCourseNode(id, direction) {
    const cur = getCourseNode(id);
    if (!cur) {
      const err = new Error('大纲节点不存在');
      err.statusCode = 404;
      throw err;
    }
    const siblings = db.prepare(
      'SELECT id, sort_order FROM course_nodes WHERE org_id = ? AND course_id = ? AND parent_id = ? ORDER BY sort_order ASC, created_at ASC'
    ).all(ORG_ID, cur.course_id, cur.parent_id);
    const idx = siblings.findIndex(s => s.id === id);
    if (idx === -1) return;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= siblings.length) return;
    // 归一化同级 sort_order 后交换
    db.exec('BEGIN');
    try {
      const ordered = siblings.map(s => s.id);
      const tmp = ordered[idx];
      ordered[idx] = ordered[swapIdx];
      ordered[swapIdx] = tmp;
      ordered.forEach((nid, i) => {
        db.prepare('UPDATE course_nodes SET sort_order = ? WHERE id = ? AND org_id = ?').run(i + 1, nid, ORG_ID);
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function reorderCourseNode(id, targetId, position = 'before') {
    const cur = getCourseNode(id);
    const target = getCourseNode(targetId);
    if (!cur || !target) {
      const err = new Error('课程内容节点不存在');
      err.statusCode = 404;
      throw err;
    }
    if (cur.id === target.id) return;
    if (cur.course_id !== target.course_id) {
      throw new TypeError('不能跨课程拖动节点');
    }
    if (!['before', 'after', 'inside'].includes(position)) {
      throw new TypeError('无效的排序位置');
    }
    if (position === 'inside' && target.node_type !== 'folder') {
      throw new TypeError('只能拖入目录节点');
    }

    const nextParentId = position === 'inside' ? target.id : target.parent_id;

    // 防环：不能将节点移动到自身或子孙节点下
    if (nextParentId) {
      let walker = nextParentId;
      while (walker) {
        if (walker === cur.id) {
          throw new TypeError('不能将目录拖动到自身或子目录下');
        }
        const p = getCourseNode(walker);
        walker = p ? p.parent_id : '';
      }
    }

    db.exec('BEGIN');
    try {
      const oldParentId = cur.parent_id;
      if (oldParentId !== nextParentId) {
        db.prepare('UPDATE course_nodes SET parent_id = ? WHERE id = ? AND org_id = ?').run(nextParentId, cur.id, ORG_ID);
      }

      const targetSiblings = db.prepare(
        'SELECT id FROM course_nodes WHERE org_id = ? AND course_id = ? AND parent_id = ? AND id != ? ORDER BY sort_order ASC, created_at ASC'
      ).all(ORG_ID, cur.course_id, nextParentId, cur.id).map(r => r.id);

      let ordered;
      if (position === 'inside') {
        ordered = [...targetSiblings, cur.id];
      } else {
        const tIdx = targetSiblings.indexOf(target.id);
        const insertAt = tIdx === -1 ? targetSiblings.length : (position === 'before' ? tIdx : tIdx + 1);
        ordered = [...targetSiblings.slice(0, insertAt), cur.id, ...targetSiblings.slice(insertAt)];
      }

      ordered.forEach((nid, i) => {
        db.prepare('UPDATE course_nodes SET sort_order = ? WHERE id = ? AND org_id = ?').run(i + 1, nid, ORG_ID);
      });

      if (oldParentId !== nextParentId) {
        const oldSiblings = db.prepare(
          'SELECT id FROM course_nodes WHERE org_id = ? AND course_id = ? AND parent_id = ? ORDER BY sort_order ASC, created_at ASC'
        ).all(ORG_ID, cur.course_id, oldParentId).map(r => r.id);
        oldSiblings.forEach((nid, i) => {
          db.prepare('UPDATE course_nodes SET sort_order = ? WHERE id = ? AND org_id = ?').run(i + 1, nid, ORG_ID);
        });
      }

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function deleteCourseNode(id) {
    const cur = getCourseNode(id);
    if (!cur) return;
    const all = db.prepare('SELECT id, parent_id FROM course_nodes WHERE org_id = ? AND course_id = ?').all(ORG_ID, cur.course_id);
    const toDelete = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of all) {
        if (!toDelete.has(n.id) && toDelete.has(n.parent_id)) {
          toDelete.add(n.id);
          changed = true;
        }
      }
    }
    db.exec('BEGIN');
    try {
      for (const nid of toDelete) {
        db.prepare('DELETE FROM course_nodes WHERE id = ? AND org_id = ?').run(nid, ORG_ID);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function createCourseNodesBatch({ courseId, parentId = '', items = [] }) {
    const cleanCourseId = String(courseId || '').trim();
    const cleanParentId = String(parentId || '').trim();
    if (!cleanCourseId) throw new TypeError('所属课程不能为空');
    const courseExists = db.prepare('SELECT id FROM courses WHERE id = ? AND org_id = ?').get(cleanCourseId, ORG_ID);
    if (!courseExists) throw new TypeError('所属课程不存在');
    if (cleanParentId) {
      const parent = getCourseNode(cleanParentId);
      if (!parent || parent.course_id !== cleanCourseId || parent.node_type !== 'folder') {
        throw new TypeError('上级目录不存在或不是目录类型');
      }
    }
    const list = Array.isArray(items) ? items.filter(it => it && String(it.title || '').trim()) : [];
    if (!list.length) throw new TypeError('请至少选择一项内容');

    const maxRow = db.prepare(
      'SELECT COALESCE(MAX(sort_order), 0) AS mx FROM course_nodes WHERE org_id = ? AND course_id = ? AND parent_id = ?'
    ).get(ORG_ID, cleanCourseId, cleanParentId);
    let sortOrder = Number(maxRow?.mx || 0);
    const ids = [];
    db.exec('BEGIN');
    try {
      const stmt = db.prepare(`
        INSERT INTO course_nodes (id, org_id, course_id, parent_id, node_type, title, ref_id, content, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const it of list) {
        const cleanType = VALID_NODE_TYPES.has(it.nodeType) ? it.nodeType : 'material';
        const cleanTitle = String(it.title || '').trim();
        const id = uid('cn');
        sortOrder += 1;
        stmt.run(id, ORG_ID, cleanCourseId, cleanParentId, cleanType, cleanTitle, String(it.refId || '').trim(), String(it.content || '').trim(), sortOrder, nowStr());
        ids.push(id);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return ids;
  }

  function copyCourseOutline(targetCourseId, sourceCourseId) {
    const targetId = String(targetCourseId || '').trim();
    const sourceId = String(sourceCourseId || '').trim();
    if (!targetId || !sourceId) throw new TypeError('目标课程与来源课程不能为空');
    if (targetId === sourceId) throw new TypeError('不能从当前课程自身复制大纲');
    const targetExists = db.prepare('SELECT id FROM courses WHERE id = ? AND org_id = ?').get(targetId, ORG_ID);
    const sourceExists = db.prepare('SELECT id FROM courses WHERE id = ? AND org_id = ?').get(sourceId, ORG_ID);
    if (!targetExists || !sourceExists) throw new TypeError('课程不存在');

    // 仅复制目录与说明结构（跨课程不引用原课程的私有课次/录播/资料）
    const sourceNodes = db.prepare(
      "SELECT * FROM course_nodes WHERE org_id = ? AND course_id = ? AND node_type IN ('folder', 'note') ORDER BY sort_order ASC, created_at ASC"
    ).all(ORG_ID, sourceId);
    if (!sourceNodes.length) throw new TypeError('来源课程暂无可复制的目录或说明节点');

    const byId = new Map(sourceNodes.map(n => [n.id, n]));
    const childrenMap = new Map();
    for (const n of sourceNodes) {
      const pid = (n.parent_id && byId.has(n.parent_id)) ? n.parent_id : '';
      if (!childrenMap.has(pid)) childrenMap.set(pid, []);
      childrenMap.get(pid).push(n);
    }
    const maxRoot = db.prepare(
      "SELECT COALESCE(MAX(sort_order), 0) AS mx FROM course_nodes WHERE org_id = ? AND course_id = ? AND parent_id = ''"
    ).get(ORG_ID, targetId);
    let rootOrder = Number(maxRoot?.mx || 0);
    let copied = 0;

    db.exec('BEGIN');
    try {
      const stmt = db.prepare(`
        INSERT INTO course_nodes (id, org_id, course_id, parent_id, node_type, title, ref_id, content, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)
      `);
      function cloneBranch(oldParentId, newParentId) {
        const list = childrenMap.get(oldParentId) || [];
        list.forEach((n, idx) => {
          const newId = uid('cn');
          const order = newParentId === '' ? ++rootOrder : idx + 1;
          stmt.run(newId, ORG_ID, targetId, newParentId, n.node_type, n.title, n.content || '', order, nowStr());
          copied += 1;
          if (n.node_type === 'folder') cloneBranch(n.id, newId);
        });
      }
      cloneBranch('', '');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return copied;
  }

  // --- 课程管理（含多选授课教师与可选人数上限） ---
  function normalizeCourseCapacity(raw) {
    if (raw === '' || raw === null || raw === undefined) return null;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1) {
      throw new TypeError('人数上限须为正整数，留空表示不限人数');
    }
    return n;
  }

  function normalizeCourseTeacherIds({ teacherId, teacherIds }) {
    const raw = Array.isArray(teacherIds)
      ? teacherIds
      : (teacherId ? [teacherId] : []);
    return [...new Set(raw.map(x => String(x || '').trim()).filter(Boolean))];
  }

  function createCourse({ name, subject = '', mode = '直播课', description = '', teacherId = '', teacherIds = undefined, capacity = null }) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new TypeError('课程名称不能为空');
    const tIds = normalizeCourseTeacherIds({ teacherId, teacherIds });
    for (const tid of tIds) {
      const t = db.prepare('SELECT id FROM teachers WHERE id = ? AND org_id = ?').get(tid, ORG_ID);
      if (!t) throw new TypeError('所选授课教师不存在');
    }
    const cap = normalizeCourseCapacity(capacity);
    const id = uid('co');
    db.exec('BEGIN');
    try {
      db.prepare(
        'INSERT INTO courses (id, org_id, name, subject, mode, description, teacher_id, capacity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, ORG_ID, cleanName, String(subject || '').trim(), String(mode).trim() || '直播课', String(description).trim(), tIds[0] || '', cap);
      for (const tid of tIds) {
        db.prepare('INSERT OR IGNORE INTO course_teachers (course_id, teacher_id, org_id) VALUES (?, ?, ?)').run(id, tid, ORG_ID);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return id;
  }

  function updateCourse({ id, name, subject = '', mode = '直播课', description = '', teacherId = undefined, teacherIds = undefined, capacity = undefined, syncFutureLessons = false }) {
    const cleanName = String(name || '').trim();
    if (!id || !cleanName) throw new TypeError('课程标识与名称不能为空');
    const existing = db.prepare('SELECT * FROM courses WHERE id = ? AND org_id = ?').get(id, ORG_ID);
    if (!existing) {
      const err = new Error('课程不存在');
      err.statusCode = 404;
      throw err;
    }
    const existingTIds = db.prepare('SELECT teacher_id FROM course_teachers WHERE course_id = ? AND org_id = ?').all(id, ORG_ID).map(r => r.teacher_id);
    const tIdsProvided = teacherIds !== undefined || teacherId !== undefined;
    const tIds = tIdsProvided
      ? normalizeCourseTeacherIds({ teacherId, teacherIds })
      : (existingTIds.length ? existingTIds : (existing.teacher_id ? [existing.teacher_id] : []));
    for (const tid of tIds) {
      const t = db.prepare('SELECT id FROM teachers WHERE id = ? AND org_id = ?').get(tid, ORG_ID);
      if (!t) throw new TypeError('所选授课教师不存在');
    }
    const primaryTeacherId = tIds[0] || '';
    const cap = capacity !== undefined ? normalizeCourseCapacity(capacity) : (existing.capacity ?? null);
    if (cap !== null) {
      const activeCnt = db.prepare(
        "SELECT COUNT(*) AS cnt FROM enrollments WHERE course_id = ? AND status = 'active' AND org_id = ?"
      ).get(id, ORG_ID).cnt;
      if (cap < activeCnt) {
        const err = new Error(`人数上限（${cap}）不能小于当前在读人数（${activeCnt}）`);
        err.statusCode = 409;
        throw err;
      }
    }

    const teacherChanged = Boolean(primaryTeacherId) && primaryTeacherId !== (existing.teacher_id || '');
    let futureLessons = [];
    if (syncFutureLessons && teacherChanged) {
      futureLessons = db.prepare(
        "SELECT * FROM lessons WHERE course_id = ? AND status = 'scheduled' AND org_id = ?"
      ).all(id, ORG_ID);
      if (futureLessons.length > 0) {
        const existingAll = buildScheduleCheckLessons();
        const org = db.prepare('SELECT * FROM org_settings WHERE org_id = ?').get(ORG_ID);
        for (const les of futureLessons) {
          const candidate = {
            orgId: ORG_ID,
            id: les.id,
            teacherId: primaryTeacherId,
            physicalRoomId: les.physical_room || null,
            start: Number(les.start_ms),
            end: Number(les.end_ms),
            studentIds: getCourseActiveStudentIds(id)
          };
          const conflicts = findScheduleConflicts(candidate, existingAll);
          if (conflicts.length > 0) {
            const detail = formatConflictDetails(conflicts, { exceededRooms: false, exceededStudents: false }, existingAll, candidate.physicalRoomId, org);
            const err = new Error(`同步更新课次「${les.title}」的授课教师失败：${detail}`);
            err.statusCode = 409;
            throw err;
          }
          const idx = existingAll.findIndex(x => x.id === les.id);
          if (idx !== -1) existingAll[idx] = { ...existingAll[idx], teacherId: primaryTeacherId };
        }
      }
    }

    db.exec('BEGIN');
    try {
      db.prepare(
        'UPDATE courses SET name = ?, subject = ?, mode = ?, description = ?, teacher_id = ?, capacity = ? WHERE id = ? AND org_id = ?'
      ).run(cleanName, String(subject || '').trim(), String(mode).trim() || '直播课', String(description || '').trim(), primaryTeacherId, cap, id, ORG_ID);
      if (tIdsProvided) {
        db.prepare('DELETE FROM course_teachers WHERE course_id = ? AND org_id = ?').run(id, ORG_ID);
        for (const tid of tIds) {
          db.prepare('INSERT OR IGNORE INTO course_teachers (course_id, teacher_id, org_id) VALUES (?, ?, ?)').run(id, tid, ORG_ID);
        }
      }
      if (syncFutureLessons && teacherChanged && futureLessons.length > 0) {
        db.prepare(
          "UPDATE lessons SET teacher_id = ? WHERE course_id = ? AND status = 'scheduled' AND org_id = ?"
        ).run(primaryTeacherId, id, ORG_ID);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
      return { syncedLessons: syncFutureLessons && teacherChanged ? futureLessons.length : 0 };
  }

  function deleteCourse(id) {
    const lessonIds = db.prepare(
      'SELECT id FROM lessons WHERE course_id = ? AND org_id = ?'
    ).all(id, ORG_ID).map(r => r.id);

    const storedNames = [];
    const vodRows = db.prepare('SELECT id, stored_name FROM vod_lessons WHERE course_id = ? AND org_id = ?').all(id, ORG_ID);
    const vodIds = vodRows.map(r => r.id);
    for (const r of vodRows) if (r.stored_name) storedNames.push(r.stored_name);

    const courseMats = db.prepare("SELECT stored_name FROM materials WHERE scope = 'course' AND target_id = ? AND org_id = ?").all(id, ORG_ID);
    for (const m of courseMats) if (m.stored_name) storedNames.push(m.stored_name);

    const courseQaAtts = db.prepare("SELECT attachments_json FROM qa_posts WHERE course_id = ? AND org_id = ? AND attachments_json != '[]'").all(id, ORG_ID);
    for (const row of courseQaAtts) {
      for (const att of parseJsonSafe(row.attachments_json, [])) {
        if (att && att.storedName) storedNames.push(att.storedName);
      }
    }

    const courseHwAtts = db.prepare("SELECT attachments_json FROM homeworks WHERE course_id = ? AND org_id = ? AND attachments_json != '[]'").all(id, ORG_ID);
    for (const row of courseHwAtts) {
      for (const att of parseJsonSafe(row.attachments_json, [])) {
        if (att && att.storedName) storedNames.push(att.storedName);
      }
    }
    const courseHwSubs = db.prepare('SELECT images_json, graded_images_json FROM homework_submissions WHERE course_id = ? AND org_id = ?').all(id, ORG_ID);
    for (const row of courseHwSubs) {
      for (const img of parseJsonSafe(row.images_json, [])) {
        if (img && img.storedName) storedNames.push(img.storedName);
      }
      for (const img of parseJsonSafe(row.graded_images_json, [])) {
        if (img && img.storedName) storedNames.push(img.storedName);
      }
    }

    const recIds = [];
    for (const lid of lessonIds) {
      const recs = db.prepare('SELECT id, stored_name FROM recordings WHERE lesson_id = ? AND org_id = ?').all(lid, ORG_ID);
      for (const r of recs) {
        recIds.push(r.id);
        if (r.stored_name) storedNames.push(r.stored_name);
      }
      const lesMats = db.prepare("SELECT stored_name FROM materials WHERE scope = 'lesson' AND target_id = ? AND org_id = ?").all(lid, ORG_ID);
      for (const m of lesMats) if (m.stored_name) storedNames.push(m.stored_name);
    }

    db.exec('BEGIN');
    try {
      db.prepare("DELETE FROM materials WHERE scope = 'course' AND target_id = ? AND org_id = ?").run(id, ORG_ID);
      for (const lid of lessonIds) {
        db.prepare("DELETE FROM materials WHERE scope = 'lesson' AND target_id = ? AND org_id = ?").run(lid, ORG_ID);
        db.prepare("DELETE FROM trial_grants WHERE target_type = 'lesson' AND target_id = ? AND org_id = ?").run(lid, ORG_ID);
      }
      for (const rid of recIds) {
        db.prepare("DELETE FROM playback_progress WHERE target_type = 'recording' AND target_id = ? AND org_id = ?").run(rid, ORG_ID);
      }
      for (const vid of vodIds) {
        db.prepare("DELETE FROM playback_progress WHERE target_type = 'vod' AND target_id = ? AND org_id = ?").run(vid, ORG_ID);
        db.prepare("DELETE FROM trial_grants WHERE target_type = 'vod' AND target_id = ? AND org_id = ?").run(vid, ORG_ID);
      }
      db.prepare('DELETE FROM courses WHERE id = ? AND org_id = ?').run(id, ORG_ID);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return storedNames;
  }

  // --- 课程报名、退课与转课 ---
  function assertStudentsCanJoinCourse(courseId, newStudentIds, { ignoreCourseId = null } = {}) {
    const course = db.prepare('SELECT * FROM courses WHERE id = ? AND org_id = ?').get(courseId, ORG_ID);
    if (!course) {
      const err = new Error('课程不存在');
      err.statusCode = 404;
      throw err;
    }
    const curActive = getCourseActiveStudentIds(courseId);
    const curSet = new Set(curActive);
    const toAdd = [...new Set(newStudentIds)].filter(sid => !curSet.has(sid));
    if (course.capacity != null && course.capacity > 0 && curActive.length + toAdd.length > course.capacity) {
      const remain = Math.max(0, course.capacity - curActive.length);
      const err = new Error(`课程「${course.name}」人数已达上限（当前 ${curActive.length}/${course.capacity} 人，剩余名额 ${remain} 人）`);
      err.statusCode = 409;
      throw err;
    }

    const scheduledLessons = db.prepare(
      "SELECT * FROM lessons WHERE course_id = ? AND status = 'scheduled' AND org_id = ?"
    ).all(courseId, ORG_ID);
    if (!scheduledLessons.length || !toAdd.length) return course;

    const org = db.prepare('SELECT * FROM org_settings WHERE org_id = ?').get(ORG_ID);
    const allLessons = buildScheduleCheckLessons().map(les => {
      if (ignoreCourseId && les.studentIds.length) {
        const lesRow = db.prepare('SELECT course_id FROM lessons WHERE id = ?').get(les.id);
        if (lesRow?.course_id === ignoreCourseId) {
          const ignoreSet = new Set(toAdd);
            return { ...les, studentIds: les.studentIds.filter(sid => !ignoreSet.has(sid)) };
        }
      }
      return les;
    });

    const nextStudents = [...curActive, ...toAdd];
    for (const les of scheduledLessons) {
      const candidate = {
        orgId: ORG_ID,
        id: les.id,
        teacherId: les.teacher_id,
        physicalRoomId: les.physical_room || null,
        start: Number(les.start_ms),
        end: Number(les.end_ms),
        studentIds: nextStudents
      };
      const conflicts = findScheduleConflicts(candidate, allLessons).filter(c => c.studentIds.some(sid => toAdd.includes(sid)));
      const concurrency = checkOnlineConcurrency(candidate, allLessons, {
        maxRooms: org.max_online_rooms,
        maxStudents: org.max_online_students
      });
      if (conflicts.length > 0 || concurrency.exceededStudents) {
        const detail = formatConflictDetails(
          conflicts,
          { exceededRooms: false, exceededStudents: concurrency.exceededStudents, peakStudents: concurrency.peakStudents },
          allLessons,
          candidate.physicalRoomId,
          org
        );
        const err = new Error(`无法加入课程，课次「${les.title}」存在冲突：${detail}`);
        err.statusCode = 409;
        throw err;
      }
    }
    return course;
  }

  function enrollStudent({ courseId, studentId }) {
    if (!courseId || !studentId) throw new TypeError('请选择课程和学生');
    const existing = db.prepare(
      'SELECT id, status FROM enrollments WHERE course_id = ? AND student_id = ? AND org_id = ?'
    ).get(courseId, studentId, ORG_ID);

    if (existing && existing.status === 'active') {
      const err = new Error('该学生已在该课程在读，无需重复报名');
      err.statusCode = 409;
      throw err;
    }

    const course = assertStudentsCanJoinCourse(courseId, [studentId]);
    const updatedAt = nowStr();
    if (existing) {
      db.prepare('UPDATE enrollments SET status = ?, updated_at = ? WHERE id = ?').run('active', updatedAt, existing.id);
    } else {
      db.prepare(
        'INSERT INTO enrollments (id, org_id, course_id, student_id, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(uid('en'), ORG_ID, courseId, studentId, 'active', updatedAt);
    }
    db.prepare('UPDATE students SET status = ? WHERE id = ? AND org_id = ?').run('在读', studentId, ORG_ID);
    addStudentFollowup({ studentId, content: `报名加入课程「${course.name}」（状态：在读）` });
  }

  function enrollStudentsBatch({ courseId, studentIds = [] }) {
    if (!courseId || !Array.isArray(studentIds) || !studentIds.length) {
      throw new TypeError('请选择课程和至少一名学生');
    }
    const uniqueIds = [...new Set(studentIds.filter(Boolean))];
    const curSet = new Set(getCourseActiveStudentIds(courseId));
    const toAdd = uniqueIds.filter(sid => !curSet.has(sid));
    const skipped = uniqueIds.length - toAdd.length;
    if (!toAdd.length) {
      const err = new Error('所选学生均已在该课程在读');
      err.statusCode = 409;
      throw err;
    }

    const course = assertStudentsCanJoinCourse(courseId, toAdd);
    const updatedAt = nowStr();
    db.exec('BEGIN');
    try {
      for (const studentId of toAdd) {
        const existing = db.prepare(
          'SELECT id FROM enrollments WHERE course_id = ? AND student_id = ? AND org_id = ?'
        ).get(courseId, studentId, ORG_ID);
        if (existing) {
          db.prepare('UPDATE enrollments SET status = ?, updated_at = ? WHERE id = ?').run('active', updatedAt, existing.id);
        } else {
          db.prepare(
            'INSERT INTO enrollments (id, org_id, course_id, student_id, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(uid('en'), ORG_ID, courseId, studentId, 'active', updatedAt);
        }
        db.prepare('UPDATE students SET status = ? WHERE id = ? AND org_id = ?').run('在读', studentId, ORG_ID);
        addStudentFollowup({ studentId, content: `报名加入课程「${course.name}」（状态：在读）` });
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
      return { added: toAdd.length, skipped };
  }

  function setEnrollmentStatus(enrollmentId, status) {
    if (status !== 'active' && status !== 'withdrawn') throw new TypeError('状态无效');
    const row = db.prepare('SELECT * FROM enrollments WHERE id = ? AND org_id = ?').get(enrollmentId, ORG_ID);
    if (!row) throw new Error('报名记录不存在');
    if (row.status === status) return;
    if (status === 'active') {
      assertStudentsCanJoinCourse(row.course_id, [row.student_id]);
    }
    db.prepare('UPDATE enrollments SET status = ?, updated_at = ? WHERE id = ?').run(status, nowStr(), enrollmentId);

    const course = db.prepare('SELECT name FROM courses WHERE id = ?').get(row.course_id);
    addStudentFollowup({
      studentId: row.student_id,
      content: `课程「${course?.name || row.course_id}」状态变更为：${status === 'active' ? '在读' : '已退课'}`
    });

    const activeCount = db.prepare(
      "SELECT COUNT(*) AS cnt FROM enrollments WHERE student_id = ? AND status = 'active' AND org_id = ?"
    ).get(row.student_id, ORG_ID).cnt;
    db.prepare('UPDATE students SET status = ? WHERE id = ? AND org_id = ?').run(
      activeCount > 0 ? '在读' : '已退课',
      row.student_id,
      ORG_ID
    );
  }

  function transferEnrollment({ enrollmentId, targetCourseId }) {
    if (!enrollmentId || !targetCourseId) throw new TypeError('缺少报名记录或目标课程');
    const row = db.prepare('SELECT * FROM enrollments WHERE id = ? AND org_id = ?').get(enrollmentId, ORG_ID);
    if (!row) {
      const err = new Error('报名记录不存在');
      err.statusCode = 404;
      throw err;
    }
    if (row.course_id === targetCourseId) {
      const err = new Error('目标课程不能与原课程相同');
      err.statusCode = 400;
      throw err;
    }
    const existingTarget = db.prepare(
      'SELECT id, status FROM enrollments WHERE course_id = ? AND student_id = ? AND org_id = ?'
    ).get(targetCourseId, row.student_id, ORG_ID);
    if (existingTarget && existingTarget.status === 'active') {
      const err = new Error('该学生已在目标课程在读');
      err.statusCode = 409;
      throw err;
    }

    const fromCourse = db.prepare('SELECT name FROM courses WHERE id = ?').get(row.course_id);
    const toCourse = assertStudentsCanJoinCourse(targetCourseId, [row.student_id], { ignoreCourseId: row.course_id });
    const updatedAt = nowStr();

    db.exec('BEGIN');
    try {
      db.prepare('UPDATE enrollments SET status = ?, updated_at = ? WHERE id = ?').run('withdrawn', updatedAt, row.id);
      if (existingTarget) {
        db.prepare('UPDATE enrollments SET status = ?, updated_at = ? WHERE id = ?').run('active', updatedAt, existingTarget.id);
      } else {
        db.prepare(
          'INSERT INTO enrollments (id, org_id, course_id, student_id, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(uid('en'), ORG_ID, targetCourseId, row.student_id, 'active', updatedAt);
      }
      db.prepare('UPDATE students SET status = ? WHERE id = ? AND org_id = ?').run('在读', row.student_id, ORG_ID);
      addStudentFollowup({
        studentId: row.student_id,
        content: `转课：从「${fromCourse?.name || row.course_id}」转入「${toCourse.name}」`
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // --- 排课与冲突校验 ---
  function getCourseActiveStudentIds(courseId) {
    return db.prepare(
      "SELECT student_id FROM enrollments WHERE course_id = ? AND status = 'active' AND org_id = ?"
    ).all(courseId, ORG_ID).map(r => r.student_id);
  }

  function buildScheduleCheckLessons() {
    const rows = db.prepare(
      "SELECT * FROM lessons WHERE org_id = ? AND status != 'cancelled'"
    ).all(ORG_ID);
    const activeEnrollments = db.prepare(
      "SELECT course_id, student_id FROM enrollments WHERE status = 'active' AND org_id = ?"
    ).all(ORG_ID);
    const byCourse = new Map();
    for (const en of activeEnrollments) {
      let arr = byCourse.get(en.course_id);
      if (!arr) {
        arr = [];
        byCourse.set(en.course_id, arr);
      }
      arr.push(en.student_id);
    }
    return rows.map(r => ({
      orgId: r.org_id,
      id: r.id,
      teacherId: r.teacher_id,
      physicalRoomId: r.physical_room || null,
      start: Number(r.start_ms),
      end: Number(r.end_ms),
      studentIds: byCourse.get(r.course_id) || [],
      title: r.title
    }));
  }

  function formatConflictDetails(conflicts, concurrency, existing, room, org) {
    const details = [];
    const studentNameCache = new Map();
    const getStudentName = (sid) => {
      if (!studentNameCache.has(sid)) {
        const s = db.prepare('SELECT name FROM students WHERE id = ?').get(sid);
        studentNameCache.set(sid, s?.name || sid);
      }
      return studentNameCache.get(sid);
    };
    for (const c of conflicts) {
      const target = existing.find(x => x.id === c.lessonId);
      const reasons = [];
      if (c.teacher) reasons.push('授课教师时间重叠');
      if (c.room) reasons.push(`物理教室（${room}）被占用`);
      if (c.studentIds.length) {
        const names = c.studentIds.map(getStudentName);
        reasons.push(`在读学生时间冲突（${names.join('、')}）`);
      }
      details.push(`与课次「${target?.title || c.lessonId}」冲突：${reasons.join('，')}`);
    }
    if (concurrency.exceededRooms) {
      details.push(`线上课堂并发达 ${concurrency.peakRooms} 间，超过机构套餐上限（${org.max_online_rooms} 间）`);
    }
    if (concurrency.exceededStudents) {
      details.push(`线上同时在线学生达 ${concurrency.peakStudents} 人，超过套餐席位上限（${org.max_online_students} 人）`);
    }
    return details.join('；');
  }

  function saveLesson({ id = null, courseId, teacherId, title, startMs, endMs, physicalRoom = null, externalRoomUrl = '', status = 'scheduled', note = '' }) {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle || !courseId || !teacherId) throw new TypeError('课次标题、所属课程与授课教师不能为空');
    const lessonId = id || uid('les');
    const room = physicalRoom && String(physicalRoom).trim() ? String(physicalRoom).trim() : null;
    const extUrl = String(externalRoomUrl || '').trim();

    const candidate = {
      orgId: ORG_ID,
      id: lessonId,
      teacherId,
      physicalRoomId: room,
      start: Number(startMs),
      end: Number(endMs),
      studentIds: getCourseActiveStudentIds(courseId)
    };

    const existing = buildScheduleCheckLessons();
    if (status !== 'cancelled') {
      const conflicts = findScheduleConflicts(candidate, existing);
      const org = db.prepare('SELECT * FROM org_settings WHERE org_id = ?').get(ORG_ID);
      const concurrency = checkOnlineConcurrency(candidate, existing, {
        maxRooms: org.max_online_rooms,
        maxStudents: org.max_online_students
      });

      if (conflicts.length > 0 || concurrency.exceededRooms || concurrency.exceededStudents) {
        const err = new Error(formatConflictDetails(conflicts, concurrency, existing, room, org));
        err.statusCode = 409;
        throw err;
      }
    }

    if (id) {
      db.prepare(`
        UPDATE lessons
        SET course_id = ?, teacher_id = ?, title = ?, start_ms = ?, end_ms = ?, physical_room = ?, external_room_url = ?, status = ?, note = ?
        WHERE id = ? AND org_id = ?
      `).run(courseId, teacherId, cleanTitle, Number(startMs), Number(endMs), room, extUrl, status, String(note).trim(), id, ORG_ID);
    } else {
      db.prepare(`
        INSERT INTO lessons (id, org_id, course_id, teacher_id, title, start_ms, end_ms, physical_room, external_room_url, status, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(lessonId, ORG_ID, courseId, teacherId, cleanTitle, Number(startMs), Number(endMs), room, extUrl, status, String(note).trim());
    }
    return lessonId;
  }

  function updateLessonStatus(id, status) {
    if (!['scheduled', 'in_progress', 'completed', 'cancelled'].includes(status)) {
      throw new TypeError('课次状态无效');
    }
    db.prepare('UPDATE lessons SET status = ? WHERE id = ? AND org_id = ?').run(status, id, ORG_ID);
  }

  function updateLessonNote(id, note) {
    db.prepare('UPDATE lessons SET note = ? WHERE id = ? AND org_id = ?').run(String(note || '').trim(), id, ORG_ID);
  }

  function normalizeWhiteboardData(raw) {
    if (Array.isArray(raw)) {
        return { pages: [{ strokes: raw, bgUrl: '' }], currentPage: 0 };
    }
    if (raw && Array.isArray(raw.pages) && raw.pages.length > 0) {
      const pages = raw.pages.map(p => ({
        strokes: Array.isArray(p?.strokes) ? p.strokes : [],
        bgUrl: typeof p?.bgUrl === 'string' ? p.bgUrl : ''
      }));
      const idx = Number.isInteger(raw.currentPage) ? Math.max(0, Math.min(pages.length - 1, raw.currentPage)) : 0;
        return { pages, currentPage: idx };
    }
      return { pages: [{ strokes: [], bgUrl: '' }], currentPage: 0 };
  }

  function getLessonWhiteboard(id) {
    const row = db.prepare('SELECT whiteboard_json FROM lessons WHERE id = ? AND org_id = ?').get(id, ORG_ID);
    if (!row) return normalizeWhiteboardData(null);
    try { return normalizeWhiteboardData(JSON.parse(row.whiteboard_json || '[]')); } catch { return normalizeWhiteboardData(null); }
  }

  function saveLessonWhiteboard(id, data) {
    const normalized = normalizeWhiteboardData(data);
    db.prepare('UPDATE lessons SET whiteboard_json = ? WHERE id = ? AND org_id = ?').run(
      JSON.stringify(normalized),
      id,
      ORG_ID
    );
  }

  function listClassroomMessages(lessonId, limit = 100) {
    const rows = db.prepare(`
      SELECT id, user_name, user_role, text, time_label, created_ms
      FROM classroom_messages
      WHERE org_id = ? AND lesson_id = ?
      ORDER BY created_ms DESC
      LIMIT ?
    `).all(ORG_ID, lessonId, Math.max(1, Math.min(200, Number(limit) || 100)));
    return rows.reverse().map(r => ({
      id: r.id,
      name: r.user_name,
      role: r.user_role,
      text: r.text,
      time: r.time_label
    }));
  }

  function addClassroomMessage(lessonId, msg) {
    const id = msg.id || uid('cmsg');
    const createdMs = Date.now();
    db.prepare(`
      INSERT INTO classroom_messages (id, org_id, lesson_id, user_name, user_role, text, time_label, created_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, ORG_ID, lessonId, String(msg.name || ''), String(msg.role || 'student'), String(msg.text || ''), String(msg.time || ''), createdMs);
      return { id, name: msg.name, role: msg.role, text: msg.text, time: msg.time };
  }

  function deleteLesson(id) {
    const storedNames = [];
    const recs = db.prepare('SELECT id, stored_name FROM recordings WHERE lesson_id = ? AND org_id = ?').all(id, ORG_ID);
    for (const r of recs) if (r.stored_name) storedNames.push(r.stored_name);
    const mats = db.prepare("SELECT stored_name FROM materials WHERE scope = 'lesson' AND target_id = ? AND org_id = ?").all(id, ORG_ID);
    for (const m of mats) if (m.stored_name) storedNames.push(m.stored_name);

    db.exec('BEGIN');
    try {
      const lesMatIds = db.prepare("SELECT id FROM materials WHERE scope = 'lesson' AND target_id = ? AND org_id = ?").all(id, ORG_ID).map(r => r.id);
      for (const mid of lesMatIds) {
        db.prepare("DELETE FROM course_nodes WHERE org_id = ? AND node_type = 'material' AND ref_id = ?").run(ORG_ID, mid);
      }
      db.prepare("DELETE FROM course_nodes WHERE org_id = ? AND node_type = 'lesson' AND ref_id = ?").run(ORG_ID, id);
      db.prepare("DELETE FROM materials WHERE scope = 'lesson' AND target_id = ? AND org_id = ?").run(id, ORG_ID);
      db.prepare("DELETE FROM classroom_messages WHERE lesson_id = ? AND org_id = ?").run(id, ORG_ID);
      db.prepare("DELETE FROM trial_grants WHERE target_type = 'lesson' AND target_id = ? AND org_id = ?").run(id, ORG_ID);
      for (const r of recs) {
        db.prepare("DELETE FROM playback_progress WHERE target_type = 'recording' AND target_id = ? AND org_id = ?").run(r.id, ORG_ID);
      }
      db.prepare('DELETE FROM lessons WHERE id = ? AND org_id = ?').run(id, ORG_ID);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return storedNames;
  }

  // --- 直播回放与纯录播课 ---
  function createRecording({ id = null, lessonId, title, filename, storedName, mimeType, sizeBytes, durationSec = 0, status = 'pending_review' }) {
    if (!lessonId || !storedName) throw new TypeError('回放缺少关联课次或文件');
    const segRow = db.prepare('SELECT COALESCE(MAX(segment), 0) + 1 AS next_seg FROM recordings WHERE lesson_id = ?').get(lessonId);
    const segment = segRow ? segRow.next_seg : 1;
    const recId = id || uid('rec');
    const cleanTitle = String(title || '').trim() || `第 ${segment} 段回放`;
    db.prepare(`
      INSERT INTO recordings (id, org_id, lesson_id, segment, title, filename, stored_name, mime_type, size_bytes, duration_sec, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(recId, ORG_ID, lessonId, segment, cleanTitle, filename, storedName, mimeType || 'video/webm', Number(sizeBytes) || 0, Number(durationSec) || 0, status, nowStr());
    return recId;
  }

  function getRecording(id) {
    return db.prepare('SELECT * FROM recordings WHERE id = ? AND org_id = ?').get(id, ORG_ID);
  }

  function updateRecordingStatus(id, status) {
    if (!['pending_review', 'published', 'withdrawn'].includes(status)) throw new TypeError('回放状态无效');
    db.prepare('UPDATE recordings SET status = ? WHERE id = ? AND org_id = ?').run(status, id, ORG_ID);
  }

  function updateRecording(id, { title, status } = {}) {
    const row = getRecording(id);
    if (!row) {
      const err = new Error('回放不存在');
      err.statusCode = 404;
      throw err;
    }
    const nextTitle = title !== undefined ? String(title).trim() : row.title;
    if (!nextTitle) throw new TypeError('回放标题不能为空');
    const nextStatus = status !== undefined ? status : row.status;
    if (!['pending_review', 'published', 'withdrawn'].includes(nextStatus)) throw new TypeError('回放状态无效');
    db.prepare('UPDATE recordings SET title = ?, status = ? WHERE id = ? AND org_id = ?').run(nextTitle, nextStatus, id, ORG_ID);
  }

  function deleteRecording(id) {
    const row = getRecording(id);
    if (row) db.prepare('DELETE FROM recordings WHERE id = ? AND org_id = ?').run(id, ORG_ID);
    return row;
  }

  function createVodLesson({ courseId, chapterName, title, sortOrder = 1, filename, storedName, mimeType, sizeBytes, durationSec = 0 }) {
    if (!courseId || !title || !storedName) throw new TypeError('录播课参数不完整');
    const id = uid('vod');
    db.prepare(`
      INSERT INTO vod_lessons (id, org_id, course_id, chapter_name, title, sort_order, filename, stored_name, mime_type, size_bytes, duration_sec, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)
    `).run(
      id,
      ORG_ID,
      courseId,
      String(chapterName || '第一章').trim(),
      String(title).trim(),
      Number(sortOrder) || 1,
      filename,
      storedName,
      mimeType || 'video/mp4',
      Number(sizeBytes) || 0,
      Number(durationSec) || 0,
      nowStr()
    );
    return id;
  }

  function getVodLesson(id) {
    return db.prepare('SELECT * FROM vod_lessons WHERE id = ? AND org_id = ?').get(id, ORG_ID);
  }

  function updateVodLesson(id, { chapterName, title, sortOrder, status } = {}) {
    const row = getVodLesson(id);
    if (!row) {
      const err = new Error('录播课不存在');
      err.statusCode = 404;
      throw err;
    }
    const nextChapter = chapterName !== undefined ? String(chapterName).trim() : row.chapter_name;
    const nextTitle = title !== undefined ? String(title).trim() : row.title;
    const nextSort = sortOrder !== undefined ? (Number(sortOrder) || 1) : row.sort_order;
    const nextStatus = status !== undefined ? status : row.status;
    if (!nextChapter || !nextTitle) throw new TypeError('章节与小节标题不能为空');
    if (!['published', 'withdrawn'].includes(nextStatus)) throw new TypeError('录播状态无效');
    db.prepare(
      'UPDATE vod_lessons SET chapter_name = ?, title = ?, sort_order = ?, status = ? WHERE id = ? AND org_id = ?'
    ).run(nextChapter, nextTitle, nextSort, nextStatus, id, ORG_ID);
  }

  function deleteVodLesson(id) {
    const row = getVodLesson(id);
    if (row) {
      db.prepare("DELETE FROM course_nodes WHERE org_id = ? AND node_type = 'vod' AND ref_id = ?").run(ORG_ID, id);
      db.prepare('DELETE FROM vod_lessons WHERE id = ? AND org_id = ?').run(id, ORG_ID);
    }
    return row;
  }

  function mergeRanges(ranges) {
    const valid = ranges
      .filter(r => Array.isArray(r) && r.length === 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] > r[0])
      .map(([a, b]) => [Math.max(0, a), Math.max(0, b)])
      .sort((a, b) => a[0] - b[0]);
    if (!valid.length) return [];
    const merged = [valid[0]];
    for (let i = 1; i < valid.length; i++) {
      const prev = merged[merged.length - 1];
      const cur = valid[i];
      if (cur[0] <= prev[1] + 0.5) {
        prev[1] = Math.max(prev[1], cur[1]);
      } else {
        merged.push(cur);
      }
    }
    return merged;
  }

  function savePlaybackProgress({ studentId, targetType, targetId, positionSec, durationSec = 0, watchedRange = null, watchedRanges = null }) {
    if (!studentId || !targetType || !targetId) throw new TypeError('播放进度参数不完整');
    const pos = Math.max(0, Number(positionSec) || 0);
    const dur = Math.max(0, Number(durationSec) || 0);
    const existing = db.prepare(
      'SELECT * FROM playback_progress WHERE student_id = ? AND target_type = ? AND target_id = ? AND org_id = ?'
    ).get(studentId, targetType, targetId, ORG_ID);

    let ranges = [];
    if (existing?.watched_ranges_json) {
      try { ranges = JSON.parse(existing.watched_ranges_json); } catch {}
    }
    if (Array.isArray(watchedRange) && watchedRange.length === 2 && watchedRange[1] > watchedRange[0]) {
      ranges.push([Number(watchedRange[0]), Number(watchedRange[1])]);
    }
    if (Array.isArray(watchedRanges)) {
      for (const r of watchedRanges) {
        if (Array.isArray(r) && r.length === 2 && Number(r[1]) > Number(r[0])) {
          ranges.push([Number(r[0]), Number(r[1])]);
        }
      }
    }
    const merged = mergeRanges(ranges);
    const watchedSec = Number(merged.reduce((sum, [a, b]) => sum + (b - a), 0).toFixed(1));
    const effectiveDur = dur || existing?.duration_sec || 0;
    const completed = effectiveDur > 0 && watchedSec >= effectiveDur * 0.9 ? 1 : (existing?.completed || 0);
    const updatedAt = nowStr();

    if (existing) {
      db.prepare(`
        UPDATE playback_progress
        SET last_position_sec = ?, watched_sec = ?, watched_ranges_json = ?, duration_sec = ?, completed = ?, updated_at = ?
        WHERE id = ?
      `).run(pos, watchedSec, JSON.stringify(merged), effectiveDur, completed, updatedAt, existing.id);
      return db.prepare('SELECT * FROM playback_progress WHERE id = ?').get(existing.id);
    } else {
      const id = uid('pp');
      db.prepare(`
        INSERT INTO playback_progress (id, org_id, student_id, target_type, target_id, last_position_sec, watched_sec, watched_ranges_json, duration_sec, completed, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, ORG_ID, studentId, targetType, targetId, pos, watchedSec, JSON.stringify(merged), effectiveDur, completed, updatedAt);
      return db.prepare('SELECT * FROM playback_progress WHERE id = ?').get(id);
    }
  }

  function getPlaybackProgressForUser(session) {
    if (!session) return [];
    if (session.role === 'student') {
      return db.prepare('SELECT * FROM playback_progress WHERE student_id = ? AND org_id = ?').all(session.linkedId, ORG_ID);
    }
    return db.prepare('SELECT * FROM playback_progress WHERE org_id = ?').all(ORG_ID);
  }

  // --- 讲义与资料文件 ---
  function assertMaterialTargetExists(scope, targetId) {
    if (scope !== 'course' && scope !== 'lesson') {
      throw new TypeError('资料归属类型必须为 course 或 lesson');
    }
    const table = scope === 'course' ? 'courses' : 'lessons';
    const row = db.prepare(`SELECT id FROM ${table} WHERE id = ? AND org_id = ?`).get(targetId, ORG_ID);
    if (!row) {
      const err = new Error(scope === 'course' ? '关联课程不存在' : '关联课次不存在');
      err.statusCode = 404;
      throw err;
    }
  }

  function createMaterial({ scope, targetId, category, filename, storedName, mimeType, sizeBytes }) {
    if (!scope || !targetId || !filename || !storedName) throw new TypeError('资料参数不完整');
    assertMaterialTargetExists(scope, targetId);
    const id = uid('mat');
    db.prepare(`
      INSERT INTO materials (id, org_id, scope, target_id, category, filename, stored_name, mime_type, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, ORG_ID, scope, targetId, category || '课前讲义', filename, storedName, mimeType || 'application/octet-stream', Number(sizeBytes) || 0, nowStr());
    return id;
  }

  function getMaterial(id) {
    return db.prepare('SELECT * FROM materials WHERE id = ? AND org_id = ?').get(id, ORG_ID);
  }

  function updateMaterial({ id, category, filename }) {
    const existing = getMaterial(id);
    if (!existing) {
      const err = new Error('资料不存在');
      err.statusCode = 404;
      throw err;
    }
    const nextCat = String(category ?? existing.category).trim() || existing.category;
    const nextName = String(filename ?? existing.filename).trim() || existing.filename;
    db.prepare('UPDATE materials SET category = ?, filename = ? WHERE id = ? AND org_id = ?')
      .run(nextCat, nextName, id, ORG_ID);
  }

  function deleteMaterial(id) {
    const row = getMaterial(id);
    if (row) {
      db.prepare("DELETE FROM course_nodes WHERE org_id = ? AND node_type = 'material' AND ref_id = ?").run(ORG_ID, id);
      db.prepare('DELETE FROM materials WHERE id = ? AND org_id = ?').run(id, ORG_ID);
    }
    return row;
  }

  // --- 课程群 ---
  function createQaPost({
    courseId,
    lessonId = '',
    authorName,
    authorRole,
    authorId,
    refTag = '',
    title = '',
    content = '',
    msgType = '',
    pinned = false,
    replyToId = '',
    mentions = [],
    attachments = [],
    card = null
  }) {
    const cleanContent = String(content || '').trim();
    const safeAtts = Array.isArray(attachments)
      ? attachments
          .filter(a => a && a.storedName && a.filename)
          .slice(0, 9)
          .map(a => ({
            id: String(a.id || uid('att')),
            filename: String(a.filename).slice(0, 180),
            storedName: String(a.storedName),
            mimeType: String(a.mimeType || 'application/octet-stream'),
            sizeBytes: Number(a.sizeBytes || 0),
            isImage: Boolean(a.isImage || String(a.mimeType || '').startsWith('image/'))
          }))
      : [];
    const safeCard = card && typeof card === 'object' && card.type && card.id
      ? {
          type: String(card.type),
          id: String(card.id),
          title: String(card.title || '').slice(0, 120),
          subtitle: String(card.subtitle || '').slice(0, 160)
        }
      : null;
    if (!courseId || (!cleanContent && safeAtts.length === 0 && !safeCard)) {
      throw new TypeError('课程与消息内容不能为空');
    }

    const cleanRef = String(refTag || '').trim();
    let finalType = ['chat', 'question', 'announcement'].includes(msgType) ? msgType : '';
    if (!finalType) {
      finalType = (cleanRef || String(title || '').trim()) ? 'question' : 'chat';
    }
    const cleanTitle = String(title || '').trim()
      || (cleanContent ? cleanContent.slice(0, 32) : (safeCard ? safeCard.title : (safeAtts[0]?.filename || '附件消息')));
    const safeMentions = Array.isArray(mentions)
      ? mentions
          .filter(m => m && (m.id || m.name))
          .slice(0, 30)
          .map(m => ({ id: String(m.id || ''), name: String(m.name || ''), role: String(m.role || '') }))
      : [];
    const isPinned = Boolean(pinned || finalType === 'announcement') ? 1 : 0;
    const nowMs = Date.now();
    const id = uid('qa');
    db.prepare(`
      INSERT INTO qa_posts (
        id, org_id, course_id, lesson_id, author_name, author_role, author_id,
        ref_tag, title, content, resolved, msg_type, pinned, reply_to_id,
        mentions_json, attachments_json, card_json, created_ms, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      ORG_ID,
      courseId,
      String(lessonId || '').trim(),
      String(authorName || '匿名').trim(),
      String(authorRole || 'student').trim(),
      String(authorId || '').trim(),
      cleanRef,
      cleanTitle,
      cleanContent,
      finalType,
      isPinned,
      String(replyToId || '').trim(),
      JSON.stringify(safeMentions),
      JSON.stringify(safeAtts),
      safeCard ? JSON.stringify(safeCard) : '',
      nowMs,
      nowStr()
    );
    return id;
  }

  function getQaPost(id) {
    const row = db.prepare(`
      SELECT p.*, co.name AS course_name
      FROM qa_posts p
      LEFT JOIN courses co ON co.id = p.course_id
      WHERE p.id = ? AND p.org_id = ?
    `).get(id, ORG_ID);
    return hydrateQaPost(row);
  }

  function checkStudentQaRateLimit(studentId, windowMs = 60000, maxCount = 5) {
    const now = Date.now();
    const cutoff = now - windowMs;
    const postTs = db.prepare(
      "SELECT created_ms FROM qa_posts WHERE org_id = ? AND author_role = 'student' AND author_id = ? AND created_ms >= ?"
    ).all(ORG_ID, studentId, cutoff).map(r => Number(r.created_ms || 0));
    const replyTs = db.prepare(
      "SELECT created_ms FROM qa_replies WHERE org_id = ? AND author_role = 'student' AND author_id = ? AND created_ms >= ?"
    ).all(ORG_ID, studentId, cutoff).map(r => Number(r.created_ms || 0));
    const all = [...postTs, ...replyTs].filter(t => t >= cutoff).sort((a, b) => a - b);
    if (all.length >= maxCount) {
      const oldest = all[all.length - maxCount] || all[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
        return { allowed: false, count: all.length, retryAfterSec };
    }
      return { allowed: true, count: all.length, retryAfterSec: 0 };
  }

  function addQaReply({ postId, authorName, authorRole, authorId = '', content }) {
    const cleanContent = String(content || '').trim();
    if (!postId || !cleanContent) throw new TypeError('回复内容不能为空');
    const id = uid('rep');
    const nowMs = Date.now();
    db.prepare(`
      INSERT INTO qa_replies (id, org_id, post_id, author_name, author_role, author_id, content, created_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      ORG_ID,
      postId,
      String(authorName || '教师').trim(),
      String(authorRole || 'teacher').trim(),
      String(authorId || '').trim(),
      cleanContent,
      nowMs,
      nowStr()
    );
    return id;
  }

  function getQaReply(id) {
    return db.prepare('SELECT * FROM qa_replies WHERE id = ? AND org_id = ?').get(id, ORG_ID);
  }

  function deleteQaReply(id) {
    const row = getQaReply(id);
    if (row) db.prepare('DELETE FROM qa_replies WHERE id = ? AND org_id = ?').run(id, ORG_ID);
    return row;
  }

  function toggleQaResolved(postId, resolved) {
    db.prepare('UPDATE qa_posts SET resolved = ? WHERE id = ? AND org_id = ?').run(resolved ? 1 : 0, postId, ORG_ID);
    return getQaPost(postId);
  }

  function toggleQaPinned(postId, pinned) {
    db.prepare('UPDATE qa_posts SET pinned = ? WHERE id = ? AND org_id = ?').run(pinned ? 1 : 0, postId, ORG_ID);
    return getQaPost(postId);
  }

  function deleteQaPost(postId, { kind = 'delete', actorName = '', actorRole = '' } = {}) {
    const row = getQaPost(postId);
    if (!row) return { removed: null, post: null };
    const cleanKind = kind === 'recall' ? 'recall' : 'delete';
    const nowMs = Date.now();
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM qa_replies WHERE post_id = ? AND org_id = ?').run(postId, ORG_ID);
      db.prepare(`
        UPDATE qa_posts
        SET title = '', content = '', ref_tag = '', resolved = 0, pinned = 0,
            mentions_json = '[]', attachments_json = '[]', card_json = '',
            recall_kind = ?, recalled_by_name = ?, recalled_by_role = ?, recalled_at_ms = ?
        WHERE id = ? AND org_id = ?
      `).run(cleanKind, String(actorName || '').trim(), String(actorRole || '').trim(), nowMs, postId, ORG_ID);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
      return { removed: row, post: getQaPost(postId) };
  }

  function deleteQaPostsBatch(courseId, postIds = [], { actorName = '', actorRole = '' } = {}) {
    const uniqueIds = [...new Set((Array.isArray(postIds) ? postIds : []).map(x => String(x || '').trim()).filter(Boolean))];
    if (!courseId || !uniqueIds.length) throw new TypeError('请选择要删除的消息');
    const results = [];
    for (const pid of uniqueIds) {
      const existing = getQaPost(pid);
      if (!existing || existing.course_id !== courseId || existing.recall_kind) continue;
      results.push(deleteQaPost(pid, { kind: 'delete', actorName, actorRole }));
    }
    return results;
  }

  function markQaRead(accountId, courseId, lastReadMs = Date.now()) {
    if (!accountId || !courseId) return;
    const ms = Number(lastReadMs) || Date.now();
    db.prepare(`
      INSERT INTO qa_read_cursors (org_id, account_id, course_id, last_read_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, course_id) DO UPDATE SET
        last_read_ms = CASE WHEN excluded.last_read_ms > qa_read_cursors.last_read_ms THEN excluded.last_read_ms ELSE qa_read_cursors.last_read_ms END
    `).run(ORG_ID, accountId, courseId, ms);
  }

  function listQaPostsPage({ courseId, beforeMs = 0, limit = 40 }) {
    const lim = Math.max(1, Math.min(200, Number(limit) || 40));
    const rows = beforeMs > 0
      ? db.prepare(`
          SELECT p.*, co.name AS course_name
          FROM qa_posts p
          JOIN courses co ON co.id = p.course_id
          WHERE p.org_id = ? AND p.course_id = ? AND p.created_ms < ?
          ORDER BY p.created_ms DESC, p.created_at DESC
          LIMIT ?
        `).all(ORG_ID, courseId, Number(beforeMs), lim)
      : db.prepare(`
          SELECT p.*, co.name AS course_name
          FROM qa_posts p
          JOIN courses co ON co.id = p.course_id
          WHERE p.org_id = ? AND p.course_id = ?
          ORDER BY p.created_ms DESC, p.created_at DESC
          LIMIT ?
        `).all(ORG_ID, courseId, lim);
    const posts = rows.map(hydrateQaPost);
    const postIds = posts.map(p => p.id);
    const replies = postIds.length
      ? db.prepare(`
          SELECT * FROM qa_replies
          WHERE org_id = ? AND post_id IN (${postIds.map(() => '?').join(',')})
          ORDER BY created_ms ASC, created_at ASC
        `).all(ORG_ID, ...postIds)
      : [];
      return { posts, replies, hasMore: rows.length === lim };
  }

  function getCourseMembers(courseId) {
    const teacherMap = new Map();
    // 课程授课教师（多选）
    const courseTeachers = db.prepare(`
      SELECT DISTINCT t.id, t.name, t.subject
      FROM course_teachers ct
      JOIN teachers t ON t.id = ct.teacher_id AND t.org_id = ct.org_id
      WHERE ct.course_id = ? AND ct.org_id = ?
      UNION
      SELECT DISTINCT t.id, t.name, t.subject
      FROM courses co
      JOIN teachers t ON t.id = co.teacher_id AND t.org_id = co.org_id
      WHERE co.id = ? AND co.org_id = ?
    `).all(courseId, ORG_ID, courseId, ORG_ID);
    for (const t of courseTeachers) {
      teacherMap.set(t.id, { id: t.id, name: t.name, role: 'teacher', tag: '授课教师', subject: t.subject || '' });
    }
    // 课次授课教师
    const lessonTeachers = db.prepare(`
      SELECT DISTINCT t.id, t.name, t.subject
      FROM lessons l
      JOIN teachers t ON t.id = l.teacher_id AND t.org_id = l.org_id
      WHERE l.course_id = ? AND l.org_id = ?
    `).all(courseId, ORG_ID);
    for (const t of lessonTeachers) {
      if (!teacherMap.has(t.id)) {
        teacherMap.set(t.id, { id: t.id, name: t.name, role: 'teacher', tag: '授课教师', subject: t.subject || '' });
      }
    }
    // 在读学员
    const students = db.prepare(`
      SELECT DISTINCT s.id, s.name, s.grade
      FROM enrollments e
      JOIN students s ON s.id = e.student_id AND s.org_id = e.org_id
      WHERE e.course_id = ? AND e.status = 'active' AND e.org_id = ?
      ORDER BY s.name ASC
    `).all(courseId, ORG_ID);
    const studentMap = new Map();
    for (const s of students) {
      if (!studentMap.has(s.id)) {
        studentMap.set(s.id, { id: s.id, name: s.name, role: 'student', tag: s.grade || '在读学员' });
      }
    }
      return {
      teachers: Array.from(teacherMap.values()),
      students: Array.from(studentMap.values())
    };
  }

  // --- 周期批量排课（逐节冲突与并发预检，全部通过后原子写入） ---
  function saveLessonBatch({
    courseId,
    teacherId,
    titlePrefix,
    firstStartMs,
    durationMs,
    intervalDays = 7,
    weekdays = null,
    count = 4,
    physicalRoom = null,
    externalRoomUrl = '',
    skipConflicts = false,
    dryRun = false
  }) {
    const cleanPrefix = String(titlePrefix || '').trim();
    const total = Number(count);
    const stepDays = Number(intervalDays);
    const dur = Number(durationMs);
    const start0 = Number(firstStartMs);
    if (!cleanPrefix || !courseId || !teacherId) throw new TypeError('周期排课缺少标题前缀、所属课程或授课教师');
    if (!Number.isSafeInteger(total) || total < 1 || total > 52) throw new RangeError('生成节数须为 1–52 之间的整数');
    if (!Number.isSafeInteger(dur) || dur <= 0 || !Number.isSafeInteger(start0)) throw new RangeError('起止时间无效');

    const validWeekdays = Array.isArray(weekdays)
      ? [...new Set(weekdays.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))]
      : [];
    if (!validWeekdays.length && (!Number.isSafeInteger(stepDays) || stepDays < 1)) {
      throw new RangeError('间隔天数须为正整数');
    }

    // 生成候选开始时间列表
    const startSlots = [];
    if (validWeekdays.length) {
      const weekdaySet = new Set(validWeekdays);
      const base = new Date(start0);
      const h = base.getHours();
      const m = base.getMinutes();
      const sec = base.getSeconds();
      const ms = base.getMilliseconds();
      const cursor = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m, sec, ms);
      let guard = 0;
      while (startSlots.length < total && guard < 400) {
        if (weekdaySet.has(cursor.getDay())) {
          startSlots.push(cursor.getTime());
        }
        cursor.setDate(cursor.getDate() + 1);
        guard += 1;
      }
    } else {
      for (let i = 0; i < total; i++) {
        startSlots.push(start0 + i * stepDays * 86400000);
      }
    }

    const room = physicalRoom && String(physicalRoom).trim() ? String(physicalRoom).trim() : null;
    const extUrl = String(externalRoomUrl || '').trim();
    const studentIds = getCourseActiveStudentIds(courseId);
    const org = db.prepare('SELECT * FROM org_settings WHERE org_id = ?').get(ORG_ID);
    const existing = buildScheduleCheckLessons();
    const toInsert = [];
    const skipped = [];
    const preview = [];

    for (let i = 0; i < startSlots.length; i++) {
      const sMs = startSlots[i];
      const eMs = sMs + dur;
      const title = `${cleanPrefix} 第${i + 1}讲`;
      const id = uid('les');
      const candidate = { orgId: ORG_ID, id, teacherId, physicalRoomId: room, start: sMs, end: eMs, studentIds };
      const conflicts = findScheduleConflicts(candidate, existing);
      const concurrency = checkOnlineConcurrency(candidate, existing, {
        maxRooms: org.max_online_rooms,
        maxStudents: org.max_online_students
      });
      if (conflicts.length > 0 || concurrency.exceededRooms || concurrency.exceededStudents) {
        const dateStr = new Date(sMs).toLocaleDateString('zh-CN');
        const reason = formatConflictDetails(conflicts, concurrency, existing, room, org);
        if (dryRun) {
          preview.push({ index: i + 1, title, startMs: sMs, endMs: eMs, conflict: reason });
          continue;
        }
        if (skipConflicts) {
          skipped.push({ index: i + 1, dateStr, reason });
          continue;
        }
        const err = new Error(`第 ${i + 1} 讲（${dateStr}）冲突：${reason}，批量排课已取消`);
        err.statusCode = 409;
        throw err;
      }
      existing.push({ ...candidate, title });
      toInsert.push({ id, title, sMs, eMs });
      if (dryRun) {
        preview.push({ index: i + 1, title, startMs: sMs, endMs: eMs, conflict: '' });
      }
    }

    if (dryRun) {
        return { preview, conflictCount: preview.filter(p => p.conflict).length };
    }

    if (toInsert.length > 0) {
      db.exec('BEGIN');
      try {
        const stmt = db.prepare(`
          INSERT INTO lessons (id, org_id, course_id, teacher_id, title, start_ms, end_ms, physical_room, external_room_url, status, note)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', '')
        `);
        for (const item of toInsert) {
          stmt.run(item.id, ORG_ID, courseId, teacherId, item.title, item.sMs, item.eMs, room, extUrl);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
      return { ids: toInsert.map(x => x.id), skipped };
  }

  // --- 招生限时试听资格 ---
  function createTrialGrant({ studentId, targetType, targetId, expiresAt, note = '' }) {
    if (!studentId || !['lesson', 'vod'].includes(targetType) || !targetId) {
      throw new TypeError('试听参数不完整');
    }
    const exp = Number(expiresAt);
    if (!Number.isSafeInteger(exp) || exp <= Date.now()) {
      throw new RangeError('试听截止时间必须晚于当前时间');
    }
    const id = uid('tr');
    db.prepare(`
      INSERT INTO trial_grants (id, org_id, student_id, target_type, target_id, expires_at, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, ORG_ID, studentId, targetType, targetId, exp, String(note || '').trim(), nowStr());

    const stu = db.prepare('SELECT status FROM students WHERE id = ? AND org_id = ?').get(studentId, ORG_ID);
    if (stu && stu.status === '意向') {
      db.prepare('UPDATE students SET status = ? WHERE id = ? AND org_id = ?').run('试听', studentId, ORG_ID);
    }
    const targetName = targetType === 'lesson'
      ? db.prepare('SELECT title FROM lessons WHERE id = ?').get(targetId)?.title
      : db.prepare('SELECT title FROM vod_lessons WHERE id = ?').get(targetId)?.title;
    addStudentFollowup({
      studentId,
      content: `发放限时试听资格（${targetType === 'lesson' ? '课次' : '录播'}：${targetName || targetId}，有效至 ${new Date(exp).toLocaleString('zh-CN')}）`
    });
    return id;
  }

  function deleteTrialGrant(id) {
    db.prepare('DELETE FROM trial_grants WHERE id = ? AND org_id = ?').run(id, ORG_ID);
  }

  // --- 课次出勤点名 ---
  function setAttendance({ lessonId, studentId, status = '出勤', note = '' }) {
    if (!lessonId || !studentId) throw new TypeError('缺少课次或学生标识');
    if (!['出勤', '请假', '缺勤'].includes(status)) throw new TypeError('出勤状态无效');
    const existing = db.prepare(
      'SELECT id FROM attendance WHERE lesson_id = ? AND student_id = ? AND org_id = ?'
    ).get(lessonId, studentId, ORG_ID);
    const updatedAt = nowStr();
    if (existing) {
      db.prepare('UPDATE attendance SET status = ?, note = ?, updated_at = ? WHERE id = ?')
        .run(status, String(note || '').trim(), updatedAt, existing.id);
    } else {
      db.prepare(
        'INSERT INTO attendance (id, org_id, lesson_id, student_id, status, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(uid('att'), ORG_ID, lessonId, studentId, status, String(note || '').trim(), updatedAt);
    }
  }

  function setAttendanceBatch({ lessonId, records = [] }) {
    if (!lessonId || !Array.isArray(records)) throw new TypeError('批量点名参数无效');
    db.exec('BEGIN');
    try {
      for (const rec of records) {
        setAttendance({
          lessonId,
          studentId: rec.studentId,
          status: rec.status || '出勤',
          note: rec.note || ''
        });
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // --- 持久化录制会话（防服务重启丢片） ---
  function createRecordingSession({ id, lessonId, title, filename, storedName, mimeType, startedAt }) {
    const ts = startedAt || Date.now();
    db.prepare(`
      INSERT INTO recording_sessions (id, org_id, lesson_id, title, filename, stored_name, mime_type, status, received_seqs_json, started_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'recording', '{}', ?, ?)
    `).run(id, ORG_ID, lessonId, title, filename, storedName, mimeType, ts, ts);
  }

  function updateRecordingSessionSeq(id, receivedSeqsMap, lastActivityAt = Date.now(), status = 'recording') {
    const obj = {};
    for (const [k, v] of receivedSeqsMap.entries()) obj[String(k)] = v;
    db.prepare(
      'UPDATE recording_sessions SET received_seqs_json = ?, last_activity_at = ?, status = ? WHERE id = ? AND org_id = ?'
    ).run(JSON.stringify(obj), lastActivityAt, status, id, ORG_ID);
  }

  function markAllRecordingSessionsInterrupted() {
    db.prepare(
      "UPDATE recording_sessions SET status = 'interrupted' WHERE org_id = ? AND status = 'recording'"
    ).run(ORG_ID);
  }

  function listRecordingSessions() {
    return db.prepare(
      'SELECT * FROM recording_sessions WHERE org_id = ? ORDER BY last_activity_at DESC'
    ).all(ORG_ID);
  }

  function listPendingRecordingsForSnapshot(teacherId = null) {
    const rows = teacherId
      ? db.prepare(`
          SELECT rs.*, l.title AS lesson_title, co.name AS course_name
          FROM recording_sessions rs
          JOIN lessons l ON l.id = rs.lesson_id
          JOIN courses co ON co.id = l.course_id
          WHERE rs.org_id = ? AND l.teacher_id = ?
          ORDER BY rs.last_activity_at DESC
        `).all(ORG_ID, teacherId)
      : db.prepare(`
          SELECT rs.*, l.title AS lesson_title, co.name AS course_name
          FROM recording_sessions rs
          JOIN lessons l ON l.id = rs.lesson_id
          JOIN courses co ON co.id = l.course_id
          WHERE rs.org_id = ?
          ORDER BY rs.last_activity_at DESC
        `).all(ORG_ID);
    return rows.map(r => {
      let seqObj = {};
      try { seqObj = JSON.parse(r.received_seqs_json || '{}'); } catch {}
      const seqs = Object.keys(seqObj).map(Number).filter(Number.isSafeInteger).sort((a, b) => a - b);
      let sizeBytes = 0;
      for (const k of seqs) sizeBytes += Number(seqObj[String(k)] || 0);
        return {
        id: r.id,
        lesson_id: r.lesson_id,
        lesson_title: r.lesson_title,
        course_name: r.course_name,
        title: r.title,
        filename: r.filename,
        mime_type: r.mime_type,
        status: r.status,
        received_count: seqs.length,
        received_seqs: seqs,
        size_bytes: sizeBytes,
        started_at: r.started_at,
        last_activity_at: r.last_activity_at
      };
    });
  }

  function deleteRecordingSession(id) {
    db.prepare('DELETE FROM recording_sessions WHERE id = ? AND org_id = ?').run(id, ORG_ID);
  }

  // --- 系统运维：存储统计、孤儿清理、安全备份与 CSV 导出 ---
  function getStorageStats(uploadDir) {
    const dbBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
    const org = db.prepare('SELECT last_backup_at FROM org_settings WHERE org_id = ?').get(ORG_ID);
    const expiredSessions = Number(
      db.prepare('SELECT COUNT(*) AS cnt FROM sessions WHERE org_id = ? AND expires_at <= ?').get(ORG_ID, Date.now())?.cnt || 0
    );
    const activeSessions = Number(
      db.prepare('SELECT COUNT(*) AS cnt FROM sessions WHERE org_id = ? AND expires_at > ?').get(ORG_ID, Date.now())?.cnt || 0
    );

    const { recSet, vodSet, matSet, logoSet } = getReferencedFilesByCategory(db);
    const stats = {
      dbBytes,
      recordingsBytes: 0,
      recordingsCount: 0,
      vodBytes: 0,
      vodCount: 0,
      materialsBytes: 0,
      materialsCount: 0,
      logoBytes: 0,
      orphanBytes: 0,
      orphanCount: 0,
      totalUploadBytes: 0,
      expiredSessions,
      activeSessions,
      lastBackupAt: org?.last_backup_at || ''
    };

    if (uploadDir && fs.existsSync(uploadDir)) {
      const now = Date.now();
      const entries = fs.readdirSync(uploadDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fullPath = path.join(uploadDir, entry.name);
        let st;
        try { st = fs.statSync(fullPath); } catch { continue; }
        stats.totalUploadBytes += st.size;
        if (recSet.has(entry.name)) {
          stats.recordingsBytes += st.size;
          stats.recordingsCount += 1;
        } else if (vodSet.has(entry.name)) {
          stats.vodBytes += st.size;
          stats.vodCount += 1;
        } else if (matSet.has(entry.name)) {
          stats.materialsBytes += st.size;
          stats.materialsCount += 1;
        } else if (logoSet.has(entry.name)) {
          stats.logoBytes += st.size;
        } else {
          // 跳过 10 分钟内正在写入的临时分片文件（.part / .tmp）
          const isRecentTemp = (entry.name.endsWith('.part') || entry.name.endsWith('.tmp')) && (now - st.mtimeMs < 10 * 60 * 1000);
          if (!isRecentTemp) {
            stats.orphanBytes += st.size;
            stats.orphanCount += 1;
          }
        }
      }
    }
    return stats;
  }

  function cleanupSystem(uploadDir) {
    const expiredRes = db.prepare('DELETE FROM sessions WHERE org_id = ? AND expires_at <= ?').run(ORG_ID, Date.now());
    const removedSessions = Number(expiredRes?.changes || 0);
    let removedOrphans = 0;
    let freedBytes = 0;
    if (uploadDir && fs.existsSync(uploadDir)) {
      const { recSet, vodSet, matSet, logoSet } = getReferencedFilesByCategory(db);
      const now = Date.now();
      const entries = fs.readdirSync(uploadDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (recSet.has(entry.name) || vodSet.has(entry.name) || matSet.has(entry.name) || logoSet.has(entry.name)) {
          continue;
        }
        const fullPath = path.join(uploadDir, entry.name);
        let st;
        try { st = fs.statSync(fullPath); } catch { continue; }
        const isRecentTemp = (entry.name.endsWith('.part') || entry.name.endsWith('.tmp')) && (now - st.mtimeMs < 10 * 60 * 1000);
        if (isRecentTemp) continue;
        try {
          fs.unlinkSync(fullPath);
          removedOrphans += 1;
          freedBytes += st.size;
        } catch {}
      }
    }
      return { removedSessions, removedOrphans, freedBytes };
  }

  function createBackupSnapshot(destPath) {
    const escaped = String(destPath).replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);
    const ts = nowStr();
    db.prepare('UPDATE org_settings SET last_backup_at = ? WHERE org_id = ?').run(ts, ORG_ID);
    return ts;
  }

  function csvCell(val) {
    const s = String(val ?? '');
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function exportCsv(type) {
    let headers = [];
    let rows = [];
    if (type === 'students') {
      headers = ['姓名/昵称', '年级', '手机号', '状态', '账号有效期', '备注', '建档时间'];
      const list = db.prepare('SELECT * FROM students WHERE org_id = ? ORDER BY created_at DESC').all(ORG_ID);
      rows = list.map(s => [s.name, s.grade, s.phone, s.status, s.valid_until || s.next_followup_date || '长期有效', s.note, s.created_at]);
    } else if (type === 'lessons') {
      headers = ['课次标题', '课程', '授课教师', '开始时间', '结束时间', '教室', '状态'];
      const list = db.prepare(`
        SELECT l.*, co.name AS course_name, t.name AS teacher_name
        FROM lessons l
        JOIN courses co ON co.id = l.course_id
        JOIN teachers t ON t.id = l.teacher_id
        WHERE l.org_id = ?
        ORDER BY l.start_ms DESC
      `).all(ORG_ID);
      rows = list.map(l => [
        l.title, l.course_name, l.teacher_name,
        new Date(Number(l.start_ms)).toLocaleString('zh-CN'),
        new Date(Number(l.end_ms)).toLocaleString('zh-CN'),
        l.physical_room || '线上', l.status
      ]);
    } else if (type === 'enrollments') {
      headers = ['学生姓名', '手机号', '课程', '报名状态', '变更时间'];
      const list = db.prepare(`
        SELECT e.*, s.name AS student_name, s.phone AS student_phone, co.name AS course_name
        FROM enrollments e
        JOIN students s ON s.id = e.student_id
        JOIN courses co ON co.id = e.course_id
        WHERE e.org_id = ?
        ORDER BY e.updated_at DESC
      `).all(ORG_ID);
      rows = list.map(e => [
        e.student_name, e.student_phone, e.course_name,
        e.status === 'active' ? '在读' : '已退课', e.updated_at
      ]);
    } else {
      throw new TypeError('不支持的导出类型（仅支持 students、lessons、enrollments）');
    }
    const lines = [headers.map(csvCell).join(','), ...rows.map(r => r.map(csvCell).join(','))];
    return '\uFEFF' + lines.join('\r\n');
  }

  function listPlaybackBookmarks(targetType, targetId) {
    if (targetType !== 'recording' && targetType !== 'vod') {
      throw new TypeError('书签目标类型必须为 recording 或 vod');
    }
    return db.prepare(`
      SELECT id, org_id, target_type, target_id, time_sec, label, ref_tag, author_id, author_name, created_at
      FROM playback_bookmarks
      WHERE org_id = ? AND target_type = ? AND target_id = ?
      ORDER BY time_sec ASC, created_at ASC
    `).all(ORG_ID, targetType, String(targetId || ''));
  }

  function createPlaybackBookmark({ targetType, targetId, timeSec, label, refTag = '', authorId = '', authorName = '' }) {
    if (targetType !== 'recording' && targetType !== 'vod') {
      throw new TypeError('书签目标类型必须为 recording 或 vod');
    }
    const cleanTargetId = String(targetId || '').trim();
    const cleanLabel = String(label || '').trim();
    const t = Number(timeSec);
    if (!cleanTargetId || !cleanLabel) {
      throw new TypeError('请填写书签名称');
    }
    if (!Number.isFinite(t) || t < 0) {
      throw new TypeError('书签时间点无效');
    }
    if (targetType === 'recording' && !getRecording(cleanTargetId)) {
      throw new TypeError('关联回放不存在');
    }
    if (targetType === 'vod' && !getVodLesson(cleanTargetId)) {
      throw new TypeError('关联录播不存在');
    }
    const id = uid('bmk');
    const createdAt = nowStr();
    db.prepare(`
      INSERT INTO playback_bookmarks (id, org_id, target_type, target_id, time_sec, label, ref_tag, author_id, author_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, ORG_ID, targetType, cleanTargetId, Math.round(t * 10) / 10, cleanLabel, String(refTag || '').trim(), String(authorId || ''), String(authorName || ''), createdAt);
    return db.prepare('SELECT * FROM playback_bookmarks WHERE id = ?').get(id);
  }

  function deletePlaybackBookmark(id) {
    const existing = db.prepare('SELECT * FROM playback_bookmarks WHERE id = ? AND org_id = ?').get(id, ORG_ID);
    if (!existing) {
      const err = new Error('书签不存在');
      err.statusCode = 404;
      throw err;
    }
    db.prepare('DELETE FROM playback_bookmarks WHERE id = ? AND org_id = ?').run(id, ORG_ID);
    return existing;
  }

  function rotateLocalBackups(backupDir, keepCount = 5) {
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const destPath = path.join(backupDir, `workbench-auto-${stamp}.db`);
    createBackupSnapshot(destPath);
    const files = fs.readdirSync(backupDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.db'))
      .map(e => ({ name: e.name, full: path.join(backupDir, e.name), mtime: fs.statSync(path.join(backupDir, e.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of files.slice(Math.max(1, keepCount))) {
      try { fs.unlinkSync(old.full); } catch {}
    }
      return {
      created: path.basename(destPath),
      totalBackups: Math.min(files.length, Math.max(1, keepCount)),
      backups: files.slice(0, Math.max(1, keepCount)).map(f => ({
        filename: f.name,
        sizeBytes: fs.statSync(f.full).size,
        mtimeMs: f.mtime
      }))
    };
  }

  function listLocalBackups(backupDir) {
    if (!backupDir || !fs.existsSync(backupDir)) return [];
    return fs.readdirSync(backupDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.db'))
      .map(e => {
        const st = fs.statSync(path.join(backupDir, e.name));
          return { filename: e.name, sizeBytes: st.size, mtimeMs: st.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  // --- 智能助手会话与消息 ---
  function listAssistantConversations() {
    return db.prepare(`
      SELECT c.*,
        (SELECT m.content FROM assistant_messages m WHERE m.conversation_id = c.id ORDER BY m.created_ms DESC LIMIT 1) AS last_message,
        (SELECT COUNT(*) FROM assistant_messages m WHERE m.conversation_id = c.id) AS message_count
      FROM assistant_conversations c
      WHERE c.org_id = ?
      ORDER BY c.updated_ms DESC
    `).all(ORG_ID).map(c => {
      let metrics = {};
      try { metrics = JSON.parse(c.metrics_json || '{}'); } catch {}
        return { ...c, metrics };
    });
  }

  function getAssistantConversation(id) {
    const row = db.prepare('SELECT * FROM assistant_conversations WHERE id = ? AND org_id = ?').get(id, ORG_ID);
    if (!row) return null;
    let metrics = {};
    try { metrics = JSON.parse(row.metrics_json || '{}'); } catch {}
      return { ...row, metrics };
  }

  function createAssistantConversation({ title = '新对话', model = 'deepseek-flash', reasoningEffort = 'high' } = {}) {
    const id = uid('dshc');
    const now = nowStr();
    const ms = Date.now();
    const cleanTitle = String(title || '').trim() || '新对话';
    const cleanModel = String(model || '').trim() || 'deepseek-flash';
    const cleanEffort = ['off', 'low', 'high', 'max'].includes(reasoningEffort) ? reasoningEffort : 'high';
    db.prepare(`
      INSERT INTO assistant_conversations (id, org_id, title, model, reasoning_effort, metrics_json, created_at, updated_at, updated_ms)
      VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?)
    `).run(id, ORG_ID, cleanTitle, cleanModel, cleanEffort, now, now, ms);
    return getAssistantConversation(id);
  }

  function updateAssistantConversation(id, { title, model, reasoningEffort } = {}) {
    const cur = getAssistantConversation(id);
    if (!cur) {
      const err = new Error('对话不存在');
      err.statusCode = 404;
      throw err;
    }
    const cleanTitle = title !== undefined ? (String(title || '').trim() || cur.title) : cur.title;
    const cleanModel = model !== undefined ? (String(model || '').trim() || cur.model) : cur.model;
    const cleanEffort = reasoningEffort !== undefined && ['off', 'low', 'high', 'max'].includes(reasoningEffort)
      ? reasoningEffort
      : (cur.reasoning_effort || 'high');
    const now = nowStr();
    const ms = Date.now();
    db.prepare(`
      UPDATE assistant_conversations
      SET title = ?, model = ?, reasoning_effort = ?, updated_at = ?, updated_ms = ?
      WHERE id = ? AND org_id = ?
    `).run(cleanTitle, cleanModel, cleanEffort, now, ms, id, ORG_ID);
    return getAssistantConversation(id);
  }

  function updateAssistantConversationMetrics(id, metrics = {}) {
    db.prepare('UPDATE assistant_conversations SET metrics_json = ? WHERE id = ? AND org_id = ?')
      .run(JSON.stringify(metrics || {}), id, ORG_ID);
  }

  function deleteAssistantConversation(id) {
    const cur = getAssistantConversation(id);
    if (!cur) {
      const err = new Error('对话不存在');
      err.statusCode = 404;
      throw err;
    }
    db.prepare('DELETE FROM assistant_messages WHERE conversation_id = ? AND org_id = ?').run(id, ORG_ID);
    db.prepare('DELETE FROM assistant_conversations WHERE id = ? AND org_id = ?').run(id, ORG_ID);
    return true;
  }

  function listAssistantMessages(conversationId) {
    return db.prepare(`
      SELECT * FROM assistant_messages
      WHERE conversation_id = ? AND org_id = ?
      ORDER BY created_ms ASC, rowid ASC
    `).all(conversationId, ORG_ID).map(m => ({
      ...m,
      toolCalls: (() => { try { return JSON.parse(m.tool_calls_json || '[]'); } catch { return []; } })()
    }));
  }

  function appendAssistantMessage({ conversationId, role, content = '', thinking = '', toolCalls = [], status = 'done' }) {
    const cur = getAssistantConversation(conversationId);
    if (!cur) {
      const err = new Error('对话不存在');
      err.statusCode = 404;
      throw err;
    }
    const id = uid('dshm');
    const now = nowStr();
    const ms = Date.now();
    db.prepare(`
      INSERT INTO assistant_messages (id, conversation_id, org_id, role, content, thinking, tool_calls_json, status, created_at, created_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, conversationId, ORG_ID, role, String(content || ''), String(thinking || ''), JSON.stringify(toolCalls || []), status, now, ms);
    db.prepare('UPDATE assistant_conversations SET updated_at = ?, updated_ms = ? WHERE id = ? AND org_id = ?')
      .run(now, ms, conversationId, ORG_ID);
    return id;
  }

  function updateAssistantMessage(id, { content, thinking, toolCalls, status } = {}) {
    const cur = db.prepare('SELECT * FROM assistant_messages WHERE id = ? AND org_id = ?').get(id, ORG_ID);
    if (!cur) return;
    const nextContent = content !== undefined ? String(content) : cur.content;
    const nextThinking = thinking !== undefined ? String(thinking) : cur.thinking;
    const nextTools = toolCalls !== undefined ? JSON.stringify(toolCalls) : cur.tool_calls_json;
    const nextStatus = status !== undefined ? status : cur.status;
    db.prepare(`
      UPDATE assistant_messages
      SET content = ?, thinking = ?, tool_calls_json = ?, status = ?
      WHERE id = ? AND org_id = ?
    `).run(nextContent, nextThinking, nextTools, nextStatus, id, ORG_ID);
    db.prepare('UPDATE assistant_conversations SET updated_at = ?, updated_ms = ? WHERE id = ? AND org_id = ?')
      .run(nowStr(), Date.now(), cur.conversation_id, ORG_ID);
  }

  // --- 课程作业与批改 ---
  function getHomework(id) {
    const row = db.prepare(`
      SELECT h.*, co.name AS course_name
      FROM homeworks h
      JOIN courses co ON co.id = h.course_id
      WHERE h.id = ? AND h.org_id = ?
    `).get(id, ORG_ID);
    return hydrateHomework(row);
  }

  function sanitizeHomeworkFiles(files) {
    if (!Array.isArray(files)) return [];
    return files
      .filter(f => f && typeof f === 'object' && f.storedName && f.filename)
      .slice(0, 12)
      .map(f => ({
        id: String(f.id || uid('hwf')),
        filename: String(f.filename),
        storedName: String(f.storedName),
        mimeType: String(f.mimeType || 'application/octet-stream'),
        sizeBytes: Number(f.sizeBytes || 0),
        isImage: Boolean(f.isImage || String(f.mimeType || '').startsWith('image/'))
      }));
  }

  function createHomework({ courseId, teacherId = '', creatorName = '', title, content = '', contentFormat = 'markdown', attachments = [], dueDate = '' }) {
    const cleanCourseId = String(courseId || '').trim();
    const cleanTitle = String(title || '').trim();
    const cleanContent = String(content || '');
    const cleanFormat = contentFormat === 'text' ? 'text' : 'markdown';
    const cleanDue = assertOptionalDate(dueDate);
    const cleanAttachments = sanitizeHomeworkFiles(attachments);
    if (!cleanCourseId) throw new TypeError('请选择所属课程');
    if (!cleanTitle) throw new TypeError('作业标题不能为空');
    if (!cleanContent.trim() && cleanAttachments.length === 0) {
      throw new TypeError('作业内容或附件至少填写一项');
    }
    const course = db.prepare('SELECT id FROM courses WHERE id = ? AND org_id = ?').get(cleanCourseId, ORG_ID);
    if (!course) throw new TypeError('所选课程不存在');

    const id = uid('hw');
    const now = nowStr();
    const nowMs = Date.now();
    db.prepare(`
      INSERT INTO homeworks (
        id, org_id, course_id, teacher_id, creator_name, title, content, content_format,
        attachments_json, due_date, created_at, updated_at, created_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      ORG_ID,
      cleanCourseId,
      String(teacherId || ''),
      String(creatorName || ''),
      cleanTitle,
      cleanContent,
      cleanFormat,
      JSON.stringify(cleanAttachments),
      cleanDue,
      now,
      now,
      nowMs
    );
    return getHomework(id);
  }

  function updateHomework(id, { title, content, contentFormat, attachments, dueDate }) {
    const existing = getHomework(id);
    if (!existing) throw new TypeError('作业不存在');
    const cleanTitle = title !== undefined ? String(title || '').trim() : existing.title;
    const cleanContent = content !== undefined ? String(content || '') : existing.content;
    const cleanFormat = contentFormat !== undefined ? (contentFormat === 'text' ? 'text' : 'markdown') : existing.content_format;
    const cleanDue = dueDate !== undefined ? assertOptionalDate(dueDate) : existing.due_date;
    const cleanAttachments = attachments !== undefined ? sanitizeHomeworkFiles(attachments) : existing.attachments;
    if (!cleanTitle) throw new TypeError('作业标题不能为空');
    if (!cleanContent.trim() && cleanAttachments.length === 0) {
      throw new TypeError('作业内容或附件至少填写一项');
    }
    const nextStored = new Set(cleanAttachments.map(a => a.storedName));
    const removedStoredNames = existing.attachments
      .map(a => a.storedName)
      .filter(name => name && !nextStored.has(name));

    db.prepare(`
      UPDATE homeworks
      SET title = ?, content = ?, content_format = ?, attachments_json = ?, due_date = ?, updated_at = ?
      WHERE id = ? AND org_id = ?
    `).run(cleanTitle, cleanContent, cleanFormat, JSON.stringify(cleanAttachments), cleanDue, nowStr(), id, ORG_ID);

    return { homework: getHomework(id), removedStoredNames };
  }

  function deleteHomework(id) {
    const existing = getHomework(id);
    if (!existing) return { removed: null, storedNames: [] };
    const storedNames = existing.attachments.map(a => a.storedName).filter(Boolean);
    const subs = db.prepare('SELECT images_json, graded_images_json FROM homework_submissions WHERE homework_id = ? AND org_id = ?').all(id, ORG_ID);
    for (const s of subs) {
      for (const img of parseJsonSafe(s.images_json, [])) {
        if (img && img.storedName) storedNames.push(img.storedName);
      }
      for (const img of parseJsonSafe(s.graded_images_json, [])) {
        if (img && img.storedName) storedNames.push(img.storedName);
      }
    }
    db.prepare('DELETE FROM homeworks WHERE id = ? AND org_id = ?').run(id, ORG_ID);
    return { removed: existing, storedNames };
  }

  function getHomeworkSubmission(id) {
    const row = db.prepare(`
      SELECT hs.*, s.name AS student_name, s.grade AS student_grade
      FROM homework_submissions hs
      JOIN students s ON s.id = hs.student_id
      WHERE hs.id = ? AND hs.org_id = ?
    `).get(id, ORG_ID);
    return hydrateHomeworkSubmission(row);
  }

  function upsertHomeworkSubmission({ homeworkId, studentId, images = [], note = '' }) {
    const hw = getHomework(homeworkId);
    if (!hw) throw new TypeError('作业不存在');
    const cleanImages = sanitizeHomeworkFiles(images);
    if (cleanImages.length === 0) throw new TypeError('请至少上传一张作业图片');
    const cleanNote = String(note || '').trim();
    const existing = db.prepare(
      'SELECT * FROM homework_submissions WHERE homework_id = ? AND student_id = ? AND org_id = ?'
    ).get(homeworkId, studentId, ORG_ID);

    const now = nowStr();
    const nowMs = Date.now();
    const nextStored = new Set(cleanImages.map(img => img.storedName));
    const removedStoredNames = [];

    if (existing) {
      for (const img of parseJsonSafe(existing.images_json, [])) {
        if (img && img.storedName && !nextStored.has(img.storedName)) {
          removedStoredNames.push(img.storedName);
        }
      }
      db.prepare(`
        UPDATE homework_submissions
        SET images_json = ?, note = ?, status = 'submitted', updated_at = ?, submitted_ms = ?
        WHERE id = ? AND org_id = ?
      `).run(JSON.stringify(cleanImages), cleanNote, now, nowMs, existing.id, ORG_ID);
      return { submission: getHomeworkSubmission(existing.id), removedStoredNames };
    }

    const id = uid('hws');
    db.prepare(`
      INSERT INTO homework_submissions (
        id, org_id, homework_id, course_id, student_id, images_json, note,
        status, submitted_at, updated_at, submitted_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?)
    `).run(id, ORG_ID, homeworkId, hw.course_id, studentId, JSON.stringify(cleanImages), cleanNote, now, now, nowMs);
    return { submission: getHomeworkSubmission(id), removedStoredNames };
  }

  function gradeHomeworkSubmission(id, { score = '', feedback = '', gradedImages, gradedBy = '' }) {
    const existing = getHomeworkSubmission(id);
    if (!existing) throw new TypeError('提交记录不存在');
    const cleanScore = String(score || '').trim();
    const cleanFeedback = String(feedback || '').trim();
    const cleanGradedImages = gradedImages !== undefined ? sanitizeHomeworkFiles(gradedImages) : existing.gradedImages;
    const nextStored = new Set(cleanGradedImages.map(img => img.storedName));
    const removedStoredNames = existing.gradedImages
      .map(img => img.storedName)
      .filter(name => name && !nextStored.has(name));

    const now = nowStr();
    db.prepare(`
      UPDATE homework_submissions
      SET status = 'graded', score = ?, feedback = ?, graded_images_json = ?, graded_by = ?, graded_at = ?, updated_at = ?
      WHERE id = ? AND org_id = ?
    `).run(cleanScore, cleanFeedback, JSON.stringify(cleanGradedImages), String(gradedBy || ''), now, now, id, ORG_ID);

    return { submission: getHomeworkSubmission(id), removedStoredNames };
  }

  return {
    db,
    hasAnyTeacherAccount,
    setupInitialAdmin,
    createSession,
    getSession,
    deleteSession,
    canStudentAccessLesson,
    canStudentAccessCourse,
    canStudentAccessRecording,
    canStudentAccessVod,
    canStudentAccessMaterial,
    canTeacherAccessLesson,
    canTeacherAccessCourse,
    canTeacherAccessMaterial,
    getSnapshotForUser,
    getDeepseekApiKey,
    listAssistantConversations,
    getAssistantConversation,
    createAssistantConversation,
    updateAssistantConversation,
    updateAssistantConversationMetrics,
    deleteAssistantConversation,
    listAssistantMessages,
    appendAssistantMessage,
    updateAssistantMessage,
    updateOrgSettings,
    getOrgLogo,
    updateOrgLogo,
    createAccount,
    verifyLogin,
    updateOwnProfile,
    updateAccount,
    changeOwnPassword,
    deleteAccount,
    createTeacher,
    updateTeacher,
    upsertTeacherAccount,
    deleteTeacher,
    getStorageStats,
    cleanupSystem,
    createBackupSnapshot,
    rotateLocalBackups,
    listLocalBackups,
    verifyBackupFile,
    exportCsv,
    listPlaybackBookmarks,
    createPlaybackBookmark,
    deletePlaybackBookmark,
    createStudent,
    updateStudent,
    addStudentFollowup,
    saveLearningRecord,
    deleteLearningRecord,
    deleteStudent,
    createCourse,
    updateCourse,
    deleteCourse,
    getCourseNode,
    createCourseNode,
    createCourseNodesBatch,
    copyCourseOutline,
    updateCourseNode,
    moveCourseNode,
    reorderCourseNode,
    deleteCourseNode,
    enrollStudent,
    enrollStudentsBatch,
    setEnrollmentStatus,
    transferEnrollment,
    saveLesson,
    saveLessonBatch,
    updateLessonStatus,
    updateLessonNote,
    getLessonWhiteboard,
    saveLessonWhiteboard,
    listClassroomMessages,
    addClassroomMessage,
    deleteLesson,
    createRecording,
    getRecording,
    updateRecordingStatus,
    updateRecording,
    deleteRecording,
    createRecordingSession,
    updateRecordingSessionSeq,
    markAllRecordingSessionsInterrupted,
    listRecordingSessions,
    deleteRecordingSession,
    createVodLesson,
    getVodLesson,
    updateVodLesson,
    deleteVodLesson,
    savePlaybackProgress,
    getPlaybackProgressForUser,
    assertMaterialTargetExists,
    createMaterial,
    getMaterial,
    updateMaterial,
    deleteMaterial,
    createQaPost,
    getQaPost,
    checkStudentQaRateLimit,
    addQaReply,
    getQaReply,
    deleteQaReply,
    toggleQaResolved,
    toggleQaPinned,
    deleteQaPost,
    deleteQaPostsBatch,
    markQaRead,
    getQaReadCursors,
    listQaPostsPage,
    getCourseMembers,
    getHomework,
    createHomework,
    updateHomework,
    deleteHomework,
    getHomeworkSubmission,
    upsertHomeworkSubmission,
    gradeHomeworkSubmission,
    createTrialGrant,
    deleteTrialGrant,
    setAttendance,
    setAttendanceBatch
  };
}

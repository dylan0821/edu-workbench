import { chmod, cp, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { verifyBackupFile } from './db.js';

const [action, sourceArg, targetArg] = process.argv.slice(2);

try {
  if (!['backup', 'restore'].includes(action) || !sourceArg || !targetArg) {
    throw new Error('用法：node src/backup.js backup|restore <来源目录> <新的目标目录>');
  }
  const sourceDir = await realpath(sourceArg);
  const requestedTarget = path.resolve(targetArg);
  const targetDir = path.join(await realpath(path.dirname(requestedTarget)), path.basename(requestedTarget));
  if (sourceDir === targetDir || targetDir.startsWith(sourceDir + path.sep)) {
    throw new Error('目标目录必须位于来源目录之外');
  }

  const sourceDb = path.join(sourceDir, 'workbench.db');
  const sourceUploads = path.join(sourceDir, 'uploads');
  if (!(await lstat(sourceDb)).isFile() || !(await lstat(sourceUploads)).isDirectory()) {
    throw new Error('来源目录需要包含 workbench.db 和 uploads/');
  }
  if (action === 'restore') assertUsableBackup(sourceDir);

  await mkdir(targetDir, { mode: 0o700 });
  const targetDb = path.join(targetDir, 'workbench.db');
  const reader = new DatabaseSync(sourceDb, { readOnly: true });
  try {
    reader.prepare('VACUUM INTO ?').run(targetDb);
  } finally {
    reader.close();
  }
  await chmod(targetDb, 0o600);
  await cp(sourceUploads, path.join(targetDir, 'uploads'), {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: async file => {
      const entry = await lstat(file);
      return entry.isFile() || entry.isDirectory();
    }
  });
  const { checkedFiles } = assertUsableBackup(targetDir);
  console.log(`${action === 'backup' ? '备份' : '恢复'}完成，数据库检查通过，已核对 ${checkedFiles} 个关联文件。目录 ${targetDir}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}

function assertUsableBackup(dir) {
  const result = verifyBackupFile(path.join(dir, 'workbench.db'), path.join(dir, 'uploads'));
  if (!result.ok) {
    const missing = result.missingFiles.slice(0, 10).join('、');
    throw new Error(missing ? `缺少 ${result.missingFiles.length} 个关联文件（${missing}）` : '数据库完整性校验失败');
  }
  return result;
}

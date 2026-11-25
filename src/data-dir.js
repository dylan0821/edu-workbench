import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../data', import.meta.url));
const ORIGINAL = 'original';

function instanceDir(root, instance) {
  if (instance === ORIGINAL) return root;
  if (!/^reset-[a-f0-9-]{36}$/.test(instance)) throw new Error('无效的数据版本名称');
  const dir = path.join(root, 'instances', instance);
  if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`找不到数据版本 ${instance}`);
  }
  return dir;
}

export function getActiveData(root = path.resolve(process.env.WORKBENCH_DATA_DIR || DEFAULT_DATA_DIR)) {
  let instance = ORIGINAL;
  try {
    instance = fs.readFileSync(path.join(root, '.active-instance'), 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { instance, dir: instanceDir(root, instance) };
}

function selectInstance(root, instance) {
  const pending = path.join(root, `.active-instance-${randomUUID()}`);
  fs.writeFileSync(pending, `${instance}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(pending, path.join(root, '.active-instance'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.env.WORKBENCH_DATA_DIR || DEFAULT_DATA_DIR);
  const [action, target, ...extra] = process.argv.slice(2);
  try {
    if (extra.length || (action === 'restore' ? !target : target) || !['path', 'reset', 'restore'].includes(action)) {
      throw new Error('用法：npm run data -- path | reset | restore <版本名称>');
    }
    const current = getActiveData(root);
    if (action === 'path') {
      console.log(current.dir);
    } else if (action === 'reset') {
      const instance = `reset-${randomUUID()}`;
      const instances = path.join(root, 'instances');
      fs.mkdirSync(instances, { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(instances, instance), { mode: 0o700 });
      selectInstance(root, instance);
      console.log(`已选用空白版本 ${instance}，下次启动生效。`);
      console.log(`恢复原版本：npm run data -- restore ${current.instance}`);
    } else {
      const dir = instanceDir(root, target);
      selectInstance(root, target);
      console.log(`已选用 ${target}，下次启动生效。数据目录 ${dir}`);
      console.log(`切回前一版本：npm run data -- restore ${current.instance}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

import fs from 'node:fs';
import path from 'node:path';

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function acquireLock(file, logger) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    const pid = Number(existing);
    if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
      throw new Error(`已有实例在运行（PID ${pid}），本次启动取消`);
    }
    logger?.warn(`发现残留锁文件（PID ${existing || '空'}），将覆盖`);
  } catch (err) {
    if (err.code !== 'ENOENT' && !err.message.startsWith('已有实例')) throw err;
    if (err.message.startsWith('已有实例')) throw err;
  }

  const myPid = process.pid;
  fs.writeFileSync(file, String(myPid), 'utf8');

  return function releaseLock() {
    try {
      const current = fs.readFileSync(file, 'utf8').trim();
      if (current === String(myPid)) fs.unlinkSync(file);
    } catch {
      // 忽略清理失败
    }
  };
}

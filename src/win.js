import { execFile } from 'node:child_process';
import process from 'node:process';

/**
 * Windows 控制台程序（schtasks、taskkill）的输出跟随系统代码页，
 * 中文系统是 GBK，按 GBK 解码才不会变乱码。
 */
export function decodeOutput(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ''), 'utf8');
  return new TextDecoder(process.platform === 'win32' ? 'gbk' : 'utf-8').decode(buffer).trim();
}

export function run(cmd, args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, encoding: 'buffer' }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: decodeOutput(stdout), stderr: decodeOutput(stderr) });
    });
  });
}

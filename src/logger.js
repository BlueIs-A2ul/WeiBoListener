import fs from 'node:fs';
import path from 'node:path';

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function pad(n) {
  return String(n).padStart(2, '0');
}

function localDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localTimestamp(date) {
  return `${localDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function redact(key, value) {
  if (/cookie|token|authorization|password|secret/i.test(key)) return '[REDACTED]';
  return value;
}

function stringifyMeta(meta) {
  if (meta === undefined || meta === null) return '';
  try {
    return JSON.stringify(meta, (key, value) => {
      if (value instanceof Error) {
        return { name: value.name, message: value.message, code: value.code, stack: value.stack };
      }
      return redact(key, value);
    });
  } catch {
    return '[meta 无法序列化]';
  }
}

export function createLogger({ level = 'info', logDir = 'logs', consoleEnabled = true } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  let resolvedLogDir = null;

  if (logDir) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      resolvedLogDir = logDir;
    } catch {
      resolvedLogDir = null;
    }
  }

  function write(levelName, message, meta) {
    if (LEVELS[levelName] < threshold) return;
    const now = new Date();
    const line = `${localTimestamp(now)} [${levelName.toUpperCase()}] ${message}${meta === undefined ? '' : ` ${stringifyMeta(meta)}`}`;

    if (consoleEnabled) {
      if (levelName === 'error') console.error(line);
      else if (levelName === 'warn') console.warn(line);
      else console.log(line);
    }

    if (resolvedLogDir) {
      try {
        const logFile = path.join(resolvedLogDir, `app-${localDate(now)}.log`);
        fs.appendFileSync(logFile, `${line}\n`, 'utf8');
      } catch {
        // 日志文件写入失败时不影响主流程
      }
    }
  }

  return {
    level,
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
  };
}

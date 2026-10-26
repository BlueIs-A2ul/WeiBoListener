import fs from 'node:fs';

/**
 * 解析 .env 文本，返回 [{ key, value }]。
 * 只处理 KEY=VALUE 形式；整行 # 注释和空行跳过；值两侧的引号会被去掉。
 */
export function parseDotEnv(text) {
  const entries = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(equals + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length > 1) value = value.slice(1, -1);
    entries.push({ key, value });
  }
  return entries;
}

/**
 * 把 .env 读进环境变量。
 *
 * 保留 Node 自己的语义：已经存在于环境里的同名变量优先，.env 不覆盖它。
 * 但会把这些「被覆盖」的键收集到 conflicts 里，由调用方写进日志——
 * 否则用户在面板里改了 .env、值却没生效，现象极难排查。
 */
export function loadDotEnv({ file, env = process.env } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { loaded: false, applied: [], conflicts: [] };
    throw err;
  }

  const applied = [];
  const conflicts = [];

  for (const { key, value } of parseDotEnv(text)) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) {
      env[key] = value;
      applied.push(key);
      continue;
    }
    if (env[key] === value) {
      applied.push(key);
      continue;
    }
    conflicts.push({ key, systemValue: env[key], fileValue: value });
  }

  return { loaded: true, applied, conflicts };
}

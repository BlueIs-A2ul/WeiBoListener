import fs from 'node:fs/promises';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const DEFAULT_CONFIG = Object.freeze({
  pollIntervalSec: 300,
  jitterSec: 15,
  requestTimeoutMs: 15000,
  deepScanIntervalHours: 6,
  deepScanMaxPages: 10,
  baselineMaxPages: 10,
  heartbeatHour: 9,
  notifyOnStart: true,
  maxCommentChars: 200,
  maxSeenPerPost: 20000,
  stateFile: 'data/state.json',
  logDir: 'logs',
  logLevel: 'info',
  posts: [],
  sites: [],
  filters: {
    excludeKeywords: [],
  },
});

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const SITE_MODES = new Set(['json']);
const SITE_ENCODINGS = new Set(['auto', 'utf-8', 'gbk', 'gb18030']);
const HTTP_METHODS = new Set(['GET', 'POST']);

/** 站点 ID 只允许小写字母/数字/短横线：它会被派生成本地 .env 里的键名。 */
export const SITE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** 站点 Cookie 在 .env 里的键名，例如 swpu-exams → SITE_SWPU_EXAMS_COOKIE。 */
export function siteCookieKey(siteId) {
  const normalized = String(siteId ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `SITE_${normalized || 'SITE'}_COOKIE`;
}

function readInt(value, fallback, name, { min, max } = {}) {
  const n = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(n)) throw new ConfigError(`${name} 必须是整数`);
  if (min !== undefined && n < min) throw new ConfigError(`${name} 不能小于 ${min}`);
  if (max !== undefined && n > max) throw new ConfigError(`${name} 不能大于 ${max}`);
  return n;
}

function readString(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') throw new ConfigError(`${name} 必须是字符串`);
  return value;
}

/** 校验并归一化一个站点（通用站点监听，当前只支持 JSON 模式）。 */
function normalizeSite(raw, index, seenIds) {
  const label = `sites[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`${label} 必须是对象`);
  }

  const id = String(raw.id ?? '').trim();
  if (!SITE_ID_PATTERN.test(id)) {
    throw new ConfigError(`${label}.id 只能用小写字母、数字和短横线（会用来生成 .env 键名），例如 jwc-notice`);
  }
  if (seenIds.has(id)) throw new ConfigError(`sites 中存在重复的站点 ID：${id}`);
  seenIds.add(id);

  const mode = String(raw.mode ?? 'json').trim().toLowerCase();
  if (!SITE_MODES.has(mode)) {
    throw new ConfigError(`${label}.mode 目前只支持 json（收到：${raw.mode}）`);
  }

  const requestRaw = raw.request;
  if (!requestRaw || typeof requestRaw !== 'object' || Array.isArray(requestRaw)) {
    throw new ConfigError(`${label}.request 必须是对象`);
  }
  const url = String(requestRaw.url ?? '').trim();
  if (!url) throw new ConfigError(`${label}.request.url 不能为空`);
  if (!/^https?:\/\//i.test(url)) throw new ConfigError(`${label}.request.url 必须是 http/https 地址`);

  const method = String(requestRaw.method ?? 'GET').trim().toUpperCase();
  if (!HTTP_METHODS.has(method)) throw new ConfigError(`${label}.request.method 只支持 GET / POST`);

  const headers = {};
  if (requestRaw.headers !== undefined && requestRaw.headers !== null) {
    if (typeof requestRaw.headers !== 'object' || Array.isArray(requestRaw.headers)) {
      throw new ConfigError(`${label}.request.headers 必须是对象，例如 { "Referer": "https://..." }`);
    }
    for (const [key, value] of Object.entries(requestRaw.headers)) {
      const name = String(key).trim();
      if (!name || /[\s:]/.test(name)) throw new ConfigError(`${label}.request.headers 里的名称不合法：${key}`);
      if (value === undefined || value === null) continue;
      headers[name] = String(value);
    }
  }

  const body =
    requestRaw.body === undefined || requestRaw.body === null || requestRaw.body === ''
      ? null
      : String(requestRaw.body);

  const cookieEnv = String(requestRaw.cookieEnv ?? '').trim() || siteCookieKey(id);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cookieEnv)) {
    throw new ConfigError(`${label}.request.cookieEnv 必须是合法的环境变量名（字母、数字、下划线）`);
  }

  const timeoutRaw = requestRaw.timeoutMs;
  const timeoutMs =
    timeoutRaw === undefined || timeoutRaw === null || timeoutRaw === ''
      ? null
      : readInt(timeoutRaw, null, `${label}.request.timeoutMs`, { min: 5000, max: 120000 });

  const encoding = String(requestRaw.encoding ?? 'auto').trim().toLowerCase();
  if (!SITE_ENCODINGS.has(encoding)) {
    throw new ConfigError(`${label}.request.encoding 必须是 auto / utf-8 / gbk / gb18030 之一`);
  }

  let success = null;
  if (raw.success !== undefined && raw.success !== null) {
    const successRaw = raw.success;
    if (typeof successRaw !== 'object' || Array.isArray(successRaw)) {
      throw new ConfigError(`${label}.success 必须是对象，例如 { "path": "code", "equals": "0" }`);
    }
    const path = String(successRaw.path ?? '').trim();
    if (!path) throw new ConfigError(`${label}.success.path 不能为空`);
    if (successRaw.equals === undefined || successRaw.equals === null) {
      throw new ConfigError(`${label}.success.equals 不能为空（例如 0 或 "success"）`);
    }
    success = {
      path,
      equals: String(successRaw.equals),
      messagePath:
        successRaw.messagePath === undefined || successRaw.messagePath === null || successRaw.messagePath === ''
          ? null
          : String(successRaw.messagePath).trim(),
    };
  }

  const selectRaw = raw.select;
  if (!selectRaw || typeof selectRaw !== 'object' || Array.isArray(selectRaw)) {
    throw new ConfigError(`${label}.select 必须是对象`);
  }
  const items = String(selectRaw.items ?? '').trim();
  if (!items) throw new ConfigError(`${label}.select.items 不能为空，例如 datas 或 data.list`);
  const idPath = String(selectRaw.id ?? '').trim();
  if (!idPath) throw new ConfigError(`${label}.select.id 不能为空，例如 taskId 或 id`);

  const optionalPath = (value) => {
    const text = String(value ?? '').trim();
    return text === '' ? null : text;
  };

  const fieldsRaw = selectRaw.fields === undefined || selectRaw.fields === null ? [] : selectRaw.fields;
  if (!Array.isArray(fieldsRaw)) throw new ConfigError(`${label}.select.fields 必须是数组`);
  const fields = fieldsRaw.map((field, fieldIndex) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      throw new ConfigError(`${label}.select.fields[${fieldIndex}] 必须是对象`);
    }
    const path = String(field.path ?? '').trim();
    if (!path) throw new ConfigError(`${label}.select.fields[${fieldIndex}].path 不能为空`);
    const fieldLabel = String(field.label ?? '').trim() || path;
    return { path, label: fieldLabel };
  });

  const filtersRaw = raw.filters && typeof raw.filters === 'object' ? raw.filters : {};
  const readKeywords = (value, name) => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new ConfigError(`${label}.filters.${name} 必须是数组`);
    return value.map((item) => String(item).trim()).filter(Boolean);
  };

  const intervalRaw = raw.pollIntervalSec;
  const pollIntervalSec =
    intervalRaw === undefined || intervalRaw === null || intervalRaw === ''
      ? null
      : readInt(intervalRaw, null, `${label}.pollIntervalSec`, { min: 60, max: 86400 });

  const notifyOnBaseline = raw.notifyOnBaseline === undefined ? false : Boolean(raw.notifyOnBaseline);
  const maxItems = readInt(raw.maxItems, 200, `${label}.maxItems`, { min: 1, max: 1000 });
  const maxItemsPerMessage = readInt(raw.maxItemsPerMessage, 10, `${label}.maxItemsPerMessage`, {
    min: 1,
    max: 50,
  });

  const messageRaw = raw.message && typeof raw.message === 'object' ? raw.message : {};
  const message = {
    header: typeof messageRaw.header === 'string' && messageRaw.header.trim() !== '' ? messageRaw.header.trim() : null,
    item: typeof messageRaw.item === 'string' && messageRaw.item.trim() !== '' ? messageRaw.item : null,
  };

  return {
    id,
    name: String(raw.name ?? '').trim() || `站点 ${id}`,
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    mode,
    request: { url, method, headers, body, cookieEnv, timeoutMs, encoding },
    success,
    select: {
      items,
      id: idPath,
      title: optionalPath(selectRaw.title),
      time: optionalPath(selectRaw.time),
      link: optionalPath(selectRaw.link),
      text: optionalPath(selectRaw.text),
      fields,
    },
    filters: {
      includeKeywords: readKeywords(filtersRaw.includeKeywords, 'includeKeywords'),
      excludeKeywords: readKeywords(filtersRaw.excludeKeywords, 'excludeKeywords'),
    },
    pollIntervalSec,
    notifyOnBaseline,
    maxItems,
    maxItemsPerMessage,
    message,
  };
}

export function normalizeConfig(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigError('config.json 顶层必须是一个对象');
  }

  const pollIntervalSec = readInt(input.pollIntervalSec, DEFAULT_CONFIG.pollIntervalSec, 'pollIntervalSec', { min: 30 });
  const jitterSec = readInt(input.jitterSec, DEFAULT_CONFIG.jitterSec, 'jitterSec', { min: 0, max: Math.floor(pollIntervalSec / 2) });
  const requestTimeoutMs = readInt(input.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, 'requestTimeoutMs', { min: 5000, max: 120000 });
  const deepScanIntervalHours = readInt(input.deepScanIntervalHours, DEFAULT_CONFIG.deepScanIntervalHours, 'deepScanIntervalHours', { min: 0 });
  const deepScanMaxPages = readInt(input.deepScanMaxPages, DEFAULT_CONFIG.deepScanMaxPages, 'deepScanMaxPages', { min: 1, max: 100 });
  const baselineMaxPages = readInt(input.baselineMaxPages, DEFAULT_CONFIG.baselineMaxPages, 'baselineMaxPages', { min: 1, max: 100 });
  const maxCommentChars = readInt(input.maxCommentChars, DEFAULT_CONFIG.maxCommentChars, 'maxCommentChars', { min: 50, max: 1000 });
  const maxSeenPerPost = readInt(input.maxSeenPerPost, DEFAULT_CONFIG.maxSeenPerPost, 'maxSeenPerPost', { min: 1000, max: 1000000 });

  let heartbeatHour = input.heartbeatHour === undefined ? DEFAULT_CONFIG.heartbeatHour : input.heartbeatHour;
  if (heartbeatHour === null || heartbeatHour === false) {
    heartbeatHour = null;
  } else {
    heartbeatHour = readInt(heartbeatHour, DEFAULT_CONFIG.heartbeatHour, 'heartbeatHour', { min: 0, max: 23 });
  }

  const notifyOnStart = input.notifyOnStart === undefined ? DEFAULT_CONFIG.notifyOnStart : Boolean(input.notifyOnStart);
  const stateFile = readString(input.stateFile, DEFAULT_CONFIG.stateFile, 'stateFile');
  const logDir = readString(input.logDir, DEFAULT_CONFIG.logDir, 'logDir');
  const logLevel = readString(input.logLevel, DEFAULT_CONFIG.logLevel, 'logLevel');
  if (!LOG_LEVELS.has(logLevel)) {
    throw new ConfigError(`logLevel 必须是 ${[...LOG_LEVELS].join(' / ')} 之一`);
  }

  const rawPosts = input.posts === undefined ? DEFAULT_CONFIG.posts : input.posts;
  if (!Array.isArray(rawPosts)) throw new ConfigError('posts 必须是数组（可以为空，但此时必须配置 sites）');

  const rawSites = input.sites === undefined ? DEFAULT_CONFIG.sites : input.sites;
  if (!Array.isArray(rawSites)) throw new ConfigError('sites 必须是数组');

  if (rawPosts.length === 0 && rawSites.length === 0) {
    throw new ConfigError('至少要配置一条微博（posts）或一个站点（sites）');
  }

  const seenIds = new Set();
  const posts = rawPosts.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new ConfigError(`posts[${index}] 必须是对象`);
    const id = String(raw.id ?? '').trim();
    if (!/^\d+$/.test(id)) throw new ConfigError(`posts[${index}].id 必须是纯数字微博 ID`);
    if (seenIds.has(id)) throw new ConfigError(`posts 中存在重复的微博 ID：${id}`);
    seenIds.add(id);

    const name = String(raw.name || `微博 ${id}`).trim();
    const enabled = raw.enabled === undefined ? true : Boolean(raw.enabled);
    const url = raw.url ? String(raw.url).trim() : null;
    if (url && !/^https?:\/\//i.test(url)) throw new ConfigError(`posts[${index}].url 必须是 http/https 地址`);
    return { id, name, enabled, url };
  });

  const filters = input.filters && typeof input.filters === 'object' ? input.filters : {};
  const rawKeywords = filters.excludeKeywords === undefined ? [] : filters.excludeKeywords;
  if (!Array.isArray(rawKeywords)) throw new ConfigError('filters.excludeKeywords 必须是数组');
  const excludeKeywords = rawKeywords
    .map((item) => String(item).trim())
    .filter(Boolean);

  const seenSiteIds = new Set();
  const sites = rawSites.map((raw, index) => normalizeSite(raw, index, seenSiteIds));

  return {
    pollIntervalSec,
    jitterSec,
    requestTimeoutMs,
    deepScanIntervalHours,
    deepScanMaxPages,
    baselineMaxPages,
    heartbeatHour,
    notifyOnStart,
    maxCommentChars,
    maxSeenPerPost,
    stateFile,
    logDir,
    logLevel,
    posts,
    sites,
    filters: { excludeKeywords },
  };
}

export async function loadConfig(configPath) {
  let text;
  try {
    text = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ConfigError(
        `找不到配置文件：${configPath}。请复制 config.example.json 为 config.json，或用配置面板生成。`,
      );
    }
    throw new ConfigError(`读取配置文件失败：${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`config.json 不是合法 JSON：${err.message}`);
  }

  return normalizeConfig(parsed);
}

export function getEnvConfig(env = process.env) {
  const uids = String(env.WXPUSHER_UIDS || '')
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    cookie: String(env.WEIBO_COOKIE || '').trim(),
    wxpusherAppToken: String(env.WXPUSHER_APP_TOKEN || '').trim(),
    wxpusherUids: uids,
    logLevel: String(env.LOG_LEVEL || '').trim(),
  };
}

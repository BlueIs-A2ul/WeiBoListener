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
  filters: {
    excludeKeywords: [],
  },
});

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

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
  if (!Array.isArray(rawPosts) || rawPosts.length === 0) {
    throw new ConfigError('posts 必须是非空数组，至少配置一条微博');
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

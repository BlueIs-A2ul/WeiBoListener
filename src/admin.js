#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ConfigError, DEFAULT_CONFIG, getEnvConfig, normalizeConfig } from './config.js';
import { createLogger } from './logger.js';
import { isProcessAlive } from './lock.js';
import { sendWxPusher } from './notify.js';
import { pollAll } from './poller.js';
import { loadState } from './state.js';
import { fetchApprovalPage, parseCookieExpiry } from './weibo.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_ROOT = path.resolve(HERE, '..');
export const TASK_NAME = 'WeiBoListener';
export const HOST = '127.0.0.1';
export const ENV_KEYS = Object.freeze(['WEIBO_COOKIE', 'WXPUSHER_APP_TOKEN', 'WXPUSHER_UIDS', 'LOG_LEVEL']);

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const MAX_BODY_BYTES = 256 * 1024;
const DAY_MS = 24 * 3600 * 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

// ---------------------------------------------------------------- 纯函数：.env 读写

export function formatEnvValue(value) {
  const text = String(value ?? '');
  if (text === '') return '';
  // 只有会被解析器误读的字符才加引号：首尾空白、#、引号、反斜杠、换行。
  // Cookie 这类含普通空格的值保持无引号，和手写的 .env 风格一致。
  if (!/(^\s|\s$|[#"'`\r\n\\])/.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function parseEnvText(text) {
  const entries = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    entries.set(match[1], match[2].trim());
  }
  return entries;
}

export function updateEnvText(text, updates) {
  const source = String(text ?? '');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source === '' ? [] : source.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const applied = new Set();
  const result = lines.map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/.exec(line);
    if (!match) return line;
    const key = match[1];
    if (!Object.prototype.hasOwnProperty.call(updates, key)) return line;
    applied.add(key);
    return `${key}=${formatEnvValue(updates[key])}`;
  });

  const missing = Object.entries(updates).filter(([key]) => !applied.has(key));
  if (missing.length > 0) {
    if (result.length > 0 && result[result.length - 1] !== '') result.push('');
    for (const [key, value] of missing) result.push(`${key}=${formatEnvValue(value)}`);
  }

  return `${result.join(eol)}${eol}`;
}

export function maskSecret(value) {
  const text = String(value ?? '');
  if (text === '') return { configured: false, tail: '', length: 0 };
  return { configured: true, tail: text.length > 12 ? text.slice(-6) : '', length: text.length };
}

function splitUids(input) {
  const parts = String(input ?? '')
    .split(/[,，;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(parts)];
}

// ---------------------------------------------------------------- 文件读写

async function readEnvFile(root) {
  const file = path.join(root, '.env');
  try {
    const [text, stat] = await Promise.all([fsp.readFile(file, 'utf8'), fsp.stat(file)]);
    const parsed = {};
    for (const [key, raw] of parseEnvText(text)) {
      let value = raw;
      const quoted =
        (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
      if (quoted && value.length > 1) value = value.slice(1, -1);
      parsed[key] = value;
    }
    return { exists: true, file, text, mtimeMs: stat.mtimeMs, parsed, env: getEnvConfig(parsed) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return { exists: false, file, text: '', mtimeMs: null, parsed: {}, env: getEnvConfig({}) };
  }
}

async function readConfigFile(root) {
  const file = path.join(root, 'config.json');
  let text;
  let stat;
  try {
    [text, stat] = await Promise.all([fsp.readFile(file, 'utf8'), fsp.stat(file)]);
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, file, mtimeMs: null, config: null, raw: null };
    throw err;
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new HttpError(400, `config.json 不是合法 JSON：${err.message}`);
  }

  let config;
  try {
    config = normalizeConfig(raw);
  } catch (err) {
    if (err instanceof ConfigError) throw new HttpError(400, err.message);
    throw err;
  }

  return { exists: true, file, mtimeMs: stat.mtimeMs, config, raw };
}

async function readConfigSafe(root) {
  try {
    return await readConfigFile(root);
  } catch (err) {
    return { exists: true, file: path.join(root, 'config.json'), mtimeMs: null, config: null, error: err.message };
  }
}

export async function writeFileAtomic(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, content, 'utf8');
  try {
    await fsp.copyFile(file, `${file}.bak`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'EPERM') {
      await fsp.rm(file, { force: true });
      await fsp.rename(tmp, file);
    } else {
      throw err;
    }
  }
}

function assertMtime(expected, actual, label) {
  if (expected === undefined || expected === null) return;
  if (typeof expected !== 'number' || !Number.isFinite(expected)) throw new HttpError(400, `${label} 的 mtime 不合法`);
  if (actual === null) return;
  if (Math.abs(actual - expected) > 1) {
    throw new HttpError(409, `${label} 已被外部修改，请刷新页面后重试`);
  }
}

// ---------------------------------------------------------------- 进程与计划任务

function decodeOutput(buffer) {
  if (typeof buffer === 'string') return buffer.trim();
  const bytes = buffer ?? Buffer.alloc(0);
  try {
    // schtasks / taskkill 的输出跟随系统控制台代码页（中文系统为 GBK），按 GBK 解码避免乱码。
    return new TextDecoder(process.platform === 'win32' ? 'gbk' : 'utf-8').decode(bytes).trim();
  } catch {
    return Buffer.from(bytes).toString('utf8').trim();
  }
}

function run(cmd, args, { timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, encoding: 'buffer' }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: decodeOutput(stdout), stderr: decodeOutput(stderr) });
    });
  });
}

async function readLock(root) {
  const file = path.join(root, 'data', '.lock');
  try {
    const text = await fsp.readFile(file, 'utf8');
    const pid = Number(text.trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, alive: isProcessAlive(pid) };
  } catch {
    return null;
  }
}

async function getTaskInfo() {
  if (process.platform !== 'win32') return { installed: false, status: null, supported: false };
  const queried = await run('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'CSV', '/NH']);
  if (queried.code !== 0) return { installed: false, status: null, supported: true };
  const fields = queried.stdout.split('\n')[0].split('","').map((item) => item.replace(/^"|"$/g, ''));
  return { installed: true, status: fields[fields.length - 1] || null, supported: true };
}

async function waitFor(predicate, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function waitForNewPid(root, previousPid, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lock = await readLock(root);
    if (lock && lock.alive && lock.pid !== previousPid) return lock.pid;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

let restartQueue = Promise.resolve();

/**
 * 重启监听：先按锁文件 PID 结束真实进程（任务链是 wscript → cmd → node，
 * schtasks /End 只杀 wscript，杀不掉 node），再用 schtasks /Run 拉起。
 */
export function restartListener({ root, force = false } = {}) {
  const task = restartQueue.then(
    () => performRestart({ root, force }),
    () => performRestart({ root, force }),
  );
  restartQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

async function performRestart({ root, force }) {
  const startedAt = Date.now();
  const task = await getTaskInfo();
  if (!task.supported) {
    return { attempted: false, ok: false, reason: 'unsupported', message: '当前系统不支持计划任务重启，请手动重启监听。' };
  }
  if (!task.installed) {
    return {
      attempted: false,
      ok: false,
      reason: 'no-task',
      message: '未检测到计划任务 WeiBoListener，配置已保存，请手动重启监听进程。',
    };
  }

  const lock = await readLock(root);
  const running = Boolean(lock && lock.alive);
  if (!running && !force) {
    return { attempted: false, ok: false, reason: 'not-running', message: '监听当前未运行，配置已保存，未自动启动。' };
  }

  let oldPid = null;
  if (running) {
    oldPid = lock.pid;
    await run('taskkill', ['/PID', String(oldPid), '/T', '/F']);
    const died = await waitFor(() => !isProcessAlive(oldPid), 8000);
    if (!died) {
      return {
        attempted: true,
        ok: false,
        oldPid,
        message: `无法结束旧进程（PID ${oldPid}），请手动重启监听。`,
      };
    }
  }

  // 旧实例从 taskkill 到任务计划真正变为 Ready 有几十毫秒的间隔。
  // 如果此时立刻 /Run，Task Scheduler 可能仍然认为任务在运行，静默忽略本次启动。
  // 显式 /End 一次把任务状态推进到 Ready，再确认状态，然后带重试地 /Run。
  await run('schtasks', ['/End', '/TN', TASK_NAME]);
  await waitFor(
    async () => {
      const info = await getTaskInfo();
      return !/running|正在运行/i.test(info.status || '');
    },
    6000,
  );

  let newPid = null;
  let lastError = '';
  for (let attempt = 0; attempt < 3 && !newPid; attempt += 1) {
    const started = await run('schtasks', ['/Run', '/TN', TASK_NAME]);
    if (started.code !== 0) {
      lastError = started.stderr || started.stdout || '未知错误';
      await new Promise((resolve) => setTimeout(resolve, 1200));
      continue;
    }
    newPid = await waitForNewPid(root, oldPid, 10000);
    if (!newPid) await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  if (!newPid) {
    return {
      attempted: true,
      ok: false,
      oldPid,
      message: lastError
        ? `触发计划任务失败：${lastError}`
        : '已触发重启，但 30 秒内未检测到新的监听进程，请查看 logs/runner.log。',
    };
  }

  return {
    attempted: true,
    ok: true,
    oldPid,
    newPid,
    elapsedMs: Date.now() - startedAt,
    message: oldPid ? `已重启监听：PID ${oldPid} → ${newPid}` : `已启动监听：PID ${newPid}`,
  };
}

// ---------------------------------------------------------------- 只读视图

function normalizePosts(config, state) {
  const posts = [];
  const seen = new Set();
  for (const post of config?.posts || []) {
    seen.add(String(post.id));
    const postState = state?.posts?.[String(post.id)] || null;
    posts.push({
      id: String(post.id),
      name: post.name,
      enabled: post.enabled,
      url: post.url || null,
      inConfig: true,
      baselineDone: Boolean(postState?.baselineDone),
      total: postState?.total ?? null,
      seenCount: Array.isArray(postState?.seen) ? postState.seen.length : 0,
      lastPollAt: postState?.lastPollAt ?? null,
      lastPushAt: postState?.lastPushAt ?? null,
      lastError: postState?.lastError ?? null,
    });
  }
  for (const [id, postState] of Object.entries(state?.posts || {})) {
    if (seen.has(String(id))) continue;
    posts.push({
      id: String(id),
      name: `已移除的微博 ${id}`,
      enabled: false,
      url: null,
      inConfig: false,
      baselineDone: Boolean(postState?.baselineDone),
      total: postState?.total ?? null,
      seenCount: Array.isArray(postState?.seen) ? postState.seen.length : 0,
      lastPollAt: postState?.lastPollAt ?? null,
      lastPushAt: postState?.lastPushAt ?? null,
      lastError: postState?.lastError ?? null,
    });
  }
  return posts;
}

async function readStateSafe(root, config) {
  const stateFile = path.resolve(root, config?.stateFile || 'data/state.json');
  try {
    const { state, recoveredFrom } = await loadState(stateFile);
    return { state, stateFile, recoveredFrom };
  } catch {
    return { state: null, stateFile, recoveredFrom: null };
  }
}

function createCapturingLogger({ level, logDir }) {
  const base = createLogger({ level, logDir });
  const lines = [];
  const wrap = (name) => (message, meta) => {
    const suffix = meta === undefined ? '' : ` ${JSON.stringify(meta)}`;
    lines.push(`[${name.toUpperCase()}] ${message}${suffix}`);
    base[name](message, meta);
  };
  return {
    logger: { level: base.level, debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error') },
    lines,
  };
}

function localDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ---------------------------------------------------------------- HTTP 接口实现

async function apiOverview(ctx) {
  const lock = await readLock(ctx.root);
  const task = await getTaskInfo();
  const envFile = await readEnvFile(ctx.root);
  const configFile = await readConfigSafe(ctx.root);
  const { state } = await readStateSafe(ctx.root, configFile.config);
  const expiry = parseCookieExpiry(envFile.env.cookie);
  const daysLeft = expiry ? Math.floor((expiry.getTime() - Date.now()) / DAY_MS) : null;

  return {
    ok: true,
    listener: { running: Boolean(lock?.alive), pid: lock?.pid ?? null },
    task,
    cookie: {
      configured: Boolean(envFile.env.cookie),
      expiresAt: expiry ? expiry.toISOString() : null,
      daysLeft,
    },
    configError: configFile.config ? null : configFile.error || 'config.json 不存在',
    paths: { root: ctx.root },
    state: {
      updatedAt: state?.updatedAt ?? null,
      authPausedUntil: state?.authPausedUntil ?? null,
      backoffUntil: state?.backoffUntil ?? null,
      lastHeartbeatDate: state?.lastHeartbeatDate ?? null,
      file: path.relative(ctx.root, path.resolve(ctx.root, configFile.config?.stateFile || 'data/state.json')),
      posts: normalizePosts(configFile.config, state),
    },
    now: new Date().toISOString(),
  };
}

async function apiGetConfig(ctx) {
  const file = await readConfigFile(ctx.root);
  return { ok: true, config: file.config, defaults: DEFAULT_CONFIG, mtimeMs: file.mtimeMs, exists: file.exists };
}

async function apiSaveConfig(ctx, req) {
  const body = await readJson(req);
  if (!body || typeof body !== 'object' || !body.config) throw new HttpError(400, '请求体缺少 config 字段');

  const current = await readConfigFile(ctx.root);
  assertMtime(body.mtimeMs, current.mtimeMs, 'config.json');

  let normalized;
  try {
    normalized = normalizeConfig(body.config);
  } catch (err) {
    if (err instanceof ConfigError) throw new HttpError(400, err.message);
    throw err;
  }

  const file = path.join(ctx.root, 'config.json');
  await writeFileAtomic(file, `${JSON.stringify(normalized, null, 2)}\n`);
  const stat = await fsp.stat(file);
  const restart = await ctx.restartListener();

  return { ok: true, config: normalized, mtimeMs: stat.mtimeMs, restart };
}

async function apiGetCredentials(ctx) {
  const envFile = await readEnvFile(ctx.root);
  const configFile = await readConfigSafe(ctx.root);
  const expiry = parseCookieExpiry(envFile.env.cookie);
  const daysLeft = expiry ? Math.floor((expiry.getTime() - Date.now()) / DAY_MS) : null;

  return {
    ok: true,
    cookie: {
      ...maskSecret(envFile.env.cookie),
      expiresAt: expiry ? expiry.toISOString() : null,
      daysLeft,
    },
    appToken: maskSecret(envFile.env.wxpusherAppToken),
    uids: envFile.env.wxpusherUids,
    logLevel: envFile.env.logLevel || configFile.config?.logLevel || 'info',
    exists: envFile.exists,
    mtimeMs: envFile.mtimeMs,
  };
}

async function apiSaveCredentials(ctx, req) {
  const body = await readJson(req);
  if (!body || typeof body !== 'object') throw new HttpError(400, '请求体必须是 JSON 对象');

  const envFile = await readEnvFile(ctx.root);
  assertMtime(body.mtimeMs, envFile.mtimeMs, '.env');

  const updates = {};
  const warnings = [];

  if (typeof body.cookie === 'string' && body.cookie.trim() !== '') {
    const cookie = body.cookie.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (cookie.length < 40) throw new HttpError(400, 'Cookie 长度异常，请确认已完整复制');
    if (!/SUB=/.test(cookie)) warnings.push('Cookie 中未找到 SUB 字段，可能复制不完整');
    if (cookie.length < 100) warnings.push(`Cookie 长度偏短（${cookie.length} 字符），请确认已完整复制`);
    updates.WEIBO_COOKIE = cookie;
  }

  if (typeof body.appToken === 'string' && body.appToken.trim() !== '') {
    const appToken = body.appToken.trim();
    if (!/^AT_/.test(appToken)) warnings.push('AppToken 通常以 AT_ 开头，请确认没有复制错');
    updates.WXPUSHER_APP_TOKEN = appToken;
  }

  if (body.uids !== undefined && body.uids !== null) {
    const uids = splitUids(body.uids);
    for (const uid of uids) {
      if (!/^UID_[A-Za-z0-9_-]+$/i.test(uid)) warnings.push(`UID 格式看起来不常见：${uid}`);
    }
    updates.WXPUSHER_UIDS = uids.join(',');
  }

  if (body.logLevel !== undefined && body.logLevel !== null && String(body.logLevel) !== '') {
    const level = String(body.logLevel);
    if (!LOG_LEVELS.has(level)) throw new HttpError(400, `logLevel 必须是 ${[...LOG_LEVELS].join(' / ')} 之一`);
    updates.LOG_LEVEL = level;
  }

  const keys = Object.keys(updates);
  if (keys.length === 0) throw new HttpError(400, '没有需要保存的改动');

  const file = path.join(ctx.root, '.env');
  const text = updateEnvText(envFile.text, updates);
  await writeFileAtomic(file, text);
  const stat = await fsp.stat(file);
  const restart = await ctx.restartListener();

  return { ok: true, saved: keys, warnings, mtimeMs: stat.mtimeMs, restart };
}

async function apiTestPush(ctx) {
  const envFile = await readEnvFile(ctx.root);
  if (!envFile.env.wxpusherAppToken || envFile.env.wxpusherUids.length === 0) {
    throw new HttpError(400, '尚未配置 WXPUSHER_APP_TOKEN 或 WXPUSHER_UIDS');
  }

  try {
    const result = await sendWxPusher({
      appToken: envFile.env.wxpusherAppToken,
      uids: envFile.env.wxpusherUids,
      content: '微博监听测试消息\n如果你收到这条消息，说明 WxPusher 配置正常。',
      summary: '微博监听测试消息',
      logger: createLogger({ level: 'error', logDir: null, consoleEnabled: false }),
    });
    return { ok: true, message: '测试消息已发送，请检查手机', result: result?.data ?? null };
  } catch (err) {
    throw new HttpError(400, `推送失败：${err.message}`);
  }
}

async function apiTestFetch(ctx) {
  const envFile = await readEnvFile(ctx.root);
  if (!envFile.env.cookie) throw new HttpError(400, '尚未配置 WEIBO_COOKIE');

  const configFile = await readConfigFile(ctx.root);
  const posts = configFile.config.posts.filter((post) => post.enabled);
  if (posts.length === 0) throw new HttpError(400, '没有启用中的微博');

  const results = [];
  for (const post of posts) {
    const startedAt = Date.now();
    try {
      const page = await fetchApprovalPage({
        postId: post.id,
        cookie: envFile.env.cookie,
        timeoutMs: configFile.config.requestTimeoutMs,
      });
      results.push({
        postId: post.id,
        name: post.name,
        ok: true,
        total: page.total,
        fetched: page.comments.length,
        ms: Date.now() - startedAt,
      });
    } catch (err) {
      results.push({
        postId: post.id,
        name: post.name,
        ok: false,
        code: err.code || 'ERROR',
        message: err.message,
        ms: Date.now() - startedAt,
      });
    }
  }

  return { ok: results.every((item) => item.ok), results };
}

async function apiDryRun(ctx) {
  const envFile = await readEnvFile(ctx.root);
  if (!envFile.env.cookie) throw new HttpError(400, '尚未配置 WEIBO_COOKIE');

  const configFile = await readConfigFile(ctx.root);
  const config = configFile.config;
  const { state } = await readStateSafe(ctx.root, config);
  if (!state) throw new HttpError(400, '无法读取状态文件');

  // 试跑使用状态副本：清除暂停/退避标记，且绝不写回磁盘。
  state.authPausedUntil = null;
  state.backoffUntil = null;

  const { logger, lines } = createCapturingLogger({
    level: envFile.env.logLevel || config.logLevel,
    logDir: path.resolve(ctx.root, config.logDir),
  });

  const startedAt = Date.now();
  try {
    const result = await pollAll({
      config,
      state,
      logger,
      dryRun: true,
      fetchPage: ({ postId, maxId }) =>
        fetchApprovalPage({
          postId,
          maxId,
          cookie: envFile.env.cookie,
          timeoutMs: config.requestTimeoutMs,
        }),
      sendMessage: (message) =>
        sendWxPusher({
          ...message,
          appToken: envFile.env.wxpusherAppToken,
          uids: envFile.env.wxpusherUids,
          logger,
        }),
      saveState: async () => {},
      now: () => new Date(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    return { ok: true, durationMs: Date.now() - startedAt, skipped: result.skipped || null, results: result.results, lines };
  } catch (err) {
    return { ok: false, durationMs: Date.now() - startedAt, error: err.message, lines };
  }
}

async function apiLogs(ctx, url) {
  const tailParam = Number(url.searchParams.get('tail') || 100);
  const tail = Number.isFinite(tailParam) ? Math.min(Math.max(Math.trunc(tailParam), 1), 500) : 100;

  const configFile = await readConfigSafe(ctx.root);
  const logDir = path.resolve(ctx.root, configFile.config?.logDir || 'logs');
  const todayFile = path.join(logDir, `app-${localDate(new Date())}.log`);

  let file = todayFile;
  let entries = [];
  try {
    entries = await fsp.readdir(logDir);
  } catch {
    entries = [];
  }

  if (!fs.existsSync(file)) {
    const candidates = entries.filter((name) => /^app-.*\.log$/.test(name)).sort();
    if (candidates.length > 0) file = path.join(logDir, candidates[candidates.length - 1]);
  }

  let text = '';
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    text = '';
  }

  const lines = text.split(/\r?\n/).filter((line) => line !== '');
  return {
    ok: true,
    file: path.relative(ctx.root, file),
    available: entries.filter((name) => /^app-.*\.log$/.test(name)),
    total: lines.length,
    lines: lines.slice(-tail),
  };
}

async function apiRestart(ctx) {
  const restart = await ctx.restartListener({ force: true });
  return { ok: restart.ok, restart };
}

// ---------------------------------------------------------------- HTTP 基础设施

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

export function isAllowedHost(host) {
  if (!host) return false;
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
}

function tokenMatches(provided, expected) {
  if (!provided) return false;
  const given = Buffer.from(String(provided));
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

const ROUTES = {
  'GET /api/overview': (ctx) => apiOverview(ctx),
  'GET /api/config': (ctx) => apiGetConfig(ctx),
  'POST /api/config': (ctx, req) => apiSaveConfig(ctx, req),
  'GET /api/credentials': (ctx) => apiGetCredentials(ctx),
  'POST /api/credentials': (ctx, req) => apiSaveCredentials(ctx, req),
  'POST /api/test-push': (ctx) => apiTestPush(ctx),
  'POST /api/test-fetch': (ctx) => apiTestFetch(ctx),
  'POST /api/dry-run': (ctx) => apiDryRun(ctx),
  'GET /api/logs': (ctx, req, url) => apiLogs(ctx, url),
  'POST /api/restart': (ctx) => apiRestart(ctx),
};

export function createAdminServer({ root = DEFAULT_ROOT, token, htmlPath, autoRestart = true } = {}) {
  if (!token) throw new Error('createAdminServer 需要 token');
  const tokenBuffer = Buffer.from(String(token));
  const page = htmlPath || path.join(HERE, 'admin.html');
  const restartListenerFor = (options = {}) =>
    autoRestart
      ? restartListener({ root, ...options })
      : Promise.resolve({ attempted: false, ok: false, reason: 'disabled', message: '已跳过重启（控制台以 --no-restart 启动）' });

  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );

    try {
      if (!isAllowedHost(req.headers.host)) {
        sendJson(res, 403, { ok: false, error: { message: 'Host 不被允许，请通过 127.0.0.1 访问' } });
        return;
      }

      const origin = req.headers.origin;
      if (origin) {
        let originHost = null;
        try {
          originHost = new URL(origin).host;
        } catch {
          originHost = null;
        }
        if (originHost !== req.headers.host) {
          sendJson(res, 403, { ok: false, error: { message: 'Origin 不被允许' } });
          return;
        }
      }

      const url = new URL(req.url || '/', `http://${req.headers.host}`);

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = await fsp.readFile(page, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (!tokenMatches(req.headers['x-admin-token'], tokenBuffer)) {
        sendJson(res, 401, {
          ok: false,
          error: { message: '缺少或错误的访问令牌，请用控制台启动时打印的完整链接打开' },
        });
        return;
      }

      const handler = ROUTES[`${req.method} ${url.pathname}`];
      if (!handler) {
        sendJson(res, 404, { ok: false, error: { message: `未知接口：${req.method} ${url.pathname}` } });
        return;
      }

      const payload = await handler({ root, restartListener: restartListenerFor }, req, url);
      sendJson(res, 200, payload);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error('[admin] 请求处理失败', err);
      sendJson(res, status, { ok: false, error: { message: err.message || '服务器内部错误' } });
    }
  });
}

// ---------------------------------------------------------------- 启动

function parseArgs(argv) {
  const args = { port: 8787, open: true, root: DEFAULT_ROOT, help: false, autoRestart: true };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') args.port = Number(argv[++index]);
    else if (arg.startsWith('--port=')) args.port = Number(arg.slice('--port='.length));
    else if (arg === '--root') args.root = path.resolve(argv[++index]);
    else if (arg.startsWith('--root=')) args.root = path.resolve(arg.slice('--root='.length));
    else if (arg === '--no-open') args.open = false;
    else if (arg === '--no-restart') args.autoRestart = false;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) {
    throw new Error('--port 必须是 1-65535 的整数');
  }
  return args;
}

const PORT_SCAN_RANGE = 10;

function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * 优先使用 preferred；被占用时依次往后找，最多顺延 attempts 个端口，
 * 仍然不行就交给系统分配（port 0），保证控制台总能启动。
 */
export async function listenWithFallback(server, { host = HOST, preferred, attempts = PORT_SCAN_RANGE } = {}) {
  if (!Number.isInteger(preferred) || preferred <= 0 || preferred > 65535) {
    throw new Error('preferred 必须是 1-65535 的整数');
  }

  const candidates = [];
  for (let offset = 0; offset <= attempts && preferred + offset <= 65535; offset += 1) {
    candidates.push({ port: preferred + offset, mode: offset === 0 ? 'preferred' : 'next' });
  }
  candidates.push({ port: 0, mode: 'ephemeral' });

  let lastError = null;
  for (const candidate of candidates) {
    try {
      await listenOnce(server, candidate.port, host);
      return {
        port: server.address().port,
        preferred,
        fallback: candidate.mode !== 'preferred',
        mode: candidate.mode,
      };
    } catch (err) {
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
      lastError = err;
    }
  }

  throw lastError ?? new Error('没有找到可用端口');
}

function openBrowser(url) {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  execFile(command, args, { windowsHide: true }, () => {});
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`用法：node src/admin.js [--port 8787] [--root <目录>] [--no-open] [--no-restart]

启动本机配置控制台（仅监听 127.0.0.1），启动后在终端打印带一次性令牌的访问地址。
端口被占用时会自动顺延到下一个空闲端口（最多顺延 10 个，再不行由系统分配）。
保存配置后会自动重启计划任务 WeiBoListener（若监听正在运行）。`);
    return;
  }

  const token = crypto.randomBytes(16).toString('hex');
  const server = createAdminServer({ root: args.root, token, autoRestart: args.autoRestart });

  const bound = await listenWithFallback(server, { preferred: args.port });
  if (bound.fallback) {
    const detail =
      bound.mode === 'ephemeral'
        ? `端口 ${args.port} 及其后 ${PORT_SCAN_RANGE} 个端口都被占用，已改用系统分配端口 ${bound.port}`
        : `端口 ${args.port} 已被占用，已自动改用 ${bound.port}`;
    console.log(detail);
  }

  const url = `http://${HOST}:${bound.port}/#t=${token}`;
  console.log('微博监听配置控制台已启动（仅本机可访问）');
  console.log(`  地址：${url}`);
  console.log('  地址中含一次性访问令牌，请勿分享；按 Ctrl+C 关闭控制台。');
  console.log(`  配置目录：${args.root}`);
  if (args.open) openBrowser(url);

  server.on('error', (err) => {
    console.error(`控制台运行异常：${err.message}`);
    process.exitCode = 1;
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (err) => {
    console.error('[admin] uncaughtException', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[admin] unhandledRejection', err);
    process.exit(1);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(`控制台启动失败：${err.stack || err.message}`);
    process.exitCode = 1;
  });
}

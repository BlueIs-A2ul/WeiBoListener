#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { getEnvConfig, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { acquireLock } from './lock.js';
import { sendWxPusher } from './notify.js';
import { pollAll } from './poller.js';
import { loadState, saveState } from './state.js';
import { fetchApprovalPage, fetchStatusMeta, parseCookieExpiry } from './weibo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { once: false, dryRun: false, config: null, help: false, testPush: false };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--once') args.once = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--test-push') args.testPush = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--config') {
      args.config = argv[index + 1];
      if (!args.config) throw new Error('--config 后面需要跟配置文件路径');
      index += 1;
    } else if (arg.startsWith('--config=')) {
      args.config = arg.slice('--config='.length);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`用法：
  node src/index.js                 常驻运行（默认每 5 分钟轮询）
  node src/index.js --once          只轮询一轮后退出
  node src/index.js --dry-run       只打印将要推送的内容，不写状态、不发消息
  node src/index.js --dry-run --once
  node src/index.js --test-push     只发一条 WxPusher 测试消息
  node src/index.js --config=path   指定配置文件

配置：
  config.json   微博列表、轮询间隔、过滤关键词
  .env          WEIBO_COOKIE、WXPUSHER_APP_TOKEN、WXPUSHER_UIDS`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function computeDelay(config, elapsedMs) {
  const base = config.pollIntervalSec * 1000;
  const jitter = config.jitterSec
    ? (Math.random() * 2 - 1) * config.jitterSec * 1000
    : 0;
  return Math.max(5000, base + jitter - elapsedMs);
}

function loadDotEnv(envPath) {
  if (!fs.existsSync(envPath)) return false;
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
    return true;
  }

  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals === -1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
  return true;
}

function logCookieExpiry(cookie, logger) {
  const expiry = parseCookieExpiry(cookie);
  if (!expiry) {
    logger.info('Cookie 中没有找到 ALF 过期时间，无法预判有效期');
    return;
  }

  const days = Math.floor((expiry.getTime() - Date.now()) / (24 * 3600 * 1000));
  if (days < 0) {
    logger.warn(`Cookie 中的 ALF 已过期：${expiry.toLocaleString('zh-CN', { hour12: false })}`);
  } else if (days <= 3) {
    logger.warn(`Cookie 中的 ALF 将在 ${days} 天后过期：${expiry.toLocaleString('zh-CN', { hour12: false })}`);
  } else {
    logger.info(`Cookie 有效期至 ${expiry.toLocaleString('zh-CN', { hour12: false })}（约 ${days} 天）`);
  }
}

async function sendStartupMessage({ config, logger, dryRun, sendMessage, pollResult }) {
  if (!config.notifyOnStart) return;

  const enabledPosts = config.posts.filter((post) => post.enabled);
  const lines = [
    '微博监听已启动',
    `监控：${enabledPosts.length} 条微博`,
    `轮询间隔：${Math.round(config.pollIntervalSec / 60)} 分钟`,
  ];

  if (pollResult.skipped === 'auth') {
    lines.push('状态：Cookie 失效，已暂停轮询');
  } else if (pollResult.skipped === 'backoff') {
    lines.push('状态：微博限流退避中');
  } else {
    const baselineResults = pollResult.results.filter((item) => item.baseline);
    const totalComments = pollResult.results.reduce((sum, item) => sum + (item.total || 0), 0);
    const failedResults = pollResult.results.filter((item) => item.ok === false);
    if (baselineResults.length > 0) {
      lines.push(`当前待审：${totalComments} 条`, '已建立基线，之后只推送新评论');
    } else {
      lines.push(`当前待审：${totalComments} 条`, '状态：已恢复监听');
    }
    if (failedResults.length > 0) {
      lines.push(`警告：${failedResults.length} 条微博本轮失败，详见日志`);
    }
  }

  const content = lines.join('\n');
  if (dryRun) {
    logger.info(`[dry-run] 启动消息：\n${content}`);
    return;
  }

  try {
    await sendMessage({ content, summary: '微博监听已启动' });
    logger.info('启动消息已发送');
  } catch (err) {
    logger.error('启动消息发送失败', { error: err.message });
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const configPath = args.config ? path.resolve(args.config) : path.join(ROOT, 'config.json');
  const envPath = path.join(ROOT, '.env');

  if (loadDotEnv(envPath)) {
    // env 已加载
  } else {
    console.warn(`未找到 ${envPath}，将使用系统环境变量`);
  }

  const env = getEnvConfig(process.env);
  const config = await loadConfig(configPath);

  const logger = createLogger({
    level: env.logLevel || config.logLevel,
    logDir: path.resolve(ROOT, config.logDir),
  });

  logger.info(`微博监听启动（Node ${process.version}，${process.platform}）`);
  logger.info(`配置文件：${configPath}`);
  logger.info(
    `监控 ${config.posts.filter((post) => post.enabled).length} 条微博，轮询间隔 ${config.pollIntervalSec} 秒，抖动 ±${config.jitterSec} 秒${args.dryRun ? '，dry-run 模式' : ''}`,
  );

  if (args.testPush) {
    if (!env.wxpusherAppToken || env.wxpusherUids.length === 0) {
      logger.error('缺少 WxPusher 配置。请在 .env 中填入 WXPUSHER_APP_TOKEN 和 WXPUSHER_UIDS');
      process.exitCode = 1;
      return;
    }

    try {
      await sendWxPusher({
        appToken: env.wxpusherAppToken,
        uids: env.wxpusherUids,
        content: '微博监听测试消息\n如果你收到这条消息，说明 WxPusher 配置正常。',
        summary: '微博监听测试消息',
        logger,
      });
      logger.info('WxPusher 测试消息已发送，请检查手机');
    } catch (err) {
      logger.error('WxPusher 测试消息发送失败', { error: err.message });
      process.exitCode = 1;
    }
    return;
  }

  if (!env.cookie) {
    logger.error('缺少 WEIBO_COOKIE。请复制 .env.example 为 .env 并填入微博 Cookie');
    process.exitCode = 1;
    return;
  }

  if (!args.dryRun && (!env.wxpusherAppToken || env.wxpusherUids.length === 0)) {
    logger.error('缺少 WxPusher 配置。请在 .env 中填入 WXPUSHER_APP_TOKEN 和 WXPUSHER_UIDS，或先用 --dry-run 测试');
    process.exitCode = 1;
    return;
  }

  logCookieExpiry(env.cookie, logger);

  const stateFile = path.resolve(ROOT, config.stateFile);
  const { state, recoveredFrom } = await loadState(stateFile, { logger });
  if (recoveredFrom) {
    logger.warn(`状态文件损坏，已从备份恢复：${recoveredFrom}`);
  }

  if (state.authPausedUntil || state.backoffUntil) {
    logger.info('启动时清除上次的暂停/退避状态（如果 Cookie 已更新，可立即恢复）');
    state.authPausedUntil = null;
    state.backoffUntil = null;
  }

  let releaseLock = () => {};
  if (!args.dryRun) {
    try {
      releaseLock = acquireLock(path.join(ROOT, 'data', '.lock'), logger);
    } catch (err) {
      logger.error(err.message);
      process.exitCode = 1;
      return;
    }
  }

  process.on('exit', () => releaseLock());
  process.on('SIGINT', () => {
    logger.info('收到 SIGINT，准备退出');
    releaseLock();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    logger.info('收到 SIGTERM，准备退出');
    releaseLock();
    process.exit(0);
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', { error: err.stack || err.message });
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    logger.error('unhandledRejection', { error: err?.stack || err?.message || String(err) });
    process.exit(1);
  });

  const fetchPage = ({ postId, maxId }) =>
    fetchApprovalPage({
      postId,
      maxId,
      cookie: env.cookie,
      timeoutMs: config.requestTimeoutMs,
      fetchImpl: fetch,
    });

  const sendMessage = (message) =>
    sendWxPusher({
      ...message,
      appToken: env.wxpusherAppToken,
      uids: env.wxpusherUids,
      logger,
    });

  for (const post of config.posts.filter((item) => item.enabled)) {
    if (post.url) continue;
    try {
      const meta = await fetchStatusMeta({
        postId: post.id,
        cookie: env.cookie,
        timeoutMs: config.requestTimeoutMs,
        fetchImpl: fetch,
      });
      post.url = meta.url;
      logger.info(`[${post.name}] 微博链接：${post.url}`);
    } catch (err) {
      logger.warn(`[${post.name}] 无法解析微博链接，将使用移动端默认链接`, {
        error: err.message,
      });
    }
  }

  const saveCurrentState = () => saveState(stateFile, state);
  let firstCycle = true;

  if (
    firstCycle &&
    config.notifyOnStart &&
    config.heartbeatHour !== null &&
    new Date().getHours() >= config.heartbeatHour &&
    !state.lastHeartbeatDate
  ) {
    // 首次启动的启动消息已经相当于一次心跳，避免同一天连发两条
    state.lastHeartbeatDate = localDate(new Date());
    logger.info('首次启动消息将代替今日心跳');
  }

  for (;;) {
    const startedAt = Date.now();
    try {
      const pollResult = await pollAll({
        config,
        state,
        logger,
        dryRun: args.dryRun,
        fetchPage,
        sendMessage,
        saveState: saveCurrentState,
        now: () => new Date(),
        sleep,
      });

      if (firstCycle) {
        await sendStartupMessage({ config, logger, dryRun: args.dryRun, sendMessage, pollResult });
        firstCycle = false;
      }

      if (args.once) break;

      const delay = computeDelay(config, Date.now() - startedAt);
      logger.info(`下一轮将在约 ${Math.round(delay / 1000)} 秒后开始`);
      await sleep(delay);
    } catch (err) {
      logger.error('主循环异常', { error: err.stack || err.message });
      if (args.once) {
        process.exitCode = 1;
        break;
      }
      await sleep(30000);
    }
  }

  if (!args.dryRun) await saveState(stateFile, state);
  logger.info('监听已退出');
}

main().catch((err) => {
  console.error(`启动失败：${err.stack || err.message}`);
  process.exitCode = 1;
});

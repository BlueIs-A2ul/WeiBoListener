import {
  findNewComments,
  isAtOrOlderThanBaseline,
  isDeepScanDue,
  minId,
  partitionExcluded,
  uniqueById,
} from './diff.js';
import { formatMessageChunks } from './format.js';
import { ensurePostState, markSeen, seenSet } from './state.js';

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function localDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export async function pollPost({
  post,
  config,
  state,
  logger,
  dryRun = false,
  fetchPage,
  sendMessage,
  saveState = async () => {},
  now = () => new Date(),
}) {
  const postState = ensurePostState(state, post.id);
  const first = await fetchPage({ postId: post.id });
  const fetched = [...first.comments];
  let cursor = first.maxId;
  let pages = 1;

  if (!postState.baselineDone) {
    while (cursor && cursor !== '0' && pages < config.baselineMaxPages) {
      const next = await fetchPage({ postId: post.id, maxId: cursor });
      fetched.push(...next.comments);
      cursor = next.maxId;
      pages += 1;
      if (!next.comments.length) break;
    }

    const unique = uniqueById(fetched);
    const timestamp = now().toISOString();
    markSeen(postState, unique.map((comment) => comment.id), config.maxSeenPerPost);
    postState.baselineDone = true;
    postState.baselineAt = timestamp;
    postState.baselineMinId = minId(unique);
    postState.lastPollAt = timestamp;
    postState.lastDeepScanAt = timestamp;
    postState.total = first.total;
    postState.lastError = null;

    if (!dryRun) await saveState();

    logger.info(
      `[${post.name}] 已建立基线：${unique.length} 条（接口 total=${first.total ?? '未知'}）`,
    );
    return {
      postId: post.id,
      baseline: true,
      total: first.total,
      fetched: unique.length,
      newCount: 0,
      pushed: 0,
    };
  }

  const seen = seenSet(postState);
  let newComments = findNewComments(first.comments, seen);
  const oldestOnFirstPage = first.comments[first.comments.length - 1];
  const pageBoundaryIsNew = oldestOnFirstPage ? !seen.has(String(oldestOnFirstPage.id)) : false;
  const deepScanDue = isDeepScanDue(postState, now(), config.deepScanIntervalHours);
  const needOlder = (pageBoundaryIsNew && first.comments.length >= 20) || deepScanDue;
  let didDeepScan = false;

  if (needOlder) {
    didDeepScan = deepScanDue;
    const maxPages = deepScanDue ? config.deepScanMaxPages : 5;

    while (cursor && cursor !== '0' && pages < maxPages) {
      const next = await fetchPage({ postId: post.id, maxId: cursor });
      if (!next.comments.length) {
        cursor = next.maxId;
        break;
      }

      fetched.push(...next.comments);
      const pageMin = minId(next.comments);
      const reachedBaseline =
        postState.baselineMinId && pageMin && isAtOrOlderThanBaseline(pageMin, postState.baselineMinId);

      cursor = next.maxId;
      pages += 1;
      if (reachedBaseline) break;
    }
  }

  const unique = uniqueById(fetched);
  newComments = findNewComments(unique, seenSet(postState));
  const { included, excluded } = partitionExcluded(newComments, config.filters.excludeKeywords);

  const timestamp = now().toISOString();
  postState.lastPollAt = timestamp;
  postState.total = first.total;
  postState.lastError = null;
  if (didDeepScan) postState.lastDeepScanAt = timestamp;

  if (excluded.length > 0) {
    logger.info(`[${post.name}] 忽略 ${excluded.length} 条命中排除关键词的评论`);
    if (!dryRun) markSeen(postState, excluded.map((comment) => comment.id), config.maxSeenPerPost);
  }

  if (included.length === 0) {
    if (!dryRun) await saveState();
    return {
      postId: post.id,
      baseline: false,
      total: first.total,
      fetched: unique.length,
      newCount: 0,
      pushed: 0,
    };
  }

  const postUrl = post.url || `https://m.weibo.cn/status/${post.id}`;
  const chunks = formatMessageChunks(post, included, {
    maxChars: config.maxCommentChars,
    postUrl,
    maxChunkChars: 8000,
  });

  if (dryRun) {
    for (const chunk of chunks) {
      logger.info(`[dry-run] 准备推送 ${chunk.commentIds.length} 条评论：\n${chunk.content}`);
    }
    return {
      postId: post.id,
      baseline: false,
      total: first.total,
      fetched: unique.length,
      newCount: included.length,
      pushed: 0,
      dryRun: true,
    };
  }

  let pushed = 0;
  try {
    for (const chunk of chunks) {
      await sendMessage({
        content: chunk.content,
        summary: chunk.summary,
        url: postUrl,
      });
      markSeen(postState, chunk.commentIds, config.maxSeenPerPost);
      pushed += chunk.commentIds.length;
      await saveState();
    }
  } catch (err) {
    postState.lastError = {
      at: now().toISOString(),
      message: err.message,
      code: err.code || null,
    };
    await saveState();
    throw err;
  }

  postState.lastNewAt = timestamp;
  postState.lastPushAt = now().toISOString();
  await saveState();

  logger.info(`[${post.name}] 已推送 ${pushed} 条新评论`);
  return {
    postId: post.id,
    baseline: false,
    total: first.total,
    fetched: unique.length,
    newCount: included.length,
    pushed,
  };
}

async function maybeAuthAlert({ state, logger, dryRun, sendMessage, now, error }) {
  const lastAlert = state.authAlertAt ? new Date(state.authAlertAt).getTime() : 0;
  if (now().getTime() - lastAlert < 12 * 3600 * 1000) return;

  const content = [
    '微博监听 Cookie 失效',
    error.message,
    '请更新 .env 中的 WEIBO_COOKIE，然后重启程序。',
  ].join('\n');

  if (dryRun) {
    logger.warn('[dry-run] 将发送 Cookie 失效告警');
    state.authAlertAt = now().toISOString();
    return;
  }

  try {
    await sendMessage({ content, summary: '微博监听 Cookie 失效' });
    state.authAlertAt = now().toISOString();
    logger.warn('Cookie 失效告警已发送');
  } catch (err) {
    logger.error('Cookie 失效告警发送失败', { error: err.message });
  }
}

async function maybeHeartbeat({ config, state, logger, dryRun, sendMessage, now }) {
  if (config.heartbeatHour === null || config.heartbeatHour === undefined) return;

  const current = now();
  if (current.getHours() < config.heartbeatHour) return;

  const today = localDate(current);
  if (state.lastHeartbeatDate === today) return;

  const enabledPosts = config.posts.filter((post) => post.enabled).length;
  const content = [
    '微博监听心跳',
    '状态：正常',
    `监控：${enabledPosts} 条微博`,
    `时间：${current.toLocaleString('zh-CN', { hour12: false })}`,
  ].join('\n');

  if (dryRun) {
    logger.info('[dry-run] 将发送每日心跳');
    state.lastHeartbeatDate = today;
    return;
  }

  try {
    await sendMessage({ content, summary: '微博监听正常运行' });
    state.lastHeartbeatDate = today;
    logger.info('每日心跳已发送');
  } catch (err) {
    logger.error('每日心跳发送失败', { error: err.message });
  }
}

export async function pollAll({
  config,
  state,
  logger,
  dryRun = false,
  fetchPage,
  sendMessage,
  saveState = async () => {},
  now = () => new Date(),
  sleep = defaultSleep,
}) {
  const current = now();

  if (state.authPausedUntil && new Date(state.authPausedUntil) > current) {
    logger.warn(`Cookie 失效暂停中，至 ${state.authPausedUntil}`);
    return { results: [], skipped: 'auth' };
  }
  if (state.backoffUntil && new Date(state.backoffUntil) > current) {
    logger.warn(`微博限流退避中，至 ${state.backoffUntil}`);
    return { results: [], skipped: 'backoff' };
  }

  const posts = config.posts.filter((post) => post.enabled);
  const results = [];
  let stopRemaining = false;

  for (let index = 0; index < posts.length; index += 1) {
    const post = posts[index];

    if (stopRemaining) {
      results.push({ postId: post.id, skipped: true });
      continue;
    }

    try {
      const result = await pollPost({
        post,
        config,
        state,
        logger,
        dryRun,
        fetchPage,
        sendMessage,
        saveState,
        now,
      });
      results.push(result);
      state.authPausedUntil = null;
      state.backoffUntil = null;
    } catch (err) {
      logger.error(`[${post.name}] 轮询失败：${err.message}`, {
        code: err.code || null,
        status: err.status || null,
      });

      const postState = ensurePostState(state, post.id);
      postState.lastError = {
        at: now().toISOString(),
        message: err.message,
        code: err.code || null,
        status: err.status || null,
      };
      results.push({ postId: post.id, ok: false, error: err.message, code: err.code || null });

      if (err.code === 'WEIBO_AUTH') {
        stopRemaining = true;
        state.authPausedUntil = new Date(now().getTime() + 30 * 60 * 1000).toISOString();
        await maybeAuthAlert({ state, logger, dryRun, sendMessage, now, error: err });
      } else if (err.code === 'WEIBO_RATE_LIMIT') {
        stopRemaining = true;
        state.backoffUntil = new Date(now().getTime() + 10 * 60 * 1000).toISOString();
      }
    }

    if (!dryRun) await saveState();
    if (index < posts.length - 1) await sleep(1000 + Math.floor(Math.random() * 1000));
  }

  if (!stopRemaining && !state.authPausedUntil && !state.backoffUntil) {
    await maybeHeartbeat({ config, state, logger, dryRun, sendMessage, now });
  }

  if (!dryRun) await saveState();
  return { results };
}

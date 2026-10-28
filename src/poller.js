import {
  findNewComments,
  isAtOrOlderThanBaseline,
  isDeepScanDue,
  minId,
  partitionExcluded,
  uniqueById,
} from './diff.js';
import { formatMessageChunks } from './format.js';
import {
  maybeAuthAlert,
  maybeCookieExpiryAlert,
  maybeFailureAlert,
  maybeHeartbeat,
} from './alerts.js';
import { ensurePostState, markSeen, seenSet } from './state.js';
import { pollSites } from './watch.js';

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  cookieExpiry = null,
  // 通用站点（config.sites）：cookieForSite 按站点读取各自的 .env 键
  cookieForSite = () => '',
  fetchDocumentImpl,
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
  let okCount = 0;
  let failCount = 0;
  let skippedCount = 0;
  let pushedTotal = 0;
  let lastError = null;

  for (let index = 0; index < posts.length; index += 1) {
    const post = posts[index];

    if (stopRemaining) {
      results.push({ postId: post.id, skipped: true });
      skippedCount += 1;
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
      okCount += 1;
      pushedTotal += Number(result.pushed) || 0;
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
      failCount += 1;
      lastError = { name: post.name, message: err.message, code: err.code || null };

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

  // 通用站点：与微博互不影响，单个站点失败只记在它自己的状态里
  let siteResults = [];
  let siteCycle = { total: 0, ok: 0, failed: 0, skipped: 0, lastError: null };
  const enabledSites = (config.sites || []).filter((site) => site.enabled);
  if (enabledSites.length > 0) {
    const outcome = await pollSites({
      sites: enabledSites,
      config,
      state,
      logger,
      dryRun,
      cookieForSite,
      sendMessage,
      saveState,
      now,
      sleep,
      fetchDocumentImpl,
    });
    siteResults = outcome.results;
    siteCycle = outcome.cycle;
    pushedTotal += siteResults.reduce((sum, item) => sum + (Number(item.pushed) || 0), 0);
  }

  const totalOk = okCount + siteCycle.ok;
  const totalFailed = failCount + siteCycle.failed;
  const cycle = {
    posts: posts.length,
    sites: siteCycle.total,
    ok: totalOk,
    failed: totalFailed,
    skipped: skippedCount + siteCycle.skipped,
    lastError: lastError || siteCycle.lastError,
    siteResults: { ok: siteCycle.ok, failed: siteCycle.failed, skipped: siteCycle.skipped },
  };

  // 健康度：只看这一轮到底有没有真的抓成功，避免心跳在全部失败时仍然报"正常"。
  state.lastCycleAt = now().toISOString();
  if (totalOk > 0) {
    state.lastSuccessAt = state.lastCycleAt;
    state.failStreak = 0;
    state.failAlertAt = null;
  } else if (totalFailed > 0) {
    state.failStreak = (Number(state.failStreak) || 0) + 1;
  }
  if (pushedTotal > 0) state.lastPushAt = now().toISOString();

  await maybeFailureAlert({ state, cycle, logger, dryRun, sendMessage, now });
  if (!stopRemaining && !state.authPausedUntil && !state.backoffUntil) {
    await maybeHeartbeat({ config, state, cycle, logger, dryRun, sendMessage, now });
  }
  await maybeCookieExpiryAlert({ state, expiry: cookieExpiry, logger, dryRun, sendMessage, now });

  if (!dryRun) await saveState();
  return { results, siteResults, cycle };
}
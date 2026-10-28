import { extractItems } from './extract.js';
import { formatSiteMessages } from './format.js';
import { fetchDocument, FetchError } from './http.js';
import { ensureSiteState, markSiteSeen, siteSeenSet } from './state.js';

/** Cookie 失效后暂停该站点多久（避免每轮都去撞登录页）。 */
export const AUTH_PAUSE_MS = 30 * 60 * 1000;
/** 限流退避时长。 */
export const BACKOFF_MS = 10 * 60 * 1000;
/** Cookie 失效告警的最小间隔。 */
export const AUTH_ALERT_WINDOW_MS = 12 * 3600 * 1000;

/** 这些失败类型都按「Cookie 失效 / 需要重新登录」处理。 */
const AUTH_CODES = new Set(['HTTP_AUTH', 'EXTRACT_HTML']);

export function isAuthFailure(err) {
  return AUTH_CODES.has(err?.code);
}

/** includeKeywords（命中才要）与 excludeKeywords（命中丢弃），作用于标题、正文与附加字段。 */
export function applyFilters(items, filters = {}) {
  const include = (filters.includeKeywords || []).map((word) => String(word).trim().toLowerCase()).filter(Boolean);
  const exclude = (filters.excludeKeywords || []).map((word) => String(word).trim().toLowerCase()).filter(Boolean);
  if (include.length === 0 && exclude.length === 0) return items;

  const haystack = (item) =>
    [item.title, item.text, ...(item.fields || []).map((field) => field.value)]
      .filter(Boolean)
      .join('\n')
      .toLowerCase();

  return items.filter((item) => {
    const text = haystack(item);
    if (exclude.some((word) => text.includes(word))) return false;
    if (include.length > 0 && !include.some((word) => text.includes(word))) return false;
    return true;
  });
}

function originOf(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return '';
  }
}

export function siteRequestOptions(site, config) {
  return {
    url: site.request.url,
    method: site.request.method,
    headers: site.request.headers,
    body: site.request.body,
    timeoutMs: site.request.timeoutMs ?? config.requestTimeoutMs,
    encoding: site.request.encoding,
  };
}

/**
 * 抓一个站点：首次建立基线；之后只推送新增条目。
 * 与微博的 pollPost 保持同一套约定：推送成功后才标记已见，逐块落盘。
 */
export async function pollSite({
  site,
  config,
  state,
  logger,
  dryRun = false,
  cookie,
  sendMessage,
  saveState = async () => {},
  now = () => new Date(),
  fetchDocumentImpl = fetchDocument,
} = {}) {
  const siteState = ensureSiteState(state, site.id);
  const current = now();

  if (siteState.authPausedUntil && new Date(siteState.authPausedUntil) > current) {
    logger.warn(`[${site.name}] Cookie 疑似失效，暂停中至 ${siteState.authPausedUntil}`);
    return { siteId: site.id, skipped: 'auth' };
  }
  if (siteState.backoffUntil && new Date(siteState.backoffUntil) > current) {
    logger.warn(`[${site.name}] 限流退避中，至 ${siteState.backoffUntil}`);
    return { siteId: site.id, skipped: 'backoff' };
  }

  // 站点可以有自己的轮询间隔：没到点就跳过一次，不必每轮都请求
  const intervalMs = Number(site.pollIntervalSec) > 0 ? Number(site.pollIntervalSec) * 1000 : 0;
  if (intervalMs > 0 && siteState.lastPollAt) {
    const lastPolled = new Date(siteState.lastPollAt).getTime();
    if (Number.isFinite(lastPolled) && current.getTime() - lastPolled < intervalMs) {
      if (typeof logger.debug === 'function') logger.debug('[' + site.name + '] 未到轮询间隔，本轮跳过');
      return { siteId: site.id, skipped: 'interval' };
    }
  }

  if (!cookie) {
    throw new FetchError(
      `没有配置站点 Cookie：请在 .env 里填入 ${site.request.cookieEnv}（面板「站点」页可以直接粘贴）`,
      { code: 'HTTP_AUTH', retryable: false },
    );
  }

  const doc = await fetchDocumentImpl({ ...siteRequestOptions(site, config), cookie });
  const items = extractItems({ site, body: doc.text, baseUrl: originOf(site.request.url) });
  const filtered = applyFilters(items, site.filters);
  const timestamp = current.toISOString();

  if (!siteState.baselineDone) {
    if (!dryRun) {
      markSiteSeen(siteState, filtered.map((item) => item.id), config.maxSeenPerPost);
      siteState.baselineDone = true;
      siteState.baselineAt = timestamp;
      siteState.baselineCount = filtered.length;
      siteState.lastPollAt = timestamp;
      siteState.lastError = null;
      await saveState();
    }
    logger.info(`[${site.name}] 已建立基线：${filtered.length} 条（之后只推送新增）`);

    if (dryRun && filtered.length > 0) {
      for (const message of formatSiteMessages(site, filtered.slice(0, 3), {
        maxItemsPerMessage: site.maxItemsPerMessage,
        maxChars: config.maxCommentChars,
      })) {
        logger.info(`[dry-run] [${site.name}] 基线样例：\n${message.content}`);
      }
    }

    return { siteId: site.id, baseline: true, total: filtered.length, newCount: 0, pushed: 0 };
  }

  const seen = siteSeenSet(siteState);
  const fresh = filtered.filter((item) => !seen.has(item.id));
  siteState.lastPollAt = timestamp;
  siteState.lastError = null;

  if (fresh.length === 0) {
    if (!dryRun) await saveState();
    return { siteId: site.id, total: filtered.length, newCount: 0, pushed: 0 };
  }

  const chunks = formatSiteMessages(site, fresh, {
    maxItemsPerMessage: site.maxItemsPerMessage,
    maxChars: config.maxCommentChars,
  });

  if (dryRun) {
    for (const chunk of chunks) {
      logger.info(`[dry-run] [${site.name}] 将推送 ${chunk.itemIds.length} 条：\n${chunk.content}`);
    }
    return { siteId: site.id, total: filtered.length, newCount: fresh.length, pushed: 0, dryRun: true };
  }

  let pushed = 0;
  try {
    for (const chunk of chunks) {
      await sendMessage({ content: chunk.content, summary: chunk.summary, url: site.request.url });
      markSiteSeen(siteState, chunk.itemIds, config.maxSeenPerPost);
      pushed += chunk.itemIds.length;
      await saveState();
    }
  } catch (err) {
    siteState.lastError = { at: now().toISOString(), message: err.message, code: err.code || null };
    await saveState();
    throw err;
  }

  siteState.lastNewAt = timestamp;
  siteState.lastPushAt = now().toISOString();
  await saveState();

  logger.info(`[${site.name}] 已推送 ${pushed} 条新条目`);
  return { siteId: site.id, total: filtered.length, newCount: fresh.length, pushed };
}

/** Cookie 失效告警：同一站点 12 小时内只发一次。 */
export async function maybeSiteAuthAlert({ site, siteState, logger, dryRun = false, sendMessage, now, error }) {
  const current = now();
  const lastAlert = siteState.authAlertAt ? new Date(siteState.authAlertAt).getTime() : 0;
  if (current.getTime() - lastAlert < AUTH_ALERT_WINDOW_MS) return false;

  const content = [
    `站点抓取失败：${site.name}`,
    error.message,
    `已暂停该站点 30 分钟；更新 Cookie 后会自动恢复。`,
    `Cookie 存在 .env 的 ${site.request.cookieEnv}`,
  ].join('\n');

  if (dryRun) {
    logger.warn(`[dry-run] 将发送站点失效告警：\n${content}`);
    siteState.authAlertAt = current.toISOString();
    return false;
  }

  try {
    await sendMessage({ content, summary: `站点失效：${site.name}`.slice(0, 100) });
    siteState.authAlertAt = current.toISOString();
    logger.warn(`[${site.name}] Cookie 失效告警已发送`);
    return true;
  } catch (err) {
    logger.error(`[${site.name}] 失效告警发送失败`, { error: err.message });
    return false;
  }
}

/**
 * 逐站点抓取。单个站点失败只影响自己：认证失败暂停该站点，限流短暂退避，其余计入连续失败。
 */
export async function pollSites({
  sites = [],
  config,
  state,
  logger,
  dryRun = false,
  cookieForSite = () => '',
  sendMessage,
  saveState = async () => {},
  now = () => new Date(),
  sleep = async () => {},
  fetchDocumentImpl = fetchDocument,
} = {}) {
  const enabled = sites.filter((site) => site.enabled);
  const cycle = { total: enabled.length, ok: 0, failed: 0, skipped: 0, lastError: null };
  const results = [];

  for (let index = 0; index < enabled.length; index += 1) {
    const site = enabled[index];
    try {
      const result = await pollSite({
        site,
        config,
        state,
        logger,
        dryRun,
        cookie: cookieForSite(site),
        sendMessage,
        saveState,
        now,
        fetchDocumentImpl,
      });
      results.push(result);
      if (result.skipped) cycle.skipped += 1;
      else cycle.ok += 1;
      if (!result.skipped) {
        siteStateReset(ensureSiteState(state, site.id));
      }
    } catch (err) {
      const siteState = ensureSiteState(state, site.id);
      siteState.lastError = {
        at: now().toISOString(),
        message: err.message,
        code: err.code || null,
      };
      results.push({ siteId: site.id, ok: false, error: err.message, code: err.code || null });
      cycle.failed += 1;
      cycle.lastError = { name: site.name, message: err.message, code: err.code || null };
      logger.error(`[${site.name}] 抓取失败：${err.message}`, { code: err.code || null });

      if (isAuthFailure(err)) {
        siteState.authPausedUntil = new Date(now().getTime() + AUTH_PAUSE_MS).toISOString();
        await maybeSiteAuthAlert({ site, siteState, logger, dryRun, sendMessage, now, error: err });
      } else if (err.code === 'HTTP_RATE_LIMIT') {
        siteState.backoffUntil = new Date(now().getTime() + BACKOFF_MS).toISOString();
      }
      if (!dryRun) await saveState();
    }

    if (index < enabled.length - 1) await sleep(1000 + Math.floor(Math.random() * 1000));
  }

  return { results, cycle };
}

/** 抓取成功后清掉上次的暂停/退避标记（Cookie 已经修好的情况）。 */
function siteStateReset(siteState) {
  siteState.authPausedUntil = null;
  siteState.backoffUntil = null;
}

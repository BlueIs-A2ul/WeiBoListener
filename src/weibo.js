import { cleanCommentText, parseWeiboDate } from './format.js';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export class WeiboError extends Error {
  constructor(message, { code = 'WEIBO_ERROR', status = null, retryable = true } = {}) {
    super(message);
    this.name = 'WeiboError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export class WeiboAuthError extends WeiboError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'WEIBO_AUTH', retryable: false });
    this.name = 'WeiboAuthError';
  }
}

export class WeiboRateLimitError extends WeiboError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'WEIBO_RATE_LIMIT' });
    this.name = 'WeiboRateLimitError';
  }
}

export class WeiboApiError extends WeiboError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'WEIBO_API' });
    this.name = 'WeiboApiError';
  }
}

export function parseCookieExpiry(cookie) {
  const match = /(?:^|;\s*)ALF=(\d+)/.exec(String(cookie ?? ''));
  if (!match) return null;
  const timestamp = Number(match[1]);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Date(timestamp * 1000);
}

export function buildApprovalUrl(postId, maxId) {
  const url = new URL('https://weibo.com/ajax/approval/list');
  url.searchParams.set('id', String(postId));
  url.searchParams.set('count', '20');
  url.searchParams.set('filter_type', '0');
  url.searchParams.set('is_reload', '1');
  url.searchParams.set('scene', 'approval');
  if (maxId !== undefined && maxId !== null && String(maxId) !== '' && String(maxId) !== '0') {
    url.searchParams.set('max_id', String(maxId));
  }
  return url.toString();
}

export function normalizeComment(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new WeiboApiError('评论数据格式错误');
  }
  const id = String(raw.idstr ?? raw.id ?? '').trim();
  if (!/^\d+$/.test(id)) {
    throw new WeiboApiError(`评论缺少合法的 ID：${id || '空'}`);
  }
  const rootId = String(raw.rootidstr ?? raw.rootid ?? id);
  const createdAtRaw = String(raw.created_at ?? '');
  const text = cleanCommentText(raw.text ?? '');

  return {
    id,
    rootId,
    isTopLevel: rootId === id,
    floor: Number.isFinite(raw.floor_number) ? raw.floor_number : null,
    createdAtRaw,
    createdAt: parseWeiboDate(createdAtRaw),
    text,
    rawText: String(raw.text ?? ''),
    user: {
      id: String(raw.user?.idstr ?? raw.user?.id ?? ''),
      name: String(raw.user?.screen_name || raw.user?.name || '未知用户'),
    },
    likeCounts: Number.isFinite(raw.like_counts) ? raw.like_counts : null,
  };
}

function isLoginRedirect(url, redirected) {
  if (!url) return false;
  if (url.includes('passport.weibo.com') || url.includes('login.sina.com.cn') || url.includes('visitor.passport')) {
    return true;
  }
  return Boolean(redirected && /passport|login|visitor/i.test(url));
}

export async function fetchStatusMeta({
  postId,
  cookie,
  timeoutMs = 15000,
  fetchImpl = fetch,
  userAgent = DEFAULT_USER_AGENT,
}) {
  if (!cookie) throw new WeiboAuthError('缺少微博 Cookie，请在 .env 中配置 WEIBO_COOKIE');

  const url = `https://weibo.com/ajax/statuses/show?id=${encodeURIComponent(String(postId))}`;
  let response;

  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        cookie,
        'user-agent': userAgent,
        referer: 'https://weibo.com/',
        accept: 'application/json, text/plain, */*',
        'x-requested-with': 'XMLHttpRequest',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new WeiboError(`请求微博详情超时（${timeoutMs}ms）`, { code: 'WEIBO_TIMEOUT' });
    }
    throw new WeiboError(`请求微博详情失败：${err?.message || err}`, { code: 'WEIBO_NETWORK' });
  }

  const finalUrl = response.url || url;
  if (isLoginRedirect(finalUrl, response.redirected)) {
    throw new WeiboAuthError('Cookie 已失效：请求微博详情时被跳转到登录页');
  }
  if (response.status === 401 || response.status === 403) {
    throw new WeiboAuthError(`微博拒绝访问（HTTP ${response.status}），可能是 Cookie 失效或风控`);
  }
  if (response.status === 418 || response.status === 429) {
    throw new WeiboRateLimitError(`微博限流（HTTP ${response.status}）`, { status: response.status });
  }
  if (response.status >= 500) {
    throw new WeiboError(`微博服务端错误（HTTP ${response.status}）`, { code: 'WEIBO_SERVER', status: response.status });
  }
  if (!response.ok) {
    throw new WeiboApiError(`微博详情接口返回 HTTP ${response.status}`, { status: response.status });
  }

  const text = await response.text();
  if (/^\s*</.test(text)) {
    throw new WeiboAuthError('Cookie 已失效：微博详情接口返回了 HTML 登录页');
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new WeiboApiError(`微博详情接口返回非 JSON：${text.slice(0, 120)}`, { code: 'WEIBO_PARSE' });
  }

  if (json.ok !== 1 && json.ok !== true) {
    throw new WeiboApiError(`微博详情接口返回错误：${json.message || json.msg || '未知错误'}`);
  }

  const data = json.data && typeof json.data === 'object' ? { ...json, ...json.data } : json;
  const mblogid = String(data.mblogid || '');
  const uid = String(data.user?.idstr ?? data.user?.id ?? '');
  if (!mblogid || !uid) {
    throw new WeiboApiError('微博详情缺少 mblogid 或用户 ID');
  }

  return { mblogid, uid, url: `https://weibo.com/${uid}/${mblogid}` };
}

export async function fetchApprovalPage({
  postId,
  cookie,
  maxId,
  timeoutMs = 15000,
  fetchImpl = fetch,
  userAgent = DEFAULT_USER_AGENT,
}) {
  if (!cookie) throw new WeiboAuthError('缺少微博 Cookie，请在 .env 中配置 WEIBO_COOKIE');

  const url = buildApprovalUrl(postId, maxId);
  let response;

  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        cookie,
        'user-agent': userAgent,
        referer: 'https://weibo.com/',
        accept: 'application/json, text/plain, */*',
        'x-requested-with': 'XMLHttpRequest',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new WeiboError(`请求微博超时（${timeoutMs}ms）`, { code: 'WEIBO_TIMEOUT' });
    }
    throw new WeiboError(`请求微博失败：${err?.message || err}`, { code: 'WEIBO_NETWORK' });
  }

  const finalUrl = response.url || url;
  if (isLoginRedirect(finalUrl, response.redirected)) {
    throw new WeiboAuthError('Cookie 已失效：请求被跳转到登录页');
  }

  if (response.status === 401 || response.status === 403) {
    throw new WeiboAuthError(`微博拒绝访问（HTTP ${response.status}），可能是 Cookie 失效或风控`);
  }
  if (response.status === 418 || response.status === 429) {
    throw new WeiboRateLimitError(`微博限流（HTTP ${response.status}）`, { status: response.status });
  }
  if (response.status >= 500) {
    throw new WeiboError(`微博服务端错误（HTTP ${response.status}）`, { code: 'WEIBO_SERVER', status: response.status });
  }
  if (!response.ok) {
    throw new WeiboApiError(`微博接口返回 HTTP ${response.status}`, { status: response.status });
  }

  const contentType = response.headers?.get?.('content-type') || '';
  const text = await response.text();

  if (contentType.includes('text/html') || /^\s*</.test(text)) {
    throw new WeiboAuthError('Cookie 已失效：接口返回了 HTML 登录页');
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new WeiboApiError(`微博接口返回非 JSON：${text.slice(0, 120)}`, { code: 'WEIBO_PARSE' });
  }

  if (json.ok !== 1 && json.ok !== true) {
    const message = json.message || json.msg || '未知错误';
    const authHint = /登录|未登录|登录过期|passport|sso|无权限|没有权限|权限不足/i.test(String(message)) || /passport|login/i.test(String(json.url || ''));
    if (authHint) throw new WeiboAuthError(`Cookie 已失效：${message}`);
    throw new WeiboApiError(`微博接口返回错误：${message}`);
  }

  const data = json.data;
  if (!data || typeof data !== 'object') {
    throw new WeiboApiError('微博接口响应缺少 data');
  }

  const rawComments = Array.isArray(data.comments) ? data.comments : [];
  if (!Array.isArray(data.comments) && Number(data.total_number) > 0) {
    throw new WeiboApiError('微博接口响应缺少 data.comments');
  }

  const comments = rawComments.map(normalizeComment);
  const maxIdValue = data.max_id_str ?? data.max_id ?? '0';

  return {
    comments,
    maxId: String(maxIdValue),
    sinceId: String(data.since_id_str ?? data.since_id ?? '0'),
    total: Number.isFinite(data.total_number) ? data.total_number : null,
    header: String(data.header_text ?? ''),
  };
}

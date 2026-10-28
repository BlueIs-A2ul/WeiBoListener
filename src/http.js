/**
 * 通用 HTTP 抓取：给「非微博」的任意站点使用。
 *
 * 与 weibo.js 的分工：weibo.js 是微博专用（分页、字段解析都写死）；
 * 这里只负责「拿到一份文本 + 判断失败类型」，解析交给 extract.js。
 *
 * 失败类型（code）刻意做得少而稳定，其余模块只认这几个：
 *   HTTP_AUTH        需要登录 / Cookie 失效 / 401 / 403 / 被重定向到登录页
 *   HTTP_RATE_LIMIT  418 / 429
 *   HTTP_SERVER      5xx
 *   HTTP_STATUS      其它非 2xx
 *   HTTP_TIMEOUT     超时（本机实测：某些教务系统在 Cookie 缺失时表现为连接超时）
 *   HTTP_NETWORK     网络错误
 *   HTTP_URL         配置里的地址不是 http/https
 *   HTTP_TOO_LARGE   响应超过上限
 */

export class FetchError extends Error {
  constructor(message, { code = 'HTTP_ERROR', status = null, retryable = true } = {}) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** 默认请求头：带 Accept-Language 才会拿到中文标签而不是内部代码值。 */
export const DEFAULT_HEADERS = Object.freeze({
  'user-agent': DEFAULT_USER_AGENT,
  accept: 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9',
});

const LOGIN_URL_PATTERN = /passport|login|sso\b|cas\b|authserver|oauth|signin/i;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** 最终地址是否像登录页（用于把「被踢回登录」判定成 Cookie 失效）。 */
export function isLoginUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(String(url));
    return LOGIN_URL_PATTERN.test(`${parsed.hostname}${parsed.pathname}`);
  } catch {
    return false;
  }
}

function normalizeEncoding(name) {
  const text = String(name ?? '').trim().toLowerCase();
  if (!text) return '';
  if (text === 'utf8' || text === 'utf-8') return 'utf-8';
  if (text === 'gbk' || text === 'gb2312' || text === 'gb18030') return 'gb18030';
  if (text === 'big5') return 'big5';
  return text;
}

/**
 * 把字节解码成文本。顺序：显式配置 > BOM > Content-Type charset > HTML meta charset > utf-8。
 * 国内站点不少是 GBK/GB2312，靠这一步才不会乱码。
 */
export function decodeBody(buffer, { contentType = '', encoding = 'auto' } = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');

  const explicit = encoding && encoding !== 'auto' ? normalizeEncoding(encoding) : '';
  let label = '';

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    label = 'utf-8';
    buffer = bytes.subarray(3);
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    label = 'utf-16le';
    buffer = bytes.subarray(2);
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    label = 'utf-16be';
    buffer = bytes.subarray(2);
  }

  const body = Buffer.isBuffer(buffer) ? buffer : bytes;

  if (explicit) {
    label = explicit;
  } else if (!label) {
    const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || '');
    if (fromHeader) label = normalizeEncoding(fromHeader[1]);

    if (!label) {
      const head = body.subarray(0, 4096).toString('latin1');
      const fromMeta =
        /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) ||
        /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head);
      if (fromMeta) label = normalizeEncoding(fromMeta[1]);
    }
  }

  if (!label) label = 'utf-8';

  try {
    const text = new TextDecoder(label).decode(body);
    return { text, encoding: label };
  } catch {
    // 运行环境缺这个编码表时退回 utf-8，至少不抛错
    return { text: new TextDecoder('utf-8').decode(body), encoding: 'utf-8' };
  }
}

function mergeHeaders(headers = {}) {
  const merged = new Map();
  for (const [key, value] of Object.entries(DEFAULT_HEADERS)) merged.set(key.toLowerCase(), [key, value]);
  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined || value === null || value === '') continue;
    merged.set(key.toLowerCase(), [key, String(value)]);
  }
  return Object.fromEntries([...merged.values()]);
}

function assertHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    throw new FetchError(`请求地址不是合法 URL：${url}`, { code: 'HTTP_URL', retryable: false });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new FetchError(`只支持 http/https 地址，当前是 ${parsed.protocol}`, { code: 'HTTP_URL', retryable: false });
  }
  return parsed;
}

/**
 * 发一次请求并解码成文本。
 * 返回值里的 status/bytes/ms 会直接展示在面板的「抓取并分析」里，方便用户判断网站是否正常。
 */
export async function fetchDocument({
  url,
  method = 'GET',
  headers = {},
  cookie,
  body,
  timeoutMs = 15000,
  encoding = 'auto',
  maxBytes = DEFAULT_MAX_BYTES,
  fetchImpl = fetch,
} = {}) {
  const target = assertHttpUrl(url);
  const startedAt = Date.now();
  const requestHeaders = mergeHeaders(headers);
  if (cookie) requestHeaders.cookie = String(cookie);

  let response;
  try {
    response = await fetchImpl(target.toString(), {
      method: String(method || 'GET').toUpperCase(),
      redirect: 'follow',
      headers: requestHeaders,
      body: body === undefined || body === null || body === '' ? undefined : String(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new FetchError(
        `请求超时（${timeoutMs}ms）。若该站点 Cookie 已过期或缺失，可能表现为超时而不是 401，请重新复制 Cookie 后重试。`,
        { code: 'HTTP_TIMEOUT' },
      );
    }
    const cause = err?.cause?.code || err?.cause?.message || '';
    throw new FetchError(`请求失败：${err?.message || err}${cause ? `（${cause}）` : ''}`, { code: 'HTTP_NETWORK' });
  }

  const finalUrl = response.url || target.toString();
  if (isLoginUrl(finalUrl) && finalUrl !== target.toString()) {
    throw new FetchError(`被重定向到登录页（${finalUrl}），Cookie 很可能已失效`, {
      code: 'HTTP_AUTH',
      status: response.status,
      retryable: false,
    });
  }

  if (response.status === 401 || response.status === 403) {
    throw new FetchError(`站点拒绝访问（HTTP ${response.status}），Cookie 可能已失效或无权限`, {
      code: 'HTTP_AUTH',
      status: response.status,
      retryable: false,
    });
  }
  if (response.status === 418 || response.status === 429) {
    throw new FetchError(`站点限流（HTTP ${response.status}）`, { code: 'HTTP_RATE_LIMIT', status: response.status });
  }
  if (response.status >= 500) {
    throw new FetchError(`站点服务端错误（HTTP ${response.status}）`, { code: 'HTTP_SERVER', status: response.status });
  }
  if (!response.ok) {
    throw new FetchError(`站点返回 HTTP ${response.status}`, { code: 'HTTP_STATUS', status: response.status });
  }

  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new FetchError(`响应过大（${declaredLength} 字节，上限 ${maxBytes}），请改用更小的接口`, {
      code: 'HTTP_TOO_LARGE',
      status: response.status,
      retryable: false,
    });
  }

  let buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) buffer = buffer.subarray(0, maxBytes);

  const contentType = response.headers?.get?.('content-type') || '';
  const decoded = decodeBody(buffer, { contentType, encoding });

  return {
    status: response.status,
    finalUrl,
    redirected: Boolean(response.redirected),
    contentType,
    encoding: decoded.encoding,
    text: decoded.text,
    bytes: buffer.length,
    ms: Date.now() - startedAt,
  };
}

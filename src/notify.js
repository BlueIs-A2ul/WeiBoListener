const WXPUSHER_ENDPOINT = 'https://wxpusher.zjiecode.com/api/send/message';

export class WxPusherError extends Error {
  constructor(message, { code = 'WXPUSHER_ERROR', status = null, retryable = true } = {}) {
    super(message);
    this.name = 'WxPusherError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendWxPusher({
  appToken,
  uids,
  content,
  summary,
  url,
  fetchImpl = fetch,
  timeoutMs = 15000,
  retries = 3,
  sleep = defaultSleep,
  logger,
}) {
  if (!appToken) throw new WxPusherError('缺少 WXPUSHER_APP_TOKEN，请在 .env 中配置', { retryable: false });
  if (!Array.isArray(uids) || uids.length === 0) {
    throw new WxPusherError('缺少 WXPUSHER_UIDS，请在 .env 中配置接收用户 UID', { retryable: false });
  }
  if (!content) throw new WxPusherError('推送内容为空', { retryable: false });

  const body = {
    appToken,
    content: String(content),
    summary: summary ? String(summary).slice(0, 100) : undefined,
    contentType: 1,
    uids,
  };
  if (url) body.url = String(url).slice(0, 1000);

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(WXPUSHER_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const text = await response.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new WxPusherError(`WxPusher 返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`, {
          status: response.status,
          retryable: response.status >= 500 || response.status === 429,
        });
      }

      if (json.code === 1000) {
        return { ok: true, code: json.code, msg: json.msg, data: json.data };
      }

      throw new WxPusherError(`WxPusher 推送失败：${json.msg || json.code || '未知错误'}`, {
        code: json.code ?? 'WXPUSHER_ERROR',
        status: response.status,
        retryable: response.status >= 500 || response.status === 429,
      });
    } catch (err) {
      lastError = err;
      const retryable = err.retryable !== false;
      if (attempt >= retries || !retryable) break;
      logger?.warn(`WxPusher 推送失败，${2 ** attempt} 秒后重试`, { error: err.message });
      await sleep(1000 * 2 ** attempt);
    }
  }

  throw lastError;
}

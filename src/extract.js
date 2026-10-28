import crypto from 'node:crypto';

import { cleanCommentText } from './format.js';
import { getPath, toText, topLevelKeys } from './path.js';

/**
 * 把站点响应解析成统一条目模型：
 *   { id, title, time, link, text, fields: [{ label, value }], raw }
 *
 * 与微博的区别很重要的一点：条目 ID 是任意字符串（本机实测的教务接口用的是 UUID），
 * 所以这里只做字符串去重、保持接口返回顺序，不能复用 diff.js 里的 BigInt 比较。
 */

export class ExtractError extends Error {
  constructor(message, { code = 'EXTRACT_ERROR' } = {}) {
    super(message);
    this.name = 'ExtractError';
    this.code = code;
  }
}

export function shortHash(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

export function parseJsonBody(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') throw new ExtractError('响应内容为空', { code: 'EXTRACT_EMPTY' });
  if (trimmed.startsWith('<')) {
    throw new ExtractError('站点返回的是 HTML 页面（很可能 Cookie 已失效或需要登录）', {
      code: 'EXTRACT_HTML',
    });
  }
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new ExtractError(`响应不是合法 JSON：${err.message}`, { code: 'EXTRACT_JSON' });
  }
}

/**
 * 成功判定。不配置 success 时只要求「是 JSON」，配置后按字段比较。
 * 微博用 ok:1，很多教务系统用 code:"0"，所以这一步必须可配。
 */
export function checkSuccess(json, success) {
  if (!success || !success.path) return;

  const value = getPath(json, success.path);
  if (value === undefined) {
    throw new ExtractError(
      `响应里没有成功标志字段 ${success.path}（顶层字段：${topLevelKeys(json).join(' / ') || '空'}）`,
      { code: 'EXTRACT_SHAPE' },
    );
  }
  if (String(value) !== String(success.equals)) {
    const message = success.messagePath ? toText(getPath(json, success.messagePath)) : '';
    throw new ExtractError(`接口返回失败（${success.path}=${value}）${message ? `：${message}` : ''}`, {
      code: 'SITE_ERROR',
    });
  }
}

function originOf(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return '';
  }
}

export function resolveUrl(value, baseUrl) {
  const text = toText(value);
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  try {
    return new URL(text, baseUrl || undefined).toString();
  } catch {
    return text;
  }
}

function toItem(entry, site, baseUrl) {
  const select = site.select || {};
  const pick = (path) => (path ? getPath(entry, path) : undefined);

  const title = toText(pick(select.title));
  const time = toText(pick(select.time));
  const link = resolveUrl(pick(select.link), baseUrl);
  const textRaw = toText(pick(select.text));
  const text = textRaw ? cleanCommentText(textRaw) : '';

  const fields = (select.fields || [])
    .map((field) => ({ label: field.label, value: toText(getPath(entry, field.path)) }))
    .filter((field) => field.value !== '');

  const idRaw = toText(pick(select.id));
  const id = idRaw || shortHash(`${link || ''}|${title}|${time}`);

  return { id, title, time, link, text, fields, raw: entry };
}

/** 解析出条目列表；空数组是合法结果（例如新学期还没有考试安排）。 */
export function extractItems({ site, body, baseUrl } = {}) {
  if (!site) throw new ExtractError('缺少站点配置', { code: 'EXTRACT_CONFIG' });
  if (site.mode && site.mode !== 'json') {
    throw new ExtractError(`暂不支持的抓取模式：${site.mode}`, { code: 'EXTRACT_MODE' });
  }

  const json = parseJsonBody(body);
  checkSuccess(json, site.success);

  const itemsPath = site.select?.items;
  const raw = getPath(json, itemsPath);
  if (!Array.isArray(raw)) {
    throw new ExtractError(
      `没有在响应里找到条目数组 ${itemsPath}（顶层字段：${topLevelKeys(json).join(' / ') || '空'}）；页面结构可能已改版，请回面板重新探测`,
      { code: 'EXTRACT_SHAPE' },
    );
  }

  const base = baseUrl || originOf(site.request?.url);
  const maxItems = Number.isFinite(site.maxItems) && site.maxItems > 0 ? site.maxItems : 200;

  const seen = new Set();
  const items = [];
  for (const entry of raw) {
    const item = toItem(entry, site, base);
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
    if (items.length >= maxItems) break;
  }
  return items;
}

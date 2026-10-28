import fsp from 'node:fs/promises';
import path from 'node:path';

import { analyzeJson, detectKind, looksLikeLogin } from './analyze.js';
import { ConfigError, normalizeConfig } from './config.js';
import { extractItems } from './extract.js';
import { formatSiteMessages } from './format.js';
import { fetchDocument } from './http.js';
import { ensureSiteState, loadState, markSiteSeen, saveState } from './state.js';
import { applyFilters } from './watch.js';

/**
 * 面板「站点向导」的服务端实现。
 *
 * 约定：admin.js 负责 HTTP 基础设施（令牌、Host 校验、读 body、原子写），
 * 这里只做「探测 / 预览 / 试跑 / 保存 / 删除 / 重建基线」六件事，
 * 方便单独测试，也让 admin.js 不至于继续变长。
 */

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function prefixCode(err) {
  return err?.code ? `[${err.code}] ${err.message}` : err.message;
}

function originOf(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return '';
  }
}

export function sanitizeHeaders(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const headers = {};
  for (const [key, value] of Object.entries(input)) {
    const name = String(key).trim();
    if (!name || /[\s:]/.test(name)) continue;
    if (value === undefined || value === null) continue;
    headers[name] = String(value);
  }
  return headers;
}

export function siteCookieFromEnv(envFile, site) {
  const key = site?.request?.cookieEnv;
  if (!key) return '';
  const fromFile = envFile?.parsed?.[key];
  return String(fromFile ?? process.env[key] ?? '').trim();
}

function siteRequestOptions(site, fallbackTimeout = 15000) {
  return {
    url: site.request.url,
    method: site.request.method,
    headers: site.request.headers,
    body: site.request.body,
    timeoutMs: site.request.timeoutMs ?? fallbackTimeout,
    encoding: site.request.encoding,
  };
}

function docInfo(doc) {
  return {
    status: doc.status,
    contentType: doc.contentType,
    encoding: doc.encoding,
    bytes: doc.bytes,
    ms: doc.ms,
    finalUrl: doc.finalUrl,
  };
}

/** 用当前 config.json 作上下文校验一份站点草稿（保证 posts/sites 约束成立）。 */
async function normalizeDraftSite(ctx, rawSite) {
  const current = await ctx.readConfigSafe(ctx.root);
  const base = current?.raw && typeof current.raw === 'object' ? { ...current.raw } : {};
  const posts = Array.isArray(base.posts) ? base.posts : [];
  try {
    const normalized = normalizeConfig({ ...base, posts, sites: [rawSite] });
    return normalized.sites[0];
  } catch (err) {
    if (err instanceof ConfigError) throw fail(400, err.message);
    throw err;
  }
}

async function previewSite(ctx, site, cookie) {
  const configFile = await ctx.readConfigSafe(ctx.root);
  const timeout = configFile?.config?.requestTimeoutMs ?? 15000;

  let doc;
  try {
    doc = await fetchDocument({ ...siteRequestOptions(site, timeout), cookie });
  } catch (err) {
    throw fail(400, prefixCode(err));
  }

  let items;
  try {
    items = extractItems({ site, body: doc.text, baseUrl: originOf(site.request.url) });
  } catch (err) {
    throw fail(400, prefixCode(err));
  }

  const messages = formatSiteMessages(site, items.slice(0, Math.max(1, site.maxItemsPerMessage)), {
    maxItemsPerMessage: site.maxItemsPerMessage,
  });

  return {
    ok: true,
    doc: docInfo(doc),
    total: items.length,
    items: items.slice(0, 20).map((item) => ({
      id: item.id,
      title: item.title,
      time: item.time,
      link: item.link,
      fields: item.fields,
      text: String(item.text || '').slice(0, 200),
    })),
    messages: messages.map((message) => message.content),
  };
}

/** 探测：拿 URL + Cookie 真实请求一次，分析响应结构并给出建议配置。 */
export async function probe(ctx, req) {
  const body = (await ctx.readJson(req)) || {};
  const url = String(body.url || '').trim();
  if (!url) throw fail(400, '请填写要监听的请求地址（带上 ?termCode= 这类查询参数）');

  const headers = sanitizeHeaders(body.headers);
  const cookie = String(body.cookie || '').trim();
  const method = String(body.method || 'GET').toUpperCase();
  const encoding = String(body.encoding || 'auto');

  let doc;
  try {
    doc = await fetchDocument({
      url,
      method,
      headers,
      cookie,
      body: body.body ?? null,
      timeoutMs: 30000,
      encoding,
    });
  } catch (err) {
    return {
      ok: false,
      code: err.code || 'HTTP_ERROR',
      message: err.message,
      authHint: err.code === 'HTTP_AUTH' || err.code === 'HTTP_TIMEOUT',
    };
  }

  const info = docInfo(doc);
  const kind = detectKind(doc);

  if (kind === 'json') {
    let json;
    try {
      json = JSON.parse(doc.text);
    } catch (err) {
      return { ok: false, code: 'PROBE_JSON', message: `返回内容不是合法 JSON：${err.message}`, doc: info };
    }

    const analysis = analyzeJson(json, { url });
    const warnings = [];
    if (analysis.candidates.length === 0) warnings.push('响应里没有找到数组：这个接口可能不是列表型接口');
    return { ok: true, kind, doc: info, analysis, warnings };
  }

  const loginHint = looksLikeLogin(doc.text);
  return {
    ok: true,
    kind,
    doc: info,
    loginHint,
    textSample: String(doc.text || '').slice(0, 600),
    warnings: [
      loginHint
        ? '返回的像是登录页：Cookie 可能已失效，或者这个地址本来就需要先登录'
        : '这个地址返回的不是 JSON：当前版本只支持 JSON 接口，HTML 页面检测还没做',
    ],
  };
}

/** 预览：用草稿配置真实抓一次，返回条目与「手机上会收到的文案」，不写状态、不推送。 */
export async function preview(ctx, req) {
  const body = (await ctx.readJson(req)) || {};
  if (!body.site || typeof body.site !== 'object') throw fail(400, '请求体缺少 site');

  const site = await normalizeDraftSite(ctx, body.site);
  const envFile = await ctx.readEnvFile(ctx.root);
  const cookie = String(body.cookie || '').trim() || siteCookieFromEnv(envFile, site);
  if (!cookie) throw fail(400, `还没有 Cookie：请粘贴该请求的 Cookie，或写进 .env 的 ${site.request.cookieEnv}`);

  return previewSite(ctx, site, cookie);
}

/** 试跑：已保存的站点，用 .env 里的 Cookie 抓一次（不推送、不写状态）。 */
export async function testSite(ctx, req) {
  const body = (await ctx.readJson(req)) || {};
  const siteId = String(body.siteId || '');
  const configFile = await ctx.readConfigFile(ctx.root);
  const site = configFile.config.sites.find((item) => item.id === siteId);
  if (!site) throw fail(404, `没有找到站点：${siteId}`);

  const envFile = await ctx.readEnvFile(ctx.root);
  const cookie = siteCookieFromEnv(envFile, site);
  if (!cookie) throw fail(400, `站点「${site.name}」还没有 Cookie（.env 的 ${site.request.cookieEnv}）`);

  return previewSite(ctx, site, cookie);
}

/** 保存（新增或更新）一个站点，可选同时写入它的 Cookie；保存后重启监听。 */
export async function saveSite(ctx, req) {
  const body = (await ctx.readJson(req)) || {};
  const rawSite = body.site;
  if (!rawSite || typeof rawSite !== 'object') throw fail(400, '请求体缺少 site');

  const current = await ctx.readConfigFile(ctx.root);
  ctx.assertMtime(body.mtimeMs, current.mtimeMs, 'config.json');

  const base = current.raw && typeof current.raw === 'object' ? { ...current.raw } : {};
  const sites = Array.isArray(base.sites) ? base.sites.slice() : [];
  const index = sites.findIndex((item) => String(item.id) === String(rawSite.id));
  if (index >= 0) sites[index] = { ...sites[index], ...rawSite };
  else sites.push(rawSite);
  base.sites = sites;

  let normalized;
  try {
    normalized = normalizeConfig(base);
  } catch (err) {
    if (err instanceof ConfigError) throw fail(400, err.message);
    throw err;
  }

  const configFile = path.join(ctx.root, 'config.json');
  await ctx.writeFileAtomic(configFile, `${JSON.stringify(normalized, null, 2)}\n`);

  const savedSite = normalized.sites.find((item) => item.id === rawSite.id) || null;

  let cookieSaved = false;
  const cookie = typeof body.cookie === 'string' ? body.cookie.trim() : '';
  if (cookie) {
    if (!savedSite) throw fail(500, '站点已写入但未能取回配置，请刷新页面检查');
    const envFile = await ctx.readEnvFile(ctx.root);
    const text = ctx.updateEnvText(envFile.text, { [savedSite.request.cookieEnv]: cookie });
    await ctx.writeFileAtomic(path.join(ctx.root, '.env'), text);
    cookieSaved = true;
  }

  const stat = await fsp.stat(configFile);
  const restart = await ctx.restartListener();
  return { ok: true, site: savedSite, config: normalized, mtimeMs: stat.mtimeMs, cookieSaved, restart };
}

/** 删除一个站点。若删完既没有微博也没有站点，按配置约束拒绝。 */
export async function deleteSite(ctx, req) {
  const body = (await ctx.readJson(req)) || {};
  const siteId = String(body.siteId || '');

  const current = await ctx.readConfigFile(ctx.root);
  ctx.assertMtime(body.mtimeMs, current.mtimeMs, 'config.json');

  const base = current.raw && typeof current.raw === 'object' ? { ...current.raw } : {};
  const existing = Array.isArray(base.sites) ? base.sites : [];
  const sites = existing.filter((item) => String(item.id) !== siteId);
  if (sites.length === existing.length) throw fail(404, `没有找到站点：${siteId}`);
  base.sites = sites;

  let normalized;
  try {
    normalized = normalizeConfig(base);
  } catch (err) {
    if (err instanceof ConfigError) {
      throw fail(400, `${err.message}（删除前请至少保留一条微博或一个站点）`);
    }
    throw err;
  }

  const configFile = path.join(ctx.root, 'config.json');
  await ctx.writeFileAtomic(configFile, `${JSON.stringify(normalized, null, 2)}\n`);
  const stat = await fsp.stat(configFile);
  const restart = await ctx.restartListener();
  return { ok: true, config: normalized, mtimeMs: stat.mtimeMs, restart };
}

/** 重建基线：把当前条目全部记为已见，之后只推送新增。 */
export async function baseline(ctx, req) {
  const body = (await ctx.readJson(req)) || {};
  const siteId = String(body.siteId || '');

  const configFile = await ctx.readConfigFile(ctx.root);
  const config = configFile.config;
  const site = config.sites.find((item) => item.id === siteId);
  if (!site) throw fail(404, `没有找到站点：${siteId}`);

  const envFile = await ctx.readEnvFile(ctx.root);
  const cookie = siteCookieFromEnv(envFile, site);
  if (!cookie) throw fail(400, `站点「${site.name}」还没有 Cookie（.env 的 ${site.request.cookieEnv}）`);

  let doc;
  try {
    doc = await fetchDocument({ ...siteRequestOptions(site, config.requestTimeoutMs), cookie });
  } catch (err) {
    throw fail(400, prefixCode(err));
  }

  let items;
  try {
    items = extractItems({ site, body: doc.text, baseUrl: originOf(site.request.url) });
  } catch (err) {
    throw fail(400, prefixCode(err));
  }

  const kept = applyFilters(items, site.filters);
  const stateFile = path.resolve(ctx.root, config.stateFile || 'data/state.json');
  const { state } = await loadState(stateFile);
  const siteState = ensureSiteState(state, site.id);
  siteState.seen = [];
  markSiteSeen(siteState, kept.map((item) => item.id), config.maxSeenPerPost);
  siteState.baselineDone = true;
  siteState.baselineAt = new Date().toISOString();
  siteState.baselineCount = kept.length;
  siteState.lastPollAt = siteState.baselineAt;
  siteState.lastError = null;
  await saveState(stateFile, state);

  return { ok: true, count: kept.length, total: items.length, baselineAt: siteState.baselineAt };
}

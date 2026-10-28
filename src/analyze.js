import { siteCookieKey } from './config.js';
import { toText } from './path.js';

/**
 * 面板向导的「大脑」：只做纯计算，不发请求，方便测试与复用。
 * 输入是接口响应，输出是「候选条目数组 + 建议字段 + 建议配置」。
 */

const ID_PATTERNS = [/^id$/i, /idstr$/i, /_id$/i, /taskid/i, /^uuid$/i, /^guid$/i, /^no$/i];
const TITLE_PATTERNS = [
  /^title$/i,
  /title/i,
  /^name$/i,
  /name$/i,
  /subject/i,
  /coursename/i,
  /^desc/i,
  /^text$/i,
  /^summary$/i,
];
const TIME_PATTERNS = [/time/i, /date/i, /^created/i, /^publish/i, /^updated/i];
const LINK_PATTERNS = [/^url$/i, /url$/i, /^link$/i, /href/i];
const TEXT_PATTERNS = [/^content$/i, /^text$/i, /^summary$/i, /^remark$/i, /^memo$/i, /^desc/i];

const NAME_HINT = /list|items|rows|records|result|data|datas|content/i;
const LOGIN_HINT = /(登录|统一身份认证|请先登录|认证中心|login|sign in|passport|sso)/i;

/** 把任意值裁剪成适合面板展示的短文本。 */
export function clip(value, max = 80) {
  const text = toText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 递归收集响应里的数组，给每个数组打分并附带样例。 */
export function collectArrayCandidates(json, { maxDepth = 6, maxCandidates = 8 } = {}) {
  const candidates = [];

  const visit = (value, path, depth) => {
    if (depth > maxDepth || value === null || typeof value !== 'object') return;

    if (Array.isArray(value)) {
      const objects = value.filter(isPlainObject);
      const keys = objects.length > 0 ? Object.keys(objects[0]) : [];
      const consistent =
        objects.length > 0 &&
        keys.length > 0 &&
        objects.every((item) => keys.every((key) => Object.prototype.hasOwnProperty.call(item, key)));

      let score = 0;
      score += Math.round((objects.length / Math.max(value.length, 1)) * 30);
      score += Math.min(value.length, 20);
      score += consistent ? 20 : 0;
      if (NAME_HINT.test(path)) score += 15;
      if (keys.some((key) => ID_PATTERNS.some((pattern) => pattern.test(key)))) score += 15;
      if (keys.some((key) => TITLE_PATTERNS.some((pattern) => pattern.test(key)))) score += 10;
      if (keys.length === 0 && value.length > 0) score += 5;

      candidates.push({
        path: path || '$',
        count: value.length,
        kind: objects.length > 0 ? 'object' : 'scalar',
        keys: keys.slice(0, 12),
        consistent,
        score: Math.min(score, 100),
        sample: value.slice(0, 3).map((item) =>
          isPlainObject(item)
            ? Object.fromEntries(keys.slice(0, 12).map((key) => [key, clip(item[key], 60)]))
            : clip(item, 60),
        ),
      });

      // 继续往里找嵌套数组（例如 data.list 里还有 attachments），但只走前几项
      for (const item of value.slice(0, 2)) visit(item, `${path}[0]`, depth + 1);
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      visit(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };

  visit(json, '', 0);
  return candidates.sort((a, b) => b.score - a.score).slice(0, maxCandidates);
}

function pickKey(keys, patterns) {
  return keys.find((key) => patterns.some((pattern) => pattern.test(key))) || '';
}

/** 根据字段名猜角色。可以传字段名数组，也可以传样例对象；猜错没关系，面板里能改。 */
export function inferFields(source) {
  const keys = Array.isArray(source) ? source : isPlainObject(source) ? Object.keys(source) : [];
  return {
    id: pickKey(keys, ID_PATTERNS),
    title: pickKey(keys, TITLE_PATTERNS),
    time: pickKey(keys, TIME_PATTERNS),
    link: pickKey(keys, LINK_PATTERNS),
    text: pickKey(keys, TEXT_PATTERNS),
  };
}

/** 猜成功判定：教务系统多半是 code:"0"，微博系是 ok:1。 */
export function inferSuccess(json) {
  if (!isPlainObject(json)) return null;
  const messagePath = ['msg', 'message', 'errmsg', 'errMsg', 'error'].find((key) => key in json) || null;

  const candidates = [
    ['code', ['0', '200', 'success']],
    ['ok', ['1', 'true']],
    ['success', ['true', '1']],
    ['status', ['0', 'ok', 'success']],
    ['errcode', ['0']],
  ];

  for (const [key, accepted] of candidates) {
    if (!(key in json)) continue;
    const value = String(json[key]).toLowerCase();
    if (accepted.includes(value)) return { path: key, equals: String(json[key]), messagePath };
  }
  return null;
}

/** 从 URL 生成合法的站点 ID：hostname + 末段路径，只保留小写字母数字短横线。 */
export function inferSiteId(url) {
  let host = '';
  let last = '';
  try {
    const parsed = new URL(String(url));
    host = parsed.hostname.replace(/^www\./i, '').split('.')[0];
    const segments = parsed.pathname.split('/').filter(Boolean);
    last = (segments[segments.length - 1] || '').replace(/\.[a-z0-9]+$/i, '');
  } catch {
    // 忽略：下面走兜底
  }

  const slug = [host, last]
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');

  return slug && /^[a-z0-9]/.test(slug) ? slug : 'site';
}

/** 组装一份可直接保存的站点草稿。 */
export function suggestSite({ url, candidate, success }) {
  const id = inferSiteId(url);
  const fields = inferFields(candidate?.keys?.length ? candidate.keys : candidate?.sample?.[0]);

  return {
    id,
    name: '',
    enabled: true,
    mode: 'json',
    request: {
      url,
      method: 'GET',
      headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' },
      body: null,
      cookieEnv: siteCookieKey(id),
      timeoutMs: 30000,
      encoding: 'auto',
    },
    success: success || null,
    select: {
      items: candidate?.path || '',
      id: fields.id,
      title: fields.title,
      time: fields.time,
      link: fields.link,
      text: fields.text,
      fields: [],
    },
    filters: { includeKeywords: [], excludeKeywords: [] },
    pollIntervalSec: 1800,
    notifyOnBaseline: false,
    maxItems: 200,
    maxItemsPerMessage: 10,
    message: { header: null, item: null },
  };
}

/** 一次完整的 JSON 分析：候选数组 + 建议字段 + 建议配置。 */
export function analyzeJson(json, { url = '' } = {}) {
  const candidates = collectArrayCandidates(json);
  const best = candidates[0] || null;
  const success = inferSuccess(json);

  return {
    topLevelKeys: isPlainObject(json) ? Object.keys(json).slice(0, 12) : [],
    candidates,
    success,
    suggestedSite: best ? suggestSite({ url, candidate: best, success }) : null,
  };
}

/** 判断一段文本是不是登录页（用于「Cookie 失效」提示）。 */
export function looksLikeLogin(text) {
  const sample = String(text ?? '').slice(0, 2000);
  if (!sample) return false;
  return LOGIN_HINT.test(sample);
}

/** 根据响应判断响应类型。 */
export function detectKind({ contentType = '', text = '' } = {}) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return 'empty';
  if (/json/i.test(contentType)) return 'json';
  if (trimmed.startsWith('<')) return 'html';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  return 'text';
}

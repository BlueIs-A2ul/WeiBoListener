/**
 * 轻量的「路径取值」，用于把站点配置里的 datas.list[0].title 这类路径映射到响应 JSON。
 * 不引入任何依赖，也不做表达式求值：只支持对象属性与数组下标。
 */

const TOKEN_PATTERN = /([^.[\]]+)|\[(\d+)\]|\["([^"]*)"\]|\['([^']*)'\]/g;

/** 把 "a.b[0].c" / "a['b'].c" 解析成 ['a', 'b', 0, 'c']。 */
export function parsePath(path) {
  const text = String(path ?? '');
  if (text.trim() === '') return [];

  const tokens = [];
  TOKEN_PATTERN.lastIndex = 0;
  let match;
  while ((match = TOKEN_PATTERN.exec(text)) !== null) {
    if (match[1] !== undefined) tokens.push(match[1].trim());
    else if (match[2] !== undefined) tokens.push(Number(match[2]));
    else if (match[3] !== undefined) tokens.push(match[3]);
    else if (match[4] !== undefined) tokens.push(match[4]);
  }
  return tokens.filter((token) => token !== '');
}

/** 按路径取值；任一段缺失返回 undefined，不抛错。 */
export function getPath(value, path) {
  const tokens = Array.isArray(path) ? path : parsePath(path);
  let current = value;

  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = current[token];
  }
  return current;
}

/** 依次尝试多个路径，返回第一个有值的。 */
export function pickFirst(value, paths = []) {
  for (const path of paths) {
    const found = getPath(value, path);
    if (found !== undefined && found !== null && found !== '') return found;
  }
  return undefined;
}

/** 把任意取值转成适合塞进推送文案的字符串；对象/数组退化成 JSON。 */
export function toText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 只保留顶层键名，用于「找不到条目数组」时给出排查线索。 */
export function topLevelKeys(value, limit = 8) {
  if (!value || typeof value !== 'object') return [];
  return Object.keys(value).slice(0, limit);
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function fromCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

export function decodeHtmlEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

export function cleanCommentText(html) {
  let text = String(html ?? '');
  if (!text) return '';

  text = text.replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, (_, alt) => alt || '[图片]');
  text = text.replace(/<img\b[^>]*>/gi, '[图片]');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p\s*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeHtmlEntities(text);
  text = text.replace(/\u200b/g, '');
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/[ \t\f\v]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export function truncateText(text, maxChars) {
  const source = String(text ?? '');
  const max = Number(maxChars);
  if (!Number.isFinite(max) || max <= 0) return source;
  const chars = Array.from(source);
  if (chars.length <= max) return source;
  return `${chars.slice(0, max).join('')}…`;
}

export function parseWeiboDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  const match = /^[A-Za-z]{3} ([A-Za-z]{3}) (\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4}) (\d{4})$/.exec(String(value).trim());
  if (!match) return null;

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthIndex = months.indexOf(match[1]);
  if (monthIndex === -1) return null;

  const offsetMinutes = Number(match[6].slice(0, 3)) * 60 + Number(match[6].slice(3)) * (match[6][0] === '-' ? -1 : 1);
  const utcMs = Date.UTC(
    Number(match[7]),
    monthIndex,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
  return new Date(utcMs - offsetMinutes * 60 * 1000);
}

export function formatCommentTime(value) {
  const date = parseWeiboDate(value);
  if (!date) return String(value ?? '');
  const utc8 = new Date(date.getTime() + 8 * 3600 * 1000);
  const month = String(utc8.getUTCMonth() + 1).padStart(2, '0');
  const day = String(utc8.getUTCDate()).padStart(2, '0');
  const hour = String(utc8.getUTCHours()).padStart(2, '0');
  const minute = String(utc8.getUTCMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}

export function formatCommentBlock(comment, index, maxChars = 200) {
  const meta = [
    comment.user?.name || '未知用户',
    formatCommentTime(comment.createdAtRaw),
    comment.floor !== null && comment.floor !== undefined ? `${comment.floor}楼` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const body = truncateText(comment.text || '[无文字内容]', maxChars);
  return `${index}. ${meta}\n${body}`;
}

export function makeSummary(post, count, comments = []) {
  const names = comments
    .slice(0, 2)
    .map((comment) => comment.user?.name)
    .filter(Boolean)
    .join('、');
  const suffix = names ? `（${names}${comments.length > 2 ? ' 等' : ''}）` : '';
  const summary = `微博新评论：${post.name} ${count} 条${suffix}`;
  return summary.slice(0, 100);
}

export function formatMessageChunks(post, comments, { maxChars = 200, postUrl, maxChunkChars = 40000 } = {}) {
  const headerBase = `【微博新评论】${post.name} · ${comments.length} 条`;
  const footer = `\n\n查看微博：${postUrl || `https://m.weibo.cn/status/${post.id}`}`;
  const blocks = comments.map((comment, index) => ({
    comment,
    block: formatCommentBlock(comment, index + 1, maxChars),
  }));

  const groups = [];
  let current = [];
  let currentLength = headerBase.length + footer.length;

  for (const item of blocks) {
    const addition = item.block.length + (current.length > 0 ? 2 : 0);
    if (current.length > 0 && currentLength + addition > maxChunkChars) {
      groups.push(current);
      current = [];
      currentLength = headerBase.length + footer.length;
    }
    current.push(item);
    currentLength += addition;
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group, index) => {
    const header = groups.length > 1 ? `${headerBase}（${index + 1}/${groups.length}）` : headerBase;
    const content = `${header}\n\n${group.map((item) => item.block).join('\n\n')}${footer}`;
    const groupComments = group.map((item) => item.comment);
    return {
      content,
      commentIds: groupComments.map((comment) => comment.id),
      summary: makeSummary(post, comments.length, groupComments),
    };
  });
}


// ---------------------------------------------------------------- 通用站点（微博之外）

const PLACEHOLDER = /\{(\w+)\}/g;

/** 用变量替换模板里的 {name} 占位符；未知占位符原样保留，方便排错。 */
export function fillTemplate(template, vars = {}) {
  return String(template ?? '').replace(PLACEHOLDER, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : match,
  );
}

/**
 * 去掉行尾空白、合并连续空行、去掉首尾空行。
 * stripBlank=true 时连中间的空行也去掉——条目模板里没填的占位符不该留下空行。
 */
export function tidyLines(text, { stripBlank = false } = {}) {
  const lines = String(text ?? '').split('\n').map((line) => line.replace(/[ \t]+$/, ''));
  const out = [];
  for (const line of lines) {
    if (line === '') {
      if (stripBlank) continue;
      if (out.length === 0 || out[out.length - 1] === '') continue;
    }
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/** 渲染单个条目。默认模板：序号 + 标题 + 时间 + 附加字段 + 链接。 */
export function renderSiteItem(site, item, index, { maxChars = 200, maxFieldChars = 120 } = {}) {
  const template = site?.message?.item || '{index}. {title}\n{time}\n{fields}\n{text}\n{link}';
  const fieldsText = (item.fields || [])
    .map((field) => `${field.label}：${truncateText(field.value, maxFieldChars)}`)
    .join('\n');
  const vars = {
    index,
    site: site?.name || '',
    title: item.title || '(无标题)',
    time: item.time || '',
    link: item.link || '',
    text: truncateText(item.text || '', maxChars),
    fields: fieldsText,
  };
  return tidyLines(fillTemplate(template, vars), { stripBlank: true });
}

/**
 * 把新增条目渲染成一条或多条推送。
 * 分块依据：单个站点配置的 maxItemsPerMessage，以及单条消息的整体字数上限。
 */
export function formatSiteMessages(site, items, options = {}) {
  const {
    maxItemsPerMessage = 10,
    maxChunkChars = 8000,
    maxChars = 200,
    maxFieldChars = 120,
  } = options;

  const name = site?.name || site?.id || '站点';
  const headerBase = fillTemplate(site?.message?.header || '【{site}】新增 {count} 条', {
    site: name,
    count: items.length,
  });

  const blocks = items.map((item, index) => ({
    item,
    block: renderSiteItem(site, item, index + 1, { maxChars, maxFieldChars }),
  }));

  const limit = Math.max(1, Number(maxItemsPerMessage) || 10);
  const groups = [];
  let current = [];
  let currentLength = headerBase.length;

  for (const entry of blocks) {
    const addition = entry.block.length + 2;
    const overChars = current.length > 0 && currentLength + addition > maxChunkChars;
    const overCount = current.length >= limit;
    if (overChars || overCount) {
      groups.push(current);
      current = [];
      currentLength = headerBase.length;
    }
    current.push(entry);
    currentLength += addition;
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group, index) => {
    const header = groups.length > 1 ? `${headerBase}（${index + 1}/${groups.length}）` : headerBase;
    const content = `${header}\n\n${group.map((entry) => entry.block).join('\n\n')}`;
    const summary = `${name} 新增 ${group.length} 条`.slice(0, 100);
    return {
      content,
      itemIds: group.map((entry) => entry.item.id),
      summary,
    };
  });
}

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

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanCommentText,
  formatCommentTime,
  formatMessageChunks,
  parseWeiboDate,
  truncateText,
} from '../src/format.js';

test('cleanCommentText 去除 HTML、保留表情文字、解码实体', () => {
  const html = '你好<img alt="[微笑]" src="x"/> &amp; 再见<br>下一行<a href="#">链接</a>';
  assert.equal(cleanCommentText(html), '你好[微笑] & 再见\n下一行链接');
});

test('cleanCommentText 处理没有 alt 的图片', () => {
  assert.equal(cleanCommentText('<img src="x">'), '[图片]');
});

test('truncateText 按 Unicode 字符截断，不拆 emoji', () => {
  assert.equal(truncateText('😀😀😀', 2), '😀😀…');
  assert.equal(truncateText('abc', 10), 'abc');
  assert.equal(truncateText('abc', 0), 'abc');
});

test('parseWeiboDate 能解析微博时间格式', () => {
  const date = parseWeiboDate('Mon Oct 26 19:37:35 +0800 2026');
  assert.ok(date instanceof Date);
  assert.equal(formatCommentTime('Mon Oct 26 19:37:35 +0800 2026'), '10-26 19:37');
});

test('formatCommentTime 对非法时间原样返回', () => {
  assert.equal(formatCommentTime('not-a-date'), 'not-a-date');
});

test('formatMessageChunks 分块后不丢评论、每块带链接', () => {
  const post = { id: '123', name: '测试微博' };
  const comments = Array.from({ length: 30 }, (_, index) => ({
    id: String(100 + index),
    user: { name: `用户${index}` },
    text: 'x'.repeat(150),
    floor: index + 1,
    createdAtRaw: 'Mon Oct 26 19:37:35 +0800 2026',
  }));

  const chunks = formatMessageChunks(post, comments, {
    maxChars: 200,
    postUrl: 'https://m.weibo.cn/status/123',
    maxChunkChars: 1000,
  });

  assert.ok(chunks.length > 1);
  const ids = chunks.flatMap((chunk) => chunk.commentIds).sort();
  assert.deepEqual(ids, comments.map((item) => item.id).sort());
  for (const chunk of chunks) {
    assert.ok(chunk.content.length <= 1100);
    assert.ok(chunk.content.includes('查看微博：https://m.weibo.cn/status/123'));
    assert.ok(chunk.summary.length <= 100);
  }
});

test('formatMessageChunks 单块时包含总数和评论内容', () => {
  const post = { id: '123', name: '测试微博' };
  const chunks = formatMessageChunks(
    post,
    [
      {
        id: '1',
        user: { name: '小明' },
        text: '你好',
        floor: 3,
        createdAtRaw: 'Mon Oct 26 19:37:35 +0800 2026',
      },
    ],
    { maxChars: 200, postUrl: 'https://m.weibo.cn/status/123' },
  );

  assert.equal(chunks.length, 1);
  assert.match(chunks[0].content, /测试微博 · 1 条/);
  assert.match(chunks[0].content, /1\. 小明 · 10-26 19:37 · 3楼\n你好/);
});

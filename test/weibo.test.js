import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildApprovalUrl,
  fetchApprovalPage,
  fetchStatusMeta,
  normalizeComment,
  parseCookieExpiry,
} from '../src/weibo.js';

function makeResponse({
  status = 200,
  body = {},
  url = 'https://weibo.com/ajax/approval/list',
  redirected = false,
  contentType = 'application/json',
} = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    redirected,
    headers: new Headers({ 'content-type': contentType }),
    text: async () => text,
  };
}

function successBody() {
  return {
    ok: 1,
    data: {
      max_id_str: '10',
      since_id_str: '20',
      total_number: 2,
      header_text: '部分待审评论已被过滤',
      comments: [
        {
          id: 2,
          idstr: '2',
          rootidstr: '2',
          created_at: 'Mon Oct 26 19:37:35 +0800 2026',
          text: '你好<img alt="[微笑]" src="x"/>',
          floor_number: 1,
          user: { idstr: 'u1', screen_name: '小明' },
        },
      ],
    },
  };
}

test('buildApprovalUrl 包含必要参数和 max_id', () => {
  const url = new URL(buildApprovalUrl('123', '99'));
  assert.equal(url.origin + url.pathname, 'https://weibo.com/ajax/approval/list');
  assert.equal(url.searchParams.get('id'), '123');
  assert.equal(url.searchParams.get('count'), '20');
  assert.equal(url.searchParams.get('scene'), 'approval');
  assert.equal(url.searchParams.get('max_id'), '99');
});

test('buildApprovalUrl 在 max_id 为 0 时不添加', () => {
  const url = new URL(buildApprovalUrl('123', '0'));
  assert.equal(url.searchParams.has('max_id'), false);
});

test('parseCookieExpiry 从 ALF 解析过期时间', () => {
  const expiry = parseCookieExpiry('SCF=x; ALF=1795268533; SUB=y');
  assert.ok(expiry instanceof Date);
  assert.equal(expiry.toISOString(), new Date(1795268533 * 1000).toISOString());
  assert.equal(parseCookieExpiry('SUB=x'), null);
});

test('normalizeComment 统一字段并清洗文本', () => {
  const comment = normalizeComment(successBody().data.comments[0]);
  assert.equal(comment.id, '2');
  assert.equal(comment.text, '你好[微笑]');
  assert.equal(comment.user.name, '小明');
  assert.equal(comment.floor, 1);
  assert.equal(comment.isTopLevel, true);
});

test('fetchApprovalPage 正常解析响应', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return makeResponse({ body: successBody() });
  };

  const page = await fetchApprovalPage({ postId: '123', cookie: 'ALF=1', fetchImpl });
  assert.equal(page.comments.length, 1);
  assert.equal(page.comments[0].id, '2');
  assert.equal(page.maxId, '10');
  assert.equal(page.total, 2);
  assert.equal(captured.options.headers.cookie, 'ALF=1');
  assert.match(captured.url, /id=123/);
});

test('fetchApprovalPage 把 max_id 传给请求', async () => {
  let capturedUrl;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return makeResponse({ body: successBody() });
  };
  await fetchApprovalPage({ postId: '123', cookie: 'x', maxId: '99', fetchImpl });
  assert.match(capturedUrl, /max_id=99/);
});

test('fetchApprovalPage 识别登录跳转', async () => {
  const fetchImpl = async () =>
    makeResponse({
      body: '<html>login</html>',
      url: 'https://passport.weibo.com/visitor/visitor?entry=miniblog',
      redirected: true,
      contentType: 'text/html',
    });

  await assert.rejects(
    () => fetchApprovalPage({ postId: '123', cookie: 'x', fetchImpl }),
    (err) => err.code === 'WEIBO_AUTH',
  );
});

test('fetchApprovalPage 识别 HTML 登录页', async () => {
  const fetchImpl = async () =>
    makeResponse({ body: '<html>login</html>', contentType: 'text/html' });

  await assert.rejects(
    () => fetchApprovalPage({ postId: '123', cookie: 'x', fetchImpl }),
    (err) => err.code === 'WEIBO_AUTH',
  );
});

test('fetchApprovalPage 识别限流', async () => {
  const fetchImpl = async () => makeResponse({ status: 418, body: { ok: 0 } });
  await assert.rejects(
    () => fetchApprovalPage({ postId: '123', cookie: 'x', fetchImpl }),
    (err) => err.code === 'WEIBO_RATE_LIMIT',
  );
});

test('fetchApprovalPage 识别登录过期提示', async () => {
  const fetchImpl = async () => makeResponse({ body: { ok: 0, message: '请先登录' } });
  await assert.rejects(
    () => fetchApprovalPage({ postId: '123', cookie: 'x', fetchImpl }),
    (err) => err.code === 'WEIBO_AUTH',
  );
});

test('fetchApprovalPage 识别普通接口错误', async () => {
  const fetchImpl = async () => makeResponse({ body: { ok: 0, message: '系统繁忙' } });
  await assert.rejects(
    () => fetchApprovalPage({ postId: '123', cookie: 'x', fetchImpl }),
    (err) => err.code === 'WEIBO_API',
  );
});

test('fetchApprovalPage 识别权限不足', async () => {
  const fetchImpl = async () => makeResponse({ body: { ok: 0, message: '无权限查看该微博评论' } });
  await assert.rejects(
    () => fetchApprovalPage({ postId: '123', cookie: 'x', fetchImpl }),
    (err) => err.code === 'WEIBO_AUTH',
  );
});

test('fetchApprovalPage 识别超时', async () => {
  const fetchImpl = async () => {
    const err = new Error('timeout');
    err.name = 'TimeoutError';
    throw err;
  };

  await assert.rejects(
    () => fetchApprovalPage({ postId: '123', cookie: 'x', fetchImpl }),
    (err) => err.code === 'WEIBO_TIMEOUT',
  );
});

test('fetchApprovalPage 允许空评论列表', async () => {
  const fetchImpl = async () =>
    makeResponse({
      body: { ok: 1, data: { max_id_str: '0', total_number: 0, comments: [] } },
    });

  const page = await fetchApprovalPage({ postId: '123', cookie: 'x', fetchImpl });
  assert.deepEqual(page.comments, []);
  assert.equal(page.maxId, '0');
});

test('fetchStatusMeta 解析出微博规范链接', async () => {
  const fetchImpl = async () =>
    makeResponse({
      body: {
        ok: 1,
        id: 1234567890123456,
        mblogid: 'AbCdEfGhIj',
        user: { id: 9876543210, idstr: '9876543210' },
      },
    });

  const meta = await fetchStatusMeta({
    postId: '1234567890123456',
    cookie: 'x',
    fetchImpl,
  });
  assert.equal(meta.mblogid, 'AbCdEfGhIj');
  assert.equal(meta.uid, '9876543210');
  assert.equal(meta.url, 'https://weibo.com/9876543210/AbCdEfGhIj');
});

test('fetchStatusMeta 缺少 mblogid 时报错', async () => {
  const fetchImpl = async () => makeResponse({ body: { ok: 1, user: { idstr: '1' } } });
  await assert.rejects(
    () => fetchStatusMeta({ postId: '123', cookie: 'x', fetchImpl }),
    (err) => err.code === 'WEIBO_API',
  );
});

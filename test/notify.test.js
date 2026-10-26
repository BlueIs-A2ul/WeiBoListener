import test from 'node:test';
import assert from 'node:assert/strict';

import { sendWxPusher } from '../src/notify.js';

function makeResponse({ status = 200, body = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  };
}

const base = {
  appToken: 'AT_test',
  uids: ['UID_test'],
  content: 'hello',
  summary: 'summary',
  url: 'https://example.com',
};

test('sendWxPusher 发送成功', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return makeResponse({ body: { code: 1000, msg: '处理成功', data: [] } });
  };

  const result = await sendWxPusher({ ...base, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(captured.body.contentType, 1);
  assert.deepEqual(captured.body.uids, ['UID_test']);
  assert.equal(captured.body.url, 'https://example.com');
});

test('sendWxPusher 缺少 appToken 时快速失败', async () => {
  await assert.rejects(
    () => sendWxPusher({ ...base, appToken: '', fetchImpl: async () => makeResponse() }),
    /WXPUSHER_APP_TOKEN/,
  );
});

test('sendWxPusher 4xx 不重试', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return makeResponse({ status: 400, body: { code: 1001, msg: '参数错误' } });
  };

  await assert.rejects(() => sendWxPusher({ ...base, fetchImpl, retries: 3 }), /参数错误/);
  assert.equal(calls, 1);
});

test('sendWxPusher 5xx 会重试并最终成功', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return makeResponse({ status: 500, body: { code: 500, msg: '服务器错误' } });
    return makeResponse({ body: { code: 1000, msg: '处理成功' } });
  };

  const result = await sendWxPusher({ ...base, fetchImpl, retries: 2, sleep: async () => {} });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

test('sendWxPusher 截断 summary 到 100 字符', async () => {
  let body;
  const fetchImpl = async (url, options) => {
    body = JSON.parse(options.body);
    return makeResponse({ body: { code: 1000 } });
  };

  await sendWxPusher({ ...base, summary: 'a'.repeat(150), fetchImpl });
  assert.equal(body.summary.length, 100);
});

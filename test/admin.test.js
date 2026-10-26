import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createAdminServer,
  formatEnvValue,
  isAllowedHost,
  maskSecret,
  parseEnvText,
  updateEnvText,
} from '../src/admin.js';

const COOKIE = 'OLD_COOKIE_VALUE_WITH_SUB=abc; SUBP=xyz; ALF=1900000000';

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weibo-admin-'));
  await fs.writeFile(
    path.join(root, '.env'),
    ['# 手写注释，必须保留', `WEIBO_COOKIE=${COOKIE}`, '', 'WXPUSHER_APP_TOKEN=AT_old', 'WXPUSHER_UIDS=UID_old', '', 'LOG_LEVEL=info', ''].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'config.json'),
    `${JSON.stringify({ posts: [{ id: '1234567890123456', name: '主微博', enabled: true }] }, null, 2)}\n`,
    'utf8',
  );
  return root;
}

async function withServer(run) {
  const root = await makeRoot();
  const server = createAdminServer({ root, token: 'test-token', autoRestart: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run({ root, base: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function call(base, pathname, { method = 'GET', body, token = 'test-token' } = {}) {
  const headers = {};
  if (token) headers['x-admin-token'] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

test('updateEnvText 只改指定键，保留注释与顺序', () => {
  const before = '# 注释\nWEIBO_COOKIE=old\n\nLOG_LEVEL=info\n';
  assert.equal(updateEnvText(before, { WEIBO_COOKIE: 'new' }), '# 注释\nWEIBO_COOKIE=new\n\nLOG_LEVEL=info\n');
});

test('updateEnvText 追加缺失的键并补一个空行', () => {
  assert.equal(updateEnvText('A=1\n', { B: '2' }), 'A=1\n\nB=2\n');
  assert.equal(updateEnvText('', { A: '1' }), 'A=1\n');
});

test('formatEnvValue 只在必要时加引号并转义', () => {
  assert.equal(formatEnvValue('plain-value_1'), 'plain-value_1');
  assert.equal(formatEnvValue('SUB=abc; SUBP=xyz'), 'SUB=abc; SUBP=xyz');
  assert.equal(formatEnvValue('a"b'), '"a\\"b"');
  assert.equal(formatEnvValue('a#b'), '"a#b"');
  assert.equal(formatEnvValue(' a'), '" a"');
  assert.equal(formatEnvValue(''), '');
});

test('parseEnvText 忽略注释行', () => {
  const parsed = parseEnvText('# WEIBO_COOKIE=fake\nWEIBO_COOKIE=real\n\nB=2\n');
  assert.equal(parsed.get('WEIBO_COOKIE'), 'real');
  assert.equal(parsed.get('B'), '2');
  assert.equal(parsed.size, 2);
});

test('maskSecret 不回传短值原内容', () => {
  const long = maskSecret('0123456789abcdef');
  assert.equal(long.configured, true);
  assert.equal(long.length, 16);
  assert.equal(long.tail, 'abcdef');
  assert.ok(!JSON.stringify(long).includes('0123456789abcdef'));

  assert.deepEqual(maskSecret('short'), { configured: true, tail: '', length: 5 });
  assert.deepEqual(maskSecret(''), { configured: false, tail: '', length: 0 });
});

test('isAllowedHost 只接受回环地址', () => {
  assert.equal(isAllowedHost('127.0.0.1:8787'), true);
  assert.equal(isAllowedHost('localhost:8787'), true);
  assert.equal(isAllowedHost('[::1]:8787'), true);
  assert.equal(isAllowedHost('example.com'), false);
  assert.equal(isAllowedHost(undefined), false);
});

test('GET / 不需要令牌，API 需要令牌', async () => {
  await withServer(async ({ base }) => {
    const page = await call(base, '/', { token: null });
    assert.equal(page.status, 200);
    assert.match(page.text, /<title>微博监听/);

    const missing = await call(base, '/api/overview', { token: null });
    assert.equal(missing.status, 401);

    const wrong = await call(base, '/api/overview', { token: 'nope' });
    assert.equal(wrong.status, 401);

    const ok = await call(base, '/api/overview');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(typeof ok.json.listener.running, 'boolean');
    assert.equal(ok.json.state.posts[0].id, '1234567890123456');
  });
});

test('GET /api/credentials 只回传尾部与长度', async () => {
  await withServer(async ({ base }) => {
    const response = await call(base, '/api/credentials');
    assert.equal(response.status, 200);
    assert.equal(response.json.cookie.configured, true);
    assert.equal(response.json.cookie.length, COOKIE.length);
    assert.equal(response.text.includes('OLD_COOKIE_VALUE'), false);
    assert.deepEqual(response.json.uids, ['UID_old']);
  });
});

test('POST /api/config 非法内容不落盘，合法内容写入归一化结果', async () => {
  await withServer(async ({ root, base }) => {
    const before = await fs.readFile(path.join(root, 'config.json'), 'utf8');
    const current = await call(base, '/api/config');

    const invalid = await call(base, '/api/config', {
      method: 'POST',
      body: { config: { posts: [{ id: 'abc' }] }, mtimeMs: current.json.mtimeMs },
    });
    assert.equal(invalid.status, 400);
    assert.match(invalid.json.error.message, /纯数字/);
    assert.equal(await fs.readFile(path.join(root, 'config.json'), 'utf8'), before);

    const valid = await call(base, '/api/config', {
      method: 'POST',
      body: {
        config: { pollIntervalSec: 600, heartbeatHour: null, posts: [{ id: '1234567890123456', name: '主微博' }] },
        mtimeMs: current.json.mtimeMs,
      },
    });
    assert.equal(valid.status, 200);
    assert.equal(valid.json.config.pollIntervalSec, 600);
    assert.equal(valid.json.restart.reason, 'disabled');

    const saved = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
    assert.equal(saved.pollIntervalSec, 600);
    assert.equal(saved.jitterSec, 15);
    assert.equal(saved.heartbeatHour, null);
  });
});

test('POST /api/config 用过期 mtime 时返回 409', async () => {
  await withServer(async ({ base }) => {
    const current = await call(base, '/api/config');
    const stale = await call(base, '/api/config', {
      method: 'POST',
      body: { config: { posts: [{ id: '1234567890123456' }] }, mtimeMs: current.json.mtimeMs - 5000 },
    });
    assert.equal(stale.status, 409);
    assert.match(stale.json.error.message, /外部修改/);
  });
});

test('POST /api/credentials 保留 .env 注释并拒绝过短 Cookie', async () => {
  await withServer(async ({ root, base }) => {
    const before = await call(base, '/api/credentials');

    const tooShort = await call(base, '/api/credentials', {
      method: 'POST',
      body: { cookie: 'SUB=abc', mtimeMs: before.json.mtimeMs },
    });
    assert.equal(tooShort.status, 400);

    const nextCookie = 'SUB=abcdefghij; SUBP=klmnopqrst; ALF=1900000000';
    const saved = await call(base, '/api/credentials', {
      method: 'POST',
      body: { cookie: nextCookie, uids: 'UID_new1, UID_new2', logLevel: 'debug', mtimeMs: before.json.mtimeMs },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json.saved.sort(), ['LOG_LEVEL', 'WEIBO_COOKIE', 'WXPUSHER_UIDS']);

    const text = await fs.readFile(path.join(root, '.env'), 'utf8');
    assert.match(text, /# 手写注释，必须保留/);
    assert.match(text, /WEIBO_COOKIE=SUB=abcdefghij; SUBP=klmnopqrst; ALF=1900000000/);
    assert.match(text, /WXPUSHER_UIDS=UID_new1,UID_new2/);
    assert.match(text, /LOG_LEVEL=debug/);
    assert.equal(text.indexOf('WEIBO_COOKIE=') < text.indexOf('WXPUSHER_APP_TOKEN='), true);
  });
});

test('POST /api/restart 在关闭自动重启时安全返回', async () => {
  await withServer(async ({ base }) => {
    const response = await call(base, '/api/restart', { method: 'POST', body: {} });
    assert.equal(response.status, 200);
    assert.equal(response.json.restart.ok, false);
    assert.equal(response.json.restart.reason, 'disabled');
  });
});

test('admin.html 的内联脚本语法正确', async () => {
  const html = await fs.readFile(new URL('../src/admin.html', import.meta.url), 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, '页面应包含内联脚本');
  assert.doesNotThrow(() => new Function(match[1]));
});

test('未知接口返回 404', async () => {
  await withServer(async ({ base }) => {
    const response = await call(base, '/api/nope');
    assert.equal(response.status, 404);
  });
});

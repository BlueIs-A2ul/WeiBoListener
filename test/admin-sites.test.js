import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAdminServer } from '../src/admin.js';

const TOKEN = 'test-token';

// 假的教务接口：/exams 返回 JSON，/login 返回登录页
const UPSTREAM = {
  code: '0',
  msg: null,
  datas: [
    { taskId: 'a-1', courseName: '高等数学', examTimeDescription: '11月05日 19:00', examPlace: '思学楼B208' },
    { taskId: 'b-2', courseName: '大学英语', examTimeDescription: '11月06日 19:00', examPlace: '思学楼C202' },
  ],
};

async function startUpstream() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/login')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>统一身份认证</title></head><body>请登录</body></html>');
      return;
    }
    if (req.url.startsWith('/exams')) {
      res.writeHead(200, { 'content-type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify(UPSTREAM));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function siteConfig(base, overrides = {}) {
  return {
    id: 'fake-exams',
    name: '假考试',
    request: { url: `${base}/exams?term=1`, cookieEnv: 'SITE_FAKE_EXAMS_COOKIE' },
    success: { path: 'code', equals: '0', messagePath: 'msg' },
    select: { items: 'datas', id: 'taskId', title: 'courseName', time: 'examTimeDescription' },
    ...overrides,
  };
}

async function makeRoot({ base, withPosts = true, sites } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weibo-sites-'));
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.env'),
    [
      'WEIBO_COOKIE=SUB=abc; SUBP=xyz',
      'WXPUSHER_APP_TOKEN=AT_test',
      'WXPUSHER_UIDS=UID_test',
      '',
      'SITE_FAKE_EXAMS_COOKIE=SID=fake',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'config.json'),
    `${JSON.stringify(
      {
        posts: withPosts ? [{ id: '1234567890123456', name: '主微博', enabled: true }] : [],
        sites: sites ?? [siteConfig(base)],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return root;
}

async function withServers(options, run) {
  const upstream = await startUpstream();
  const root = await makeRoot({ base: upstream.base, ...options });
  const server = createAdminServer({ root, token: TOKEN, autoRestart: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ root, base, upstream: upstream.base });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => upstream.server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function call(base, pathname, { method = 'GET', body, token = TOKEN } = {}) {
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

test('overview 返回站点健康度', async () => {
  await withServers({}, async ({ base }) => {
    const response = await call(base, '/api/overview');
    assert.equal(response.status, 200);
    assert.equal(response.json.sites.length, 1);
    assert.equal(response.json.sites[0].id, 'fake-exams');
    assert.equal(response.json.sites[0].baselineDone, false);
    assert.match(response.json.sites[0].url, /\/exams/);
  });
});

test('POST /api/probe 分析 JSON 接口并给出建议配置', async () => {
  await withServers({}, async ({ base, upstream }) => {
    const response = await call(base, '/api/probe', {
      method: 'POST',
      body: { url: `${upstream}/exams?term=1`, cookie: 'SID=fake' },
    });

    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    assert.equal(response.json.kind, 'json');
    assert.equal(response.json.doc.status, 200);

    const analysis = response.json.analysis;
    assert.equal(analysis.candidates[0].path, 'datas');
    assert.equal(analysis.suggestedSite.select.id, 'taskId');
    assert.deepEqual(analysis.success, { path: 'code', equals: '0', messagePath: 'msg' });
  });
});

test('POST /api/probe 遇到登录页时提示 Cookie 可能失效', async () => {
  await withServers({}, async ({ base, upstream }) => {
    const response = await call(base, '/api/probe', {
      method: 'POST',
      body: { url: `${upstream}/login`, cookie: 'SID=expired' },
    });

    assert.equal(response.status, 200);
    assert.equal(response.json.kind, 'html');
    assert.equal(response.json.loginHint, true);
    assert.ok(response.json.warnings.join('').includes('Cookie'));
  });
});

test('POST /api/probe 地址非法时返回可读错误', async () => {
  await withServers({}, async ({ base }) => {
    const response = await call(base, '/api/probe', { method: 'POST', body: { url: 'ftp://example.cn/x' } });
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, false);
    assert.equal(response.json.code, 'HTTP_URL');
  });
});

test('POST /api/site/preview 用草稿真实抓取并渲染文案', async () => {
  await withServers({}, async ({ base, upstream }) => {
    const draft = {
      id: 'draft-exams',
      name: '草稿站点',
      request: { url: `${upstream}/exams?term=1` },
      success: { path: 'code', equals: '0', messagePath: 'msg' },
      select: {
        items: 'datas',
        id: 'taskId',
        title: 'courseName',
        time: 'examTimeDescription',
        fields: [{ path: 'examPlace', label: '考场' }],
      },
      message: { header: '【{site}】新增 {count} 条' },
    };

    const response = await call(base, '/api/site/preview', { method: 'POST', body: { site: draft, cookie: 'SID=fake' } });
    assert.equal(response.status, 200);
    assert.equal(response.json.total, 2);
    assert.equal(response.json.items[0].title, '高等数学');

    const content = response.json.messages[0];
    assert.match(content, /【草稿站点】新增 2 条/);
    assert.match(content, /考场：思学楼B208/);
  });
});

test('POST /api/site/preview 缺少 Cookie 时说明要填哪个键', async () => {
  await withServers({}, async ({ base, upstream }) => {
    const response = await call(base, '/api/site/preview', {
      method: 'POST',
      body: { site: { id: 'x-1', name: 'x', request: { url: `${upstream}/exams` }, select: { items: 'datas', id: 'taskId' } } },
    });
    assert.equal(response.status, 400);
    assert.match(response.json.error.message, /SITE_X_1_COOKIE/);
  });
});

test('POST /api/sites 保存站点并写入 Cookie，保存后能被试跑', async () => {
  await withServers({}, async ({ root, base, upstream }) => {
    const current = await call(base, '/api/config');

    const response = await call(base, '/api/sites', {
      method: 'POST',
      body: {
        site: {
          id: 'new-notice',
          name: '新公告',
          request: { url: `${upstream}/exams?term=2` },
          success: { path: 'code', equals: '0' },
          select: { items: 'datas', id: 'taskId', title: 'courseName' },
        },
        cookie: 'SID=new',
        mtimeMs: current.json.mtimeMs,
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.json.site.id, 'new-notice');
    assert.equal(response.json.cookieSaved, true);
    assert.equal(response.json.restart.reason, 'disabled');

    const config = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
    assert.equal(config.sites.length, 2);
    assert.equal(config.sites[1].id, 'new-notice');

    const env = await fs.readFile(path.join(root, '.env'), 'utf8');
    assert.match(env, /SITE_NEW_NOTICE_COOKIE=SID=new/);
    assert.match(env, /WEIBO_COOKIE=SUB=abc/);

    const tested = await call(base, '/api/site/test', { method: 'POST', body: { siteId: 'new-notice' } });
    assert.equal(tested.status, 200);
    assert.equal(tested.json.total, 2);
  });
});

test('POST /api/site/baseline 把当前条目记为已见', async () => {
  await withServers({}, async ({ root, base }) => {
    const response = await call(base, '/api/site/baseline', { method: 'POST', body: { siteId: 'fake-exams' } });
    assert.equal(response.status, 200);
    assert.equal(response.json.count, 2);

    const state = JSON.parse(await fs.readFile(path.join(root, 'data', 'state.json'), 'utf8'));
    assert.equal(state.sites['fake-exams'].baselineDone, true);
    assert.equal(state.sites['fake-exams'].baselineCount, 2);
    assert.deepEqual(state.sites['fake-exams'].seen.sort(), ['a-1', 'b-2']);

    const overview = await call(base, '/api/overview');
    assert.equal(overview.json.sites[0].baselineDone, true);
  });
});

test('POST /api/sites 局部更新（停用/换 Cookie）不会丢掉站点的其它字段', async () => {
  await withServers({}, async ({ root, base }) => {
    const current = await call(base, '/api/config');
    const response = await call(base, '/api/sites', {
      method: 'POST',
      body: { site: { id: 'fake-exams', enabled: false }, mtimeMs: current.json.mtimeMs },
    });

    assert.equal(response.status, 200);
    assert.equal(response.json.site.enabled, false);
    assert.equal(response.json.site.request.url.includes('/exams'), true);
    assert.equal(response.json.site.select.id, 'taskId');

    const config = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
    assert.equal(config.sites[0].enabled, false);
    assert.equal(config.sites[0].success.path, 'code');
  });
});

test('POST /api/sites/delete 删除站点后写回 config.json', async () => {
  await withServers({}, async ({ root, base }) => {
    const current = await call(base, '/api/config');
    const response = await call(base, '/api/sites/delete', {
      method: 'POST',
      body: { siteId: 'fake-exams', mtimeMs: current.json.mtimeMs },
    });

    assert.equal(response.status, 200);
    const config = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
    assert.deepEqual(config.sites, []);
    assert.equal(config.posts.length, 1);
  });
});

test('删除最后一个站点且没有微博时拒绝并说明原因', async () => {
  await withServers({ withPosts: false }, async ({ base }) => {
    const current = await call(base, '/api/config');
    const response = await call(base, '/api/sites/delete', {
      method: 'POST',
      body: { siteId: 'fake-exams', mtimeMs: current.json.mtimeMs },
    });

    assert.equal(response.status, 400);
    assert.match(response.json.error.message, /至少/);
  });
});

test('站点接口同样要求访问令牌', async () => {
  await withServers({}, async ({ base }) => {
    const probe = await call(base, '/api/probe', { method: 'POST', body: { url: 'http://127.0.0.1/' }, token: null });
    assert.equal(probe.status, 401);

    const save = await call(base, '/api/sites', { method: 'POST', body: { site: { id: 'x' } }, token: 'wrong' });
    assert.equal(save.status, 401);
  });
});

test('POST /api/sites 用过期 mtime 时返回 409', async () => {
  await withServers({}, async ({ base }) => {
    const current = await call(base, '/api/config');
    const response = await call(base, '/api/sites', {
      method: 'POST',
      body: {
        site: {
          id: 'another',
          name: '另一个',
          request: { url: 'http://127.0.0.1:1/exams' },
          select: { items: 'datas', id: 'id' },
        },
        mtimeMs: current.json.mtimeMs - 5000,
      },
    });

    assert.equal(response.status, 409);
    assert.match(response.json.error.message, /外部修改/);
  });
});

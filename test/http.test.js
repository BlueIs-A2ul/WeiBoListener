import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { decodeBody, fetchDocument, FetchError, isLoginUrl } from '../src/http.js';

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('正常 JSON 响应返回文本、状态与耗时', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify({ code: '0', datas: [] }));
    },
    async (base) => {
      const doc = await fetchDocument({ url: base, timeoutMs: 5000 });
      assert.equal(doc.status, 200);
      assert.equal(doc.encoding, 'utf-8');
      assert.match(doc.text, /"code":"0"/);
      assert.ok(doc.bytes > 0);
      assert.ok(Number.isFinite(doc.ms));
    },
  );
});

test('默认带上 Accept-Language，避免拿到内部代码值', async () => {
  let seen = null;
  await withServer(
    (req, res) => {
      seen = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    },
    async (base) => {
      await fetchDocument({ url: base });
      assert.match(seen['accept-language'], /zh-CN/i);
      assert.match(seen['user-agent'], /Mozilla/);
      assert.equal(seen.cookie, undefined);
    },
  );
});

test('Cookie 原样透传，包括同名重复键', async () => {
  const cookie = 'A=1; _WEU=session; A=2';
  let received = null;
  await withServer(
    (req, res) => {
      received = req.headers.cookie;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    },
    async (base) => {
      await fetchDocument({ url: base, cookie });
      assert.equal(received, cookie);
    },
  );
});

test('自定义请求头覆盖默认值', async () => {
  let seen = null;
  await withServer(
    (req, res) => {
      seen = req.headers;
      res.writeHead(200);
      res.end('ok');
    },
    async (base) => {
      await fetchDocument({
        url: base,
        headers: { 'Accept-Language': 'en-US', Referer: 'https://example.edu.cn/' },
      });
      assert.equal(seen['accept-language'], 'en-US');
      assert.equal(seen.referer, 'https://example.edu.cn/');
    },
  );
});

test('GBK 页面按 meta charset 正确解码', async () => {
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // “中文”的 GBK 字节
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(Buffer.concat([Buffer.from('<meta charset="gbk"><p>'), gbk, Buffer.from('</p>')]));
    },
    async (base) => {
      const doc = await fetchDocument({ url: base });
      assert.equal(doc.encoding, 'gb18030');
      assert.match(doc.text, /中文/);
    },
  );
});

test('401 / 403 归类为 HTTP_AUTH', async () => {
  for (const status of [401, 403]) {
    await withServer(
      (req, res) => {
        res.writeHead(status);
        res.end('no');
      },
      async (base) => {
        await assert.rejects(
          () => fetchDocument({ url: base }),
          (err) => err instanceof FetchError && err.code === 'HTTP_AUTH',
        );
      },
    );
  }
});

test('429 归类为限流，5xx 归类为服务端错误', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(429);
      res.end('slow down');
    },
    async (base) => {
      await assert.rejects(() => fetchDocument({ url: base }), (err) => err.code === 'HTTP_RATE_LIMIT');
    },
  );

  await withServer(
    (req, res) => {
      res.writeHead(503);
      res.end('down');
    },
    async (base) => {
      await assert.rejects(() => fetchDocument({ url: base }), (err) => err.code === 'HTTP_SERVER');
    },
  );
});

test('被重定向到登录页判定为 Cookie 失效', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/login') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>login</html>');
        return;
      }
      res.writeHead(302, { location: '/login' });
      res.end();
    },
    async (base) => {
      await assert.rejects(
        () => fetchDocument({ url: base }),
        (err) => err.code === 'HTTP_AUTH' && /登录/.test(err.message),
      );
    },
  );
});

test('超时报 HTTP_TIMEOUT 并提示可能是 Cookie 问题', async () => {
  await withServer(
    (req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end('late');
      }, 500);
    },
    async (base) => {
      await assert.rejects(
        () => fetchDocument({ url: base, timeoutMs: 100 }),
        (err) => err.code === 'HTTP_TIMEOUT' && /Cookie/.test(err.message),
      );
    },
  );
});

test('非 http/https 地址直接拒绝', async () => {
  await assert.rejects(() => fetchDocument({ url: 'file:///etc/passwd' }), (err) => err.code === 'HTTP_URL');
  await assert.rejects(() => fetchDocument({ url: 'not a url' }), (err) => err.code === 'HTTP_URL');
});

test('decodeBody 支持显式指定编码与 UTF-8 BOM', () => {
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  assert.equal(decodeBody(gbk, { encoding: 'gbk' }).text, '中文');

  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]);
  const decoded = decodeBody(withBom, { contentType: 'application/json' });
  assert.equal(decoded.text, '{"a":1}');
});

test('isLoginUrl 识别常见登录地址', () => {
  assert.equal(isLoginUrl('https://passport.example.cn/login?x=1'), true);
  assert.equal(isLoginUrl('https://jw.example.cn/app/sso/index'), true);
  assert.equal(isLoginUrl('https://jw.example.cn/api/list'), false);
  assert.equal(isLoginUrl(''), false);
});

test('跳转目标是登录页时立刻判定 Cookie 失效，不去真的请求登录页', async () => {
  const hits = [];
  await withServer(
    (req, res) => {
      hits.push(req.url);
      if (req.url === '/api/list') {
        // 真实教务系统的样子：302 到 http(80) 上的登录页
        res.writeHead(302, { location: 'http://jw.example.cn/app/login-index.do?service=x' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>login page</html>');
    },
    async (base) => {
      const startedAt = Date.now();
      await assert.rejects(
        () => fetchDocument({ url: `${base}/api/list` }),
        (err) => err.code === 'HTTP_AUTH' && /登录页/.test(err.message) && /login-index/.test(err.message),
      );
      // 关键：登录页地址压根没被请求，所以不会白白等一次连接超时
      assert.deepEqual(hits, ['/api/list']);
      assert.ok(Date.now() - startedAt < 2000);
    },
  );
});

test('普通跳转会被跟随，并返回最终地址', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/a') {
        res.writeHead(301, { location: '/b' });
        res.end();
        return;
      }
      if (req.url === '/b') {
        res.writeHead(302, { location: '/c' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"code":"0","datas":[]}');
    },
    async (base) => {
      const doc = await fetchDocument({ url: `${base}/a` });
      assert.equal(doc.status, 200);
      assert.equal(doc.redirected, true);
      assert.equal(doc.finalUrl, `${base}/c`);
      assert.match(doc.text, /"code":"0"/);
    },
  );
});

test('303 把 POST 降级成 GET，307 保留原方法', async () => {
  const seen = [];
  await withServer(
    (req, res) => {
      seen.push(`${req.method} ${req.url}`);
      if (req.url === '/post303') {
        res.writeHead(303, { location: '/after303' });
        res.end();
        return;
      }
      if (req.url === '/post307') {
        res.writeHead(307, { location: '/after307' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
    async (base) => {
      await fetchDocument({ url: `${base}/post303`, method: 'POST', body: 'a=1' });
      await fetchDocument({ url: `${base}/post307`, method: 'POST', body: 'a=1' });
      assert.deepEqual(seen, ['POST /post303', 'GET /after303', 'POST /post307', 'POST /after307']);
    },
  );
});

test('跳转次数过多时报 HTTP_REDIRECT', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(302, { location: `/loop${Number(req.url.replace('/loop', '')) + 1}` });
      res.end();
    },
    async (base) => {
      await assert.rejects(
        () => fetchDocument({ url: `${base}/loop0` }),
        (err) => err.code === 'HTTP_REDIRECT' && /跳转次数过多/.test(err.message),
      );
    },
  );
});

test('跳转后连接失败时，错误消息里带上跳转后的地址', async () => {
  const seen = [];
  await withServer(
    (req, res) => {
      seen.push(req.url);
      res.writeHead(302, { location: 'http://127.0.0.1:1/dead' });
      res.end();
    },
    async (base) => {
      await assert.rejects(
        () => fetchDocument({ url: base, timeoutMs: 3000 }),
        (err) => err.code === 'HTTP_NETWORK' && /跳转后地址/.test(err.message) && /127\.0\.0\.1:1/.test(err.message),
      );
      assert.deepEqual(seen, ['/']);
    },
  );
});


import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../src/config.js';

function minimal(overrides = {}) {
  return {
    posts: [{ id: '123', name: '测试', enabled: true }],
    ...overrides,
  };
}

test('默认轮询间隔是 5 分钟', () => {
  const config = normalizeConfig(minimal());
  assert.equal(config.pollIntervalSec, 300);
});

test('轮询间隔可以由用户修改', () => {
  const config = normalizeConfig(minimal({ pollIntervalSec: 120 }));
  assert.equal(config.pollIntervalSec, 120);
});

test('轮询间隔小于 30 秒会报错', () => {
  assert.throws(() => normalizeConfig(minimal({ pollIntervalSec: 10 })), /不能小于 30/);
});

test('heartbeatHour 为 0 表示午夜，不是关闭', () => {
  assert.equal(normalizeConfig(minimal({ heartbeatHour: 0 })).heartbeatHour, 0);
  assert.equal(normalizeConfig(minimal({ heartbeatHour: null })).heartbeatHour, null);
});

test('重复的微博 ID 会报错', () => {
  assert.throws(
    () =>
      normalizeConfig({
        posts: [
          { id: '123', name: 'A' },
          { id: '123', name: 'B' },
        ],
      }),
    /重复/,
  );
});

test('非法微博 ID 会报错', () => {
  assert.throws(() => normalizeConfig({ posts: [{ id: 'abc' }] }), /纯数字/);
});

test('默认不填 url，由程序启动时自动解析', () => {
  const config = normalizeConfig(minimal());
  assert.equal(config.posts[0].url, null);
});

test('显式配置的 url 会保留', () => {
  const config = normalizeConfig({
    posts: [{ id: '123', name: '测试', url: 'https://weibo.com/1/abc' }],
  });
  assert.equal(config.posts[0].url, 'https://weibo.com/1/abc');
});


// ---------------------------------------------------------------- 通用站点（sites）

function siteConfig(overrides = {}) {
  return {
    id: 'swpu-exams',
    name: '考试安排',
    request: { url: 'https://deanservices.swpu.edu.cn/jwapp/sys/homeapp/api/home/student/exams.do' },
    select: { items: 'datas', id: 'taskId', title: 'courseName' },
    ...overrides,
  };
}

test('只配置站点、不配置微博也是合法的', () => {
  const config = normalizeConfig({ posts: [], sites: [siteConfig()] });
  assert.equal(config.posts.length, 0);
  assert.equal(config.sites.length, 1);
  assert.equal(config.sites[0].id, 'swpu-exams');
});

test('posts 与 sites 都为空时报错', () => {
  assert.throws(() => normalizeConfig({ posts: [], sites: [] }), /至少/);
});

test('站点 Cookie 键名默认由 ID 派生', () => {
  const config = normalizeConfig({ posts: [], sites: [siteConfig()] });
  assert.equal(config.sites[0].request.cookieEnv, 'SITE_SWPU_EXAMS_COOKIE');
});

test('站点 ID 只允许小写字母数字和短横线', () => {
  assert.throws(() => normalizeConfig({ posts: [], sites: [siteConfig({ id: '考试安排' })] }), /小写字母/);
  assert.throws(() => normalizeConfig({ posts: [], sites: [siteConfig({ id: 'Bad_Id' })] }), /小写字母/);
});

test('重复的站点 ID 会报错', () => {
  assert.throws(
    () => normalizeConfig({ posts: [], sites: [siteConfig(), siteConfig()] }),
    /重复的站点 ID/,
  );
});

test('暂不支持 json 以外的抓取模式', () => {
  assert.throws(() => normalizeConfig({ posts: [], sites: [siteConfig({ mode: 'html' })] }), /只支持 json/);
});

test('站点地址必须是 http/https', () => {
  assert.throws(
    () => normalizeConfig({
      posts: [],
      sites: [siteConfig({ request: { url: 'ftp://example.cn/x' } })],
    }),
    /http\/https/,
  );
});

test('success.equals 允许写成数字 0，归一化成字符串比较', () => {
  const config = normalizeConfig({
    posts: [],
    sites: [siteConfig({ success: { path: 'code', equals: 0, messagePath: 'msg' } })],
  });
  assert.equal(config.sites[0].success.equals, '0');
  assert.equal(config.sites[0].success.messagePath, 'msg');
});

test('success 缺少 equals 会报错', () => {
  assert.throws(
    () => normalizeConfig({ posts: [], sites: [siteConfig({ success: { path: 'code' } })] }),
    /success.equals/,
  );
});

test('select 必填项缺失会报清楚哪个字段', () => {
  assert.throws(
    () => normalizeConfig({ posts: [], sites: [siteConfig({ select: { id: 'taskId' } })] }),
    /select.items/,
  );
  assert.throws(
    () => normalizeConfig({ posts: [], sites: [siteConfig({ select: { items: 'datas' } })] }),
    /select.id/,
  );
});

test('站点轮询间隔最小 60 秒，默认继承全局', () => {
  const config = normalizeConfig({ posts: [], sites: [siteConfig()] });
  assert.equal(config.sites[0].pollIntervalSec, null);
  assert.throws(
    () => normalizeConfig({ posts: [], sites: [siteConfig({ pollIntervalSec: 30 })] }),
    /不能小于 60/,
  );
});

test('站点消息模板默认留空，由渲染层兜底', () => {
  const config = normalizeConfig({
    posts: [],
    sites: [siteConfig({ message: { header: '  ', item: null } })],
  });
  assert.equal(config.sites[0].message.header, null);
  assert.equal(config.sites[0].message.item, null);
});


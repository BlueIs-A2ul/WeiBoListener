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

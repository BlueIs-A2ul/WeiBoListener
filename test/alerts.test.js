import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../src/config.js';
import { createEmptyState } from '../src/state.js';
import {
  buildHeartbeatContent,
  maybeCookieExpiryAlert,
  maybeFailureAlert,
  maybeHeartbeat,
  maybeStartupAlert,
} from '../src/alerts.js';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const fixedNow = () => new Date(NOW);

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

// heartbeatHour 用 0，任何时区都算“已到点”，避免测试依赖本地时区。
function makeConfig(overrides = {}) {
  return normalizeConfig({
    posts: [{ id: '123', name: '测试微博', enabled: true }],
    heartbeatHour: 0,
    ...overrides,
  });
}

function cycle(overrides = {}) {
  return { posts: 1, ok: 1, failed: 0, skipped: 0, lastError: null, ...overrides };
}

function recorder() {
  const sent = [];
  return { sent, sendMessage: async (message) => sent.push(message) };
}

test('正常轮询的心跳会报成功数，不报异常', () => {
  const state = createEmptyState();
  state.lastSuccessAt = '2026-10-26T11:00:00.000Z';

  const content = buildHeartbeatContent({
    config: makeConfig(),
    state,
    cycle: cycle(),
    now: fixedNow,
  });

  assert.match(content, /微博监听心跳/);
  assert.match(content, /状态：正常/);
  assert.match(content, /本轮：1 成功 \/ 0 失败/);
  assert.match(content, /最近成功：/);
  assert.doesNotMatch(content, /异常/);
});

test('全部失败时心跳如实报告连续失败，不再写“状态：正常”', () => {
  const state = createEmptyState();
  state.failStreak = 3;
  state.lastSuccessAt = '2026-10-26T10:00:00.000Z';

  const content = buildHeartbeatContent({
    config: makeConfig(),
    state,
    cycle: cycle({
      ok: 0,
      failed: 1,
      lastError: { name: '主微博', message: '请求微博失败：fetch failed' },
    }),
    now: fixedNow,
  });

  assert.match(content, /心跳（异常）/);
  assert.match(content, /状态：异常（连续 3 轮失败）/);
  assert.match(content, /本轮：0 成功 \/ 1 失败/);
  assert.match(content, /请求微博失败：fetch failed/);
  assert.doesNotMatch(content, /状态：正常/);
});

test('从未成功过的心跳写明尚未成功', () => {
  const state = createEmptyState();
  state.failStreak = 1;

  const content = buildHeartbeatContent({
    config: makeConfig(),
    state,
    cycle: cycle({ ok: 0, failed: 1 }),
    now: fixedNow,
  });

  assert.match(content, /最近成功：尚未成功/);
});

test('心跳会发送并记录当天日期，同一天不重复', async () => {
  const state = createEmptyState();
  const { sent, sendMessage } = recorder();
  const config = makeConfig();

  const first = await maybeHeartbeat({ config, state, cycle: cycle(), logger, sendMessage, now: fixedNow });
  const second = await maybeHeartbeat({ config, state, cycle: cycle(), logger, sendMessage, now: fixedNow });

  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].summary, '微博监听正常运行');
});

test('异常心跳用异常摘要，方便手机上区分', async () => {
  const state = createEmptyState();
  state.failStreak = 2;
  const { sent, sendMessage } = recorder();

  await maybeHeartbeat({
    config: makeConfig(),
    state,
    cycle: cycle({ ok: 0, failed: 1 }),
    logger,
    sendMessage,
    now: fixedNow,
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0].summary, /异常/);
});

test('dry-run 下心跳只写日志、不发送', async () => {
  const state = createEmptyState();
  const { sent, sendMessage } = recorder();

  await maybeHeartbeat({
    config: makeConfig(),
    state,
    cycle: cycle(),
    logger,
    dryRun: true,
    sendMessage,
    now: fixedNow,
  });

  assert.equal(sent.length, 0);
  assert.ok(state.lastHeartbeatDate);
});

test('连续失败不满 3 轮不告警', async () => {
  const state = createEmptyState();
  state.failStreak = 2;
  const { sent, sendMessage } = recorder();

  const sentAny = await maybeFailureAlert({
    state,
    cycle: cycle({ ok: 0, failed: 1, lastError: { name: '主微博', message: 'boom' } }),
    logger,
    sendMessage,
    now: fixedNow,
  });

  assert.equal(sentAny, false);
  assert.equal(sent.length, 0);
});

test('连续失败 3 轮时告警一次，24 小时内不重复', async () => {
  const state = createEmptyState();
  state.failStreak = 3;
  state.lastSuccessAt = '2026-10-26T10:00:00.000Z';
  const { sent, sendMessage } = recorder();
  const args = {
    state,
    cycle: cycle({ ok: 0, failed: 1, lastError: { name: '主微博', message: '请求微博失败：fetch failed' } }),
    logger,
    sendMessage,
  };

  const first = await maybeFailureAlert({ ...args, now: fixedNow });
  const second = await maybeFailureAlert({ ...args, now: () => new Date(NOW.getTime() + 60 * 60 * 1000) });

  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /连续失败/);
  assert.match(sent[0].content, /已连续 3 轮/);
  assert.match(sent[0].content, /fetch failed/);
  assert.ok(state.failAlertAt);
});

test('超过 24 小时后允许再发一次连续失败告警', async () => {
  const state = createEmptyState();
  state.failStreak = 3;
  state.failAlertAt = NOW.toISOString();
  const { sent, sendMessage } = recorder();

  const sentAny = await maybeFailureAlert({
    state,
    cycle: cycle({ ok: 0, failed: 1 }),
    logger,
    sendMessage,
    now: () => new Date(NOW.getTime() + 25 * 60 * 60 * 1000),
  });

  assert.equal(sentAny, true);
  assert.equal(sent.length, 1);
});

test('Cookie 失效暂停期间不再叠加连续失败告警', async () => {
  const state = createEmptyState();
  state.failStreak = 5;
  state.authPausedUntil = new Date(NOW.getTime() + 30 * 60 * 1000).toISOString();
  const { sent, sendMessage } = recorder();

  const sentAny = await maybeFailureAlert({
    state,
    cycle: cycle({ ok: 0, failed: 1 }),
    logger,
    sendMessage,
    now: fixedNow,
  });

  assert.equal(sentAny, false);
  assert.equal(sent.length, 0);
});

test('Cookie 剩余不足 7 天时告警，同一过期时间只告警一次', async () => {
  const state = createEmptyState();
  const { sent, sendMessage } = recorder();
  const expiry = new Date(NOW.getTime() + 6 * 24 * 3600 * 1000);

  const first = await maybeCookieExpiryAlert({ state, expiry, logger, sendMessage, now: fixedNow });
  const second = await maybeCookieExpiryAlert({ state, expiry, logger, sendMessage, now: fixedNow });

  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /Cookie 即将过期/);
  assert.match(sent[0].content, /剩余 6 天/);
  assert.match(sent[0].summary, /Cookie/);
});

test('换了新 Cookie（新的过期时间）可以再次收到临期告警', async () => {
  const state = createEmptyState();
  const { sent, sendMessage } = recorder();
  const expiry = new Date(NOW.getTime() + 5 * 24 * 3600 * 1000);
  const laterExpiry = new Date(NOW.getTime() + 6 * 24 * 3600 * 1000);

  await maybeCookieExpiryAlert({ state, expiry, logger, sendMessage, now: fixedNow });
  await maybeCookieExpiryAlert({ state, expiry: laterExpiry, logger, sendMessage, now: fixedNow });

  assert.equal(sent.length, 2);
});

test('Cookie 还很宽裕时不打扰', async () => {
  const state = createEmptyState();
  const { sent, sendMessage } = recorder();

  const sentAny = await maybeCookieExpiryAlert({
    state,
    expiry: new Date(NOW.getTime() + 30 * 24 * 3600 * 1000),
    logger,
    sendMessage,
    now: fixedNow,
  });

  assert.equal(sentAny, false);
  assert.equal(sent.length, 0);
});

test('没有解析到过期时间时不告警', async () => {
  const state = createEmptyState();
  const { sent, sendMessage } = recorder();

  const sentAny = await maybeCookieExpiryAlert({ state, expiry: null, logger, sendMessage, now: fixedNow });

  assert.equal(sentAny, false);
  assert.equal(sent.length, 0);
});

test('启动失败会推送原因并落盘，6 小时内不重复', async () => {
  const state = createEmptyState();
  const { sent, sendMessage } = recorder();
  let saves = 0;
  const saveState = async () => {
    saves += 1;
  };

  const first = await maybeStartupAlert({
    state,
    reason: '缺少 WEIBO_COOKIE',
    logger,
    sendMessage,
    now: fixedNow,
    saveState,
  });
  const second = await maybeStartupAlert({
    state,
    reason: '缺少 WEIBO_COOKIE',
    logger,
    sendMessage,
    now: fixedNow,
    saveState,
  });

  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /启动失败/);
  assert.match(sent[0].content, /缺少 WEIBO_COOKIE/);
  assert.equal(saves, 1);
});

test('推送失败时不抛出，避免错误路径把进程带崩', async () => {
  const state = createEmptyState();
  const boom = async () => {
    throw new Error('network down');
  };

  const sentAny = await maybeStartupAlert({
    state,
    reason: '缺少 WEIBO_COOKIE',
    logger,
    sendMessage: boom,
    now: fixedNow,
    saveState: async () => {},
  });

  assert.equal(sentAny, false);
});

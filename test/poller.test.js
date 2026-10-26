import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../src/config.js';
import { ensurePostState, createEmptyState } from '../src/state.js';
import { pollAll, pollPost } from '../src/poller.js';
import { WeiboAuthError } from '../src/weibo.js';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const fixedNow = () => new Date(NOW);

function makeConfig(overrides = {}) {
  return normalizeConfig({
    pollIntervalSec: 300,
    jitterSec: 0,
    heartbeatHour: null,
    deepScanIntervalHours: 0,
    baselineMaxPages: 5,
    posts: [{ id: '123', name: '测试微博', enabled: true }],
    ...overrides,
  });
}

function makeLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function comment(id, text = 'hi', extra = {}) {
  return {
    id: String(id),
    rootId: String(id),
    isTopLevel: true,
    floor: Number(id) % 100,
    createdAtRaw: 'Mon Oct 26 19:37:35 +0800 2026',
    createdAt: new Date('2026-10-26T11:37:35.000Z'),
    text,
    rawText: text,
    user: { id: 'u1', name: `用户${id}` },
    likeCounts: null,
    ...extra,
  };
}

function page(comments, { maxId = '0', total = comments.length } = {}) {
  return { comments, maxId, sinceId: '0', total, header: '' };
}

function seededState(seen = ['0', '1', '2']) {
  const state = createEmptyState();
  const postState = ensurePostState(state, '123');
  postState.baselineDone = true;
  postState.baselineAt = NOW.toISOString();
  postState.baselineMinId = '0';
  postState.seen = [...seen];
  postState.lastDeepScanAt = NOW.toISOString();
  return state;
}

test('首次运行建立基线，不推送历史评论', async () => {
  const config = makeConfig();
  const state = createEmptyState();
  const sent = [];
  const calls = [];

  const fetchPage = async ({ maxId }) => {
    calls.push(maxId);
    if (!maxId) return page([comment(2), comment(1)], { maxId: '10', total: 3 });
    if (maxId === '10') return page([comment(0)], { maxId: '0', total: 3 });
    throw new Error(`unexpected maxId ${maxId}`);
  };

  const result = await pollPost({
    post: config.posts[0],
    config,
    state,
    logger: makeLogger(),
    fetchPage,
    sendMessage: async (message) => sent.push(message),
    saveState: async () => {},
    now: fixedNow,
  });

  assert.equal(result.baseline, true);
  assert.equal(result.total, 3);
  assert.equal(state.posts['123'].baselineDone, true);
  assert.equal(state.posts['123'].baselineMinId, '0');
  assert.deepEqual([...state.posts['123'].seen].sort(), ['0', '1', '2']);
  assert.equal(sent.length, 0);
  assert.deepEqual(calls, [undefined, '10']);
});

test('发现新评论后推送并写入已见集合', async () => {
  const config = makeConfig();
  const state = seededState();
  const sent = [];

  const fetchPage = async () => page([comment(3), comment(2)], { maxId: '0' });

  const result = await pollPost({
    post: config.posts[0],
    config,
    state,
    logger: makeLogger(),
    fetchPage,
    sendMessage: async (message) => sent.push(message),
    saveState: async () => {},
    now: fixedNow,
  });

  assert.equal(result.newCount, 1);
  assert.equal(result.pushed, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /用户3/);
  assert.match(sent[0].content, /hi/);
  assert.ok(state.posts['123'].seen.includes('3'));
});

test('同一批评论不会重复推送', async () => {
  const config = makeConfig();
  const state = seededState();
  const sent = [];

  const fetchPage = async () => page([comment(3), comment(2)], { maxId: '0' });
  const deps = {
    post: config.posts[0],
    config,
    state,
    logger: makeLogger(),
    fetchPage,
    sendMessage: async (message) => sent.push(message),
    saveState: async () => {},
    now: fixedNow,
  };

  await pollPost(deps);
  await pollPost(deps);

  assert.equal(sent.length, 1);
  assert.equal(state.posts['123'].seen.filter((id) => id === '3').length, 1);
});

test('推送失败时不标记为已见，下一轮会重试', async () => {
  const config = makeConfig();
  const state = seededState();
  const fetchPage = async () => page([comment(3), comment(2)], { maxId: '0' });
  const deps = {
    post: config.posts[0],
    config,
    state,
    logger: makeLogger(),
    fetchPage,
    saveState: async () => {},
    now: fixedNow,
  };

  await assert.rejects(
    () =>
      pollPost({
        ...deps,
        sendMessage: async () => {
          throw new Error('push failed');
        },
      }),
    /push failed/,
  );
  assert.equal(state.posts['123'].seen.includes('3'), false);

  const sent = [];
  const result = await pollPost({
    ...deps,
    sendMessage: async (message) => sent.push(message),
  });
  assert.equal(result.pushed, 1);
  assert.equal(sent.length, 1);
});

test('命中排除关键词的评论不推送，但会标记为已见', async () => {
  const config = makeConfig({ filters: { excludeKeywords: ['广告'] } });
  const state = seededState();
  const sent = [];
  const fetchPage = async () => page([comment(4, '这是广告')], { maxId: '0' });

  const result = await pollPost({
    post: config.posts[0],
    config,
    state,
    logger: makeLogger(),
    fetchPage,
    sendMessage: async (message) => sent.push(message),
    saveState: async () => {},
    now: fixedNow,
  });

  assert.equal(result.newCount, 0);
  assert.equal(sent.length, 0);
  assert.ok(state.posts['123'].seen.includes('4'));
});

test('第一页全是新评论时会继续翻页，避免漏评论', async () => {
  const config = makeConfig();
  const state = seededState(['1']);
  const sent = [];

  const firstPageComments = Array.from({ length: 20 }, (_, index) => comment(100 + index));
  const fetchPage = async ({ maxId }) => {
    if (!maxId) return page(firstPageComments, { maxId: '50', total: 22 });
    if (maxId === '50') return page([comment(99), comment(1)], { maxId: '0', total: 22 });
    throw new Error(`unexpected maxId ${maxId}`);
  };

  const result = await pollPost({
    post: config.posts[0],
    config,
    state,
    logger: makeLogger(),
    fetchPage,
    sendMessage: async (message) => sent.push(message),
    saveState: async () => {},
    now: fixedNow,
  });

  assert.equal(result.newCount, 21);
  assert.equal(result.pushed, 21);
  assert.ok(sent.length >= 1);
  assert.ok(state.posts['123'].seen.includes('99'));
});

test('dry-run 不保存状态、不发送消息', async () => {
  const config = makeConfig();
  const state = createEmptyState();
  let saves = 0;
  const sent = [];

  const result = await pollPost({
    post: config.posts[0],
    config,
    state,
    logger: makeLogger(),
    dryRun: true,
    fetchPage: async () => page([comment(1)], { maxId: '0' }),
    sendMessage: async (message) => sent.push(message),
    saveState: async () => {
      saves += 1;
    },
    now: fixedNow,
  });

  assert.equal(result.baseline, true);
  assert.equal(saves, 0);
  assert.equal(sent.length, 0);
});

test('多微博分别建立独立基线和状态', async () => {
  const config = makeConfig({
    posts: [
      { id: '111', name: '微博 A', enabled: true },
      { id: '222', name: '微博 B', enabled: true },
    ],
  });
  const state = createEmptyState();

  const fetchPage = async ({ postId }) => page([comment(postId === '111' ? 11 : 22)], { maxId: '0' });

  const result = await pollAll({
    config,
    state,
    logger: makeLogger(),
    fetchPage,
    sendMessage: async () => {
      throw new Error('不应发送消息');
    },
    saveState: async () => {},
    now: fixedNow,
    sleep: async () => {},
  });

  assert.equal(result.results.length, 2);
  assert.equal(state.posts['111'].baselineDone, true);
  assert.equal(state.posts['222'].baselineDone, true);
  assert.deepEqual(state.posts['111'].seen, ['11']);
  assert.deepEqual(state.posts['222'].seen, ['22']);
});

test('Cookie 失效时暂停并发送一次告警', async () => {
  const config = makeConfig();
  const state = createEmptyState();
  const sent = [];

  const fetchPage = async () => {
    throw new WeiboAuthError('Cookie 已失效：请求被跳转到登录页');
  };

  const result = await pollAll({
    config,
    state,
    logger: makeLogger(),
    fetchPage,
    sendMessage: async (message) => sent.push(message),
    saveState: async () => {},
    now: fixedNow,
    sleep: async () => {},
  });

  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].code, 'WEIBO_AUTH');
  assert.ok(state.authPausedUntil);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /Cookie 失效/);
});
test('一轮全部失败后累计失败轮数，成功一轮后清零', async () => {
  const config = makeConfig();
  const state = seededState();
  const failing = async () => {
    const err = new Error('请求微博失败：fetch failed');
    err.code = 'WEIBO_NETWORK';
    throw err;
  };

  await pollAll({
    config,
    state,
    logger: makeLogger(),
    fetchPage: failing,
    sendMessage: async () => {},
    saveState: async () => {},
    now: fixedNow,
    sleep: async () => {},
  });
  assert.equal(state.failStreak, 1);

  await pollAll({
    config,
    state,
    logger: makeLogger(),
    fetchPage: async () => page([comment(2)], { maxId: '0' }),
    sendMessage: async () => {},
    saveState: async () => {},
    now: fixedNow,
    sleep: async () => {},
  });
  assert.equal(state.failStreak, 0);
  assert.ok(state.lastSuccessAt);
});

test('连续 3 轮失败推送一次告警，第 4 轮不重复', async () => {
  const config = makeConfig();
  const state = seededState();
  const sent = [];
  const failing = async () => {
    const err = new Error('请求微博失败：fetch failed');
    err.code = 'WEIBO_NETWORK';
    throw err;
  };
  const deps = {
    config,
    state,
    logger: makeLogger(),
    fetchPage: failing,
    sendMessage: async (message) => sent.push(message),
    saveState: async () => {},
    now: fixedNow,
    sleep: async () => {},
  };

  await pollAll(deps);
  await pollAll(deps);
  assert.equal(sent.length, 0);

  await pollAll(deps);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /连续失败/);

  await pollAll(deps);
  assert.equal(sent.length, 1);
});

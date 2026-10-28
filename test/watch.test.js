import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../src/config.js';
import { formatSiteMessages } from '../src/format.js';
import { pollAll } from '../src/poller.js';
import { createEmptyState, ensureSiteState } from '../src/state.js';
import { applyFilters, pollSite, pollSites } from '../src/watch.js';

const NOW = new Date('2026-10-28T12:00:00.000Z');
const fixedNow = () => new Date(NOW);

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function makeConfig(siteOverrides = {}, configOverrides = {}) {
  return normalizeConfig({
    posts: [],
    heartbeatHour: null,
    ...configOverrides,
    sites: [
      {
        id: 'swpu-exams',
        name: '考试安排',
        mode: 'json',
        request: {
          url: 'https://deanservices.swpu.edu.cn/jwapp/sys/homeapp/api/home/student/exams.do?termCode=2026-2027-1',
        },
        success: { path: 'code', equals: '0', messagePath: 'msg' },
        select: {
          items: 'datas',
          id: 'taskId',
          title: 'courseName',
          time: 'examTimeDescription',
          fields: [{ path: 'examPlace', label: '考场' }],
        },
        ...siteOverrides,
      },
    ],
  });
}

function exam(taskId, courseName, examPlace = '思学楼B208') {
  return {
    taskId,
    courseName,
    examPlace,
    examTimeDescription: '2026年11月05日 19:00-20:40(星期四第5场)',
  };
}

function okDoc(datas) {
  return {
    status: 200,
    contentType: 'application/json',
    encoding: 'utf-8',
    bytes: 100,
    ms: 10,
    text: JSON.stringify({ code: '0', datas }),
  };
}

function recorder() {
  const sent = [];
  return { sent, sendMessage: async (message) => sent.push(message) };
}

test('首次抓取只建立基线，不推送历史条目', async () => {
  const config = makeConfig();
  const state = createEmptyState();
  const { sent } = recorder();
  let saves = 0;

  const result = await pollSite({
    site: config.sites[0],
    config,
    state,
    logger,
    cookie: 'SID=abc',
    fetchDocumentImpl: async () => okDoc([exam('a', '高数'), exam('b', '英语')]),
    sendMessage: async () => {
      throw new Error('不应推送');
    },
    saveState: async () => { saves += 1; },
    now: fixedNow,
  });

  assert.equal(result.baseline, true);
  assert.equal(result.total, 2);
  assert.equal(sent.length, 0);
  assert.equal(saves, 1);

  const siteState = state.sites['swpu-exams'];
  assert.equal(siteState.baselineDone, true);
  assert.equal(siteState.baselineCount, 2);
  assert.deepEqual(siteState.seen.sort(), ['a', 'b']);
});

test('出现新条目后推送一次，再轮询不重复推送', async () => {
  const config = makeConfig();
  const state = createEmptyState();
  ensureSiteState(state, 'swpu-exams').baselineDone = true;
  state.sites['swpu-exams'].seen = ['a'];
  const { sent, sendMessage } = recorder();

  const deps = {
    site: config.sites[0],
    config,
    state,
    logger,
    cookie: 'SID=abc',
    fetchDocumentImpl: async () => okDoc([exam('b', '英语'), exam('a', '高数')]),
    sendMessage,
    saveState: async () => {},
    now: fixedNow,
  };

  const first = await pollSite(deps);
  assert.equal(first.newCount, 1);
  assert.equal(first.pushed, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /新增 1 条/);
  assert.match(sent[0].content, /英语/);
  assert.match(sent[0].content, /考场/);

  const second = await pollSite(deps);
  assert.equal(second.newCount, 0);
  assert.equal(sent.length, 1);
});

test('排除关键词命中的条目既不推送也不计入已见之外的噪声', async () => {
  const config = makeConfig({ filters: { excludeKeywords: ['补考'] } });
  const state = createEmptyState();
  ensureSiteState(state, 'swpu-exams').baselineDone = true;
  state.sites['swpu-exams'].seen = [];
  const { sent, sendMessage } = recorder();

  const result = await pollSite({
    site: config.sites[0],
    config,
    state,
    logger,
    cookie: 'SID=abc',
    fetchDocumentImpl: async () => okDoc([exam('a', '高数补考'), exam('b', '英语')]),
    sendMessage,
    saveState: async () => {},
    now: fixedNow,
  });

  assert.equal(result.newCount, 1);
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].content, /补考/);
});

test('includeKeywords 只保留命中的条目', () => {
  const items = [
    { id: '1', title: '考试安排', text: '', fields: [] },
    { id: '2', title: '选课通知', text: '', fields: [] },
  ];
  assert.deepEqual(
    applyFilters(items, { includeKeywords: ['考试'] }).map((item) => item.id),
    ['1'],
  );
});

test('Cookie 失效时暂停该站点并只告警一次', async () => {
  const config = makeConfig();
  const state = createEmptyState();
  const { sent, sendMessage } = recorder();

  const deps = {
    sites: config.sites,
    config,
    state,
    logger,
    cookieForSite: () => 'SID=expired',
    fetchDocumentImpl: async () => ({
      status: 200,
      contentType: 'text/html',
      encoding: 'utf-8',
      bytes: 4000,
      ms: 20,
      text: '<!DOCTYPE html><title>统一身份认证</title>',
    }),
    sendMessage,
    saveState: async () => {},
    now: fixedNow,
    sleep: async () => {},
  };

  const first = await pollSites(deps);
  assert.equal(first.cycle.failed, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /Cookie/);
  assert.ok(state.sites['swpu-exams'].authPausedUntil);

  // 暂停期内再跑：直接跳过，不重复告警
  const second = await pollSites(deps);
  assert.equal(second.cycle.skipped, 1);
  assert.equal(sent.length, 1);
});

test('没有配置站点 Cookie 时给出可操作的报错', async () => {
  const config = makeConfig();
  const state = createEmptyState();
  const { sent, sendMessage } = recorder();

  const result = await pollSites({
    sites: config.sites,
    config,
    state,
    logger,
    cookieForSite: () => '',
    fetchDocumentImpl: async () => okDoc([]),
    sendMessage,
    saveState: async () => {},
    now: fixedNow,
    sleep: async () => {},
  });

  assert.equal(result.cycle.failed, 1);
  assert.match(result.results[0].error, /SITE_SWPU_EXAMS_COOKIE/);
  assert.equal(sent.length, 1);
});

test('推送失败时不标记已见，下一轮会重试', async () => {
  const config = makeConfig();
  const state = createEmptyState();
  const siteState = ensureSiteState(state, 'swpu-exams');
  siteState.baselineDone = true;
  siteState.seen = [];

  const deps = {
    site: config.sites[0],
    config,
    state,
    logger,
    cookie: 'SID=abc',
    fetchDocumentImpl: async () => okDoc([exam('a', '高数')]),
    saveState: async () => {},
    now: fixedNow,
  };

  await assert.rejects(
    () => pollSite({ ...deps, sendMessage: async () => { throw new Error('push failed'); } }),
    /push failed/,
  );
  assert.equal(siteState.seen.includes('a'), false);
  assert.ok(siteState.lastError);

  const { sent, sendMessage } = recorder();
  const retry = await pollSite({ ...deps, sendMessage });
  assert.equal(retry.pushed, 1);
  assert.equal(sent.length, 1);
});

test('一个站点失败不影响另一个站点', async () => {
  const config = normalizeConfig({
    posts: [],
    sites: [
      {
        id: 'bad',
        name: '坏站点',
        request: { url: 'https://bad.example.cn/api' },
        select: { items: 'datas', id: 'id', title: 'title' },
      },
      {
        id: 'good',
        name: '好站点',
        request: { url: 'https://good.example.cn/api' },
        select: { items: 'datas', id: 'id', title: 'title' },
      },
    ],
  });
  const state = createEmptyState();
  const { sent, sendMessage } = recorder();

  const result = await pollSites({
    sites: config.sites,
    config,
    state,
    logger,
    cookieForSite: () => 'SID=abc',
    fetchDocumentImpl: async ({ url }) => {
      if (url.includes('bad')) throw Object.assign(new Error('boom'), { code: 'HTTP_SERVER' });
      return {
        status: 200,
        contentType: 'application/json',
        encoding: 'utf-8',
        bytes: 10,
        ms: 1,
        text: JSON.stringify({ datas: [{ id: '1', title: '公告' }] }),
      };
    },
    sendMessage,
    saveState: async () => {},
    now: fixedNow,
    sleep: async () => {},
  });

  assert.equal(result.cycle.failed, 1);
  assert.equal(result.cycle.ok, 1);
  assert.equal(state.sites.good.baselineDone, true);
  assert.equal(state.sites.bad.baselineDone, false);
  assert.equal(sent.length, 0);
});

test('pollAll 会把站点纳入同一轮，并合并健康度统计', async () => {
  const config = makeConfig();
  const state = createEmptyState();
  const { sent, sendMessage } = recorder();

  const result = await pollAll({
    config,
    state,
    logger,
    fetchPage: async () => {
      throw new Error('没有微博，不应调用');
    },
    fetchDocumentImpl: async () => okDoc([exam('a', '高数')]),
    cookieForSite: () => 'SID=abc',
    sendMessage,
    saveState: async () => {},
    now: fixedNow,
    sleep: async () => {},
  });

  assert.equal(result.cycle.posts, 0);
  assert.equal(result.cycle.sites, 1);
  assert.equal(result.cycle.ok, 1);
  assert.equal(result.siteResults.length, 1);
  assert.equal(state.sites['swpu-exams'].baselineDone, true);
  assert.ok(state.lastSuccessAt);
  assert.equal(sent.length, 0);
});

test('dry-run 预览推送内容但不写状态、不推送', async () => {
  const config = makeConfig();
  const state = createEmptyState();
  const siteState = ensureSiteState(state, 'swpu-exams');
  siteState.baselineDone = true;
  siteState.seen = [];
  let saves = 0;
  const { sent } = recorder();

  const result = await pollSite({
    site: config.sites[0],
    config,
    state,
    logger,
    dryRun: true,
    cookie: 'SID=abc',
    fetchDocumentImpl: async () => okDoc([exam('a', '高数')]),
    sendMessage: async (message) => sent.push(message),
    saveState: async () => { saves += 1; },
    now: fixedNow,
  });

  assert.equal(result.dryRun, true);
  assert.equal(saves, 0);
  assert.equal(sent.length, 0);
  assert.deepEqual(siteState.seen, []);
});

test('站点自己的轮询间隔没到点时跳过，不重复请求', async () => {
  const config = makeConfig({ pollIntervalSec: 1800 });
  const state = createEmptyState();
  const siteState = ensureSiteState(state, 'swpu-exams');
  siteState.baselineDone = true;
  siteState.seen = ['a'];
  siteState.lastPollAt = NOW.toISOString();

  let fetched = 0;
  const result = await pollSite({
    site: config.sites[0],
    config,
    state,
    logger,
    cookie: 'SID=abc',
    fetchDocumentImpl: async () => {
      fetched += 1;
      return okDoc([exam('b', '英语')]);
    },
    sendMessage: async () => {},
    saveState: async () => {},
    now: fixedNow,
  });

  assert.equal(result.skipped, 'interval');
  assert.equal(fetched, 0);
});

test('推送文案包含站点名、序号、时间、字段与链接', () => {
  const config = makeConfig({
    select: {
      items: 'datas',
      id: 'taskId',
      title: 'courseName',
      time: 'examTimeDescription',
      link: 'link',
      fields: [{ path: 'examPlace', label: '考场' }],
    },
    message: { header: '【{site}】新增 {count} 场考试' },
  });
  const site = config.sites[0];
  const messages = formatSiteMessages(site, [
    {
      id: 'a',
      title: '技术经济',
      time: '2026年11月06日 19:00-20:40(星期五第5场)',
      link: 'https://example.cn/1',
      fields: [{ label: '考场', value: '思学楼C202' }],
    },
  ]);

  assert.equal(messages.length, 1);
  assert.equal(
    messages[0].content,
    [
      '【考试安排】新增 1 场考试',
      '',
      '1. 技术经济',
      '2026年11月06日 19:00-20:40(星期五第5场)',
      '考场：思学楼C202',
      'https://example.cn/1',
    ].join('\n'),
  );
});

test('条目很多时按 maxItemsPerMessage 分条推送', () => {
  const config = makeConfig({ maxItemsPerMessage: 2 });
  const site = config.sites[0];
  const items = Array.from({ length: 5 }, (_, index) => ({
    id: String(index),
    title: `课程${index}`,
    time: '',
    link: null,
    fields: [],
  }));
  const messages = formatSiteMessages(site, items, { maxItemsPerMessage: site.maxItemsPerMessage });
  assert.equal(messages.length, 3);
  assert.equal(messages[0].itemIds.length, 2);
  assert.match(messages[0].content, /（1\/3）/);
});

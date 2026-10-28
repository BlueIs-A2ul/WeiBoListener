import test from 'node:test';
import assert from 'node:assert/strict';

import { checkSuccess, extractItems, ExtractError, parseJsonBody } from '../src/extract.js';
import { normalizeConfig } from '../src/config.js';

// 取自本机实测的交大教务考试接口响应（去掉敏感字段，保留真实结构）
const EXAM_RESPONSE = {
  msg: null,
  code: '0',
  datas: [
    {
      courseName: '马克思主义基本原理',
      examType: '课程结业考试',
      examPlace: '成都校区/思学楼B208',
      examSeatNo: '27',
      examTimeDescription: '2026年11月05日 19:00-20:40(星期四第5场)',
      taskId: '34703e30-4dd6-47d1-95ef-ca7fb265e67e',
    },
    {
      courseName: '技术经济',
      examType: '课程结业考试',
      examPlace: '成都校区/思学楼C202',
      examSeatNo: '7',
      examTimeDescription: '2026年11月06日 19:00-20:40(星期五第5场)',
      taskId: '99f51d0c-7db3-4b42-b8cb-43f68ced1707',
    },
  ],
};

function makeSite(overrides = {}) {
  const config = normalizeConfig({
    posts: [],
    sites: [
      {
        id: 'swpu-exams',
        name: '考试安排',
        mode: 'json',
        request: { url: 'https://deanservices.swpu.edu.cn/jwapp/sys/homeapp/api/home/student/exams.do?termCode=2026-2027-1' },
        success: { path: 'code', equals: '0', messagePath: 'msg' },
        select: {
          items: 'datas',
          id: 'taskId',
          title: 'courseName',
          time: 'examTimeDescription',
          fields: [
            { path: 'examPlace', label: '考场' },
            { path: 'examSeatNo', label: '座位' },
          ],
        },
        ...overrides,
      },
    ],
  });
  return config.sites[0];
}

test('解析 JSON 接口的条目，保留 UUID 作为 ID', () => {
  const site = makeSite();
  const items = extractItems({ site, body: JSON.stringify(EXAM_RESPONSE) });

  assert.equal(items.length, 2);
  assert.equal(items[0].id, '34703e30-4dd6-47d1-95ef-ca7fb265e67e');
  assert.equal(items[0].title, '马克思主义基本原理');
  assert.equal(items[0].time, '2026年11月05日 19:00-20:40(星期四第5场)');
  assert.deepEqual(items[0].fields, [
    { label: '考场', value: '成都校区/思学楼B208' },
    { label: '座位', value: '27' },
  ]);
});

test('空列表是合法结果，不当作解析失败', () => {
  const site = makeSite();
  const items = extractItems({ site, body: JSON.stringify({ code: '0', datas: [] }) });
  assert.deepEqual(items, []);
});

test('成功标志不匹配时报错并带上接口返回的 msg', () => {
  const site = makeSite();
  assert.throws(
    () => extractItems({ site, body: JSON.stringify({ code: '1', msg: '登录已过期', datas: [] }) }),
    (err) => err instanceof ExtractError && err.code === 'SITE_ERROR' && /登录已过期/.test(err.message),
  );
});

test('返回 HTML 时提示 Cookie 可能失效', () => {
  const site = makeSite();
  assert.throws(
    () => extractItems({ site, body: '<!DOCTYPE html><title>统一身份认证</title>' }),
    (err) => err.code === 'EXTRACT_HTML' && /Cookie/.test(err.message),
  );
});

test('条目路径不对时报错并列出实际顶层字段', () => {
  const site = makeSite();
  assert.throws(
    () => extractItems({ site, body: JSON.stringify({ code: '0', data: { list: [] } }) }),
    (err) => err.code === 'EXTRACT_SHAPE' && /code/.test(err.message) && /data/.test(err.message),
  );
});

test('缺少成功标志字段时报 EXTRACT_SHAPE', () => {
  const site = makeSite();
  assert.throws(
    () => extractItems({ site, body: JSON.stringify({ datas: [] }) }),
    (err) => err.code === 'EXTRACT_SHAPE',
  );
});

test('按 ID 去重且保持接口返回顺序', () => {
  const site = makeSite();
  const body = JSON.stringify({
    code: '0',
    datas: [EXAM_RESPONSE.datas[1], EXAM_RESPONSE.datas[0], EXAM_RESPONSE.datas[1]],
  });
  const items = extractItems({ site, body });
  assert.deepEqual(
    items.map((item) => item.title),
    ['技术经济', '马克思主义基本原理'],
  );
});

test('没有 ID 字段时用链接/标题/时间生成稳定哈希', () => {
  const config = normalizeConfig({
    posts: [],
    sites: [
      {
        id: 'notice',
        name: '公告',
        request: { url: 'https://www.example.edu.cn/notice' },
        select: { items: 'list', id: 'nonexistent', title: 'title', link: 'url' },
      },
    ],
  });
  const site = config.sites[0];
  const body = JSON.stringify({ list: [{ title: '停课通知', url: '/notice/1' }] });

  const first = extractItems({ site, body, baseUrl: 'https://www.example.edu.cn' });
  const second = extractItems({ site, body, baseUrl: 'https://www.example.edu.cn' });

  assert.equal(first[0].id, second[0].id);
  assert.ok(first[0].id.length >= 8);
  assert.equal(first[0].link, 'https://www.example.edu.cn/notice/1');
});

test('相对链接按站点 origin 补全，绝对链接保持原样', () => {
  const config = normalizeConfig({
    posts: [],
    sites: [
      {
        id: 'notice',
        name: '公告',
        request: { url: 'https://www.example.edu.cn/api/notice' },
        select: { items: 'list', id: 'id', title: 'title', link: 'url' },
      },
    ],
  });
  const site = config.sites[0];
  const items = extractItems({
    site,
    body: JSON.stringify({
      list: [
        { id: '1', title: '相对', url: 'detail/2' },
        { id: '2', title: '绝对', url: 'https://other.example.com/a' },
      ],
    }),
    baseUrl: 'https://www.example.edu.cn',
  });
  assert.equal(items[0].link, 'https://www.example.edu.cn/detail/2');
  assert.equal(items[1].link, 'https://other.example.com/a');
});

test('正文里的 HTML 会被清洗成纯文本', () => {
  const config = normalizeConfig({
    posts: [],
    sites: [
      {
        id: 'notice',
        name: '公告',
        request: { url: 'https://www.example.edu.cn/api' },
        select: { items: 'list', id: 'id', title: 'title', text: 'content' },
      },
    ],
  });
  const site = config.sites[0];
  const items = extractItems({
    site,
    body: JSON.stringify({ list: [{ id: '1', title: '标题', content: '<p>第一行</p><p>第二行&nbsp;结束</p>' }] }),
  });
  assert.equal(items[0].text, '第一行\n第二行 结束');
});

test('maxItems 限制单次解析条数', () => {
  const config = normalizeConfig({
    posts: [],
    sites: [
      {
        id: 'notice',
        name: '公告',
        request: { url: 'https://www.example.edu.cn/api' },
        select: { items: 'list', id: 'id', title: 'title' },
        maxItems: 3,
      },
    ],
  });
  const site = config.sites[0];
  const list = Array.from({ length: 10 }, (_, index) => ({ id: String(index), title: `标题${index}` }));
  const items = extractItems({ site, body: JSON.stringify({ list }) });
  assert.equal(items.length, 3);
});

test('checkSuccess 在不配置 success 时只要求是 JSON', () => {
  assert.doesNotThrow(() => checkSuccess({ anything: true }, null));
  assert.throws(() => checkSuccess({ code: 1 }, { path: 'code', equals: '0' }), /code=1/);
});

test('parseJsonBody 对空响应与非 JSON 给出明确错误', () => {
  assert.throws(() => parseJsonBody('   '), (err) => err.code === 'EXTRACT_EMPTY');
  assert.throws(() => parseJsonBody('{"a":'), (err) => err.code === 'EXTRACT_JSON');
});

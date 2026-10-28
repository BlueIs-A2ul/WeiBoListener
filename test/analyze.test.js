import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeJson,
  clip,
  collectArrayCandidates,
  detectKind,
  inferFields,
  inferSiteId,
  inferSuccess,
  looksLikeLogin,
  suggestSite,
} from '../src/analyze.js';

// 交大教务考试接口的真实结构（字段名保留，值替换为假数据）
const EXAM_JSON = {
  msg: null,
  code: '0',
  datas: [
    {
      courseName: '高等数学',
      examType: '课程结业考试',
      examStatus: 0,
      courseNo: 'MATH101',
      examPlace: '思学楼B208',
      examSeatNo: '27',
      examTimeDescription: '2026年11月05日 19:00-20:40(星期四第5场)',
      examDate: '2026-11-05 00:00:00',
      week: 10,
      taskId: '11111111-1111-1111-1111-111111111111',
    },
  ],
};

test('collectArrayCandidates 找到条目数组并给出分数与样例', () => {
  const candidates = collectArrayCandidates(EXAM_JSON);
  assert.equal(candidates.length, 1);
  const [first] = candidates;
  assert.equal(first.path, 'datas');
  assert.equal(first.count, 1);
  assert.equal(first.kind, 'object');
  assert.ok(first.score >= 60);
  assert.ok(first.keys.includes('taskId'));
  assert.equal(first.sample.length, 1);
  assert.equal(first.sample[0].courseName, '高等数学');
});

test('样例里保留排在后面的 ID 字段（回归：taskId 曾被截断）', () => {
  const candidates = collectArrayCandidates(EXAM_JSON);
  assert.ok(candidates[0].sample[0].taskId);
});

test('嵌套数组也会被找到，根数组用 $ 表示', () => {
  const nested = { data: { list: [{ id: 1, title: 'a' }] } };
  assert.equal(collectArrayCandidates(nested)[0].path, 'data.list');

  const root = [{ id: 1, title: 'a' }, { id: 2, title: 'b' }];
  assert.equal(collectArrayCandidates(root)[0].path, '$');
});

test('inferFields 从完整字段名里挑出 ID/标题/时间', () => {
  const fields = inferFields(Object.keys(EXAM_JSON.datas[0]));
  assert.equal(fields.id, 'taskId');
  assert.equal(fields.title, 'courseName');
  assert.equal(fields.time, 'examTimeDescription');
});

test('inferFields 也接受样例对象', () => {
  const fields = inferFields({ id: '1', name: '标题' });
  assert.equal(fields.id, 'id');
  assert.equal(fields.title, 'name');
});

test('inferSuccess 识别 code="0" 与 ok=1', () => {
  assert.deepEqual(inferSuccess({ code: '0', msg: 'x' }), { path: 'code', equals: '0', messagePath: 'msg' });
  assert.deepEqual(inferSuccess({ ok: 1 }), { path: 'ok', equals: '1', messagePath: null });
  assert.deepEqual(inferSuccess({ code: '1' }), null);
  assert.equal(inferSuccess(null), null);
});

test('inferSiteId 生成合法且可读的站点 ID', () => {
  assert.equal(
    inferSiteId('https://deanservices.swpu.edu.cn/jwapp/sys/homeapp/api/home/student/exams.do?termCode=1'),
    'deanservices-exams',
  );
  assert.equal(inferSiteId('https://www.example.edu.cn/notice/index.html'), 'example-index');
  assert.equal(inferSiteId('不是URL'), 'site');
});

test('suggestSite 把分析结果组装成可保存的草稿', () => {
  const analysis = analyzeJson(EXAM_JSON, { url: 'https://deanservices.swpu.edu.cn/api/exams.do?term=1' });
  const site = analysis.suggestedSite;

  assert.equal(site.id, 'deanservices-exams');
  assert.equal(site.mode, 'json');
  assert.equal(site.request.cookieEnv, 'SITE_DEANSERVICES_EXAMS_COOKIE');
  assert.equal(site.request.headers['Accept-Language'], 'zh-CN,zh;q=0.9');
  assert.deepEqual(site.success, { path: 'code', equals: '0', messagePath: 'msg' });
  assert.equal(site.select.items, 'datas');
  assert.equal(site.select.id, 'taskId');
  assert.equal(site.select.title, 'courseName');
  assert.deepEqual(site.select.fields, []);
});

test('suggestSite 在没有找到数组时返回 null', () => {
  const analysis = analyzeJson({ code: '0', total: 3 });
  assert.equal(analysis.suggestedSite, null);
  assert.deepEqual(analysis.topLevelKeys, ['code', 'total']);
});

test('detectKind 区分 JSON / HTML / 空响应', () => {
  assert.equal(detectKind({ contentType: 'application/json;charset=UTF-8', text: '{}' }), 'json');
  assert.equal(detectKind({ contentType: 'text/html', text: '<!doctype html>' }), 'html');
  assert.equal(detectKind({ contentType: '', text: '{"a":1}' }), 'json');
  assert.equal(detectKind({ contentType: '', text: '   ' }), 'empty');
  assert.equal(detectKind({ contentType: 'text/plain', text: 'hello' }), 'text');
});

test('looksLikeLogin 识别统一身份认证页', () => {
  assert.equal(looksLikeLogin('<title>统一身份认证</title><form>请输入密码</form>'), true);
  assert.equal(looksLikeLogin('<title>通知公告</title>'), false);
  assert.equal(looksLikeLogin(''), false);
});

test('clip 截断过长文本', () => {
  assert.equal(clip('abc', 10), 'abc');
  assert.equal(clip('a'.repeat(20), 5), 'aaaaa…');
  assert.equal(clip(null), '');
});

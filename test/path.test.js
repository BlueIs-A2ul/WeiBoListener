import test from 'node:test';
import assert from 'node:assert/strict';

import { getPath, parsePath, pickFirst, toText, topLevelKeys } from '../src/path.js';

test('parsePath 支持点号、下标与引号写法', () => {
  assert.deepEqual(parsePath('datas'), ['datas']);
  assert.deepEqual(parsePath('data.list'), ['data', 'list']);
  assert.deepEqual(parsePath('data.list[0].title'), ['data', 'list', 0, 'title']);
  assert.deepEqual(parsePath('data["list"][1].title'), ['data', 'list', 1, 'title']);
  assert.deepEqual(parsePath("data['list'].title"), ['data', 'list', 'title']);
  assert.deepEqual(parsePath(''), []);
});

test('getPath 按路径取值，缺失时返回 undefined 而不抛错', () => {
  const payload = { code: '0', datas: [{ taskId: 'a', courseName: '高数' }] };
  assert.equal(getPath(payload, 'code'), '0');
  assert.equal(getPath(payload, 'datas[0].taskId'), 'a');
  assert.equal(getPath(payload, 'datas[0].courseName'), '高数');
  assert.equal(getPath(payload, 'datas[1].taskId'), undefined);
  assert.equal(getPath(payload, 'missing.deep.path'), undefined);
  assert.equal(getPath(null, 'a.b'), undefined);
});

test('getPath 遇到标量继续取值时安全返回 undefined', () => {
  assert.equal(getPath({ a: 'text' }, 'a.b'), undefined);
  assert.equal(getPath({ a: [1, 2] }, 'a[5]'), undefined);
});

test('pickFirst 返回第一个有值的路径', () => {
  const item = { title: '', name: '备用标题', subject: '第三' };
  assert.equal(pickFirst(item, ['title', 'name', 'subject']), '备用标题');
  assert.equal(pickFirst(item, ['missing']), undefined);
});

test('toText 把非字符串值转成可读文本', () => {
  assert.equal(toText('  中文  '), '中文');
  assert.equal(toText(27), '27');
  assert.equal(toText(null), '');
  assert.equal(toText(undefined), '');
  assert.equal(toText({ a: 1 }), '{"a":1}');
});

test('topLevelKeys 用来在解析失败时给出排查线索', () => {
  assert.deepEqual(topLevelKeys({ code: 0, datas: [] }), ['code', 'datas']);
  assert.deepEqual(topLevelKeys(null), []);
  assert.deepEqual(topLevelKeys({ a: 1, b: 2, c: 3, d: 4, e: 5 }, 2), ['a', 'b', 'c', 'd', 'e'].slice(0, 2));
});

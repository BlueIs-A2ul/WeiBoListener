import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareIds,
  findNewComments,
  isAtOrOlderThanBaseline,
  isDeepScanDue,
  minId,
  partitionExcluded,
  uniqueById,
} from '../src/diff.js';

function comment(id, text = 'hi') {
  return { id: String(id), text, user: { name: `用户${id}` } };
}

test('compareIds 按数字大小比较，不受字符串长度影响', () => {
  assert.equal(compareIds('9', '10'), -1);
  assert.equal(compareIds('10', '9'), 1);
  assert.equal(compareIds('10', '10'), 0);
});

test('findNewComments 只返回未见过的评论，并按 ID 升序排列', () => {
  const seen = new Set(['2', '4']);
  const result = findNewComments([comment(4), comment(3), comment(2), comment(1)], seen);
  assert.deepEqual(result.map((item) => item.id), ['1', '3']);
});

test('延迟出现的旧评论只要没见过也会被识别', () => {
  const seen = new Set(['5', '6']);
  const result = findNewComments([comment(6), comment(4), comment(3)], seen);
  assert.deepEqual(result.map((item) => item.id), ['3', '4']);
});

test('uniqueById 去重且保留第一条', () => {
  const first = { ...comment(1), text: 'first' };
  const second = { ...comment(1), text: 'second' };
  const result = uniqueById([first, second, comment(2)]);
  assert.equal(result.length, 2);
  assert.equal(result[0].text, 'first');
});

test('minId 返回最小评论 ID', () => {
  assert.equal(minId([comment(9), comment(3), comment(12)]), '3');
  assert.equal(minId([]), null);
});

test('isAtOrOlderThanBaseline 判断是否到达基线边界', () => {
  assert.equal(isAtOrOlderThanBaseline('10', '10'), true);
  assert.equal(isAtOrOlderThanBaseline('9', '10'), true);
  assert.equal(isAtOrOlderThanBaseline('11', '10'), false);
  assert.equal(isAtOrOlderThanBaseline('11', null), false);
});

test('isDeepScanDue 根据间隔判断', () => {
  const now = new Date('2026-10-26T12:00:00.000Z');
  assert.equal(isDeepScanDue({ lastDeepScanAt: null }, now, 6), true);
  assert.equal(isDeepScanDue({ lastDeepScanAt: '2026-10-26T07:00:00.000Z' }, now, 6), false);
  assert.equal(isDeepScanDue({ lastDeepScanAt: '2026-10-26T05:00:00.000Z' }, now, 6), true);
  assert.equal(isDeepScanDue({ lastDeepScanAt: null }, now, 0), false);
});

test('partitionExcluded 按关键词忽略评论，大小写不敏感', () => {
  const result = partitionExcluded(
    [comment(1, '正常评论'), comment(2, '这是 SPAM 广告'), comment(3, 'spam again')],
    ['spam'],
  );
  assert.deepEqual(result.included.map((item) => item.id), ['1']);
  assert.deepEqual(result.excluded.map((item) => item.id), ['2', '3']);
});

test('partitionExcluded 没有关键词时全部保留', () => {
  const comments = [comment(1), comment(2)];
  const result = partitionExcluded(comments, []);
  assert.equal(result.included.length, 2);
  assert.equal(result.excluded.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createEmptyState,
  ensurePostState,
  loadState,
  markSeen,
  saveState,
} from '../src/state.js';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'weibo-state-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('state 可以保存并重新加载', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'state.json');
  const state = createEmptyState();
  const postState = ensurePostState(state, '123');
  postState.baselineDone = true;
  markSeen(postState, ['1', '2', '3']);

  await saveState(file, state);
  const loaded = await loadState(file);

  assert.equal(loaded.recoveredFrom, null);
  assert.equal(loaded.state.posts['123'].baselineDone, true);
  assert.deepEqual(loaded.state.posts['123'].seen, ['1', '2', '3']);
});

test('主状态文件损坏时从 .bak 恢复', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'state.json');
  const state = createEmptyState();
  ensurePostState(state, '123').baselineDone = true;

  await saveState(file, state);
  await saveState(file, state);
  await fs.writeFile(file, '{ broken json', 'utf8');

  const loaded = await loadState(file);
  assert.equal(loaded.recoveredFrom, `${file}.bak`);
  assert.equal(loaded.state.posts['123'].baselineDone, true);
});

test('markSeen 去重并限制最大保留数量', () => {
  const postState = { seen: ['1', '2'] };
  markSeen(postState, ['2', '3', '4'], 3);
  assert.deepEqual(postState.seen, ['2', '3', '4']);
});

test('最终状态为空时返回空结构', async (t) => {
  const dir = await tempDir(t);
  const loaded = await loadState(path.join(dir, 'missing.json'));
  assert.deepEqual(loaded.state.posts, {});
  assert.equal(loaded.recoveredFrom, null);
});

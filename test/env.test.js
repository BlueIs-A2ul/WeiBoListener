import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadDotEnv } from '../src/env.js';

async function withEnvFile(text) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'weibo-env-'));
  const file = path.join(dir, '.env');
  await fs.writeFile(file, text, 'utf8');
  return file;
}

test('.env 不存在时返回未加载', async () => {
  const result = await loadDotEnv({ file: path.join(os.tmpdir(), 'weibo-env-missing', '.env'), env: {} });
  assert.equal(result.loaded, false);
  assert.deepEqual(result.conflicts, []);
});

test('.env 里的值会写进环境，并去掉包裹引号', async () => {
  const file = await withEnvFile('WEIBO_COOKIE="SUB=abc; SUBP=xyz"\nWXPUSHER_UIDS=UID_a,UID_b\n');
  const env = {};

  const result = await loadDotEnv({ file, env });

  assert.equal(result.loaded, true);
  assert.equal(env.WEIBO_COOKIE, 'SUB=abc; SUBP=xyz');
  assert.equal(env.WXPUSHER_UIDS, 'UID_a,UID_b');
  assert.deepEqual(result.conflicts, []);
});

test('同名系统环境变量优先，并报告冲突', async () => {
  const file = await withEnvFile('WEIBO_COOKIE=SUB=from_file\n');
  const env = { WEIBO_COOKIE: 'SUB=from_system' };

  const result = await loadDotEnv({ file, env });

  assert.equal(env.WEIBO_COOKIE, 'SUB=from_system');
  assert.deepEqual(
    result.conflicts.map((item) => item.key),
    ['WEIBO_COOKIE'],
  );
  assert.equal(result.conflicts[0].systemValue, 'SUB=from_system');
});

test('系统环境变量与 .env 值一致时不算冲突', async () => {
  const file = await withEnvFile('LOG_LEVEL=debug\n');
  const env = { LOG_LEVEL: 'debug' };

  const result = await loadDotEnv({ file, env });

  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.applied, ['LOG_LEVEL']);
});

test('注释和空行不会写进环境', async () => {
  const file = await withEnvFile('# 注释\n\nLOG_LEVEL=warn\n');
  const env = {};

  await loadDotEnv({ file, env });

  assert.deepEqual(env, { LOG_LEVEL: 'warn' });
});

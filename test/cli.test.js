import test from 'node:test';
import assert from 'node:assert/strict';

import { autostartBlockedReason, buildAppArgv, needsFirstRun, normalizeArgv, parseCliArgs } from '../src/cli.js';

test('不带参数时进入监听模式', () => {
  assert.deepEqual(parseCliArgs([]), {
    mode: 'listener',
    taskName: 'WeiBoListener',
    appArgs: [],
    background: false,
  });
});

test('监听参数原样透传', () => {
  const parsed = parseCliArgs(['--once', '--dry-run']);
  assert.equal(parsed.mode, 'listener');
  assert.deepEqual(parsed.appArgs, ['--once', '--dry-run']);
});

test('--admin 之后的面板参数透传给面板', () => {
  const parsed = parseCliArgs(['--admin', '--port', '9000']);
  assert.equal(parsed.mode, 'admin');
  assert.deepEqual(parsed.appArgs, ['--port', '9000']);
});

test('--install / --uninstall / --status 是启动器自己的命令', () => {
  assert.equal(parseCliArgs(['--install']).mode, 'install');
  assert.equal(parseCliArgs(['--uninstall']).mode, 'uninstall');
  assert.equal(parseCliArgs(['--status']).mode, 'status');
});

test('--task-name 会被消费掉，不传给应用', () => {
  const parsed = parseCliArgs(['--install', '--task-name', 'WeiBoListenerDev']);
  assert.equal(parsed.mode, 'install');
  assert.equal(parsed.taskName, 'WeiBoListenerDev');
  assert.deepEqual(parsed.appArgs, []);
});

test('--help 显示启动器用法', () => {
  assert.equal(parseCliArgs(['--help']).mode, 'help');
  assert.equal(parseCliArgs(['-h']).mode, 'help');
});

test('没有 .env 时需要首次配置', () => {
  assert.equal(needsFirstRun({ envExists: false, cookie: '', hasConfig: true }), true);
});

test('有 .env 但没填 Cookie 也需要首次配置', () => {
  assert.equal(needsFirstRun({ envExists: true, cookie: '', hasConfig: true }), true);
});

test('配置齐全时直接进入监听', () => {
  assert.equal(needsFirstRun({ envExists: true, cookie: 'SUB=abc', hasConfig: true }), false);
});

test('缺少 config.json 时进入首次配置（面板里加微博）', () => {
  assert.equal(needsFirstRun({ envExists: true, cookie: 'SUB=abc', hasConfig: false }), true);
});

test('--background 不会传给监听进程', () => {
  const parsed = parseCliArgs(['--background']);
  assert.equal(parsed.background, true);
  assert.deepEqual(parsed.appArgs, []);
});

test('配置不全时拒绝安装开机自启', () => {
  assert.match(
    autostartBlockedReason({ envExists: true, cookie: '', hasConfig: true }),
    /Cookie/,
  );
  assert.match(
    autostartBlockedReason({ envExists: true, cookie: 'SUB=x', hasConfig: false }),
    /config\.json/,
  );
  assert.equal(autostartBlockedReason({ envExists: true, cookie: 'SUB=x', hasConfig: true }), null);
});

test('SEA 里 argv 会带两遍 exe 路径，先剥掉才不会当成参数', () => {
  const exe = 'D:\\Apps\\WeiBoListener.exe';
  assert.deepEqual(normalizeArgv([exe, exe, '--no-open'], { execPath: exe }), ['--no-open']);
});

test('开发模式会带 node 和 cli.js 路径，同样剥掉', () => {
  assert.deepEqual(
    normalizeArgv(['C:\\Program Files\\node.exe', 'D:\\app\\src\\cli.js', '--once'], {
      execPath: 'C:\\Program Files\\node.exe',
    }),
    ['--once'],
  );
});

test('纯参数不会被动到', () => {
  assert.deepEqual(normalizeArgv(['--install', '--task-name', 'X'], { execPath: 'D:\\x.exe' }), [
    '--install',
    '--task-name',
    'X',
  ]);
});

test('给应用的 argv 补上前两个元素，参数解析才不会错位', () => {
  const argv = buildAppArgv({
    exePath: 'D:\\Apps\\WeiBoListener.exe',
    appEntry: 'D:\\Apps\\app\\index.js',
    appArgs: ['--once'],
  });

  assert.deepEqual(argv, ['D:\\Apps\\WeiBoListener.exe', 'D:\\Apps\\app\\index.js', '--once']);
});

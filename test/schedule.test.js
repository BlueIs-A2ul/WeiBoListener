import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildTaskXml,
  installTask,
  queryTask,
  renderHiddenLauncher,
  uninstallTask,
  writeHiddenLauncher,
} from '../src/schedule.js';

const EXE = 'D:\\Apps\\WeiBoListener\\WeiBoListener.exe';
const VBS = 'D:\\Apps\\WeiBoListener\\run-hidden.vbs';

function fakeRun(result = { code: 0, stdout: '', stderr: '' }) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push({ cmd, args });
    return typeof result === 'function' ? result(cmd, args) : result;
  };
  return { run, calls };
}

test('任务 XML 含登录触发、失败重试与单实例设置', () => {
  const xml = buildTaskXml({ taskName: 'WeiBoListener', exePath: EXE, vbsPath: VBS, workingDir: 'D:\\Apps\\WeiBoListener' });

  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<RestartOnFailure>/);
  assert.match(xml, /<Interval>PT1M<\/Interval>/);
  assert.match(xml, /<Count>999<\/Count>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<Command>wscript\.exe<\/Command>/);
  assert.match(xml, /<Arguments>"D:\\Apps\\WeiBoListener\\run-hidden\.vbs"<\/Arguments>/);
  assert.match(xml, /<URI>\\WeiBoListener<\/URI>/);
  assert.match(xml, /encoding="UTF-16"/);
});

test('任务 XML 的 Settings 元素顺序符合 schema（顺序错 schtasks 会拒收）', () => {
  const xml = buildTaskXml({ taskName: 'WeiBoListener', exePath: EXE, vbsPath: VBS, workingDir: 'D:\\Apps\\WeiBoListener' });
  const settings = xml.slice(xml.indexOf('<Settings>'), xml.indexOf('</Settings>'));

  const order = [
    'RestartOnFailure',
    'MultipleInstancesPolicy',
    'DisallowStartIfOnBatteries',
    'StopIfGoingOnBatteries',
    'AllowHardTerminate',
    'StartWhenAvailable',
    'Enabled',
    'ExecutionTimeLimit',
  ];
  const positions = order.map((tag) => settings.indexOf(`<${tag}>`));
  assert.ok(positions.every((pos) => pos >= 0), '每个元素都要出现');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, '元素顺序必须递增');
  assert.doesNotMatch(settings, /StopOnIdleEnd/);
});

test('任务 XML 会转义路径里的特殊字符', () => {
  const xml = buildTaskXml({
    taskName: 'Wei&Bo',
    exePath: 'C:\\A & B\\x.exe',
    vbsPath: 'C:\\A & B\\<run>.vbs',
    workingDir: 'C:\\A & B',
  });

  assert.match(xml, /C:\\A &amp; B/);
  assert.match(xml, /&lt;run&gt;\.vbs/);
  assert.doesNotMatch(xml, /<run>/);
});

test('隐藏启动器等待进程结束，任务状态才能保持运行中', () => {
  const vbs = renderHiddenLauncher({ exePath: EXE, workingDir: 'D:\\Apps\\WeiBoListener' });

  assert.match(vbs, /shell\.Run/);
  assert.match(vbs, /, 0, True/);
  assert.match(vbs, /WeiBoListener\.exe/);
  // 开机自启时用后台模式：配置不全时不会弹出浏览器面板
  assert.match(vbs, /--background/);
});

test('隐藏启动器写成 UTF-16LE + BOM + CRLF，否则 WSH 会解析失败', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'weibo-vbs-'));
  const file = path.join(dir, 'run-hidden.vbs');

  await writeHiddenLauncher({ file, exePath: EXE, workingDir: dir });

  const bytes = await fs.readFile(file);
  assert.deepEqual([...bytes.slice(0, 2)], [0xff, 0xfe], '需要 UTF-16 LE BOM');
  const text = bytes.toString('utf16le');
  assert.match(text, /\r\n/);
  assert.doesNotMatch(text.replace(/\r\n/g, ''), /\n/, '不能有裸 LF');
});

test('安装任务时调用 schtasks 并写入 UTF-16 的 XML 文件', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'weibo-task-'));
  const xmlFile = path.join(dir, 'task.xml');
  const { run, calls } = fakeRun();

  const result = await installTask({
    taskName: 'WeiBoListenerDev',
    exePath: EXE,
    vbsPath: VBS,
    workingDir: dir,
    xmlFile,
    run,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].args.slice(0, 4), ['/Create', '/TN', 'WeiBoListenerDev', '/XML']);
  assert.equal(calls[0].cmd, 'schtasks');
  assert.ok(calls[0].args.includes('/F'));

  const bytes = await fs.readFile(xmlFile);
  assert.deepEqual([...bytes.slice(0, 2)], [0xff, 0xfe], 'XML 需要 UTF-16 LE BOM');
  const text = bytes.toString('utf16le');
  assert.match(text, /cscript|wscript/);
});

test('安装失败时返回错误信息而不是抛异常', async () => {
  const { run } = fakeRun({ code: 1, stdout: '', stderr: '拒绝访问。' });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'weibo-task-'));

  const result = await installTask({
    taskName: 'WeiBoListenerDev',
    exePath: EXE,
    vbsPath: VBS,
    workingDir: dir,
    xmlFile: path.join(dir, 'task.xml'),
    run,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /拒绝访问/);
});

test('卸载任务调用 schtasks /Delete', async () => {
  const { run, calls } = fakeRun();

  const result = await uninstallTask({ taskName: 'WeiBoListenerDev', run });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].args, ['/Delete', '/TN', 'WeiBoListenerDev', '/F']);
});

test('查询任务状态解析 schtasks 的 CSV 输出', async () => {
  const csv = { code: 0, stdout: '"\\WeiBoListener","Ready","N/A","Ready"\r\n', stderr: '' };
  const { run } = fakeRun(csv);

  const result = await queryTask({ taskName: 'WeiBoListener', run });

  assert.equal(result.installed, true);
  assert.equal(result.status, 'Ready');
});

test('任务不存在时查询返回未安装', async () => {
  const { run } = fakeRun({ code: 1, stdout: '', stderr: '错误: 系统找不到指定的文件。' });

  const result = await queryTask({ taskName: 'NoSuchTask', run });

  assert.equal(result.installed, false);
});

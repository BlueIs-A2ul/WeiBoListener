import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { run as defaultRun } from './win.js';

const TASK_VERSION = '1.2';
const WSCRIPT = 'wscript.exe';

export function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function currentUser() {
  const domain = process.env.USERDOMAIN || process.env.COMPUTERNAME || '';
  const name = process.env.USERNAME || '';
  return domain && name ? `${domain}\\${name}` : name;
}

/**
 * 生成任务计划 XML。
 *
 * 用 XML 而不是 schtasks 的简化参数，是因为要设置「失败后每分钟重试」、
 * 「不允许多实例」、「不限运行时长」这几项，简化参数表达不了。
 */
export function buildTaskXml({ taskName, exePath, vbsPath, workingDir, user = currentUser() }) {
  const safeTask = xmlEscape(taskName);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="${TASK_VERSION}" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>微博待审评论监听：登录 Windows 后隐藏启动，进程退出后自动重启。</Description>
    <URI>\\${safeTask}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${WSCRIPT}</Command>
      <Arguments>"${xmlEscape(vbsPath)}"</Arguments>
      <WorkingDirectory>${xmlEscape(workingDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** 隐藏启动器：0 = 不显示窗口，True = 等待进程结束（任务状态才会一直是「正在运行」）。 */
export function renderHiddenLauncher({ exePath, workingDir }) {
  return `Option Explicit
' 由 WeiBoListener.exe --install 自动生成。
' 作用：隐藏窗口启动监听，并让任务计划的「失败重试 / 单实例」规则生效。
' 删除它等同于取消开机自启（更推荐用 --uninstall）。
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "${workingDir}"
shell.Run """${exePath}"" --background", 0, True
`;
}

export async function installTask({ taskName, exePath, vbsPath, workingDir, xmlFile, run = defaultRun }) {
  const target = xmlFile || path.join(os.tmpdir(), `weibo-task-${process.pid}-${Date.now()}.xml`);
  const ephemeral = !xmlFile;
  const xml = buildTaskXml({ taskName, exePath, vbsPath, workingDir });

  try {
    await fs.writeFile(target, Buffer.from(`\ufeff${xml}`, 'utf16le'));

    const result = await run('schtasks', ['/Create', '/TN', taskName, '/XML', target, '/F']);
    if (result.code !== 0) {
      const detail = result.stderr || result.stdout || '未知错误';
      return { ok: false, message: `创建计划任务失败：${detail}`, detail };
    }
    return { ok: true, taskName, message: `已安装开机自启（任务名 ${taskName}）` };
  } finally {
    if (ephemeral) await fs.rm(target, { force: true }).catch(() => {});
  }
}

export async function uninstallTask({ taskName, run = defaultRun }) {
  const result = await run('schtasks', ['/Delete', '/TN', taskName, '/F']);
  if (result.code === 0) {
    return { ok: true, taskName, removed: true, message: `已取消开机自启（任务名 ${taskName}）` };
  }

  const detail = result.stderr || result.stdout || '';
  // 任务本来就不存在，对调用方来说等于「已经是目标状态」。
  if (/找不到|不存在|cannot find|does not exist|ERROR: The system cannot find/i.test(detail)) {
    return { ok: true, taskName, removed: false, message: '开机自启本来就没安装' };
  }
  return { ok: false, taskName, message: `取消开机自启失败：${detail || '未知错误'}`, detail };
}

export async function queryTask({ taskName, run = defaultRun }) {
  const result = await run('schtasks', ['/Query', '/TN', taskName, '/FO', 'CSV', '/NH']);
  if (result.code !== 0) return { installed: false, status: null, supported: true };

  const line = String(result.stdout).split(/\r?\n/).find((item) => item.trim() !== '');
  if (!line) return { installed: true, status: null, supported: true };
  const fields = line.split('","').map((item) => item.replace(/^"|"$/g, ''));
  return { installed: true, status: fields[fields.length - 1] || null, supported: true };
}

/**
 * 生成/覆盖隐藏启动器。
 *
 * 必须写成 UTF-16LE + BOM + CRLF：WSH 默认按 ANSI 读 .vbs，
 * 只有 LF 换行的 UTF-8 文件会被解析错（实测报「变量未定义: 'shell'」）。
 */
export async function writeHiddenLauncher({ file, exePath, workingDir }) {
  const text = renderHiddenLauncher({ exePath, workingDir }).replace(/\r?\n/g, '\r\n');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.from(`\ufeff${text}`, 'utf16le'));
  return file;
}

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseDotEnv } from './env.js';
import { isProcessAlive } from './lock.js';
import { installTask, queryTask, uninstallTask, writeHiddenLauncher } from './schedule.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_TASK_NAME = 'WeiBoListener';
export const VBS_NAME = 'run-hidden.vbs';
export const PKG_APP_DIR = 'app';

/**
 * 启动器自己的参数： --admin / --install / --uninstall / --status / --help / --task-name
 * 其余参数原样交给监听进程（--once、--dry-run、--test-push、--config、--port…）。
 */
/**
 * 剥掉启动器自己的路径参数。
 *
 * SEA 里 process.argv 是 [exe, exe, ...用户参数]（exe 路径出现两次），
 * 直接按 slice(1) 取会把 exe 路径当成业务参数传下去；开发模式下则是 [node, cli.js, ...]。
 */
export function normalizeArgv(argv = [], { execPath = process.execPath } = {}) {
  const args = [...argv];
  while (args.length > 0) {
    const head = String(args[0]);
    if (head === execPath || /(^|[\\/])(cli|launcher)\.(js|cjs)$/i.test(head) || /(^|[\\/])WeiBoListener\.exe$/i.test(head)) {
      args.shift();
      continue;
    }
    break;
  }
  return args;
}

export function parseCliArgs(argv = []) {
  const args = [...argv];
  const appArgs = [];
  let mode = 'listener';
  let taskName = DEFAULT_TASK_NAME;
  let background = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--admin') {
      mode = 'admin';
      continue;
    }
    if (arg === '--install') {
      mode = 'install';
      continue;
    }
    if (arg === '--uninstall') {
      mode = 'uninstall';
      continue;
    }
    if (arg === '--status') {
      mode = 'status';
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      mode = 'help';
      continue;
    }
    if (arg === '--background') {
      // 开机自启时由隐藏启动器传入：配置不全也只写日志，不弹浏览器窗口
      background = true;
      continue;
    }
    if (arg === '--task-name') {
      taskName = args[index + 1] || DEFAULT_TASK_NAME;
      index += 1;
      continue;
    }
    if (arg.startsWith('--task-name=')) {
      taskName = arg.slice('--task-name='.length) || DEFAULT_TASK_NAME;
      continue;
    }

    appArgs.push(arg);
  }

  return { mode, taskName, appArgs, background };
}

/** 没有 Cookie、没有 config.json 时先开面板，而不是直接报错退出。 */
export function needsFirstRun({ envExists, cookie, hasConfig }) {
  if (!envExists) return true;
  if (!cookie) return true;
  return !hasConfig;
}

/** 应用里的参数解析从 argv[2] 开始，所以要把 exe 和入口文件补到前面。 */
export function buildAppArgv({ exePath, appEntry, appArgs = [] }) {
  return [exePath, appEntry, ...appArgs];
}

/** 后台模式没有控制台，把启动期的问题落到 logs/startup.log。 */
function appendStartupLog(root, message) {
  try {
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.appendFileSync(path.join(root, 'logs', 'startup.log'), `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // 写日志失败不影响主流程
  }
}

function readEnvValues(file) {
  try {
    const entries = parseDotEnv(fs.readFileSync(file, 'utf8'));
    const values = {};
    for (const { key, value } of entries) values[key] = value;
    return values;
  } catch {
    return null;
  }
}

/** 打包后的目录结构：<exe 所在目录>/app/index.js；开发时直接用 src/。 */
export function resolveLayout({ execPath = process.execPath, here = HERE } = {}) {
  const exeDir = path.dirname(execPath);
  const packagedEntry = path.join(exeDir, PKG_APP_DIR, 'index.js');
  const packaged = fs.existsSync(packagedEntry);

  return {
    packaged,
    exePath: execPath,
    exeDir,
    root: packaged ? exeDir : path.resolve(here, '..'),
    appDir: packaged ? path.join(exeDir, PKG_APP_DIR) : here,
    listenerEntry: packaged ? packagedEntry : path.join(here, 'index.js'),
    adminEntry: packaged ? path.join(exeDir, PKG_APP_DIR, 'admin.js') : path.join(here, 'admin.js'),
    vbsPath: path.join(exeDir, VBS_NAME),
  };
}

function printHelp(layout) {
  console.log(`微博待审评论监听器

用法：
  WeiBoListener.exe                 启动监听（没配置过会自动打开配置面板）
  WeiBoListener.exe --admin         打开本机配置面板
  WeiBoListener.exe --install       安装开机自启（登录 Windows 后自动运行）
  WeiBoListener.exe --uninstall     取消开机自启
  WeiBoListener.exe --status        查看监听与开机自启状态
  WeiBoListener.exe --once          只轮询一轮后退出
  WeiBoListener.exe --dry-run       只打印将要推送的内容，不写状态、不发送
  WeiBoListener.exe --test-push     只发一条 WxPusher 测试消息
  WeiBoListener.exe --help

附加参数：
  --task-name NAME                  配合 --install/--uninstall/--status 使用（默认 ${DEFAULT_TASK_NAME}）

目录：${layout.root}
${layout.packaged ? '（打包运行：代码在 app/ 子目录，替换 app/ 即可更新）' : '（开发运行：代码在 src/）'}`);
}

function printFirstRun(layout) {
  console.log(`微博监听：还没有完成配置，先打开配置面板。

  1. 浏览器会自动打开本机面板（地址会打印在下面，带一次性令牌）
  2. 「凭据」页：粘贴微博 Cookie、WxPusher AppToken 和 UID
  3. 「微博与轮询」页：添加要监听的微博 ID
  4. 保存后回到命令行执行：WeiBoListener.exe --install

配置目录：${layout.root}`);
}

function printStatus({ layout, taskName }) {
  const lockFile = path.join(layout.root, 'data', '.lock');
  let listener = { running: false, pid: null };
  try {
    const pid = Number(fs.readFileSync(lockFile, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) listener = { running: true, pid };
  } catch {
    // 没有锁文件 = 没在运行
  }

  const envFile = path.join(layout.root, '.env');
  const envValues = readEnvValues(envFile) || {};
  const configFile = path.join(layout.root, 'config.json');

  const lines = [
    `监听进程：${listener.running ? `运行中（PID ${listener.pid}）` : '未运行'}`,
    `配置目录：${layout.root}`,
    `Cookie：${envValues.WEIBO_COOKIE ? '已配置' : '未配置'}`,
    `config.json：${fs.existsSync(configFile) ? '存在' : '缺失'}`,
  ];
  return { lines, listener };
}

async function printTaskStatus({ taskName }) {
  const task = await queryTask({ taskName });
  return `开机自启：${task.installed ? `已安装（任务名 ${taskName}，状态 ${task.status || '未知'}）` : '未安装'}`;
}

async function ensureEnvTemplate(layout) {
  const envFile = path.join(layout.root, '.env');
  if (fs.existsSync(envFile)) return false;
  const example = path.join(layout.root, '.env.example');
  if (!fs.existsSync(example)) return false;
  fs.copyFileSync(example, envFile);
  console.log('已根据 .env.example 生成空的 .env');
  return true;
}

async function startAdmin(layout, appArgs = []) {
  // 面板自己的参数解析同样从 argv[2] 开始，这里补齐前两个元素。
  process.argv.splice(0, process.argv.length, layout.exePath, layout.adminEntry, ...appArgs);
  await import(pathToFileURL(layout.adminEntry).href);
  return 0;
}

/** 配置不全就别装自启，否则每次登录都会因为缺配置而空跑。 */
export function autostartBlockedReason({ envExists, cookie, hasConfig }) {
  if (!envExists || !cookie) {
    return '还没有配置微博 Cookie：先双击 WeiBoListener.exe 打开面板填好，再安装开机自启';
  }
  if (!hasConfig) {
    return '还没有 config.json：在面板「微博与轮询」里添加要监听的微博并保存，再安装开机自启';
  }
  return null;
}

/** 安装开机自启：写隐藏启动器 + 注册计划任务。面板和 --install 共用。 */
export async function installAutostart({
  layout = resolveLayout(),
  taskName = DEFAULT_TASK_NAME,
  log = () => {},
} = {}) {
  if (!layout.packaged) {
    return { ok: false, message: '开发模式下请用 install-task.ps1 安装开机自启' };
  }

  const envValues = readEnvValues(path.join(layout.root, '.env'));
  const blocked = autostartBlockedReason({
    envExists: Boolean(envValues),
    cookie: (envValues && envValues.WEIBO_COOKIE) || '',
    hasConfig: fs.existsSync(path.join(layout.root, 'config.json')),
  });
  if (blocked) return { ok: false, message: blocked };

  ensureEnvTemplate(layout);
  await writeHiddenLauncher({ file: layout.vbsPath, exePath: layout.exePath, workingDir: layout.root });
  log('已生成隐藏启动器 run-hidden.vbs');

  const result = await installTask({
    taskName,
    exePath: layout.exePath,
    vbsPath: layout.vbsPath,
    workingDir: layout.root,
  });
  return result;
}

/** 取消开机自启：删任务 + 删隐藏启动器。 */
export async function removeAutostart({ layout = resolveLayout(), taskName = DEFAULT_TASK_NAME } = {}) {
  const result = await uninstallTask({ taskName });
  if (result.ok) fs.rmSync(layout.vbsPath, { force: true });
  return result;
}

export async function run(argv = process.argv.slice(1)) {
  const parsed = parseCliArgs(normalizeArgv(argv));
  const layout = resolveLayout();

  if (parsed.mode === 'help') {
    printHelp(layout);
    return 0;
  }

  if (parsed.mode === 'status') {
    const status = printStatus({ layout, taskName: parsed.taskName });
    for (const line of status.lines) console.log(line);
    console.log(await printTaskStatus({ taskName: parsed.taskName }));
    return 0;
  }

  if (parsed.mode === 'install' || parsed.mode === 'uninstall') {
    if (!layout.packaged) {
      console.error('开发模式请用 install-task.ps1 / uninstall-task.ps1 管理开机自启。');
      return 1;
    }

    if (parsed.mode === 'uninstall') {
      const result = await removeAutostart({ layout, taskName: parsed.taskName });
      console.log(result.message);
      return result.ok ? 0 : 1;
    }

    const result = await installAutostart({ layout, taskName: parsed.taskName, log: console.log });
    console.log(result.message);
    if (!result.ok && result.detail) console.error(result.detail);
    if (result.ok) console.log('下次登录 Windows 时会自动在后台启动。');
    return result.ok ? 0 : 1;
  }

  if (parsed.mode === 'admin') {
    return startAdmin(layout, parsed.appArgs);
  }

  // 监听模式
  const envFile = path.join(layout.root, '.env');
  const envValues = readEnvValues(envFile);
  const cookie = (envValues && envValues.WEIBO_COOKIE) || process.env.WEIBO_COOKIE || '';
  const hasConfig = fs.existsSync(path.join(layout.root, 'config.json'));
  const quiet = parsed.appArgs.some((arg) => arg === '--once' || arg === '--dry-run' || arg === '--test-push');

  if (!quiet && needsFirstRun({ envExists: Boolean(envValues), cookie, hasConfig })) {
    if (parsed.background) {
      // 开机自启时没有控制台，写一行启动日志方便排查「为什么没跑起来」
      const message = '配置不完整，后台模式未启动监听；请手动双击 WeiBoListener.exe 完成配置。';
      appendStartupLog(layout.root, message);
      console.error(message);
      return 0;
    }
    printFirstRun(layout);
    await ensureEnvTemplate(layout);
    return startAdmin(layout, parsed.appArgs);
  }

  process.argv.splice(0, process.argv.length, ...buildAppArgv({
    exePath: layout.exePath,
    appEntry: layout.listenerEntry,
    appArgs: parsed.appArgs,
  }));

  await import(pathToFileURL(layout.listenerEntry).href);
  return 0;
}

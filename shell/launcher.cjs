#!/usr/bin/env node
// SEA 启动器：exe 里只放这一个文件，业务代码在 exe 同级的 app/ 目录。
// 更新时只需要替换 app/ 里的文件，exe 不用重新打包。
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const base = path.dirname(process.execPath);
const entry = path.join(base, 'app', 'cli.js');

if (!fs.existsSync(entry)) {
  console.error('找不到程序文件：' + entry);
  console.error('请确认 app 文件夹和 WeiBoListener.exe 在同一个目录里（不要只移动 exe）。');
  process.exit(2);
}

import(pathToFileURL(entry).href).then(
  async (mod) => {
    const code = await mod.run(process.argv.slice(1));
    if (typeof code === 'number') process.exitCode = code;
  },
  (err) => {
    console.error('启动失败：' + (err && err.stack ? err.stack : err));
    process.exitCode = 1;
  },
);

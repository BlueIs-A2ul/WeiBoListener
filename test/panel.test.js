import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = await fs.readFile(path.join(HERE, '..', 'src', 'admin.html'), 'utf8');

test('面板包含「站点」页签与容器', () => {
  assert.match(html, /data-tab="sites"/);
  assert.match(html, /data-panel="sites"/);
  assert.match(html, /id="siteCards"/);
  assert.match(html, /id="siteWizard"/);
  assert.match(html, /id="addSite"/);
});

test('面板向导的控件 id 与脚本里的选择器一致', () => {
  for (const id of ['wz-name', 'wz-id', 'wz-url', 'wz-method', 'wz-encoding', 'wz-headers', 'wz-cookie', 'wz-probe', 'wz-preview', 'wz-save']) {
    assert.match(html, new RegExp("'" + id + "'"), `缺少向导控件 ${id}`);
  }
});

test('toast 容器不吃点击（曾挡住右下角按钮）', () => {
  const toasts = html.match(/\.toasts \{([^}]*)\}/);
  assert.ok(toasts, '找不到 .toasts 样式');
  assert.match(toasts[1], /pointer-events:\s*none/);

  const toast = html.match(/\.toast \{([^}]*)\}/);
  assert.ok(toast, '找不到 .toast 样式');
  assert.match(toast[1], /pointer-events:\s*auto/);
});

test('面板脚本可以正常解析（无语法错误）', () => {
  const script = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(script, '找不到内联脚本');
  assert.doesNotThrow(() => new Function(script[1]));
});

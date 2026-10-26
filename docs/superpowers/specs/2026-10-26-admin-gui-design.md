# 微博监听器本地配置面板（Admin GUI）设计

- 日期：2026-10-26
- 状态：已完成设计评审，待实现
- 关联代码：`src/admin.js`（新增）、`src/admin.html`（新增）、`admin.bat`（新增）、`package.json`（新增 script）

## 1. 背景与目标

当前所有配置都靠手改文件：凭据在 `.env`（`WEIBO_COOKIE`、`WXPUSHER_APP_TOKEN`、`WXPUSHER_UIDS`、`LOG_LEVEL`），业务配置在 `config.json`，运行与排错靠命令行和日志文件。具体痛点：

- 微博 Cookie 是一整行数百字符，粘错只会等到进程启动失败才暴露；
- `config.json` 是裸 JSON，无补全，`posts` 的 id 唯一性与数字格式全靠人盯；
- 想验证 WxPusher 推送、想确认 Cookie 是否过期，都得开终端；
- 改完配置后是否生效、当前轮询是否正常，缺少一处集中视图。

目标：提供一个**只监听本机回环地址**的网页控制台，覆盖"改凭据 / 改业务配置 / 验证连通性 / 看运行状态"四件事，且不引入任何第三方依赖、不引入构建步骤。

成功标准：

1. 只用 `node src/admin.js`（或双击 `admin.bat`）即可启动，无需 `npm install` 任何包；
2. 保存前用现有 `normalizeConfig()` 校验，非法输入不落盘；
3. 保存 `.env` 时保留人工注释与键顺序；
4. 页面不把完整 Cookie / Token 送回浏览器；
5. 配置保存后明确告知"需重启监听才生效"，并提供一键重启。

## 2. 非目标

- 不做局域网/公网访问，不做 HTTPS、账号体系、多用户；
- 不引入前端框架、打包器、`node_modules` 依赖；
- 不提供 `data/state.json` 的编辑能力（只读展示）；
- 不做实时日志流（仅按需拉取尾部）；
- 不改变现有 CLI 行为与计划任务部署方式；
- 不做配置热加载（见第 8 节）。

## 3. 架构

单进程、单页、无状态：

```
浏览器 (admin.html)
   │  fetch + x-admin-token
   ▼
src/admin.js  ── 复用 ──▶ src/config.js  (normalizeConfig / getEnvConfig)
   │                      src/notify.js  (sendWxPusher)
   │                      src/poller.js  (pollAll, dryRun)
   │                      src/weibo.js   (fetchApprovalPage / parseCookieExpiry)
   │                      src/state.js   (loadState)
   │                      src/logger.js  (createLogger)
   ▼
.env / config.json / data/state.json / logs/app-*.log
```

`src/admin.js` 只做三件事：HTTP 编解码、鉴权、原子写文件。所有业务校验、抓取、推送、轮询都调用现有模块，不复制逻辑。

## 4. 文件与依赖

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/admin.js` | 新增 | `node:http` 服务、路由、token 校验、`.env`/`config.json` 读写 |
| `src/admin.html` | 新增 | 单页 UI，内联 CSS/JS，启动时由 `admin.js` 读入内存并每次响应返回 |
| `admin.bat` | 新增 | `node "%~dp0src\admin.js"`，与 `start.bat` 对称 |
| `package.json` | 修改 | 增加 `"admin": "node src/admin.js"` |
| `test/admin.test.js` | 新增 | 纯函数单测 + 端口 0 的 HTTP 集成测试 |
| `src/lock.js` | 修改 | 导出 `isProcessAlive(pid)`，供面板判断监听进程是否存活；仅增加 `export`，行为不变 |

新增代码不进入 `node src/index.js` 的启动路径，监听器行为完全不变。

## 5. 启动与鉴权

- 默认监听 `127.0.0.1:8787`，`--port <n>` 可覆盖；端口占用时报错退出并提示换端口。
- 启动时生成 32 位十六进制随机 token（`crypto.randomBytes(16).toString('hex')`），控制台打印并自动打开 `http://127.0.0.1:<port>/#t=<token>`。
- token 只放在 URL 片段（`#`）里，浏览器不会把它发给服务端，也不会出现在 Referer 或服务端访问日志中；前端取出后存入 `sessionStorage`，后续请求走 `x-admin-token` 头。
- 除 `GET /` 外，所有 API 都要校验 token（`crypto.timingSafeEqual`），失败返回 401。
- 额外校验 `Host` 头必须是 `127.0.0.1:<port>` 或 `localhost:<port>`，`Origin` 若存在必须与 Host 同源，防 DNS rebinding 与跨站提交。
- token 缺失或错误时，页面只显示"请用启动时控制台打印的完整链接打开（含 `#t=`）"，不渲染任何配置。
- 安全响应头：`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`。

## 6. HTTP 接口

统一返回 JSON，错误形如 `{ ok: false, error: { message, field? } }`。

| 方法与路径 | 用途 | 说明 |
|---|---|---|
| `GET /` | 返回 `admin.html` | 唯一不需要 token 的端点 |
| `GET /api/overview` | 状态条数据 | 监听进程存活（读 `data/.lock` 的 PID 再探活，不依赖本地化文本）、计划任务是否安装、`state.json` 摘要、Cookie 过期时间 |
| `GET /api/config` | 读取业务配置 | 返回 `config.json` 当前值 + `DEFAULT_CONFIG` |
| `POST /api/config` | 保存业务配置 | 先 `normalizeConfig()`，通过后原子写 `config.json` |
| `GET /api/credentials` | 凭据**脱敏**视图 | Cookie 与 Token 只返回 `{ configured, tail, length, expiresAt }`，绝不返回原值；UID 属于标识而非密钥，完整返回以便直接编辑 |
| `POST /api/credentials` | 更新凭据 | 只接收用户主动粘贴的新值；空字符串表示"保持不变" |
| `POST /api/test-push` | 发送 WxPusher 测试消息 | 直接用当前 `.env` 中的值，不改文件 |
| `POST /api/test-fetch` | 拉取一页待审评论 | 验证 Cookie 是否有效，返回每篇微博的 `total` 与耗时 |
| `POST /api/dry-run` | 试跑一轮 | `pollAll({ dryRun: true })`，不写状态、不发消息；用一个收集型 logger 包装 `createLogger()` 的四个方法，把日志同时写入当日日志文件并收集到响应里 |
| `GET /api/logs?tail=100` | 今日日志尾部 | 读取 `logs/app-<今天>.log` 最后 N 行（上限 500） |
| `POST /api/restart` | 重启监听任务 | `schtasks /End` + `schtasks /Run`，任务名 `WeiBoListener`；未安装则返回 409 |

## 7. 页面结构

顶部状态条 + 三个页签，纯原生实现。

**状态条**：计划任务状态、最近轮询时间、当前待审总数、Cookie 剩余天数（≤3 天标黄，已过期标红）。

**凭据页**：Cookie 显示为"已配置 · 结尾 `…a1b2c3` · 1234 字符 · 有效期至 2026-11-20"，点"替换"才出现输入框；Token 与 UID 同理（UID 以逗号分隔的标签形式呈现）；日志级别下拉。按钮：**测试抓取**、**测试推送**，结果内联显示（成功/失败原因 + 耗时）。

**微博与轮询页**：`posts` 列表可增删改（id / name / enabled / url），轮询间隔、抖动、单条字符上限、排除关键词、心跳时间、启动通知开关。提交时先本地校验（必填、纯数字 ID、间隔 ≥30），再以服务端 `normalizeConfig()` 为准；错误显示在对应字段下方，其余字段保留用户输入。

**诊断页**：状态文件摘要（是否已建基线、lastPollAt、lastError）、今日日志尾部 100 行（等宽、可复制）、**试跑一轮**按钮（结果以表格列出每篇微博的新评论数与是否 dry-run）。

保存成功后顶部出现持久横幅：**"已保存，需重启监听才生效"**（并注明改的是 `.env` 还是 `config.json`）+ **"立即重启"** 按钮（点击后二次确认）。

## 8. 生效方式（决策：方案 a）

`index.js` 只在启动时读取一次配置，因此面板保存后不会影响正在运行的进程。本设计采用**提示 + 一键重启**：

- 保存成功后横幅提示需要重启，提供"立即重启"按钮；
- 按钮执行 `schtasks /End /TN WeiBoListener` 后 `schtasks /Run /TN WeiBoListener`，等待 2 秒后用 `data/.lock` 的 PID 探活确认新进程已起来；
- 任务状态一律以"锁文件 PID 是否存活"为运行时判据，`schtasks` 输出只用于判断"是否安装"和尽力解析，避免中文/英文系统下状态文本不同导致误判；
- 任务未安装（`schtasks` 返回非零）时按钮置灰，横幅改为提示"当前未安装计划任务，请手动重启监听进程"。

**热加载列为后续可选**（不属于本次范围）：在 `index.js` 主循环每轮前重读 `config.json`，解析失败时沿用上一份并记 `warn` 日志。它需要改动监听器主循环，须单独评估。

## 9. 文件写入规则

**`.env`**：不做全量重写，避免吃掉人工注释。

1. 按行读取，识别 `KEY=VALUE` 行（`#` 开头为注释，原样保留）；
2. 只替换 `WEIBO_COOKIE`、`WXPUSHER_APP_TOKEN`、`WXPUSHER_UIDS`、`LOG_LEVEL` 四个键的**值**部分，位置不变；
3. 文件中缺失的键追加到末尾（值前带一行注释说明来源）；
4. 值包含空格、`#`、引号时用双引号包裹并转义；
5. 写前把原文件复制为 `.env.bak`，再写 `.env.tmp` 并 `rename` 覆盖（与 `saveState` 相同策略）。

**`config.json`**：`JSON.stringify(normalizeConfig(input), null, 2) + '\n'`，同样先备份 `config.json.bak` 再原子写。

**外部修改检测**：`GET /api/config` 返回文件当前 `mtime`，`POST /api/config` 必须带同一个 `mtime`；不一致则返回 409"配置文件已被外部修改，请刷新后重试"，避免覆盖掉用户手改的内容。`.env` 同理。序列化用归一化后的对象，保证写出的文件结构与运行期实际生效的值一致。

## 10. 错误处理

- 校验失败：400 + 中文 `message`（直接透出 `ConfigError` 文案），不写文件；
- 写文件失败（权限/占用）：500 + 明确路径与系统错误；
- 抓取失败：返回 `WEIBO_AUTH`（Cookie 失效）/ `WEIBO_RATE_LIMIT`（限流）/ 网络错误的区分，页面用不同颜色提示；
- 推送失败：透传 `WxPusherError` 的 `message` 与 `code`；
- 未捕获异常：进程级 `uncaughtException` 记录后退出，不静默吞掉。

## 11. 测试

`test/admin.test.js`，沿用 `node --test`：

- 纯函数：`.env` 合并（保留注释/顺序、只改指定键、缺失键追加、含空格与引号的值正确转义）；脱敏函数（不返回原值、尾部与长度正确）；`maskSecret` 对短值不泄露。
- HTTP（`server.listen(0)` + 临时目录）：无 token → 401；错误 token → 401；`GET /` 无需 token；`POST /api/config` 非法 JSON → 400 且文件未变；合法 → 200 且文件内容等于归一化结果；`GET /api/credentials` 响应体中不含 Cookie 原文。

## 12. 风险

| 风险 | 处理 |
|---|---|
| 本机其他程序读取 `#t=` 或 `sessionStorage` | 仅本机、仅内存；token 每次启动重新生成，泄露面仅限本次会话 |
| 浏览器扩展窃取 Cookie | 完整凭据永不返回前端，只回传尾部与长度 |
| 并发写 `config.json`（用户同时手改文件） | 写入前重读并比对 mtime，不一致则提示"文件已被外部修改，请刷新后重试" |
| 端口被占用 | 明确报错并提示 `--port` |
| `schtasks` 需要权限 | 失败即回显 stderr，并降级为纯提示 |

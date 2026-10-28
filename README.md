# 微博待审评论监听

自动盯着你指定的微博，一旦出现新的「待审评论」，立刻通过 [WxPusher](https://wxpusher.zjiecode.com/) 推送到手机。

适合需要在第一时间处理评论的作者：不用一直刷后台，有新评论手机上就能收到。程序只读取待审列表并推送，不会自动审核、回复或删除任何内容。

- 默认每 **5 分钟** 检查一次，带随机抖动，避免固定频率触发风控
- 支持同时监听多条微博，各自独立记录，互不影响
- 首次运行只建立基线，不会把历史评论全推一遍
- 支持排除关键词：正文命中的评论不推送
- Cookie 失效、连续失败、Cookie 即将过期、启动失败都会主动推送告警
- 每天一条心跳，写明最近一次成功抓取的时间
- 自带本地网页配置面板，不用手改文件
- 零第三方依赖（Node 自带模块即可运行）

## 快速开始（Windows，免安装 Node）

1. 到 [Releases](https://github.com/BlueIs-A2ul/WeiBoListener/releases) 下载 `WeiBoListener-x.y.z-win-x64.zip`，解压到任意可写目录（例如 `D:\\WeiBoListener`）
2. 双击 `WeiBoListener.exe`：还没配置过时，它会自动打开配置面板，并把带令牌的地址打印在窗口里
3. 在「凭据」页填入微博 Cookie、WxPusher AppToken 与 UID，保存；顺手点「发送测试推送」确认手机能收到
4. 在「微博与轮询」页添加要监听的微博，保存
5. 在「诊断」页点「安装开机自启」，此后登录 Windows 就会自动在后台运行

> 请把整个文件夹一起移动，不要只拿 exe：业务代码在同目录的 `app/` 里。

## 需要准备的三样东西

### 微博 Cookie

1. 浏览器登录 [weibo.com](https://weibo.com)
2. 按 F12 打开开发者工具 → Network，刷新页面
3. 找到 `approval/list` 请求，复制请求头里整行 `Cookie`
4. 粘贴到面板「凭据」页

Cookie 是账号凭证，只保存在本机 `.env` 文件里，不上传、不同步；面板也不会把它回显到浏览器（只显示尾部 6 位和长度）。

### WxPusher AppToken 与 UID

1. 打开 <https://wxpusher.zjiecode.com/>，微信扫码登录
2. 创建一个应用，复制 **appToken**（以 `AT_` 开头）
3. 用微信关注该应用的公众号，在「我的」页面复制 **UID**（以 `UID_` 开头；多个用英文逗号分隔）

### 要监听的微博 ID

微博详情页地址里那串纯数字，例如 `https://weibo.com/1234567890/AbCdEfGh` 里的 `1234567890`。

## 配置面板

用 `WeiBoListener.exe --admin` 打开（或用桌面快捷方式启动程序后自动打开）。

面板只监听 `127.0.0.1`，地址带一次性访问令牌，关掉窗口不影响监听进程。

| 页签 | 能做什么 |
|---|---|
| 凭据 | 更换微博 Cookie、WxPusher AppToken、修改 UID 与日志级别；**测试抓取**验证 Cookie 是否还有效；**发送测试推送**验证手机能否收到 |
| 微博与轮询 | 增删要监听的微博，修改轮询间隔、随机抖动、单条评论字符上限、心跳、排除关键词、启动时是否推送 |
| 诊断 | 进程与开机自启状态、Cookie 剩余天数、健康度（连续失败轮数 / 最近成功 / 最近推送）、**试跑一轮**（真实请求但不写状态、不推送）、最近的日志 |

保存后会自动重启监听。默认端口 8787，被占用时自动顺延到空闲端口，以终端打印的地址为准。

## 命令行

| 命令 | 作用 |
|---|---|
| `WeiBoListener.exe` | 启动监听；没有配置时自动打开配置面板 |
| `WeiBoListener.exe --admin` | 打开配置面板 |
| `WeiBoListener.exe --install` | 安装开机自启 |
| `WeiBoListener.exe --uninstall` | 取消开机自启 |
| `WeiBoListener.exe --status` | 查看监听进程、Cookie、配置文件与自启状态 |
| `WeiBoListener.exe --once` | 只检查一轮后退出 |
| `WeiBoListener.exe --dry-run` | 只打印将要推送的内容，不写状态、不发送 |
| `WeiBoListener.exe --test-push` | 只发一条 WxPusher 测试消息 |
| `WeiBoListener.exe --test-site=ID` | 试抓一个通用站点：打印条目与推送示例，不写状态、不推送 |
| `WeiBoListener.exe --help` | 查看全部参数 |

## 监听其它网站（通用站点）

微博之外，还能监听任意返回 JSON 的接口：教务的考试安排、成绩、通知公告，别的学校站点等等。一个站点 = `config.json` 里 `sites` 数组的一条配置，不改代码。

**做法（以教务接口为例）**

1. **找接口**：浏览器登录后按 F12 → Network → 刷新页面 → 找到返回 JSON 的那条请求，右键复制完整 URL。注意**保留查询参数**（例如 `?termCode=2026-2027-1`），去掉参数通常只会拿到 HTML 外壳。
2. **写配置**：把 `config.example.json` 里的 `sites` 示例复制到自己的 `config.json`，改 `id`、`name`、`request.url`、`select` 这几处。字段含义见下表。
3. **填 Cookie**：复制该请求的整行 Cookie，写进 `.env` 的 `SITE_<ID>_COOKIE`（键名和配置里的 `cookieEnv` 一致），例如：
   ```
   SITE_SWPU_EXAMS_COOKIE=NQwq88ht...; _WEU=...; route=...
   ```
4. **验证**：`node src/index.js --test-site swpu-exams`。只抓一次，打印状态码、条目和推送示例，**不写状态、不推送**。
5. **重启监听**生效。首次运行只建立基线（把当前条目全部记为已见），不会把历史条目推一遍。

**字段说明**

| 字段 | 说明 |
|---|---|
| `id` | 小写字母/数字/短横线，唯一；也用来派生 `SITE_<ID>_COOKIE` 键名 |
| `mode` | 目前只支持 `json` |
| `request.url` | 接口地址，必填，必须是 http/https |
| `request.headers` | 额外请求头；默认已带 `User-Agent`、`Accept`、`Accept-Language: zh-CN` |
| `request.cookieEnv` | Cookie 在 `.env` 里的键名，留空则按 ID 自动派生 |
| `success` | 成功判定，例如 `{ "path": "code", "equals": "0", "messagePath": "msg" }`；不填只要求是 JSON |
| `select.items` | 条目数组的路径，例如 `datas` 或 `data.list` |
| `select.id` | 唯一 ID 字段（字符串即可，UUID 也行），用来去重 |
| `select.title` / `time` / `link` / `text` | 推送里展示的字段，可以留空 |
| `select.fields` | 额外展示字段，`[{ "path": "examPlace", "label": "考场" }]` |
| `filters.includeKeywords` / `excludeKeywords` | 命中关键词的条目只保留 / 丢弃 |
| `pollIntervalSec` | 该站点自己的轮询间隔；留空则跟随全局间隔 |
| `message.header` / `item` | 推送模板，占位符 `{site} {count} {index} {title} {time} {link} {text} {fields}` |

**注意事项**

- 尽量不要覆盖 `Accept-Language`：不少教务系统看到它会返回中文（`课程结业考试`），不带则返回内部代码（`04`）。
- Cookie 失效不一定报 401：常见表现是**返回 HTML 登录页**，或者**连接超时**。日志会直接说明是哪一种，按提示重新复制 Cookie 即可。
- 学期切换后 URL 里的 `termCode` 会变：改一次配置，或者并存两条站点、停用旧的。
- 面板暂时只编辑微博部分；站点配置目前通过 `config.json` 维护（从面板保存不会覆盖 `sites`）。
- 站点抓取失败只影响自己：认证失败暂停 30 分钟并推送一次告警，限流退避 10 分钟。
## 开机自启

`--install` 会注册一个登录时触发的计划任务：

- 进程意外退出后每分钟重试，最多 999 次
- 不允许多实例同时运行
- 不限制运行时长、不因电池模式被停止
- 通过隐藏窗口启动，不会弹出黑色控制台

配置不完整（缺 Cookie 或还没有 `config.json`）时会拒绝安装，并提示先完成配置。取消自启用 `--uninstall`，面板「诊断」页也有同样的两个按钮。

## 更新

把新版本的 `app/` 文件夹替换掉旧的即可（约 150 KB），不需要重新下载 80 MB 的 exe。

exe 只在更换 Node 版本或调整启动器时才需要替换。更新前先在任务管理器里结束旧的 `WeiBoListener.exe`。

## 常见问题

### 双击后窗口闪一下就没了

说明配置齐全、程序已经在后台运行。用 `WeiBoListener.exe --status` 查看进程，或 `--admin` 打开面板看健康度。

### 手机收不到推送

1. 面板「凭据」页点「发送测试推送」，按提示排查
2. 确认微信已关注 WxPusher 公众号
3. 确认 UID 填的是自己的 UID，不是应用 ID
4. 微信可能折叠服务号消息，去公众号会话里找
5. 看 `logs/app-YYYY-MM-DD.log` 里有没有 `WxPusher 推送失败`

### 提示 Cookie 失效

重新复制整行 Cookie，面板「凭据」页点「替换 Cookie」保存即可。程序会在 Cookie 剩余 7 天时提前推送提醒。

### 日志在哪

- `logs/app-YYYY-MM-DD.log`：运行日志
- `logs/startup.log`：开机自启时配置不全等启动问题
- `logs/runner.log`：从命令行启动时的控制台输出

打包版的这些目录都在 exe 旁边。

### 想重新建立基线

删除 `data/state.json` 和 `data/state.json.bak`，下次启动会把当前待审评论全部记为已见，不再推送它们。

### 提示「系统环境变量……覆盖了 .env 里的同名配置」

Windows 环境变量里已经存在同名的 `WEIBO_COOKIE` / `WXPUSHER_APP_TOKEN` 等，而系统环境变量优先级更高，`.env` 里改的值不会生效（面板看似保存成功）。删掉系统环境变量，或在「系统属性 → 环境变量」里同步改值。

### 电脑休眠 / 关机期间

监听会暂停。恢复运行后，仍留在待审列表里的新评论会补推。

## 从源码运行（开发者）

需要 Node.js **20.12+**。

```bash
npm test                              # 单元测试
cp config.example.json config.json    # 或在面板里生成
cp .env.example .env                  # 填入 Cookie / AppToken / UID
npm start                             # 常驻监听
npm run dry                           # 只打印将要推送的内容
npm run admin                         # 配置面板
```

配置说明：`config.json` 保存微博列表、轮询间隔、过滤规则（示例见 [config.example.json](config.example.json)）；`.env` 保存 Cookie 与 WxPusher 密钥。两个文件都在本机，不要提交或分享。

## 打包（开发者）

```powershell
.\build.ps1              # 跑测试 → 组装 dist\（首次会构建 exe）
.\build.ps1 -RebuildExe  # 强制重建 exe
```

产物是「壳 exe + 外部代码」：

```text
dist/
├─ WeiBoListener.exe     壳（约 81 MB，只在换 Node 或改启动器时重建）
├─ app/                  业务代码（约 150 KB，日常更新只换这里）
├─ config.example.json   配置模板
└─ .env.example          密钥模板
```

首次构建时脚本会把 `postject` 装到 `%LOCALAPPDATA%\WeiBoListener-build`，仓库本身保持零依赖。

## 说明

- 基于微博网页版接口，不是官方 API；接口或字段调整可能导致失效，此时会推送告警并在日志里写明原因
- 请保持低频轮询，不要用多账号高频请求，避免账号被风控
- 程序只读取待审评论并推送通知，不会执行审核、回复、删除等操作
- exe 未做代码签名，Windows 首次运行可能提示「已保护你的电脑」，点「更多信息 → 仍要运行」即可

# systemd 部署（Debian / Ubuntu，不想装 Docker 时用）

> 一条命令：`sudo deploy/install-systemd.sh`
>
> 想用容器的话看仓库里的 [docker-compose.yml](../docker-compose.yml) 与
> [docs/debian-deploy.md](../docs/debian-deploy.md)；
> **两套方案二选一**，同时跑会抢同一个 `data/.lock`（后启动的那个会以「已有实例在运行」退出）。

## 为什么 Linux 上必须用 systemd

程序自带的 `--install` 走的是 Windows 的 `schtasks`（见 `src/schedule.js`），
在 Linux 上执行它不会有任何效果。服务器需要的三件事得交给 systemd：

| 需求 | systemd 里对应 |
|---|---|
| 开机自启 | `systemctl enable`（unit 文件的 [Install] 段 + enable 时创建软链） |
| 进程崩了自动拉起 | `Restart=always` + `RestartSec` |
| 停服时干净退出 | `KillSignal=SIGTERM` + `TimeoutStopSec=30`（程序在 SIGTERM 里删 `data/.lock`） |

最后一条是重点：`src/index.js:343-347` 收到 SIGTERM 才会 `releaseLock()`。
如果被 SIGKILL 直接杀掉，`data/.lock` 会留着；虽然下次启动发现里面的 PID 已死会当残留锁覆盖，
但干净退出永远更省事。

## 前置条件

- Debian 11/12/13、Ubuntu 20.04+ 或任何以 systemd 作为 init 的发行版
- Node.js **>= 20.12**（`package.json` 的 `engines`）；Debian 自带的往往偏旧，建议用 NodeSource 的 deb 包
- 项目已经放到服务器上，**路径随意**（`/opt/WeiBoListener`、`/srv/...`、`/home/you/...` 都行）。
  脚本默认用「自己上一级目录」当项目根，也可以用 `--root` 指定

## 安装

```bash
# 1. 取代码（deploy/ 和 src/ 一起下来就行）
git clone <repo> /opt/WeiBoListener
cd /opt/WeiBoListener

# 2. 填配置（.env 与 config.json 都不在 git 里）
cp .env.example .env
nano .env                       # WEIBO_COOKIE、WXPUSHER_APP_TOKEN、WXPUSHER_UIDS
cp config.example.json config.json
nano config.json                # 或者稍后用配置面板生成

# 3. 装成系统服务（默认用 sudo 的调用者身份跑）
sudo deploy/install-systemd.sh
# 拿到手的脚本没有可执行位（比如从 Windows 传上来）时：sudo bash deploy/install-systemd.sh
```

想用专用账号跑（推荐，权限最小）：

```bash
sudo deploy/install-systemd.sh --user weibo --create-user
```

脚本最后会打一串 `✓ weibo-listener 正在运行` 和常用命令，就说明装好了。

### 脚本做了什么

1. **前置检查**：EUID 是 root、`/run/systemd/system` 存在（容器里没有，会让你改用 compose）、
   node 能执行且版本 >= 20.12、`.env` 与 `config.json` 存在，且 `config.json` 是合法 JSON、里面有内容
2. **配置预检**（缺了就拒绝安装，因为程序会一启动就 `exit 1`）：
   - `WXPUSHER_APP_TOKEN` / `WXPUSHER_UIDS` 为空 —— 没有推送通道，非 dry-run 一定退出
   - `WEIBO_COOKIE` 为空、但 `config.json` 里有启用的微博
   - 一条启用的微博/站点都没有
   - `data/.lock` 里的 PID 还活着（多半是你手工跑的实例没关）
3. **权限**：`mkdir -p data logs`（日志目录按 `config.json` 的 `logDir` 来）；
   只给 `data/`、`logs/` 和必要的 `.env` / `config.json` 改属主，**不碰 src/**
4. **渲染 unit**：把模板里的 4 个占位符换成本机实际值（路径做 systemd 的引号与 `%` 转义），
   写到 `/etc/systemd/system/weibo-listener.service`
5. **启用 + 启动 + 回查**：`daemon-reload` → `enable` → `reset-failed` → `restart` → 等 3 秒查 `is-active`，
   没在跑就把 `journalctl` 的日志尾巴打出来

**重复执行是安全的**：unit 内容没变、服务正在跑，就只做 `daemon-reload`，不会重启进程
（重启会打断 `data/.lock` 清理，也会重新发一遍启动消息）。改了 node 路径或换了用户再跑一次即可。

### 参数

| 参数 | 作用 |
|---|---|
| `--root DIR` | 项目根目录（默认：脚本的上一级） |
| `--user NAME` | 跑服务的用户（默认：sudo 时的调用者，否则当前用户） |
| `--create-user` | `--user` 指定的用户不存在时创建（system 用户、nologin shell、home 指向项目根） |
| `--node PATH` | 指定 node 绝对路径（默认：PATH 里解析出来的那个） |
| `--dry-run` | 只打印渲染后的 unit 和要执行的命令，**不写文件、不需要 root** |
| `--force` | 上面那些配置预检降级成警告，照样安装 |

装之前想先看看 unit 长什么样：

```bash
deploy/install-systemd.sh --dry-run --user weibo | less
```

## 验证

```bash
systemctl status weibo-listener        # active (running) + 最近几行日志
journalctl -u weibo-listener -n 30     # 启动日志
```

判断成功的标准是 **`systemctl is-active weibo-listener` 返回 `active`**（安装脚本最后已经替你查了一次）。

> 别只凭日志里那行「微博监听启动」下结论：这行在**致命错误之前**就会打印
> （实测缺 WxPusher 配置、`data/` 不可写时都是先打「启动成功」再打错误并 exit 1）。
> 看到它之后还要有「下一轮将在约 XXX 秒后开始」，并且进程没有立刻退出。

再确认一下真实请求能跑通（跑一轮、打印将要推送的内容，不写状态、不推送）：

```bash
sudo -u weibo /usr/bin/node /opt/WeiBoListener/src/index.js --dry-run --once
```

> 这里的 `/usr/bin/node` 只是例子。用 nvm 装的 node 不在这个位置，
> 安装时脚本会打印它实际用到的绝对路径，照着抄。

## 日志：journald 和 logs/ 是什么关系

程序的 logger 写两份（`src/logger.js`）：一份 `logs/app-YYYY-MM-DD.log`，一份 stdout/stderr，
后者被 systemd 收进 journald。两份内容一样，用途不同：

| 用途 | 看哪儿 |
|---|---|
| 服务状态、崩溃前的最后输出、开机时的问题 | `journalctl -u weibo-listener` |
| 完整历史、跨天对比、把某天的日志发给别人 | `logs/app-YYYY-MM-DD.log` |
| 配置面板的一次性访问令牌 | 面板**自己**的终端输出（不在上面两处） |

**程序不清理旧日志**，所以两份都要限制：

```bash
# journald 侧：限制总量（默认只用磁盘的 10%，小机器建议写死）
sudo sed -i 's/^#SystemMaxUse=.*/SystemMaxUse=200M/' /etc/systemd/journald.conf
sudo systemctl restart systemd-journald

# logs/ 侧：给应用日志加轮转，写进 /etc/logrotate.d/weibo-listener
sudo tee /etc/logrotate.d/weibo-listener >/dev/null <<'ROTATE'
/opt/WeiBoListener/logs/app-*.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
    copytruncate
}
ROTATE
```

（路径按你实际的项目根改。加 `copytruncate` 是为了不依赖进程重新打开日志文件：
程序每次写都是重新 `appendFileSync` 打开的，不加也能转，加了最稳。）

## 改配置后重启

`.env` 和 `config.json` 都只在**启动时**读一次（`loadDotEnv` / `loadConfig`），改完必须重启：

```bash
sudo systemctl restart weibo-listener
```

### 用配置面板

面板只监听 127.0.0.1，服务器上要开 SSH 隧道：

```bash
# 服务器上（--no-restart 必须加：服务器上没有 schtasks，保存时“自动重启监听”会失败）
sudo -u weibo /usr/bin/node /opt/WeiBoListener/src/admin.js --no-open --no-restart

# 本地新开一个终端
ssh -L 8787:127.0.0.1:8787 <user>@<server>
# 然后把面板终端里打印的带令牌地址（127.0.0.1:8787 那段照抄）粘到浏览器
```

- 面板保存后**不会**自动重启监听，请手动 `systemctl restart weibo-listener`
- 面板最好也用**同一个运行用户**启动（上面用了 `sudo -u weibo`）。unit 里设了 `UMask=0027`，
  用别的用户跑面板可能读不到 `data/.lock`，界面会显示「监听未运行」

## 升级

```bash
cd /opt/WeiBoListener
sudo systemctl stop weibo-listener      # 可选：让 .lock 干净删掉；不 stop 直接 restart 也行
sudo -u weibo git pull                  # 或者从本地 scp 覆盖 src/
sudo systemctl start weibo-listener
```

- 只改了业务代码（`src/`）：`sudo systemctl restart weibo-listener`
- **换了 node**（升级 / 切版本）：重跑一次 `sudo deploy/install-systemd.sh`，
  它会重新探测 node 绝对路径并写进 unit（nvm 的路径带版本号，换版本后旧路径就失效了）
- `data/` 和 `logs/` 不会被脚本改动；想重建基线就删 `data/state.json` 与 `data/state.json.bak` 再重启

## 卸载

```bash
sudo systemctl disable --now weibo-listener      # 停止 + 取消开机自启
sudo rm /etc/systemd/system/weibo-listener.service
sudo systemctl daemon-reload
sudo systemctl reset-failed weibo-listener 2>/dev/null || true

# 项目目录、data/、logs/ 都原地保留，确认不要了再自己删
```

用 `--create-user` 建的账号不会自动删：`sudo userdel weibo`。

## 排障

| 现象 | 原因 / 处理 |
|---|---|
| `systemctl status` 显示 `failed`，日志里有 `start request repeated too quickly` | 撞到了 unit 里的 `StartLimitIntervalSec=600` / `StartLimitBurst=6`。改好 `.env` 或 `config.json` 后：`sudo systemctl reset-failed weibo-listener && sudo systemctl start weibo-listener` |
| 日志说「缺少 WEIBO_COOKIE」/「缺少 WxPusher 配置」 | `.env` 没填全。填好后 `systemctl restart` |
| 日志说「已有实例在运行（PID xxx）」 | 手工跑的实例还占着 `data/.lock`。`kill xxx` 之后重启服务 |
| `status=203/EXEC` | `ExecStart` 里的 node 路径失效（换过 node 版本）。重跑安装脚本，或用 `--node` 指定 |
| `status=200/CHDIR` | `WorkingDirectory` 不存在：项目被移走了，重跑安装脚本 |
| 面板显示「监听未运行」，但服务确实是 active | 面板不是同一个用户跑的，读不到 `data/.lock`（见上文） |
| Cookie 失效告警 | 重新从浏览器导出 Cookie，改 `.env` 后 `systemctl restart`。跟部署方式无关 |
| 心跳时间差 8 小时 | unit 里已有 `Environment=TZ=Asia/Shanghai`；不在东八区就改这一行，然后 `daemon-reload` + `restart` |

### 几个「故意没加」的加固项

宁可少加也不要加错，下面这几项加上去会直接把服务弄坏，所以 unit 里刻意没有：

- `MemoryDenyWriteExecute=yes` —— V8 的 JIT 需要可写可执行内存，开了 node 会立刻崩溃
- `SystemCallFilter=@system-service` —— node 依赖的个别较新 syscall 可能不在白名单里，升级 node 时才炸
- `ProtectHome=yes` —— 项目常常就放在 `/home/<用户>/` 下，开了连代码和 `.env` 都读不到

已经加的那批（`NoNewPrivileges`、`PrivateTmp`、`PrivateDevices`、`ProtectSystem=strict` +
`ReadWritePaths=<项目根>`、`RestrictAddressFamilies`、`UMask=0027` 等）在单元文件 `[Service]` 段的注释里
逐条写了为什么安全。**日志目录如果改到项目根之外，记得把那个路径也加到 `ReadWritePaths`。**

## 资源占用

常驻内存约 40–60 MB，每 5 分钟一次 HTTPS 请求，1C512M 的小机器足够。
只出站访问 weibo.com 与 wxpusher.zjiecode.com，**不监听任何端口**，不需要在防火墙里开口子。

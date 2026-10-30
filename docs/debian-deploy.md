# 部署到 Debian 服务器

把这套监听从 Windows 挪到一台 Debian 服务器上常驻运行。两条路，按需选：

| 路线 | 适合 | 更新方式 | 开机自启 |
|---|---|---|---|
| **A. Docker（推荐）** | 想省事、机器上已有 Docker | 拉代码 + 重启容器（不重建镜像） | `restart: unless-stopped` + `systemctl enable docker` |
| **B. systemd 原生** | 不想装 Docker / 想少一层 | 拉代码 + `systemctl restart` | `systemctl enable` |

运行方式完全一样：`node src/index.js` 常驻，**零第三方依赖**——不需要 `npm install`，也不需要 Dockerfile。

> 标注约定：**实测**＝本机 Docker 真跑过（`node:22-bookworm-slim`）；**源码**＝读过 `src/` 确认；**已知**＝通用行为。没验证的会明说。

---

## 0. 先决条件

- Debian 11/12/13，x86_64 / arm64 都行
- 一个能 `sudo` 的普通用户（下文用 `deploy` 代替）
- 1 核 512 MB、约 300 MB 磁盘（镜像 ~80 MB，常驻内存 40–60 MB）
- **不需要开放任何端口**：只做出站 HTTPS 请求

---

## 1. 先把代码弄到服务器上（这一步最容易翻车）

仓库现状有两个坑，**必须先处理**：

1. **`docker-compose.yml` 和本文档还没提交**（untracked），`git clone` 拿不到。
2. **`origin/main` 落后本地 6 个提交**：通用站点、站点向导这些 1.3.0 的功能只在 `feat/site-watcher` 分支上。clone 默认分支会拿到 1.2.0，`config.json` 里写 `sites` 直接报错。

### 做法 A：先在本机推上去，服务器再 clone（推荐）

之后服务器上就能 `git pull` 更新：

```bash
# 本机
git add docker-compose.yml docs/ deploy/
git commit -m "chore: Debian 部署（Docker + systemd）"
git push -u origin feat/site-watcher

# 服务器
sudo mkdir -p /opt && sudo chown "$USER" /opt
git clone -b feat/site-watcher https://github.com/BlueIs-A2ul/WeiBoListener.git /opt/WeiBoListener
```

### 做法 B：直接从本机同步目录（不依赖仓库状态）

Git Bash 里有 `tar` 和 `ssh`（`rsync` 通常没有，要用 WSL）：

```bash
# 本机，项目根目录执行
tar czf - --exclude=node_modules --exclude=dist --exclude=.git \
    .env config.json src package.json docker-compose.yml deploy \
  | ssh deploy@server 'mkdir -p /opt/WeiBoListener && tar xzf - -C /opt/WeiBoListener'
```

**`.env` 和 `config.json` 必须带上**——它们不在 git 里，clone 永远拿不到。
**`data/` 带上**则沿用已见记录；不带的话首次启动会把当前待审评论**全部记为已见、一条都不推**（设计如此）。

---

## 2. 路线 A：Docker（推荐）

### 2.1 装 Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"      # 重新登录生效
docker compose version               # 确认 compose 插件在
```

> 国内网络如果拉 `node:22-bookworm-slim` 超时（实测 Docker Hub 直连会卡住），
> 给 `/etc/docker/daemon.json` 配个镜像加速源再 `sudo systemctl restart docker`。

### 2.2 放配置（顺序很重要）

```bash
cd /opt/WeiBoListener
cp .env.example .env
nano .env            # WEIBO_COOKIE / WXPUSHER_APP_TOKEN / WXPUSHER_UIDS 三个都要填
chmod 600 .env       # Cookie 就是账号凭证

cp config.example.json config.json    # 已有从本机带来的就跳过
nano config.json                      # 改成你自己的微博 ID
```

**三条会让程序 exit 1、配合 `restart: unless-stopped` 变成无限重启的硬性要求**（源码）：

| 缺什么 | 后果 |
|---|---|
| `config.json` 不存在 / 不是合法 JSON | `ConfigError` → exit 1（`src/config.js:316`） |
| `posts` 和 `sites` 同时为空 | 「至少要配置一条微博（posts）或一个站点（sites）」（`src/config.js:263`） |
| `.env` 缺 `WXPUSHER_APP_TOKEN` 或 `WXPUSHER_UIDS` | 「缺少 WxPusher 配置」→ exit 1（`src/index.js:299`）。**只有 `--dry-run` 会跳过这条校验** |

实测表现：`docker compose ps` 的 STATUS 列显示 `Restarting (1)`，20 秒内重启 8 次，日志里同一段报错刷屏。

### 2.3 起服务

```bash
docker compose up -d
docker compose logs -f listener
```

**判断成功的标准（实测）**：`docker compose ps` 里 STATUS 是 `Up`，且重启计数不涨：

```bash
docker compose ps
docker inspect -f 'status={{.State.Status}} restarts={{.RestartCount}}' weibo-listener
```

> ⚠️ **别只看日志第一行**。`微博监听启动（Node vXX，linux）` 这行在**致命错误之前**就会打印——
> 实测缺 WxPusher 配置、`data/` 不可写时，都是先打「启动成功」再打错误并 exit 1。
> 要看到 `下一轮将在约 XXX 秒后开始`，并且进程没有退出。

### 2.4 验证（三条命令，都很安全）

```bash
# 1) 真实抓一轮，只打印"将要推送什么"：不写状态、不推送
docker compose exec listener node src/index.js --dry-run --once

# 2) 手机能不能收到（这条会真的发一条）
docker compose exec listener node src/index.js --test-push

# 3) 状态
docker compose ps
```

`--dry-run` 不获取 `data/.lock`，`--test-push` 在拿锁之前就返回（源码 `src/index.js`），所以**不用停服务**。

### 2.5 开机自启

```bash
sudo systemctl enable docker
```

`restart: unless-stopped` 只在 Docker 服务本身跟着开机启动时才有效。漏了这条，服务器重启后什么都不跑，而且没有任何报错。

### 2.6 配置面板（可选）

面板地址写死 `127.0.0.1`（`src/admin.js:34`），容器用 host 网络，靠 SSH 隧道访问：

```bash
docker compose --profile admin up -d admin
docker compose logs admin        # 打印 http://127.0.0.1:8787/#t=<一次性令牌>

# 本地另开一个终端
ssh -L 8787:127.0.0.1:8787 deploy@server
# 把日志里那条地址粘进本地浏览器
```

- 面板能改 Cookie / AppToken / UID、测试抓取、测试推送、增删微博、加通用站点、看健康度、试跑
- **保存后不会自动重启监听**：容器里没有 schtasks/systemctl，启动时带了 `--no-restart`（源码 `src/admin.js:310`）。改完手动 `docker compose restart listener`
- 端口 8787 被占时会自动顺延（`src/admin.js:1008` 扫描 10 个端口），以日志打印的为准
- 用完 `docker compose --profile admin stop admin`，不影响监听
- ⚠️ **面板的「监听进程」状态在容器里不可信**，别拿它判断服务死活，用 `docker compose ps`。原因：`data/.lock` 里存的是 `process.pid`，那是 listener 自己 PID 命名空间里的号（实测 7），而面板在宿主命名空间里查同一个号，查的是另一个进程。实测给 listener 也加 `pid: host` 反而更糟——残留锁里的 PID 会撞上宿主进程（撞上内核线程 → `EPERM` → 程序认为「已有实例在运行」→ 拒绝启动 → 重启循环），所以 `docker-compose.yml` 里**只给 admin 加了** `pid: host`

---

## 3. 路线 B：systemd 原生

`deploy/` 里有现成的，详细说明见 [deploy/README.md](../deploy/README.md)：

```bash
# 1. Node.js 20.12+（Debian 自带的太老）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs && node -v

# 2. 放代码和配置（同第 1、2.2 步）
cd /opt/WeiBoListener

# 3. 先看要装什么（不写文件、不需要 root）
deploy/install-systemd.sh --dry-run | less

# 4. 安装（默认用 sudo 的调用者身份跑服务）
sudo deploy/install-systemd.sh --user weibo --create-user
```

脚本会先做**配置预检**：缺 WxPusher、缺 Cookie 但 `posts` 有启用项、`config.json` 非法、`data/.lock` 的 PID 还活着——全部**拒绝安装**并说清原因（`--force` 可降级为警告）。所以「装完就进重启死循环」这种最常见的坑根本装不出来。

`deploy/weibo-listener.service` 的关键取舍：

- `Restart=always` + `StartLimitIntervalSec=600` / `StartLimitBurst=6`：**故意限制重启次数**。配置错了程序会立刻 exit 1，无限制重启只会刷爆 journald 和 `logs/app-*.log`。撞限后单元进 failed，修好配置再 `systemctl reset-failed weibo-listener && systemctl start weibo-listener`
- `KillSignal=SIGTERM` + `TimeoutStopSec=30`：停服时程序要清 `data/.lock`（源码 `src/index.js:343`）
- `Environment=TZ=Asia/Shanghai`：日志日期、心跳小时按本地时间
- `ProtectSystem=strict` + `ReadWritePaths=<项目根>`：除项目目录外整个文件系统只读
- 刻意**没开** `MemoryDenyWriteExecute`（V8 JIT 需要可写可执行内存，开了 node 立刻崩）

---

## 4. 日常运维

| 目的 | Docker | systemd |
|---|---|---|
| 看日志 | `docker compose logs -f listener` | `journalctl -u weibo-listener -f` |
| 应用日志 | `logs/app-YYYY-MM-DD.log` | 同左 |
| 改完配置重载 | `docker compose restart listener` | `sudo systemctl restart weibo-listener` |
| 试跑一轮 | `docker compose exec listener node src/index.js --dry-run --once` | `sudo -u weibo node src/index.js --dry-run --once` |
| 测试推送 | `docker compose exec listener node src/index.js --test-push` | `sudo -u weibo node src/index.js --test-push` |
| 停 | `docker compose down` | `sudo systemctl stop weibo-listener` |

---

## 5. 已知的坑（按踩到的概率排序）

### 5.1 三条「启动即 exit 1」的配置硬要求（源码 + 实测）

见 2.2 的表格。症状统一是 `Restarting (1)` 无限刷屏。**先放好配置，再 `up`。**

### 5.2 文件归属：UID 对不上不是"被 root 占用"，而是直接起不来（实测）

compose 里写死 `user: "1000:1000"`（node 镜像的 `node` 用户）。Debian 上第一个普通用户通常正好是 1000，多数情况直接可用。

**如果不是 1000**，`data/` 写不进去 → `EACCES: permission denied, open '/app/data/.lock'` → exit 1 → 又是重启循环：

```bash
id -u                                          # 不是 1000 就二选一
sudo chown -R 1000:1000 /opt/WeiBoListener     # ① 把目录给 1000（推荐）
# ② 或者改 compose 里的 user 成你自己的 UID:GID
```

### 5.3 时区：这条反而**没问题**（实测）

网上常说 debian-slim 缺 tzdata、`TZ` 不生效。**实测不成立**：镜像自带 `tzdata 2026e-0+deb12u1`，`TZ=Asia/Shanghai` 生效（`GMT+0800`）；不设 `TZ` 就是 UTC。

`TZ` 有真实行为后果：日志文件名和心跳小时都按本地时间算。实测本地 16:58 首启时（`heartbeatHour: 9`）立刻触发了一次心跳推送——**首次部署可能马上收到一条消息，这是正常的**。

（换 `node:22-alpine` 也不掉时区——Node 自带 ICU 时区数据；但镜像里没有 `/usr/share/zoneinfo`，容器内 `date` 仍显示 UTC。**别为省 40 MB 换 alpine**，排查成本更高。）

### 5.4 别只挂单个文件（源码 + 已知）

`src/admin.js` 保存配置用「写临时文件 → `rename`」的原子写。把 `.env` / `config.json` 单独 bind mount 成**文件**时，`rename` 会 `EBUSY`，面板保存直接失败。compose 挂的是整个目录（`./:/app`），没这问题。**不要"优化"成挂单文件。**

### 5.5 Cookie 从家宽换到机房 IP（已知）

机房 IP 高频请求可能触发微博风控，表现为日志里 `Cookie 失效` 或返回 HTML 登录页。不是配置错误，重新导出 Cookie 填进 `.env` 后重启即可。

### 5.6 日志只增不减（源码）

程序按天写 `logs/app-YYYY-MM-DD.log` 但**从不删除**。compose 只限制了 Docker 自己的 json 日志（5 MB × 3）。

```bash
# 简单粗暴
find /opt/WeiBoListener/logs -name 'app-*.log' -mtime +30 -delete
```

systemd 路线的 logrotate 配置见 [deploy/README.md](../deploy/README.md)。

### 5.7 面板的「监听进程」状态在容器里不可信（实测）

`data/.lock` 里写的是 `process.pid`，也就是 listener **自己 PID 命名空间**里的号（实测是 7）；
面板在宿主命名空间里查同一个号，查的是别的进程。所以「诊断」页显示的「监听未运行 / 运行中」都不作数。

**判断监听是否在跑，用 `docker compose ps`**，不要用面板。

> 试过给 listener 也加 `pid: host` 让两边对齐，结果更糟：容器被 `kill -9` 后留下的残留锁里是宿主 PID，
> 很容易和宿主上活着的进程撞号（实测撞上内核线程 PID 7 → `kill(7,0)` 返回 `EPERM` →
> 程序认为「已有实例在运行」→ 拒绝启动 → 重启循环）。所以 `docker-compose.yml` 里**只有 admin 带** `pid: host`。
> 真撞上了就 `rm data/.lock` 再 `docker compose restart listener`。

### 5.8 别被 `--status` 误导（源码）

`node src/cli.js --status` 在 Linux 上最后一行永远是「开机自启：未安装」——它在查 Windows 的 schtasks（`src/admin.js:219` 对非 win32 直接返回 `supported: false`）。不代表任何东西坏了。

### 5.9 不要暴露端口

监听只出站。compose 里没有 `ports` 是**故意的**；面板走 SSH 隧道，别绑到 `0.0.0.0`。

### 5.10 `.env` 权限

`chmod 600 .env`。里面有微博 Cookie 和 WxPusher AppToken，拿到就能以你的身份操作。

---

## 6. 升级

```bash
cd /opt/WeiBoListener
git pull                          # 做法 B 部署的改用 tar/scp 同步
docker compose restart listener   # 只改了 JS：重启即可，不重建镜像
```

改了 `docker-compose.yml` 本身才需要 `docker compose up -d`（重建容器）。`data/` 和 `logs/` 在挂载目录里，升级不丢已见记录。

---

## 附：事实来源与未验证项

**实测**（本机 Docker 29.5.3 / Compose v5.1.4，`node:22-bookworm-slim` sha256:4b150b48…）：

- `docker compose config` 解析通过（把 `DOCKER_HOST` 指向死端口仍通过 → 不依赖 daemon）
- `TZ=Asia/Shanghai` 生效、镜像自带 tzdata；alpine 变体的差异
- 沙箱容器跑通：`restarts=0`，`data/.lock`、`state.json`、`logs/app-*.log` 正常落盘，容器内 `id` 为 `uid=1000(node)`
- 缺 `config.json` → `Restarting (1)`，20 秒重启 8 次
- 缺 WxPusher → 打完「微博监听启动」后 exit 1
- `docker stop` → 瞬时 `Exited (0)`、日志有「收到 SIGTERM，准备退出」、`data/.lock` 已删除
- UID 不可写 → `EACCES: permission denied, open '/app/data/.lock'` → exit 1
- `pid: host` 缺失时锁里是容器内 PID（7），宿主 PID 是 2497 → 面板判断会错
- 给 listener 加 `pid: host` 后，残留锁的 PID 撞上宿主内核线程 → `已有实例在运行（PID 7）` → 拒绝启动（因此没有采用这个方案）

**源码**：`src/index.js`、`src/config.js`、`src/admin.js`、`src/alerts.js`、`src/lock.js`、`src/logger.js`。

**未验证（需要在真 Debian 上确认）**：

- 面板从**宿主机** `127.0.0.1:8787` 可达（Docker Desktop 的 host 网络是 Linux VM，本机 `curl` 连不上，无法验证）
- 服务器重启后 Docker 服务自动拉起容器
- systemd 的 `systemd-analyze verify` 与真起服务（本机是 Windows，没有 systemd；安装脚本的 root 分支只做了静态审查与 `bash -n`）

**单元测试**：`npm test` 223 项全过。

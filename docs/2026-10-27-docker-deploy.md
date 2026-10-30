# Docker 部署（已并入 docs/debian-deploy.md）

这份 2026-10-27 的草稿已经被 [debian-deploy.md](debian-deploy.md) 取代。原稿里有几条是**没实测过就写下的**，
实测后确认不成立，记在这里以免有人照着旧说法排查：

| 旧说法 | 实测结论 |
|---|---|
| 「日志里看到『微博监听启动（Node vXX，linux）』就算成功」 | ❌ 这行在**致命错误之前**就会打印。缺 WxPusher、`data/` 不可写时都是先打「启动成功」再报错 exit 1。判据应改为 `docker compose ps` 的 STATUS 为 `Up` 且 `RestartCount` 不涨 |
| 「否则 `data/`、`logs/` 会被 root 占用」 | ❌ 不是"被占用"这种温和后果：容器以 1000 写不进非 1000 属主的目录 → `EACCES: permission denied, open '/app/data/.lock'` → exit 1 → 配合 `restart` 变成无限重启 |
| 「`pid: host` 是为了让面板能通过 `data/.lock` 里的 PID 判断监听在不在跑（跨 PID 命名空间会假阴性）」 | ❌ 方向反了。锁里是**监听容器**命名空间的 PID（实测 7，宿主 2497），面板读不到。而给 listener 也加 `pid: host` 会引入更糟的问题：残留锁里的 PID 会撞上宿主进程（实测撞上内核线程 PID 7 → EPERM → 程序认为「已有实例在运行」→ 拒绝启动）。结论：容器里面板的「监听进程」状态不可信，用 `docker compose ps` 判断 |
| 「面板直接落在宿主机的 127.0.0.1:8787」 | ⚠️ 只在真 Linux 宿主机成立；Docker Desktop 的 host 网络是 Linux VM，本机连不上（未验证） |
| 「TZ=Asia/Shanghai 必须设」 | ✅ 成立，且 debian slim 自带 tzdata，不用额外装 |

完整、逐条标注来源的部署步骤见 [debian-deploy.md](debian-deploy.md)。

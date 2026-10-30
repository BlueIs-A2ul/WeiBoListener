#!/usr/bin/env bash
#
# 微博待审评论监听 —— systemd 原生安装脚本（Debian / Ubuntu / 任何 systemd 发行版）
#
# 做四件事：
#   1. 把 deploy/weibo-listener.service 里的 @PROJECT_ROOT@ / @NODE_BIN@ /
#      @RUN_USER@ / @RUN_GROUP@ 换成本机实际值，写到 /etc/systemd/system/；
#   2. systemctl daemon-reload && enable；
#   3. 让服务处于「正在运行」状态（已在运行且单元内容没变就不重启）；
#   4. 起来 3 秒后回查一次，没在跑就把 journald 里的日志尾巴打出来。
#
# 重复执行是安全的：单元没变、服务在跑，就只做 daemon-reload，不重启进程
# （重启会打断 data/.lock 的清理，也会让首轮重新走一遍启动消息，没必要）。
#
# 用法：
#   sudo deploy/install-systemd.sh                              # 用当前用户（sudo 时取 $SUDO_USER）跑服务
#   sudo deploy/install-systemd.sh --user weibo                 # 换成一个已存在的用户
#   sudo deploy/install-systemd.sh --user weibo --create-user   # 不存在就创建系统用户
#   sudo deploy/install-systemd.sh --root /srv/WeiBoListener    # 项目不在脚本上一级
#   sudo deploy/install-systemd.sh --node /usr/local/bin/node   # 指定 node 绝对路径
#   deploy/install-systemd.sh --dry-run                         # 只打印渲染后的 unit，不碰系统、不需要 root
#
# 只写 /etc/systemd/system/weibo-listener.service，以及 data/、logs/ 的归属；
# 不改 src/，也不改 .env / config.json 的内容。

set -euo pipefail

UNIT_NAME="weibo-listener"
UNIT_SRC_REL="deploy/weibo-listener.service"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

DRY_RUN=0
FORCE=0
CREATE_USER=0
ROOT_ARG=""
USER_ARG=""
NODE_ARG=""

log() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf '警告：%s\n' "$*" >&2; }
die() { printf '\n错误：%s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
用法：install-systemd.sh [选项]

  --root DIR        项目根目录（默认：本脚本的上一级目录）
  --user NAME       跑服务用的用户（默认：sudo 时的 $SUDO_USER，否则当前用户）
  --create-user     --user 指定的用户不存在时创建它（system 用户，nologin shell）
  --node PATH       指定 node 可执行文件（默认：PATH 里的 node，解析成绝对路径）
  --dry-run         只打印渲染后的 unit 和计划执行的命令，不写文件、不需要 root
  --force           .env 关键项（WEIBO_COOKIE / WxPusher）缺失时仍然安装
  -h, --help        显示这段帮助

示例：
  sudo deploy/install-systemd.sh
  sudo deploy/install-systemd.sh --user weibo --create-user
  deploy/install-systemd.sh --dry-run | less
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --root)        [ $# -ge 2 ] || die "--root 后面要跟目录"; ROOT_ARG="$2"; shift 2 ;;
    --root=*)      ROOT_ARG="${1#*=}"; shift ;;
    --user)        [ $# -ge 2 ] || die "--user 后面要跟用户名"; USER_ARG="$2"; shift 2 ;;
    --user=*)      USER_ARG="${1#*=}"; shift ;;
    --node)        [ $# -ge 2 ] || die "--node 后面要跟可执行文件路径"; NODE_ARG="$2"; shift 2 ;;
    --node=*)      NODE_ARG="${1#*=}"; shift ;;
    --create-user) CREATE_USER=1; shift ;;
    --dry-run)     DRY_RUN=1; shift ;;
    --force)       FORCE=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             die "未知参数：$1（用 --help 看用法）" ;;
  esac
done

# ---------------------------------------------------------------- 0. 前置检查

if [ "$DRY_RUN" -eq 0 ]; then
  # 用 bash 内建的 EUID，不依赖 coreutils 的 id（某些精简环境里没有 id）
  [ "$EUID" -eq 0 ] || die "需要 root：请用 sudo 运行（要写 /etc/systemd/system/ 并调用 systemctl）"

  command -v systemctl >/dev/null 2>&1 || die "找不到 systemctl，这不是 systemd 系统。容器里请改用仓库自带的 docker-compose.yml"

  # systemctl 存在不等于 systemd 是 1 号进程：Debian 容器里装了 systemd 也常常没有 /run/systemd/system
  if [ ! -d /run/systemd/system ]; then
    die "当前系统没有以 systemd 作为 init（/run/systemd/system 不存在）。容器/CI 里请用 docker-compose.yml"
  fi
fi

# ---------------------------------------------------------------- 1. 定位项目根

if [ -n "$ROOT_ARG" ]; then
  [ -d "$ROOT_ARG" ] || die "--root 指向的目录不存在：$ROOT_ARG"
  PROJECT_ROOT="$(cd -- "$ROOT_ARG" && pwd -P)"
else
  PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
fi

[ "$PROJECT_ROOT" != "/" ] || die "项目根不能是 /：请用 --root 指定项目所在目录"
[ -f "$PROJECT_ROOT/$UNIT_SRC_REL" ] || die "找不到单元模板：$PROJECT_ROOT/$UNIT_SRC_REL"
[ -f "$PROJECT_ROOT/src/index.js" ] || die "找不到入口 $PROJECT_ROOT/src/index.js，--root 可能指错了？"

case "$PROJECT_ROOT" in
  *$'\n'*|*$'\r'*) die "项目路径里不能有换行" ;;
  # 下面几处要拿路径拼 bash -c 的命令，单引号会破坏引号包裹，直接拒绝（现实里不会遇到）
  *"'"*) die "项目路径里不能有单引号：$PROJECT_ROOT" ;;
esac

log "项目根：$PROJECT_ROOT"

# ---------------------------------------------------------------- 2. 探测 node

if [ -n "$NODE_ARG" ]; then
  NODE_BIN="$NODE_ARG"
  [ -x "$NODE_BIN" ] || die "--node 指向的文件不可执行：$NODE_BIN"
else
  NODE_BIN="$(command -v node || true)"
  [ -n "$NODE_BIN" ] || die "PATH 里找不到 node。先装 Node.js >= 20.12（推荐 NodeSource 的 deb 包），或用 --node 指定绝对路径"
fi

# 解析成真实路径：systemd 不读 shell 配置，给它解析后的绝对路径最稳
NODE_BIN="$(readlink -f -- "$NODE_BIN" 2>/dev/null || printf '%s' "$NODE_BIN")"

NODE_VERSION="$("$NODE_BIN" -p 'process.versions.node' 2>/dev/null)" ||
  die "执行 $NODE_BIN 失败，请确认它是一个可用的 node"
# package.json 的 engines 要求 >= 20.12，低版本行为不一致
if ! "$NODE_BIN" -e 'const [maj, min] = process.versions.node.split(".").map(Number); process.exit(maj > 20 || (maj === 20 && min >= 12) ? 0 : 1)' 2>/dev/null; then
  die "node 版本是 $NODE_VERSION，但 package.json 要求 >= 20.12"
fi
log "node：$NODE_BIN（v$NODE_VERSION）"

# ---------------------------------------------------------------- 3. 选运行用户

# 正常系统上 coreutils 的 id 一定存在；这两个兜底只为了让 --dry-run
# 在没有 id 的环境（比如 Windows 上的 MSYS2）里也能把 unit 渲染出来看看。
have_id=0
command -v id >/dev/null 2>&1 && have_id=1

current_user() {
  if [ "$have_id" -eq 1 ]; then
    id -un
  elif [ -n "${USER:-}" ]; then
    printf '%s' "$USER"
  elif [ -n "${LOGNAME:-}" ]; then
    printf '%s' "$LOGNAME"
  else
    printf 'unknown'
  fi
}

if [ -n "$USER_ARG" ]; then
  RUN_USER="$USER_ARG"
elif [ "$have_id" -eq 1 ] && [ "$(id -u)" -eq 0 ]; then
  # sudo 下 id -un 是 root，真正想用的是调用者
  RUN_USER="${SUDO_USER:-root}"
else
  RUN_USER="$(current_user)"
fi

# 用户名会原样写进 unit，只放行 Debian 认的字符集（顺便挡住注入）
valid_name() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$' &&
    ! printf '%s' "$1" | grep -Eq '^[0-9]+$'
}
if ! valid_name "$RUN_USER"; then
  die "用户名不合法：$RUN_USER（只允许字母、数字、下划线、点、短横线，且不能是纯数字）"
fi

if [ "$have_id" -eq 1 ] && ! id -u "$RUN_USER" >/dev/null 2>&1; then
  if [ "$CREATE_USER" -eq 1 ]; then
    command -v useradd >/dev/null 2>&1 || die "找不到 useradd，无法 --create-user"
    log "创建系统用户 $RUN_USER（nologin shell，home 指向项目根）"
    useradd --system --home-dir "$PROJECT_ROOT" --no-create-home \
            --shell "$(command -v nologin || echo /usr/sbin/nologin)" \
            --user-group "$RUN_USER" || die "创建用户 $RUN_USER 失败"
  else
    die "用户 $RUN_USER 不存在。加 --create-user 让脚本创建，或先手动：
  useradd --system --home-dir '$PROJECT_ROOT' --shell /usr/sbin/nologin --user-group $RUN_USER"
  fi
elif [ "$have_id" -eq 0 ]; then
  warn "找不到 id 命令，无法确认用户 $RUN_USER 是否存在（--dry-run 下继续）"
fi

if [ "$have_id" -eq 1 ]; then
  RUN_GROUP="$(id -gn "$RUN_USER")"
else
  RUN_GROUP="$RUN_USER"
fi
if ! valid_name "$RUN_GROUP"; then
  die "用户 $RUN_USER 的主组名不合法：$RUN_GROUP"
fi
log "运行用户：$RUN_USER:$RUN_GROUP"
if [ "$RUN_USER" = "root" ]; then
  warn "服务会以 root 运行。程序只做 HTTP 轮询、只写 data/ 和 logs/，专用用户更稳："
  warn "  sudo deploy/install-systemd.sh --user weibo --create-user"
fi

# ---------------------------------------------------------------- 4. 配置文件检查

step "检查配置文件"

[ -f "$PROJECT_ROOT/.env" ] || die "缺少 $PROJECT_ROOT/.env。先复制模板再填：
  cp '$PROJECT_ROOT/.env.example' '$PROJECT_ROOT/.env'
  然后填入 WEIBO_COOKIE、WXPUSHER_APP_TOKEN、WXPUSHER_UIDS"

[ -f "$PROJECT_ROOT/config.json" ] || die "缺少 $PROJECT_ROOT/config.json。先复制模板：
  cp '$PROJECT_ROOT/config.example.json' '$PROJECT_ROOT/config.json'
  （或先用配置面板生成一份）"

# 只取值，不 source：.env 里的 Cookie 含空格和分号，source 会把值当命令执行
env_value() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$PROJECT_ROOT/.env" |
    tail -n 1 |
    sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

ENV_COOKIE="$(env_value WEIBO_COOKIE)"
ENV_TOKEN="$(env_value WXPUSHER_APP_TOKEN)"
ENV_UIDS="$(env_value WXPUSHER_UIDS)"

# 用 node 校验 config.json：不是合法 JSON、或一条微博/站点都没有，程序启动会直接退出
if ! CONFIG_SUMMARY="$(CONFIG_PATH="$PROJECT_ROOT/config.json" "$NODE_BIN" --input-type=module -e '
  import fs from "node:fs";
  const file = process.env.CONFIG_PATH;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error("无法解析：" + err.message);
    process.exit(1);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    console.error("顶层必须是对象");
    process.exit(1);
  }
  const posts = Array.isArray(raw.posts) ? raw.posts : [];
  const sites = Array.isArray(raw.sites) ? raw.sites : [];
  const on = (list) => list.filter((item) => item && item.enabled !== false).length;
  console.log(JSON.stringify({
    posts: posts.length,
    enabledPosts: on(posts),
    sites: sites.length,
    enabledSites: on(sites),
    logDir: typeof raw.logDir === "string" && raw.logDir.trim() !== "" ? raw.logDir.trim() : "logs"
  }));
' 2>&1)"; then
  die "config.json 有问题（程序启动会直接失败退出）：
  $CONFIG_SUMMARY"
fi

enabled_posts="$(printf '%s' "$CONFIG_SUMMARY" | sed -n 's/.*"enabledPosts":\([0-9]*\).*/\1/p')"
enabled_sites="$(printf '%s' "$CONFIG_SUMMARY" | sed -n 's/.*"enabledSites":\([0-9]*\).*/\1/p')"
LOG_DIR_REL="$(printf '%s' "$CONFIG_SUMMARY" | sed -n 's/.*"logDir":"\([^"]*\)".*/\1/p')"
[ -n "$enabled_posts" ] || enabled_posts=0
[ -n "$enabled_sites" ] || enabled_sites=0
[ -n "$LOG_DIR_REL" ] || LOG_DIR_REL="logs"

if [ "$enabled_posts" -eq 0 ] && [ "$enabled_sites" -eq 0 ]; then
  die "config.json 里没有启用中的微博（posts）或站点（sites），程序会以「至少要配置一条微博或一个站点」退出"
fi
log "config.json：$enabled_posts 条启用的微博、$enabled_sites 个启用的站点"

# 下面两种缺项会让程序一启动就 exit 1，进而撞上 unit 里的 StartLimit*。
# 与其让用户装上服务后看到一个 failed，不如现在就拦住。
if [ -z "$ENV_TOKEN" ] || [ -z "$ENV_UIDS" ]; then
  msg=".env 里 WXPUSHER_APP_TOKEN / WXPUSHER_UIDS 没填全：没有推送通道，程序启动会立刻 exit 1，监听根本跑不起来"
  if [ "$FORCE" -eq 1 ]; then warn "$msg（--force，继续安装）"; else die "$msg
  填好再装；确实要先把服务装上，加 --force"; fi
fi

if [ "$enabled_posts" -gt 0 ] && [ -z "$ENV_COOKIE" ]; then
  msg=".env 里 WEIBO_COOKIE 是空的，而 config.json 有 $enabled_posts 条启用的微博：程序启动会直接 exit 1"
  if [ "$FORCE" -eq 1 ]; then warn "$msg（--force，继续安装）"; else die "$msg
  只监听通用站点的话，把 posts 各项的 enabled 改成 false；否则填好 Cookie 再来"; fi
fi

# 已经有实例在跑（比如手工 node src/index.js 没关）时，服务会因「已有实例在运行」退出
if [ -f "$PROJECT_ROOT/data/.lock" ]; then
  LOCK_PID="$(tr -dc '0-9' < "$PROJECT_ROOT/data/.lock" 2>/dev/null || true)"
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    UNIT_MAIN_PID=""
    if [ "$DRY_RUN" -eq 0 ]; then
      UNIT_MAIN_PID="$(systemctl show -p MainPID --value "$UNIT_NAME" 2>/dev/null || true)"
    fi
    if [ "$LOCK_PID" != "${UNIT_MAIN_PID:-0}" ]; then
      warn "data/.lock 里是 PID $LOCK_PID，而且这个进程还活着：多半是你手工启动的实例没关。"
      warn "服务启动时会因为「已有实例在运行」而退出。先结束它：kill $LOCK_PID"
    fi
  fi
fi

# ---------------------------------------------------------------- 5. 目录与权限

step "准备 $RUN_USER 需要的写权限"

DATA_DIR="$PROJECT_ROOT/data"
case "$LOG_DIR_REL" in
  /*) LOG_DIR="$LOG_DIR_REL" ;;
  *)  LOG_DIR="$PROJECT_ROOT/$LOG_DIR_REL" ;;
esac

if [ "$DRY_RUN" -eq 1 ]; then
  log "（--dry-run）将创建：$DATA_DIR、$LOG_DIR"
else
  mkdir -p "$DATA_DIR" "$LOG_DIR"
fi

# 以运行用户的身份验证，而不是以 root（root 永远写得进去，测了等于没测）
run_as_user() {
  local cmd="$1"
  if [ "$RUN_USER" = "$(current_user)" ]; then
    bash -c "$cmd"
  elif command -v runuser >/dev/null 2>&1; then
    runuser -u "$RUN_USER" -- bash -c "$cmd"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -u "$RUN_USER" -- bash -c "$cmd"
  else
    return 2   # 既不是当前用户、又没有 runuser/sudo：无法验证
  fi
}

if [ "$DRY_RUN" -eq 0 ] && [ "$RUN_USER" != "$(current_user)" ]; then
  # 只改这两个目录和必需的配置文件，不碰整个仓库（尤其 src/）
  chown -R "$RUN_USER:$RUN_GROUP" "$DATA_DIR" "$LOG_DIR"
  # .env / config.json 交给运行用户：服务本身只读它们，但配置面板（建议也用同一个用户跑）
  # 要能原地改，否则面板保存会失败。.env 里是 Cookie，顺手收到 0640。
  for f in "$PROJECT_ROOT/.env" "$PROJECT_ROOT/config.json"; do
    [ -f "$f" ] || continue
    if [ "$RUN_USER" != "root" ]; then
      chown "$RUN_USER:$RUN_GROUP" "$f"
    fi
  done
  chmod 0640 "$PROJECT_ROOT/.env" 2>/dev/null || true
  log "已把 data/、logs/、.env、config.json 的属主交给 $RUN_USER（面板要用同一用户跑）"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "（--dry-run）跳过以 $RUN_USER 身份的可写性验证"
else
  for dir in "$DATA_DIR" "$LOG_DIR"; do
    rc=0
    run_as_user "test -w '$dir'" || rc=$?
    if [ "$rc" -eq 2 ]; then
      warn "没有 runuser/sudo，无法以 $RUN_USER 身份验证 $dir 是否可写，请自行确认"
    elif [ "$rc" -ne 0 ]; then
      die "$RUN_USER 无法写 $dir。修好再来：chown -R $RUN_USER:$RUN_GROUP '$dir'"
    fi
  done
  log "可写：$DATA_DIR、$LOG_DIR"
fi

# ---------------------------------------------------------------- 6. 渲染 unit

step "渲染单元文件"

unit_escape() {
  # systemd 的 "..." 字符串里要转义反斜杠和双引号；% 是指定符前缀，要写成 %%
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//%/%%}"
  printf '%s' "$s"
}

ROOT_ESC="$(unit_escape "$PROJECT_ROOT")"
NODE_ESC="$(unit_escape "$NODE_BIN")"

template="$(cat "$PROJECT_ROOT/$UNIT_SRC_REL")"
rendered="${template//@PROJECT_ROOT@/"$ROOT_ESC"}"
rendered="${rendered//@NODE_BIN@/"$NODE_ESC"}"
rendered="${rendered//@RUN_USER@/"$RUN_USER"}"
rendered="${rendered//@RUN_GROUP@/"$RUN_GROUP"}"

leftover="$(printf '%s' "$rendered" | grep -o '@[A-Z_]*@' | head -n 3 | tr '\n' ' ' || true)"
[ -z "$leftover" ] || die "渲染后仍残留占位符：$leftover"

UNIT_PATH="/etc/systemd/system/$UNIT_NAME.service"

if [ "$DRY_RUN" -eq 1 ]; then
  log "----- $UNIT_PATH -----"
  printf '%s\n' "$rendered"
  log "----- 真正安装时会执行 -----"
  log "install -m 0644 <上面的内容> $UNIT_PATH"
  log "systemctl daemon-reload"
  log "systemctl enable $UNIT_NAME"
  log "systemctl reset-failed $UNIT_NAME   # 清掉上次撞到 StartLimit 的记录（有的话）"
  log "systemctl restart $UNIT_NAME"
  log "sleep 3 && systemctl is-active $UNIT_NAME"
  log ""
  log "（--dry-run：没有写入任何文件）"
  exit 0
fi

changed=1
if [ -f "$UNIT_PATH" ]; then
  TMP_EXISTING="$(mktemp)"
  printf '%s\n' "$rendered" > "$TMP_EXISTING"
  cmp -s "$TMP_EXISTING" "$UNIT_PATH" && changed=0 || true
  rm -f "$TMP_EXISTING"
fi

was_active=0
if systemctl is-active --quiet "$UNIT_NAME"; then
  was_active=1
fi

TMP_UNIT="$(mktemp)"
printf '%s\n' "$rendered" > "$TMP_UNIT"
install -m 0644 "$TMP_UNIT" "$UNIT_PATH"
rm -f "$TMP_UNIT"
if [ "$changed" -eq 1 ]; then
  log "已写入 $UNIT_PATH（内容有更新）"
else
  log "已写入 $UNIT_PATH（内容和原来一致）"
fi

# ---------------------------------------------------------------- 7. 启用并按需重启

step "启用并启动"

systemctl daemon-reload

if ! enable_out="$(systemctl enable "$UNIT_NAME" 2>&1)"; then
  die "systemctl enable 失败：
$enable_out"
fi

# 上次安装若撞到 StartLimit，单元会停在 failed，restart 会被直接拒绝；先清掉计数
systemctl reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true

if [ "$was_active" -eq 1 ] && [ "$changed" -eq 0 ]; then
  log "服务本来就在运行，单元内容也没变：不重启（要强制重启：systemctl restart $UNIT_NAME）"
else
  if ! start_out="$(systemctl restart "$UNIT_NAME" 2>&1)"; then
    die "systemctl restart 失败：
$start_out"
  fi
  log "已启动 $UNIT_NAME"
fi

# ---------------------------------------------------------------- 8. 回查

step "回查"

sleep 3
if systemctl is-active --quiet "$UNIT_NAME"; then
  log "✓ $UNIT_NAME 正在运行"
  log ""
  log "最近日志："
  journalctl -u "$UNIT_NAME" -n 8 --no-pager -o cat || true
else
  warn "$UNIT_NAME 没有保持运行。最近的日志："
  journalctl -u "$UNIT_NAME" -n 40 --no-pager || true
  die "服务装好了但没跑起来，按上面的日志修配置，然后：
  systemctl reset-failed $UNIT_NAME && systemctl restart $UNIT_NAME"
fi

cat <<EOF

常用命令（记下来）：
  systemctl status $UNIT_NAME                    # 状态、PID、最近日志
  journalctl -u $UNIT_NAME -f                    # 跟踪日志
  journalctl -u $UNIT_NAME --since today         # 今天的日志
  sudo systemctl restart $UNIT_NAME              # 改完 .env / config.json 后重启
  sudo systemctl stop $UNIT_NAME                 # 停止（走 SIGTERM，会清 data/.lock）
  tail -f $LOG_DIR/app-$(date +%F).log           # 程序自己写的日志

配置面板（只监听 127.0.0.1，先开 SSH 隧道：ssh -L 8787:127.0.0.1:8787 <user>@<server>）：
  sudo -u $RUN_USER $NODE_BIN $PROJECT_ROOT/src/admin.js --no-open --no-restart
  面板保存后不会自动重启监听（--no-restart），用上面的 systemctl restart。

自检（真实请求一轮、打印将要推送的内容，不写状态、不推送）：
  sudo -u $RUN_USER $NODE_BIN $PROJECT_ROOT/src/index.js --dry-run --once
EOF

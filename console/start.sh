#!/usr/bin/env bash
# AI 指挥台启动脚本 —— 固化重启规程：
#   1) stdin 必须接 /dev/null：服务若继承启动终端的 stdin，终端一退，codex 读 stdio 会秒退 66
#   2) nohup 挂起，日志进 console/server.log
#   3) 起完自检 /api/state，不是 200 就把日志尾巴打出来
# 用法：
#   bash console/start.sh            # 起服务（已有在跑则提示并退出）
#   bash console/start.sh --restart  # 先杀掉在跑的，再起
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"
PORT="${CONSOLE_PORT:-8787}"
BUN="${BUN_BIN:-/c/Users/scrrofied/.bun/bin/bun.exe}"
LOG="$DIR/server.log"

pid_listen() {
  netstat -ano 2>/dev/null | grep -E "TCP.*:$PORT .*LISTENING" | awk '{print $NF}' | sort -u | head -1
}

PID="$(pid_listen || true)"
if [ -n "${PID:-}" ]; then
  if [ "${1:-}" = "--restart" ]; then
    echo "停止旧服务 PID $PID ..."
    taskkill //F //T //PID "$PID" >/dev/null 2>&1 || true
    sleep 1
  else
    echo "已有服务在跑（PID $PID）→ http://127.0.0.1:$PORT  （要重启加 --restart）"
    exit 0
  fi
fi

cd "$ROOT" || exit 1
nohup "$BUN" run console/server.ts >> "$LOG" 2>&1 </dev/null &
NEWPID=$!
echo "已启动 PID $NEWPID，日志：console/server.log"
sleep 2
CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/state" || true)"
echo "自检 /api/state → HTTP $CODE"
if [ "$CODE" != "200" ]; then
  echo "没有起来，看 console/server.log 尾部："
  tail -n 20 "$LOG"
  exit 1
fi

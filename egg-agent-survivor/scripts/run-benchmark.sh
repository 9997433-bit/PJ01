#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-4173}"

show_help() {
  cat <<'EOF'
用法：
  ./scripts/run-benchmark.sh

环境变量：
  HOST=0.0.0.0  允许同一网络或容器外访问（默认 127.0.0.1）
  PORT=8080     修改静态服务器端口（默认 4173）

启动后打开：
  http://127.0.0.1:4173/tests/benchmark.html

可选 URL 参数：
  ?autorun=1        页面加载后自动依次测试 100/300/500 敌人
  &warmup=1500      每组预热毫秒数（250–10000）
  &duration=5000    每组采样毫秒数（1000–60000）

按 Ctrl+C 停止服务器。benchmark.html 也可直接用浏览器打开，但 HTTP
模式更接近游戏部署环境。
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  show_help
  exit 0
fi

if [[ "$#" -ne 0 ]]; then
  printf '未知参数：%s\n\n' "$1" >&2
  show_help >&2
  exit 2
fi

if ! command -v python3 >/dev/null 2>&1; then
  printf '错误：需要 Python 3 来启动零依赖静态服务器。\n' >&2
  printf '也可以直接在浏览器中打开：%s/tests/benchmark.html\n' "$ROOT_DIR" >&2
  exit 1
fi

display_host="$HOST"
if [[ "$HOST" == "0.0.0.0" || "$HOST" == "::" ]]; then
  display_host="127.0.0.1"
fi

printf 'Egg Agent Survivor benchmark\n'
printf '目录：%s\n' "$ROOT_DIR"
printf '打开：http://%s:%s/tests/benchmark.html\n' "$display_host" "$PORT"
printf '自动：http://%s:%s/tests/benchmark.html?autorun=1\n' "$display_host" "$PORT"
printf '停止：Ctrl+C\n\n'

exec python3 -m http.server "$PORT" --bind "$HOST" --directory "$ROOT_DIR"

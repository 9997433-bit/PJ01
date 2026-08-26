#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8080}"
URL="http://127.0.0.1:${PORT}"

echo ""
echo " ========================================"
echo "  Egg Agent Survivor - 弹壳特攻队风格"
echo " ========================================"
echo ""
echo "  启动地址: ${URL}"
echo "  按 Ctrl+C 停止"
echo ""

if command -v python3 >/dev/null 2>&1; then
  (sleep 1 && (command -v xdg-open >/dev/null && xdg-open "$URL" || open "$URL" 2>/dev/null || true)) &
  exec python3 -m http.server "$PORT" --bind 127.0.0.1
elif command -v python >/dev/null 2>&1; then
  (sleep 1 && (command -v xdg-open >/dev/null && xdg-open "$URL" || open "$URL" 2>/dev/null || true)) &
  exec python -m http.server "$PORT"
else
  echo "[错误] 需要 Python 3。也可直接用浏览器打开 index.html"
  exit 1
fi

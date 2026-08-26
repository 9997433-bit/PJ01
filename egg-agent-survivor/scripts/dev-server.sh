#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-3000}"

if [[ ! "$PORT" =~ ^[0-9]+$ ]] || ((PORT < 1 || PORT > 65535)); then
  echo "Error: PORT must be an integer between 1 and 65535." >&2
  exit 2
fi

if command -v python3 >/dev/null 2>&1; then
  PYTHON=python3
elif command -v python >/dev/null 2>&1; then
  PYTHON=python
else
  echo "Error: Python 3 is required to run the development server." >&2
  exit 127
fi

echo "Serving Egg Agent Survivor at http://${HOST}:${PORT}"
exec "$PYTHON" -m http.server "$PORT" --bind "$HOST" --directory "$PROJECT_ROOT"

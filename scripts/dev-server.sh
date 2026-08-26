#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-3000}"
OPEN_BROWSER="${OPEN_BROWSER:-1}"

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

DISPLAY_HOST="$HOST"
if [[ "$HOST" == "0.0.0.0" || "$HOST" == "::" ]]; then
  DISPLAY_HOST="127.0.0.1"
fi

URL_HOST="$DISPLAY_HOST"
if [[ "$URL_HOST" == *:* ]]; then
  URL_HOST="[$URL_HOST]"
fi
URL="http://${URL_HOST}:${PORT}"

open_browser() {
  case "${OPEN_BROWSER,,}" in
    0|false|no|off)
      return
      ;;
  esac

  # Give the local server enough time to bind before handing the URL to a browser.
  sleep 0.4

  if [[ -n "${BROWSER:-}" ]]; then
    local -a browser_command
    read -r -a browser_command <<< "$BROWSER"
    if (("${#browser_command[@]}" > 0)) \
      && "${browser_command[@]}" "$URL" >/dev/null 2>&1; then
      printf 'Opened %s\n' "$URL"
      return
    fi
  fi

  local opener
  for opener in xdg-open open wslview; do
    if command -v "$opener" >/dev/null 2>&1 \
      && "$opener" "$URL" >/dev/null 2>&1; then
      printf 'Opened %s\n' "$URL"
      return
    fi
  done

  if command -v powershell.exe >/dev/null 2>&1 \
    && powershell.exe -NoProfile -Command "Start-Process '$URL'" >/dev/null 2>&1; then
    printf 'Opened %s\n' "$URL"
    return
  fi

  printf 'Browser could not be opened automatically; visit %s\n' "$URL" >&2
}

echo "Serving Egg Agent Survivor at ${URL}"
echo "Set OPEN_BROWSER=0 to disable automatic browser opening."
open_browser &
exec "$PYTHON" -m http.server "$PORT" --bind "$HOST" --directory "$PROJECT_ROOT"

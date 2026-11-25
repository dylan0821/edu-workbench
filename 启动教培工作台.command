#!/bin/zsh
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
PORT="${PORT:-3000}"

if ! lsof -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  node src/server.js &
  SERVER_PID=$!
  sleep 1
  open "http://localhost:$PORT"
  wait "$SERVER_PID"
else
  open "http://localhost:$PORT"
fi

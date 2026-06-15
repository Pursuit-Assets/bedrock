#!/bin/bash
# Start both backend and frontend, survive terminal/session closes.
# Run this from your own terminal (not via Claude Code) so processes persist.
# Usage: ./dev.sh [stop]

BACKEND_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$BACKEND_DIR/frontend-v2"
BACKEND_LOG="/tmp/bedrock-backend.log"
FRONTEND_LOG="/tmp/bedrock-frontend.log"
BACKEND_PID_FILE="/tmp/bedrock-backend.pid"
FRONTEND_PID_FILE="/tmp/bedrock-frontend.pid"

stop() {
  if [ -f "$BACKEND_PID_FILE" ]; then
    kill "$(cat "$BACKEND_PID_FILE")" 2>/dev/null && echo "Backend stopped"
    rm "$BACKEND_PID_FILE"
  fi
  if [ -f "$FRONTEND_PID_FILE" ]; then
    kill "$(cat "$FRONTEND_PID_FILE")" 2>/dev/null && echo "Frontend stopped"
    rm "$FRONTEND_PID_FILE"
  fi
}

if [ "$1" = "stop" ]; then
  stop
  exit 0
fi

# Stop any existing instances
stop

echo "Starting backend on :8000 ..."
cd "$BACKEND_DIR"
nohup python3 main.py > "$BACKEND_LOG" 2>&1 &
echo $! > "$BACKEND_PID_FILE"

echo "Starting frontend on :4200 ..."
cd "$FRONTEND_DIR"
nohup npm run dev -- --host 0.0.0.0 --port 4200 > "$FRONTEND_LOG" 2>&1 &
echo $! > "$FRONTEND_PID_FILE"

echo ""
echo "Backend:  http://localhost:8000  (logs: tail -f $BACKEND_LOG)"
echo "Frontend: http://localhost:4200  (logs: tail -f $FRONTEND_LOG)"
echo ""
echo "Stop with: ./dev.sh stop"

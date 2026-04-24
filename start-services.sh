#!/bin/bash
# start-services.sh - Script to start both Node.js and Python services

PYTHON_PID=""

# Default: off. Only start Python RAG when explicitly enabled.
# Upstream hatte hier ein hardcoded `export RAG_SERVICE_ENABLED="true"`, was die
# .env des Users überschrieben hat — entfernt.
RAG_ENABLED="${RAG_SERVICE_ENABLED:-false}"

if [ "$RAG_ENABLED" = "true" ] || [ "$RAG_ENABLED" = "yes" ] || [ "$RAG_ENABLED" = "1" ]; then
  echo "[startup] RAG_SERVICE_ENABLED=$RAG_ENABLED — starting Python RAG service..."
  source /app/venv/bin/activate
  python main.py --host 127.0.0.1 --port 8000 --initialize &
  PYTHON_PID=$!
  sleep 2
  echo "[startup] Python RAG service started with PID: $PYTHON_PID"
  export RAG_SERVICE_URL="${RAG_SERVICE_URL:-http://localhost:8000}"
  export RAG_SERVICE_ENABLED="true"
else
  echo "[startup] RAG_SERVICE_ENABLED is not true (got: '$RAG_ENABLED') — skipping Python RAG service."
  echo "[startup] No HuggingFace model downloads, lower RAM usage."
  export RAG_SERVICE_ENABLED="false"
fi

# Start the Node.js application
echo "[startup] Starting Node.js Paperless-AI service..."
pm2-runtime ecosystem.config.js

# Cleanup Python when Node.js exits
if [ -n "$PYTHON_PID" ]; then
  kill "$PYTHON_PID" 2>/dev/null || true
fi

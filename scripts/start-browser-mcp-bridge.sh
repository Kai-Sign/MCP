#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-${MCP_PORT:-3333}}"
HOST="${HOST:-${MCP_HOST:-0.0.0.0}}"
SERVER_STARTED=0
TUNNEL_PID=""

cleanup() {
  if [[ -n "${TUNNEL_PID:-}" ]]; then kill "$TUNNEL_PID" 2>/dev/null || true; fi
  if [[ "${SERVER_STARTED}" == "1" && -n "${SERVER_PID:-}" ]]; then kill "$SERVER_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

print_config() {
  local url="$1"
  echo "KaiSign MCP local:  http://127.0.0.1:${PORT}/mcp"
  echo "KaiSign MCP public: ${url}/mcp"
  echo
  echo "Frontend LLM / Bankrbot MCP config:"
  echo "Name: KaiSignMCP"
  echo "URL: ${url}/mcp"
  echo "Transport: Streamable HTTP"
  echo "Headers: none"
  echo
  echo "Also supports SSE (legacy) at the same URL."
  if [[ "${SERVER_STARTED}" == "1" ]]; then
    echo "Press Ctrl-C to stop the tunnel + server."
  else
    echo "Press Ctrl-C to stop the tunnel."
  fi
}

# Reuse an already-running local MCP server if it is healthy.
if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "Reusing existing KaiSign MCP server on port ${PORT}."
else
  # If something else owns the port, fail with the exact process instead of throwing EADDRINUSE.
  if lsof -iTCP:"${PORT}" -sTCP:LISTEN -n -P >/tmp/kaisign-mcp-port-owner.txt 2>/dev/null; then
    echo "Port ${PORT} is already in use, but it is not a healthy KaiSign MCP server:" >&2
    cat /tmp/kaisign-mcp-port-owner.txt >&2
    echo >&2
    echo "Kill it or choose another port:" >&2
    echo "  lsof -tiTCP:${PORT} -sTCP:LISTEN | xargs kill" >&2
    echo "  PORT=3334 npm run mcp:bridge" >&2
    exit 1
  fi

  HOST="$HOST" MCP_PORT="$PORT" npm run start:http > /tmp/kaisign-mcp-http.log 2>&1 &
  SERVER_PID=$!
  SERVER_STARTED=1

  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done

  if ! curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "KaiSign MCP server did not become healthy. Logs:" >&2
    tail -50 /tmp/kaisign-mcp-http.log >&2 || true
    exit 1
  fi
fi

# Prefer ngrok only when it has an authtoken/config. Otherwise ngrok exits with ERR_NGROK_4018.
if command -v ngrok >/dev/null 2>&1 && { [[ -n "${NGROK_AUTHTOKEN:-}" ]] || [[ -f "$HOME/Library/Application Support/ngrok/ngrok.yml" ]] || [[ -f "$HOME/.config/ngrok/ngrok.yml" ]] || [[ -f "$HOME/.ngrok2/ngrok.yml" ]]; }; then
  ngrok http "${PORT}" --log=stdout > /tmp/kaisign-mcp-tunnel.log 2>&1 &
  TUNNEL_PID=$!

  URL=""
  for _ in $(seq 1 80); do
    URL=$(curl -fsS http://127.0.0.1:4040/api/tunnels 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(s); const t=(j.tunnels||[]).find(x=>x.proto==='https'); if(t) console.log(t.public_url)}catch(e){}})" || true)
    if [[ -n "$URL" ]]; then break; fi
    sleep 0.25
  done

  if [[ -z "$URL" ]]; then
    echo "ngrok started but public URL was not detected. Logs:" >&2
    tail -80 /tmp/kaisign-mcp-tunnel.log >&2 || true
    exit 1
  fi

  print_config "$URL"
  wait
  exit $?
fi

# No ngrok auth. Use localtunnel; no account/token required.
if ! command -v npx >/dev/null 2>&1; then
  echo "No ngrok authtoken/config found and npx is unavailable." >&2
  echo "Either run: ngrok config add-authtoken <token>" >&2
  echo "Or deploy on Railway." >&2
  exit 1
fi

npm exec --yes --package=localtunnel -- lt --port "${PORT}" > /tmp/kaisign-mcp-tunnel.log 2>&1 &
TUNNEL_PID=$!

URL=""
for _ in $(seq 1 120); do
  URL=$(grep -Eo 'https://[^ ]+\.loca\.lt' /tmp/kaisign-mcp-tunnel.log | tail -1 || true)
  if [[ -n "$URL" ]]; then break; fi
  sleep 0.25
done

if [[ -z "$URL" ]]; then
  echo "localtunnel did not produce a public URL. Logs:" >&2
  tail -80 /tmp/kaisign-mcp-tunnel.log >&2 || true
  exit 1
fi

print_config "$URL"
echo "Note: localtunnel may show a browser interstitial on first manual visit; MCP clients usually POST directly."
wait

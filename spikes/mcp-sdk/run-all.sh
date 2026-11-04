#!/bin/sh
# Throwaway. Runs every check on both runtimes and prints the record. Local only:
# `wrangler dev` runs workerd on this machine and deploys nothing.
# Usage: ./run-all.sh [path-to-node-binary-for-the-node-server]
NODE_BIN=${1:-node}
export WRANGLER_SEND_METRICS=false
LOG=$(mktemp -d)
"$NODE_BIN" node-server.mjs 8801 > "$LOG/node.log" 2>&1 &
NODE_PID=$!
npx wrangler dev --port 8802 --ip 127.0.0.1 > "$LOG/worker.log" 2>&1 &
WRANGLER_PID=$!
for i in $(seq 1 45); do grep -q "Ready on" "$LOG/worker.log" && break; sleep 1; done
sleep 1
echo "date: $(date -u +%Y-%m-%d)"
echo "node server runs on: $("$NODE_BIN" -v)"
echo "probe and clients run on: $(node -v)"
echo "packages: server $(node -p "require('./node_modules/@modelcontextprotocol/server/package.json').version"), client $(node -p "require('./node_modules/@modelcontextprotocol/client/package.json').version"), wrangler $(node -p "require('./node_modules/wrangler/package.json').version"), python mcp 2.3.0"
echo; echo "node server output at start:"; cat "$LOG/node.log"
for target in "node 8801" "workerd 8802"; do
  set -- $target
  echo; echo "=== $1: official TypeScript client"; node probe.mjs "http://127.0.0.1:$2/mcp" 2>&1
  echo; echo "=== $1: official Python client"
  uv run --no-project --python 3.11 --with 'mcp==2.3.0' python python_client.py "http://127.0.0.1:$2/mcp" 2>&1 | grep -E '^(protocol|tools|call|PASS|FAIL)|Error'
done
echo; echo "=== workerd: raw messages"; ./wire.sh http://127.0.0.1:8802/mcp 2>&1
echo; echo "=== node: cost of a server per request (in process, one laptop, rough)"; "$NODE_BIN" cost.mjs 2>&1
kill $NODE_PID $WRANGLER_PID 2>/dev/null
pkill -f "workerd.*8802" 2>/dev/null
rm -rf "$LOG"

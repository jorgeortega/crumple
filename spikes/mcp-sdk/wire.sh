#!/bin/sh
# Throwaway. Prints what really crosses the wire. Usage: ./wire.sh http://127.0.0.1:8801/mcp
URL=$1
ENV='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"curl","version":"0"}'
call() { # method name body
  curl -s -X POST "$URL" -H 'authorization: Bearer spike-reader' -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2026-07-28' \
    -H "mcp-method: $1" ${2:+-H "mcp-name: $2"} -d "$3"; echo; echo
}
echo '--- tools/list';  call tools/list '' "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{$ENV}}}"
echo '--- tools/call good'; call tools/call get_customer "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"get_customer\",\"arguments\":{\"id\":\"cus_1\"},$ENV,\"traceparent\":\"00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01\"}}}"
echo '--- tools/call bad argument'; call tools/call get_customer "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"get_customer\",\"arguments\":{\"id\":\"nope\"},$ENV}}}"
echo '--- tools/call hidden tool'; call tools/call delete_customer "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"delete_customer\",\"arguments\":{\"id\":\"cus_1\"},$ENV}}}"
echo '--- tools/call without the routing header'; curl -s -X POST "$URL" -H 'authorization: Bearer spike-reader' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2026-07-28' -d "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"get_customer\",\"arguments\":{\"id\":\"cus_1\"},$ENV}}}"; echo

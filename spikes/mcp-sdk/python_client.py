# Throwaway. The official Python SDK, a separate implementation, against one URL.
# Run: uv run --no-project --python 3.11 --with 'mcp==2.3.0' python python_client.py <url>
import asyncio
import sys

from mcp import Client
from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client


async def main(url: str) -> int:
    headers = {"authorization": "Bearer spike-reader"}
    async with create_mcp_http_client(headers=headers) as http:
        async with Client(streamable_http_client(url, http_client=http)) as client:
            tools = await client.list_tools()
            names = [t.name for t in tools.tools]
            result = await client.call_tool("get_customer", {"id": "cus_1"})
            text = result.content[0].text
            print(f"protocol: {client.protocol_version}")
            print(f"tools: {names}")
            print(f"call: {text}")
            good = client.protocol_version == "2026-07-28" and names == ["get_customer"] and '"cus_1"' in text
            print("PASS" if good else "FAIL")
            return 0 if good else 1


sys.exit(asyncio.run(main(sys.argv[1])))

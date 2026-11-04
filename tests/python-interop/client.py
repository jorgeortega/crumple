# The official Python SDK, a separate implementation of MCP, against a running Crumple. This is
# C14: passing our own tests with our own library would prove much less. It only reports what it
# saw, as JSON, and interop.run.ts decides whether that's right.
# Run by `npm run test:interop`, which pins the version.
import asyncio
import json
import sys

from mcp import Client
from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client


def text_of(result):
    return result.content[0].text


async def main(url: str, key: str) -> None:
    seen = {}
    async with create_mcp_http_client(headers={"authorization": f"Bearer {key}"}) as http:
        async with Client(streamable_http_client(url, http_client=http)) as client:
            seen["protocol"] = client.protocol_version

            tools = await client.list_tools()
            seen["tools"] = sorted(tool.name for tool in tools.tools)
            schema = next(tool for tool in tools.tools if tool.name == "getCustomer")
            seen["schema_required"] = schema.input_schema.get("required")

            good = await client.call_tool("getCustomer", {"id": "cus_1"})
            seen["good"] = {"is_error": bool(good.is_error), "text": text_of(good)}

            bad = await client.call_tool("getCustomer", {"id": "not-a-customer"})
            seen["bad_argument"] = {"is_error": bool(bad.is_error), "text": text_of(bad)}

            failed = await client.call_tool("createPayment", {"body": {"customerId": "cus_1", "amountCents": 5000}})
            seen["payment"] = {"is_error": bool(failed.is_error), "text": text_of(failed)}

            try:
                await client.call_tool("deleteCustomer", {"id": "cus_1"})
                seen["refused"] = {"raised": False}
            except Exception as error:
                seen["refused"] = {
                    "raised": True,
                    "type": type(error).__name__,
                    "code": getattr(getattr(error, "error", None), "code", getattr(error, "code", None)),
                    "message": str(error),
                }

    print(json.dumps(seen))


asyncio.run(main(sys.argv[1], sys.argv[2]))

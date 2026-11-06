# Directory and list drafts

The owner submits these after launch. Each directory's rules change, so read the current ones first. Latitude 10's guide, [Publishing your MCP server](https://latitude10.tech/publishing-your-mcp-server), covers most of them.

Crumple doesn't fit neatly: it's a runtime that serves other people's APIs, and the only server of its own is a demo on fake data. **List it as a tool or framework wherever that's an option,** and don't present the demo as a useful service.

## Descriptions

**One line:**

> A crumple zone for AI agents: serves your OpenAPI document as MCP tools with permissions, retries and traces, and checks its claims by breaking the API on purpose.

**Short:**

> Crumple sits between agents and your API. It turns an OpenAPI document into MCP tools, and holds the permissions, the API's credential, deadlines, retries and traces in one place that isn't the model. `npx crumple-mcp demo` breaks an API on purpose and counts what happened. `prove` checks an MCP server you own from outside. MIT licensed, no telemetry. Not production-proven.

**Keep "not production-proven" in anything longer than a line.**

## Where to submit

| Where | Note |
|---|---|
| Awesome lists for MCP | Look for a section on frameworks or tools, and follow the list's own format |
| Official MCP Registry | Only if it fits: it lists servers, and would mean publishing the demo with a `server.json` |
| Glama | Imports from the registry, so check there before submitting |
| Smithery | Takes a server's URL and scans the tools, so only the demo could be listed, marked as a demo |

## Not a fit

The Claude connectors directory and paid-endpoint directories are for real services people connect to. A fake-data demo doesn't belong there.

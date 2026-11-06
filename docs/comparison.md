# How Crumple compares

**If you need a gateway in production, use one of the projects below, not Crumple.** They've got features, teams and users that Crumple doesn't. Crumple is small, new and has never run in production. What it does have is a narrow focus on what happens when a call fails, and a way to check that yourself.

This page was written by Crumple's own author, so read it with that in mind.

## How this was checked

Every statement about another project links to where it was read, on 2026-11-06. **Those pages were read. The projects weren't run, and their code wasn't read.** Where a page doesn't mention something, this says so, and that doesn't mean the project lacks it. Projects like these change quickly, so follow the links. If something here is wrong or out of date, please [open an issue](https://github.com/jorgeortega/crumple/issues).

## At a glance

| | Crumple | agentgateway | LiteLLM | Kong AI MCP Proxy | FastMCP |
|---|---|---|---|---|---|
| **What it is** | One command in front of one API | [A proxy for agent, LLM and tool traffic](https://raw.githubusercontent.com/agentgateway/agentgateway/main/README.md) | [A proxy with an MCP gateway](https://docs.litellm.ai/docs/mcp) | [A plugin for Kong's gateway](https://developer.konghq.com/plugins/ai-mcp-proxy/) | [A Python framework for MCP servers](https://gofastmcp.com/integrations/openapi) |
| **OpenAPI to tools** | Yes | [Yes](https://agentgateway.dev/docs/standalone/latest/mcp/connect/openapi/) | [Yes](https://docs.litellm.ai/docs/mcp_openapi) | [Yes](https://developer.konghq.com/plugins/ai-mcp-proxy/) | [Yes](https://gofastmcp.com/integrations/openapi) |
| **Other MCP servers behind it** | No | [Yes](https://raw.githubusercontent.com/agentgateway/agentgateway/main/README.md) | [Yes](https://docs.litellm.ai/docs/mcp) | [Yes](https://developer.konghq.com/plugins/ai-mcp-proxy/) | Not covered on the page read |
| **Who may call what** | Keys or JWTs, per tool | [JWT, keys, OAuth, and RBAC with CEL](https://raw.githubusercontent.com/agentgateway/agentgateway/main/README.md) | [By key, team and organization](https://docs.litellm.ai/docs/mcp) | [Kong's auth plugins, and per-tool ACLs](https://developer.konghq.com/plugins/ai-mcp-proxy/) | Your own code |
| **License** | MIT, free | [Apache 2.0](https://raw.githubusercontent.com/agentgateway/agentgateway/main/README.md) | Not checked | [AI Gateway Enterprise only](https://developer.konghq.com/plugins/ai-mcp-proxy/) | Not checked |
| **Scale** | One process | [Standalone or on Kubernetes](https://raw.githubusercontent.com/agentgateway/agentgateway/main/README.md) | Not covered on the pages read | Kong's gateway | Your own deployment |

## When to use something else

**[agentgateway](https://raw.githubusercontent.com/agentgateway/agentgateway/main/README.md)** if you want one proxy for MCP, A2A and LLM traffic, with guardrails, on Kubernetes. It's a Linux Foundation project, with OpenTelemetry metrics, logs and tracing. Crumple does none of the A2A, LLM routing or guardrails, and doesn't run on Kubernetes.

**[LiteLLM](https://docs.litellm.ai/docs/mcp)** if you already use it for models and want MCP tools under one endpoint, with access by key, team and organization, and per-customer budgets. Crumple tracks cost only in its own agent runner, and has no teams or organizations.

**[Kong's AI MCP Proxy](https://developer.konghq.com/plugins/ai-mcp-proxy/)** if Kong already runs in front of your APIs and you have AI Gateway Enterprise. Its [ACLs and audit log of access attempts](https://developer.konghq.com/plugins/ai-mcp-proxy/) sit next to the rest of your gateway.

**[FastMCP](https://gofastmcp.com/integrations/openapi)** if you're writing a server in Python and want to hand-shape its tools. Its own docs make a point worth repeating: it [warns that models do better with curated servers](https://gofastmcp.com/integrations/openapi) than with auto-converted OpenAPI, and recommends that route for bootstrapping. That applies to Crumple too. Crumple converts an OpenAPI document, so its tools are only as good as your document's descriptions, and `--include` and `--exclude` are the only curation it offers.

**To test a server by hand,** [MCP Inspector](https://raw.githubusercontent.com/modelcontextprotocol/inspector/main/README.md) has a web UI, a terminal UI and a CLI. **To check protocol conformance,** [the official conformance framework](https://raw.githubusercontent.com/modelcontextprotocol/conformance/main/README.md) covers clients and servers against the spec. `prove` isn't a replacement for either, and Crumple hasn't yet been run against the conformance suite.

## Where Crumple differs

Two things, and the first needs testing rather than trusting.

### Whether a write can be retried

Crumple decides retries per operation, from the OpenAPI document. A write with no idempotency key gets one attempt, even after a 503, and the agent is told the outcome is unknown. A write that declares a key is retried with the same key. [What gets retried](../README.md#what-gets-retried) has the whole table.

Of the projects here, agentgateway documents a retry policy in the most detail. It's [attempts, an optional backoff and a list of status codes, and the page doesn't mention idempotency or write methods](https://agentgateway.dev/docs/standalone/latest/documentation/configuration/resiliency/retries/). That page is about routes in general, so it may not be the whole story for a tool call. The [LiteLLM OpenAPI page](https://docs.litellm.ai/docs/mcp_openapi) doesn't cover retries, and neither did the Kong and FastMCP pages read here.

**So this isn't a claim that they double-charge.** It's a question to ask of any gateway you run: lose the response to a payment, and count the payments. You can do that against your own stack.

### Claims as checks

`npx crumple-mcp prove --self` breaks an API on purpose and reports what held, and each check has a test requiring it to fail against [a server built to be wrong](../src/cli/wrong-server.ts). `prove <url>` runs the part that works from outside against any MCP server you own. That says less than you might hope, because most failure behaviour can't be seen from outside. [What it doesn't do](../README.md#what-it-doesnt-do) has the limits.

## What Crumple doesn't have

Set against these projects as a group: multiple upstreams, several replicas sharing limits, TLS, stdio serving, a UI, teams, argument-level rules, guardrails, a community, and any production use. Those are real gaps, and some won't be filled.

# Capability Map: Crumple

Status: revision 2, approved by the owner on 2026-11-04. Revision 1 was approved on
2026-11-03; this one changes it because the owner set the goal as a popular GitHub
repo and an open source npm package.

This is the index of what exists. Each module gets its own spec,
`SPEC-<module-id>.md`, next to this file. Module ids are stable: they don't get
renamed. Arrows point one way, and there are no cycles.

```
                    one npm package: crumple-mcp
  +--------------------------------------------------------------+
  |  cli:  demo  |  prove  |  serve  |  eval                     |
  +--------------------------------------------------------------+

  agent-runner --MCP--> mcp-surface --> access-control --> executor --> your API
       |                     |               |                |      (fault-api in tests)
       +---------------------+--- telemetry -+----------------+

  prove  --MCP--> any MCP server: yours, or Crumple itself
  evals  drive agent-runner
  hosted-demo deploys mcp-surface and fault-api on Cloudflare
```

| Module id | Responsibility | Depends on |
|---|---|---|
| `fault-api` | Demo API that can be slow, fail or return malicious text on command | none |
| `telemetry` | Traces, metrics and audit events | none |
| `executor` | One tool call becomes one upstream request, with timeouts, retries, circuit breaker and concurrency limits | `telemetry` |
| `access-control` | Who is calling, what they may do, and sealed upstream credentials | `telemetry` |
| `mcp-surface` | Turns OpenAPI into tools and serves the MCP endpoint | `executor`, `access-control`, `telemetry` |
| `cli` | The installable package: config, `demo`, `serve`, and the wiring for the other commands | `mcp-surface`, `fault-api` |
| `prove` | The checks: run against Crumple or any MCP server, with results to share, including load runs | `fault-api` (speaks to servers over MCP only) |
| `agent-runner` | Minimal agent loop, model adapters, record and replay, tokens and cost | `telemetry` (speaks to servers over MCP only) |
| `evals` | Scored agent scenarios, run with `eval` | `agent-runner`, `fault-api` |
| `hosted-demo` | Public deployment, abuse limits, the trace and results page | `mcp-surface`, `telemetry`, `fault-api` |

`benchmarks` from revision 1 is now part of `prove`.

## Build order

1. `fault-api`, `telemetry`
2. `executor`, `access-control`
3. `mcp-surface`
4. `cli`
5. `prove`, `agent-runner`
6. `evals`, `hosted-demo`

`access-control` comes before `mcp-surface` on purpose: nothing is ever exposed
without a permission check, even during development.

## Where each original requirement lives

| Requirement | Module |
|---|---|
| Exposes APIs as MCP tools | `mcp-surface` |
| Executes tools with authentication and permission controls | `access-control` |
| Supports concurrent agent requests | `executor`, measured by `prove` |
| Implements retries, timeouts and error handling | `executor` |
| Tracks token consumption, latency and execution costs | `agent-runner`, `telemetry` |
| Includes automated agent evaluations | `evals` |
| Provides observability and execution traces | `telemetry`, shown by `hosted-demo` |

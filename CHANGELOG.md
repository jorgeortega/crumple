# Changelog

Each published version gets its changes here, newest first.

## 0.1.0 (not yet published)

The first real version. `crumple-mcp@0.0.1` on npm is a placeholder that holds the name.

### Added

- `serve`: an OpenAPI 3.0 or 3.1 document as MCP tools, on the current MCP protocol and the 2025 one older clients still use.
- Permissions: API keys stored hashed, or JWTs checked against your issuer's keys, denied by default, with grants per tool. A write needs a grant that names it.
- Credentials: the agent's token stops at `access-control`, and the upstream credential comes from the environment or is sealed into the database with `credential set`.
- Failure handling: a deadline on every call, retries only for temporary failures, idempotency keys for writes, a circuit breaker, limits per caller and per API, and errors that tell the agent what to do next.
- Traces and audit: OpenTelemetry traces with one id from the agent's call to the API, sent only where `--otlp` says, and an audit log with `--db`.
- `demo`: breaks an API on purpose and counts what happened.
- `prove`: checks your own server from outside, Crumple itself with `--self`, and load on your machine with `--load`. Reports come as Markdown, JSON and an SVG badge.
- `eval`: agent scenarios graded by what reached the API, replayed free from recordings or run live on a real model, with a spending cap.
- `fault-api`: the fake API that fails on command, which every test and the demo run against.
- A hosted demo at [crumple.latitude10.tech](https://crumple.latitude10.tech), on fake data, with no model behind it.

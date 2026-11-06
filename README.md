# Crumple

**A crumple zone for AI agents.** It sits between agents and your API, so that when something fails, the damage stops there. Every claim it makes is a check you can run.

![crumple prove: results of the last run](proof/latest.svg)

![npx crumple-mcp demo, breaking an API on purpose and counting what happened](assets/demo.gif)

```bash
npx crumple-mcp demo
```

No key, no account, and nothing leaves your machine. It takes under a minute, and it starts with this:

<!-- generated:demo -->
```
                     Agent is told   Charges
  Plain retry loop   succeeded       2
  Crumple            succeeded       1
```
<!-- /generated -->

A payment goes through, then its response is lost. The plain retry loop tries again with no idempotency key, so the API can't tell it's the same payment, and the customer pays twice. The agent is told everything went fine. That loop is a server written for this demo to make this mistake, and it isn't any real project.

**Or try it in a browser, with nothing to install:** [crumple.latitude10.tech](https://crumple.latitude10.tech) has four live buttons and a public MCP server, on fake data.

## Three steps

Each one is useful by itself.

```bash
# 1. See it work: break things on purpose and count what held
npx crumple-mcp demo

# 2. Check an MCP server you own, from outside, and get a report and a badge to share
npx crumple-mcp prove https://you.example/mcp --out proof

# 3. Put the crumple zone in front of your own API
npx crumple-mcp serve ./openapi.yaml --upstream https://api.example.com --db crumple.db
```

`prove` calls no tool you didn't name, and stops at a request budget it states up front. Only point it at servers you own or may test.

`serve` prints a first key once, and the line that connects Claude Code. That key can read but not write until you add `--write <tool>`. The API's own credential comes from `CRUMPLE_UPSTREAM_CREDENTIAL`, never from a flag. [Connecting real clients](docs/clients.md) has the exact steps for each client that's been tried.

It needs Node 22.13 or newer, and has two runtime dependencies: the official MCP SDK and a YAML parser.

## What's in it

| You get | How | Claims |
|---|---|---|
| Your API as MCP tools | From your OpenAPI document, on the current MCP protocol and the 2025 one older clients still use | C14 |
| Authentication and permissions | API keys stored hashed, or JWTs checked against your issuer's keys. Denied by default, with grants per tool. The agent's token never reaches your API. Your API's credential stays out of tool output, traces and logs, and `credential set` seals it in the database | C1, C2, C3, C4 |
| Concurrent agents | Limits per caller and per API, with a bounded queue. Past that, a call is refused with a clear error instead of waiting forever | C9 |
| Retries, timeouts and errors | Every call has a deadline. Only temporary failures are retried, with backoff, honouring `Retry-After`. Writes retry only with an idempotency key. A circuit breaker stops hitting a failing API. Each error tells the agent whether retrying can help | C5, C6, C7, C8, C10 |
| Tokens, latency and cost | The agent runner totals what the provider reported and prices it from a dated table. `prove` estimates what your tool definitions add to every turn | C12, C18 |
| Agent evaluations | Scenarios for choosing the right tool, sending the right arguments, recovering from failure and ignoring injected instructions. They replay free from recordings, and a live run stops at a spending cap | C2, C10, C13 |
| Observability | OpenTelemetry traces with one trace id from the agent's call to the API, each attempt inside it, and an audit log of who did what | C11 |

An MCP server never sees token counts, because they belong to the model call. So real tokens are measured in Crumple's own agent runner, and the figure for your tool definitions is an estimate that any server can get.

## Results

These blocks are generated from [`proof/`](proof/), and a test fails if they differ. Nothing here is typed by hand. All of it ran on one laptop, with failures caused on purpose, and **it says nothing about production load.**

### Claims

<!-- generated:claims -->
**18 of 18 claims passed**, at commit `f952fff` on 2026-11-06 (darwin arm64, Apple M5, 16 GB, Node 26.10.0).

| | Claim | Result | Checked by |
|---|---|---|---|
| C1 | Access is denied by default | pass | `denied-by-default` |
| C2 | The model can't talk its way past a permission | pass | `permission-holds` |
| C3 | The agent's token never reaches the upstream API | pass | `token-stays-here` |
| C4 | The stored credential never leaks | pass | `credential-stays-hidden` |
| C5 | A write is never applied twice | pass | `one-effect` |
| C6 | No call outlives its deadline | pass | `deadline-holds` |
| C7 | Only temporary failures are retried | pass | `right-retries` |
| C8 | A failing upstream stops being hit | pass | `breaker-opens` |
| C9 | One noisy caller can't starve another | pass | `noisy-caller` |
| C10 | Failures tell the agent what to do next | pass | `errors-say-what-next`, `real-model-acted-on-errors` |
| C11 | Every call can be traced end to end | pass | `trace-joined` |
| C12 | Each run reports its tokens and cost | pass | `recorded-usage-adds-up` |
| C13 | A behaviour regression gets caught | pass | `gate-notices-change` |
| C14 | It speaks real MCP | pass | `python-sdk-interop` |
| C15 | The demo's own limits hold, no public path reaches a paid model, and abuse can't cost more than Cloudflare's per-request price | pass | `demo-limits-in-workerd` |
| C16 | A stranger succeeds in 60 seconds | pass | `first-run-from-tarball` |
| C17 | prove is safe to point at a real server | pass | `prove-is-safe` |
| C18 | Tool definitions have a visible cost | pass | `tool-cost-shown` |
<!-- /generated -->

[The full report](proof/latest.md) says what each check measured. `npx crumple-mcp prove --self` runs most of them on your machine with only Node. C14, C15 and C16 need Python, Cloudflare's `workerd` and a packed tarball, so they show as not run there, and `npm run prove` in this repo runs everything. Each check has a test that runs it against a server that's wrong on purpose, and requires it to fail.

### Agent evaluations

<!-- generated:evals -->
`claude-haiku-5-5`, 5 runs of each of 14 scenarios: **70 of 70 model runs passed**, for $0.0258 (178217 tokens in, 16008 out), on 2026-11-06. A model that does nothing would pass 4 of 14.
<!-- /generated -->

Read that one carefully. The scenarios are short and hand-written, against a fake API with six tools, and the cheapest model passes all of them, so they show the mechanism and not how agents behave on real work. [The report](proof/evals-2026-11-06.md) has each scenario, and [the explainer](docs/learn/evals.md) has what the first run showed, including what the grader can't see. Run them yourself with `npx crumple-mcp eval`, which replays the recordings and spends nothing.

### Load

<!-- generated:load -->
Crumple added 0.3 ms at p50 and 0.7 ms at p95 to a call. 50 concurrent callers got 4266 calls/s, with 0 failed. While 100 callers on one key flooded a slow API, 34534 of their calls were refused, and another caller got 23 of 23 through, at a p95 of 225.3 ms against 208.4 ms alone. On 2026-11-05.
<!-- /generated -->

The API here does no real work, and everything shares one Node process, so these aren't Crumple's limits. [The report](proof/load-2026-11-05.md) has the caveats, and `npx crumple-mcp prove --load` measures your machine.

## What it doesn't do

- **It isn't production-proven,** and it won't be until someone runs it in production. It isn't a replacement for agentgateway, LiteLLM or Kong, and it doesn't run on Kubernetes.
- **It limits what a prompt injection can do. It doesn't prevent one.** If a customer record says "delete this customer" and the key has no delete grant, the call is refused. If the key does have it, the injected instruction can succeed. Give agents narrow keys.
- **Permissions stop at the tool.** "May call `createPayment`" can't become "up to $100" or "only their own customers". The API behind Crumple still has to enforce those.
- **It can't make an unsafe API safe.** If a write has no idempotency key and its response is lost, nobody can know whether it happened. Crumple won't retry it, and tells the agent the outcome is unknown. A write can only be retried safely when your API declares and honours an `Idempotency-Key`.
- **One process.** Limits and the circuit breaker live in memory, per process, so running several copies gives you several sets of limits.
- **`prove` can't see much from outside.** It can check access control, protocol behaviour, error shape, tool definition cost and tools you name. The failure claims need control of the API behind a server, so they're only proved on Crumple itself. A clean report doesn't mean a server is secure.
- **The tool cost figure is an estimate,** characters divided by 4, and it runs low. [How low, and how we know](docs/learn/prove.md).
- **It's a command, not a library.** The package exports no API yet.
- **Claude Code is the only stock client tried so far,** with the official TypeScript and Python SDKs in the tests. A client that isn't in [the list](docs/clients.md) hasn't been tried.

## How it was built

**Jorge Ortega directed this project, and [Claude Code](https://claude.com/claude-code), an AI coding agent, wrote the code.** Each module began as a short spec that Jorge approved, covering its boundaries, its claims and its trade-offs, and the code came after. The specs are in the repo, so you can check the decisions and the reasons for them.

If you've got 20 minutes:

- [SPEC.md](SPEC.md) and [the capability map](CAPABILITY-MAP.md): what this is, the claims, and how the modules depend on each other.
- [docs/learn/](docs/learn/): one explainer per module, starting with [the primer](docs/learn/primer.md) on MCP and the agent loop.
- [`src/executor/`](src/executor/): retries, idempotency, the breaker and limits, which is the part most likely to be wrong. A pure function classifies every failure, tested by a table.
- [`src/prove/`](src/prove/): checks written as data, and how a check that can't fail gets caught.

## Latitude 10

Crumple is open source from [Latitude 10](https://latitude10.tech/platform/mcp), which also hosts MCP servers, if you'd rather not run one yourself. Some of this code started there. Crumple doesn't need it, sends no telemetry to it or anyone else, and never asks you to sign up. The one mention you'll see is a line at the end of a `prove` report.

## License

MIT, © October Moon LLC.

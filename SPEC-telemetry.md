# Spec: `telemetry`

Status: draft for the owner's approval, 2026-11-04. Module on
[the map](CAPABILITY-MAP.md), depending on nothing.

## What it is

The record of what happened to each call: who called, what was decided, how many attempts it
took, and how long each one lasted. Every other module writes to it, and it must never leak what
it records. Traces are where secrets most often escape, because logging feels harmless.

| Claim | What `telemetry` has to do for it |
|---|---|
| C11 every call can be traced end to end | Join agent and server spans into one trace through `traceparent` |
| C4 stored credential never leaks | Make it structurally hard for a secret to get in |
| C12 tokens and cost per run | Carry the token counts `agent-runner` measures |

It also holds the owner's requirement for "latency", and the map's "audit events".

## The decision that matters: write it, or use the OpenTelemetry SDK?

An interviewer will ask this, so here's the honest case.

| | OpenTelemetry SDK | About 300 lines of ours (chosen) |
|---|---|---|
| Install size | Several packages added to every `npx` | Nothing |
| Workers | Needs extra setup | Web-standard from the start |
| Output | OTLP | **Also OTLP**, so Jaeger, Tempo and Honeycomb all still work |
| Auto-instrumentation, sampling | Yes | No |
| Keeping up with the standard | Their job | Ours |

Crumple's own span tree is small and known in advance, and the spec caps runtime dependencies at
two. We only need to emit the format, and the format is the part that gives users freedom.
**If this were inside a company's service I'd use the SDK.** The reason it's different here is that
this is a package people install with `npx`. That's the answer to give, and it isn't "the SDK is bad".

## How it works

```ts
const telemetry = createTelemetry({ sinks: [memorySink()], now, randomId, secrets });

const server = telemetry.startSpan('tools/call get_customer', {
  kind: 'server',
  parent: parseTraceparent(meta.traceparent),   // undefined starts a new trace
  attributes: { 'mcp.method.name': 'tools/call', 'gen_ai.tool.name': 'get_customer' },
});
const attempt = server.child('GET /customers/{id}', { kind: 'client' });
attempt.end({ attributes: { 'http.response.status_code': 503 }, errorType: '503' });
server.end();
```

**The current span is passed explicitly, not picked up by magic.** Tracing libraries usually use
`AsyncLocalStorage`, so code doesn't have to pass anything. That's Node-specific, though Workers does
offer it behind a flag, and it hides a dependency. Passing it adds one parameter to a few functions,
and readers can see exactly how a span connects to its parent. Also, tests need no setup.

**Time and ids are injected,** so tests are exact and never depend on a clock.

### What a trace looks like

Names follow [OpenTelemetry's MCP conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md),
read at the source on 2026-11-04 (commit `633cbb060b`). They moved to a new repository, so older links
are stale.

```
invoke_agent                         internal  agent-runner
  chat claude-haiku-5-5              client    tokens live here (C12)
  tools/call get_customer            client    agent-runner
    tools/call get_customer          server    mcp-surface; the joined span (C11)
      authorize                      internal  access-control: caller and decision
      execute                        internal  executor: deadline, breaker state
        GET /customers/{id}          client    attempt 1, 503
        GET /customers/{id}          client    attempt 2, 200, http.request.resend_count = 1
```

Each retry is its own span, so a trace shows the backoff gaps. A tool that returned `isError` is
recorded with `error.type = tool_error`, as the conventions say.

**These conventions are marked Development, so they can change.** That's the reason attribute names
live in one file. A rename means one edit.

## The important part: what can't get in

The usual way to protect traces is a denylist: record everything and scrub what looks secret. That
fails open, because the next secret you didn't think of goes straight through. So:

**Attributes are an allowlist.** Only keys in one list are recorded. Anything else is dropped and
counted, and in tests it throws, so a developer finds out immediately.

| Group | Keys |
|---|---|
| Protocol | `mcp.method.name`, `mcp.protocol.version`, `gen_ai.tool.name`, `gen_ai.operation.name`, `jsonrpc.request.id` |
| Failure | `error.type` |
| Upstream | `http.request.method`, `http.response.status_code`, `http.request.resend_count`, `url.template`, `server.address` |
| Model | `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, and the two cache token keys |
| Ours | `crumple.caller`, `crumple.decision`, `crumple.decision.reason`, `crumple.deadline_ms`, `crumple.breaker.state`, `crumple.retry.delay_ms`, `crumple.queue_ms`, `crumple.cost_usd` |

**So these can never be recorded,** by design rather than by discipline:

- **Tool arguments and results.** The conventions make them opt-in, and we don't offer the option. A
  debugging flag that leaks customer data is exactly how these incidents happen.
- **Bodies, headers and query strings.**
- **Real URLs.** `url.template` holds `/customers/{id}`, never `/customers/cus_1`, because a path can
  name a customer. Latitude 10's scrubber learned the same lesson.
- **Upstream error text,** which can repeat anything, including the credential. `error.type` holds a
  short code from our own list.
- **The caller's key.** `crumple.caller` is a key's id, not the key.

**Values get two more defences,** because some allowed values come from outside (a `jsonrpc.request.id`
is whatever the client sent, and a tool name in a refused call could be anything). Strings are capped
at 256 characters, and any value containing a registered secret is replaced. C4 is tested through this
path by having `fault-api` echo the credential.

### Incoming trace context is untrusted

`traceparent` comes from the caller. It's parsed strictly by the W3C format, and an invalid one starts a
new trace rather than failing the call, because a bad trace id must never stop a tool call. `baggage` and
`tracestate` aren't read at all, since baggage can carry anything.

## Where records go

| Sink | When | Notes |
|---|---|---|
| Memory | Always | A ring of 10,000 spans. The oldest are dropped, and it can't grow forever |
| OTLP over HTTP | **Only when the user configures an endpoint** | Batched, with its own timeout |
| Pretty printer | `demo` and `prove` | For humans |

Two rules here come straight from the main spec:

- **Nothing is ever sent by default.** The project's "never send telemetry" rule and an OTLP exporter can
  sound like they conflict, but they don't: this goes only to an address the user typed. A test proves that
  with no endpoint configured, `fetch` is never called.
- **Telemetry can't hurt a call.** A slow or failing exporter loses spans and counts the loss. Its errors never
  reach a caller. `flush()` returns a promise, so Workers can pass it to `waitUntil`.

**Metrics** come from the same records rather than a second system. When a span ends, a histogram of
`mcp.server.operation.duration` is updated with the buckets the conventions specify, plus counts by tool and error
type. Percentiles from a histogram are estimates, so `prove:load` measures precisely on its own. **Metrics aren't
exported as OTLP in this version.** A trace backend can derive them from spans, and I'd add it if someone asks.

**Audit events** answer "who did what", separately from traces, because a span ring is allowed to forget and an
audit record shouldn't be: `{ at, caller, tool, decision, reason, traceId }`, with no arguments. In memory mode
they only last as long as the process, and the `cli` spec covers saving them through the storage interface.

## What it won't do

- **Sampling.** Every span is recorded. That's fine at this scale, but it's the first thing a high-traffic service
  would need.
- **Span links.** The conventions suggest linking the HTTP request's trace when `_meta` has its own. We use `_meta`
  and fall back to the HTTP `traceparent` header if it's absent.
- **Log collection.** Crumple doesn't try to be a logging system.

## How it's tested

| Test | Proves |
|---|---|
| A table of `traceparent` strings from the W3C rules | Strict parsing, and bad input starts a new trace |
| Unknown attribute key | Dropped and counted, and throws under test |
| A planted secret in every allowed value | Replaced everywhere, including in a captured OTLP export |
| An exporter that fails or hangs | The span ends normally and a counter goes up |
| No endpoint configured | Zero `fetch` calls |
| A captured OTLP JSON sample, plus a manual look in Jaeger | Real tools can read it |
| Ring and histogram | Memory stays bounded, and buckets match the conventions |

## Files

`src/telemetry/` holds `index.ts`, `attributes.ts` (the allowlist, and every name in one place), `span.ts`,
`traceparent.ts`, `sinks.ts`, `otlp.ts`, `metrics.ts` and `audit.ts`, with tests alongside.

## Decision for the owner

**Should tool arguments stay impossible to record, with no debug flag?** I recommend yes, and the rest of this spec
assumes it. The cost is real: debugging "why did the agent call it with that?" means looking at the agent's side,
where the arguments are already in the conversation. The server never holds them in a trace, which is a line you can
say plainly in an interview.

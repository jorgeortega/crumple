# Spec: `executor`

Status: approved by the owner on 2026-11-04 ("Approve both"), including both decisions at the end. Module on
[the map](CAPABILITY-MAP.md), depending only on `telemetry`.

## What it is

One tool call becomes one upstream outcome. Everything between "the agent asked" and "here's what
happened" lives here: deadlines, retries, the circuit breaker, concurrency limits, and errors that say
what to do next. **It knows nothing about MCP,** so it can be tested and load-tested alone, and it's the
module a senior engineer will read first.

| Claim | What `executor` does for it |
|---|---|
| C5 a write is never applied twice | Retries a write only when it has a way to be safe, and otherwise says the outcome is unknown |
| C6 no call outlives its deadline | One deadline covers the queue, every attempt, the backoff and reading the body |
| C7 only temporary failures are retried | A pure table decides, from the failure and the operation |
| C8 a failing upstream stops being hit | A circuit breaker fails fast, then tests for recovery |
| C9 a noisy caller can't starve another | Per-caller and per-upstream limits, with a clear refusal |
| C10 failures say what to do next | Every error says whether retrying can help, and how |
| C3, C4 credentials | The credential goes on last, and comes back out of whatever the API returns |

## The decision that matters: when is it safe to retry?

**Retrying a read is free. Retrying a write can charge someone twice.** So the rule isn't about the failure
alone. It's about the failure and what the operation is.

[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110#section-9.2.2) says a client "SHOULD NOT automatically retry
a request with a non-idempotent method" unless it knows that's safe. `mcp-surface` works out each operation's
retry policy from the OpenAPI document and hands it over as plain data:

| Policy | Which operations | Retried? |
|---|---|---|
| `safe` | `GET`, `HEAD`, or marked `x-crumple-safe-to-retry: true` | Yes |
| `with_key` | Declares an `Idempotency-Key` parameter | Yes, with the same key on every attempt |
| `never` | Every other write | **No. One attempt, always** |

**`PUT` and `DELETE` are `never` unless marked**, even though the RFC calls them idempotent and allows the retry. In
practice, retrying a `DELETE` that succeeded returns a 404, telling the agent that a delete that worked has failed, and
plenty of real `PUT`s have side effects. It's one line in the OpenAPI document to mark an operation safe, and being wrong
in this direction costs a visible error rather than a silent double effect.

**Crumple can't make an unsafe API safe.** If a write has no idempotency key and the response is lost, nobody can know
whether it happened. The honest move is to say so, which is the next section. This limit goes in the README.

### What each failure means

`classify()` is a pure function, tested by a table of every row below against every policy.

| What happened | `safe` | `with_key` | `never` |
|---|---|---|---|
| Connection lost, or attempt timed out | Retry | Retry | `outcome_unknown` |
| 500, 502, 503, 504 | Retry | Retry | `outcome_unknown` |
| 429 | Retry after waiting | Retry after waiting | `rate_limited` (not applied, safe to try later) |
| 408, 425 | Retry | Retry | `rate_limited` |
| 401, 403 | `upstream_auth` | `upstream_auth` | `upstream_auth` |
| Other 4xx | `rejected` | `rejected` | `rejected` |
| 3xx | `redirected` | `redirected` | `redirected` |
| 2xx with HTML where JSON was promised | `invalid_response` | `invalid_response` | `invalid_response` |

A 503 on a `never` write counts as unknown because a 503 only usually means nothing happened, and "usually" is the
wrong standard for money. Redirects are never followed, because following one could carry the credential to another host.

## Errors that tell the agent what to do

This is what the agent receives when something fails. Its fields are what C10 is checked against:

```ts
interface ExecutorError {
  code: string;
  message: string;          // written for the model to read
  retry: 'no' | 'later' | 'same_key' | 'check_first';
  retryAfterMs?: number;
  idempotencyKey?: string;  // present when retry is 'same_key'
  detail?: string;          // an upstream 4xx's explanation, capped and redacted
}
```

| Code | Means | `retry` | Example message |
|---|---|---|---|
| `invalid_arguments` | The request couldn't be built | `no` | A required path value is missing |
| `rejected` | The API said the request is wrong (4xx) | `no` | Fix the arguments, then call again |
| `upstream_auth` | The API refused **Crumple's** credential | `no` | The agent can't fix this. Tell the operator |
| `rate_limited` | Asked to slow down | `later` | Try again in 30 seconds |
| `unavailable` | A read is still failing after retries | `later` | The API is having problems |
| `timeout` | The deadline ran out on a read | `later` | No answer within 30 seconds |
| `outcome_unknown` | **A write may or may not have happened** | `check_first`, or `same_key` | Read the record before trying again |
| `circuit_open` | Failing fast, nothing was sent | `later` | The API has been failing, so this wasn't sent |
| `overloaded` | Too many calls in progress | `later` | Too many calls right now |
| `response_too_large` | Over the 1 MB cap | `no` | Ask for less, such as with a smaller limit |
| `redirected`, `invalid_response` | The API answered something unusable | `no` | |
| `cancelled` | The caller went away | `no` | |

`check_first` is the part I'd point an interviewer at. A retry loop that treats a lost response as a failure is how double
charges happen. Most tools have only "failed" and "succeeded", and an agent told "failed" will try again.

**Upstream text.** A 4xx explanation goes to the agent as `detail`, capped at 2 KB, because "amount must be positive" helps it
fix the call. Bodies of 5xx responses don't, because they tend to be stack traces. `detail` is untrusted: it's the same channel
prompt injection comes through, and that's why permissions don't rely on what the model decides (C2).

A network error's own message is never passed on, because it can contain the URL, including a credential in the query string. That
lesson is lifted from Latitude 10's code.

## How a call runs

```
call(operation, args, { caller, parentSpan, signal })
  |
  |  the deadline starts here
  v
build the request        no network yet: a bad argument costs nothing
  v
caller slot, then upstream slot     or refuse with `overloaded`
  v
+--> breaker allows it?  no: `circuit_open`, zero upstream requests
|     v
|   one attempt           in its own span, with the credential added last
|     v
|   classify()            done, or...
|     v
+-- wait: Retry-After or jittered backoff, unless the deadline wouldn't allow it
```

**One deadline for everything.** Default 30 seconds, covering the queue, every attempt, backoff and the body. Each attempt also
has its own 10-second limit, so one hang can't spend the whole budget. Cancelling aborts the real request, which `fault-api` records.
The body read counts, because of `stall-body`: a timeout that stops at the headers would hang forever there.

C6's stated margin is **500 ms** in `prove`, against a real clock. Unit tests use a fake clock and have no margin.

**Backoff is exponential with full jitter:** a random wait between zero and `min(5 s, 200 ms * 2^attempt)`. Without the randomness, every
client that failed at the same moment retries at the same moment, and hits the API again together.

**`Retry-After` is honored,** in both formats the RFC allows (seconds or a date). If the wait wouldn't fit in the remaining deadline, Crumple
doesn't wait and returns `rate_limited` with `retryAfterMs`, so the agent can decide. A hostile value can't stall anything, because the deadline wins.

**Three attempts in total** is the default. The RFC's advice leans towards one retry, and three with backoff is common practice on top of a breaker.
It's a setting.

### Circuit breaker

A pure state machine, tested by a table of states and events, in its own file, because it's second on the spec's cut list.

```
closed --(at least 5 calls in the last 20, half of them failing)--> open
open   --(30 seconds pass)--> half-open
half-open --(one probe succeeds)--> closed
half-open --(the probe fails)--> open
```

**What counts as a failure:** timeouts, lost connections and 5xx. **4xx and 429 don't,** because otherwise one agent's bad arguments could cut every
other agent off from a healthy API. There's one breaker per upstream, and each attempt counts, including retries. While half-open, one probe goes through and
everything else fails fast.

### Concurrency limits

Two levels: at most 10 in flight per caller, then at most 50 per upstream. **The first level is what delivers C9:** a flooding caller fills its own 10 slots and
leaves the rest free. Excess calls wait in a bounded queue, at most 20 per caller and 200 for the upstream, using up their own deadline as they wait. Past that, they're refused at once with
`overloaded`, because a queue with no limit is just a slower outage.

A call keeps its slots during backoff. Releasing them would let more work in exactly while the upstream is struggling.

A call that waited out its whole deadline isn't sent, and gets `overloaded`. For a write, sending it would be a charge nobody will wait to hear about. Building it found this: a queued call was being sent at the instant it expired.

**Limit:** this is first-come-first-served at the upstream level, not fair scheduling, so hundreds of well-behaved callers could still queue behind one another. Limits are
exact within a Node process, and per instance on Workers, as the main spec says.

## Idempotency keys: who makes them

For a `with_key` operation, the executor generates one key per call and sends it on every attempt. **But that only protects retries inside Crumple.** If Crumple gives up and the
agent calls the tool again, a new key would mean a second charge.

So when a `with_key` write gives up, the error returns the key with `retry: 'same_key'`, and the tool accepts an optional key argument. The agent is told exactly how to retry safely:

```json
{
  "code": "outcome_unknown",
  "retry": "same_key",
  "idempotencyKey": "a1b2c3",
  "message": "This may have been applied. To retry safely, call again with idempotencyKey a1b2c3."
}
```

The evals test that a real model follows this.

## What's lifted, and what changes

From Latitude 10's `app/hosted-mcp/_lib/upstream.ts`, which keeps October Moon LLC's copyright:

| Lifted | Change |
|---|---|
| `buildRequest`: path encoding, refusing `.` and `..`, staying under the base URL, line-break checks | Allows the configured host, including localhost, with no host-ownership check. Drops the `x-agentify-*` header |
| The blocked header list (`authorization`, `cookie`, `host`, ...), from `convert.ts` | So a model can't set those through an argument |
| `readCapped`, the 1 MB and 2 KB caps | Runs under the deadline |
| Credential last, on a header or the query | Passed in as a function, because `executor` can't import `access-control` |
| `redact`: the raw, URL-encoded and form-encoded forms | Used on every response, and each form is also registered with `telemetry` |
| Reporting network errors by kind only | |

Its comment says "Sent once, never retried", so everything about retries is new, along with the deadline, breaker, limits and `classify()`.

Argument validation isn't lifted. The spike showed the SDK validates arguments against the schema before a tool runs.

**Two small additions asked for by earlier specs:** fixed upstream headers from config, which is how a test sets `x-fault` (`SPEC-fault-api.md`), and sending
`traceparent` on each attempt, so an API's own traces can join in. That's on by default, can be turned off, and carries only random ids, though a caller can choose the trace id.

## The interface

```ts
const executor = createExecutor({
  baseUrl: 'https://api.example.com',
  getCredential,                  // from access-control, wired by mcp-surface
  headers: { 'x-fault': 'hang' }, // fixed upstream headers, optional
  telemetry,
  fetch, now, sleep, random,      // injected, so tests use no clock or network
  limits, retry, breaker,         // the defaults above
});

const outcome = await executor.call(operation, args, { caller: 'key_1', parentSpan, signal });
// { ok: true, status, body, contentType, attempts }
// { ok: false, error: ExecutorError, attempts }
```

It never throws for an upstream problem. A failure is a normal return value, so nothing can forget to handle one.

## What it won't do

- **No retry budget.** Google's SRE book suggests capping retries as a share of traffic, to stop retry storms. Here the attempt limit and the breaker cover most of it. It's a fair
  thing to add for high traffic.
- **No hedged requests,** where a second copy is sent if the first is slow. It's powerful and it's wrong for writes.
- **No response caching,** and no streaming: a call's body is read in full, up to the cap.
- **No outbound allowlist beyond the one configured upstream.** One Crumple instance serves one API.
- **Redaction has a limit.** It catches a credential echoed as sent, or URL-encoded. An API that hashes or reverses it won't be caught.

## How it's tested

All with `fault-api` in process, and a fake clock, so nothing really waits.

| Test | Proves |
|---|---|
| `classify()`: every failure against every policy | C7, and the table above stays true |
| `hang` and `stall-body` return `timeout` at the deadline, and `fault-api` records `abandoned` | C6, including the body |
| `drop` on a `with_key` write, then a retry: exactly one effect in `fault-api` | C5 |
| `drop` on a `never` write: one attempt, `outcome_unknown`, `check_first` | C5, and C10 |
| A lost connection before any headers (a stub, since `fault-api`'s `drop` can't produce it) | The limit named in `SPEC-fault-api.md` |
| A 400 gets one attempt, a 503 gets three, and `Retry-After` sets the wait | C7, counted from `fault-api`'s log |
| Breaker state table, then sustained failure means zero further requests, then recovery | C8 |
| A flood from one caller, while a second caller's calls succeed, and excess gets `overloaded` | C9 |
| `echo-auth`: the credential is absent from the result and from every span | C4 |
| `fault-api`'s header log never shows anything but the configured credential | C3 |
| Every error has a `retry` and a message | C10 |

95% branch coverage, enforced by the local gate. `prove` runs the same claims again later, end to end and on a real clock.

## Files

`src/executor/`: `index.ts`, `request.ts` (lifted), `call.ts`, `errors.ts` (`classify()` and the error list), `retry.ts`, `breaker.ts`, `limits.ts` and `clock.ts`, with tests alongside. Tasks 11 to 14
build these in order. `operation.ts` holds the plain shape of an operation, which `mcp-surface` fills in from OpenAPI.

## Decided

The owner approved both on 2026-11-04.

**1. The idempotency key is shown to the agent,** as above. The alternative was to derive a key from the caller, tool and arguments, so a repeat call gets the same key automatically. That needs nothing
from the model, but it would silently swallow a legitimate second identical charge, such as two $50 payments on purpose. An agent can misuse a key, but a silently dropped payment is worse, and a visible key is also what lets the eval show
an agent recovering properly.

**2. A write with no idempotency key is never retried, even after a 503.** The cost: some writes that a retry would have rescued return `outcome_unknown` instead, and the agent has to check and try again.
The benefit is the sentence "Crumple never applies a write twice, and when it can't be sure, it says so", which is the claim this project stands on.

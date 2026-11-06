# crumple-mcp prove: Crumple itself

**19 passed, 0 failed, 0 not run.**

Run 2026-11-06T15:15:30.582Z, taking 70.7 s, with crumple-mcp 0.1.0: commit f952fff. darwin arm64, Apple M5, 16 GB, Node 26.10.0.

Measured on one machine, with failures caused on purpose. It says nothing about production load.

## Claims

| Claim | | Result | Checked by |
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

## Checks

| Check | Result | What happened |
|---|---|---|
| `denied-by-default` No key, a wrong key and a key without the grant | pass | All three refused, and the API received no requests. The same call with a good key went through. |
| `permission-holds` A record says to delete, and a read-only key tries it directly | pass | Refused, nothing deleted, and the audit log has the attempt. |
| `token-stays-here` What reaches the API on a normal call | pass | The agent's key appears nowhere in what arrived, and the stored credential did arrive. |
| `credential-stays-hidden` The API repeats the credential back | pass | The API repeated it, and it's absent from the tool's output, spans, audit events and logs. |
| `one-effect` A payment applies, then its response is lost | pass | One effect when a retry recovered it, and one when every response was lost and the caller retried with the key it was given. |
| `deadline-holds` The API hangs, before and partway through its answer | pass | A structured error within the 800 ms deadline plus a 500 ms margin. Measured: hang 804 ms, stall-body 804 ms. |
| `right-retries` A 400, a 503, and a 503 with Retry-After | pass | A 400 got 1 attempt, a 503 got 3, and Retry-After: 1 was honoured, waiting 1003 ms. |
| `breaker-opens` The API keeps failing, then recovers | pass | After 3 failures, a call failed fast with no request reaching the API, and calls worked again by themselves after 400 ms. |
| `noisy-caller` One caller floods a slow API, while another keeps working | pass | Of 20 flooding calls, 3 went through and 17 were refused with overloaded. The other caller got all 3 through. |
| `errors-say-what-next` Each kind of failure, read as an agent would | pass | Each error has a code, a message and advice on retrying: rejected (no), unavailable (later), rate_limited (later), invalid_response (no), timeout (later). |
| `prove-is-safe` prove on a server whose tools all claim to be read-only, writes included | pass | 4 tools claimed to be read-only, and none was called: the API received nothing. 6 of 30 requests used. |
| `tool-cost-shown` What the tool definitions cost | pass | About 467 tokens per turn across 4 tools, as an estimate. |
| `trace-joined` One tool call, from the real agent loop to the API | pass | One trace, from the agent's call to the API, with the caller, the decision and 1 attempt. It used the real agent loop with a scripted model, since joining a trace doesn't depend on what a model says. |
| `gate-notices-change` Every tool's description is broken, and a recording is replayed | pass | Unchanged, the replay passes. With the descriptions broken, it reports them as changed and the gate fails. This catches any change, good or bad. Only a live run shows whether a real model does worse. |
| `real-model-acted-on-errors` A real model reading Crumple's errors, replayed from its recording | pass | On 2026-11-06, claude-haiku-5-5 got each failure from Crumple and acted on what it said, with a system prompt that says nothing about errors: lost-responses, api-down-then-up, wont-get-better. Today's server still gives it the same words. This is one kept run of each, not a rate: the rates are in the live eval's report. |
| `recorded-usage-adds-up` Each run's tokens and cost, against the provider's own numbers | pass | In 14 recordings from a real model, each run's totals equal what the provider's replies add up to, with a cost worked out per call: 36880 tokens in and 3181 out. |
| `python-sdk-interop` The official Python SDK, a separate implementation, lists and calls tools | pass | npm run test:interop: 7 tests passed in 3.6 s. |
| `demo-limits-in-workerd` The demo's rate limit, daily cap and reset, in workerd, with no public path to a paid model | pass | npm run test:workers: 30 tests passed in 25.6 s. |
| `first-run-from-tarball` A first run from a packed tarball in an empty folder on this machine, not a clean machine or the published package | pass | npm run test:install: 15 tests passed in 36.7 s. |

---

Made with [crumple-mcp](https://github.com/jorgeortega/crumple), open source from [Latitude 10](https://latitude10.tech/platform/mcp), which also hosts MCP servers.

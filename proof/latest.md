# crumple-mcp prove: Crumple itself

**14 passed, 0 failed, 0 not run.**

Run 2026-11-06T06:20:48.405Z, taking 4.3 s, with crumple-mcp 0.1.0: commit 46fff9a. darwin arm64, Apple M5, 16 GB, Node 26.10.0.

Measured on one machine, with failures caused on purpose. It says nothing about production load.

## Claims

| Claim | | Result | Not checked here |
|---|---|---|---|
| C1 | Access is denied by default | pass |  |
| C2 | The model can't talk its way past a permission | pass |  |
| C3 | The agent's token never reaches the upstream API | pass |  |
| C4 | The stored credential never leaks | pass |  |
| C5 | A write is never applied twice | pass |  |
| C6 | No call outlives its deadline | pass |  |
| C7 | Only temporary failures are retried | pass |  |
| C8 | A failing upstream stops being hit | pass |  |
| C9 | One noisy caller can't starve another | pass |  |
| C10 | Failures tell the agent what to do next | partly checked | a real model recovering needs a live eval, which spends money |
| C11 | Every call can be traced end to end | pass |  |
| C12 | Each run reports its tokens and cost | not run | needs a recording from a real model, which spends money (Task 27) |
| C13 | A behaviour regression gets caught | pass |  |
| C14 | It speaks real MCP | not run | needs Python, so it runs in npm run test:interop |
| C15 | The demo's own limits hold, no public path reaches a paid model, and abuse can't cost more than Cloudflare's per-request price | not run | needs the Worker, so it runs in npm run test:workers |
| C16 | A stranger succeeds in 60 seconds | not run | a stranger's first run, so it runs in npm run test:install |
| C17 | prove is safe to point at a real server | pass |  |
| C18 | Tool definitions have a visible cost | pass |  |

## Checks

| Check | Result | What happened |
|---|---|---|
| `denied-by-default` No key, a wrong key and a key without the grant | pass | All three refused, and the API received no requests. The same call with a good key went through. |
| `permission-holds` A record says to delete, and a read-only key tries it directly | pass | Refused, nothing deleted, and the audit log has the attempt. |
| `token-stays-here` What reaches the API on a normal call | pass | The agent's key appears nowhere in what arrived, and the stored credential did arrive. |
| `credential-stays-hidden` The API repeats the credential back | pass | The API repeated it, and it's absent from the tool's output, spans, audit events and logs. |
| `one-effect` A payment applies, then its response is lost | pass | One effect when a retry recovered it, and one when every response was lost and the caller retried with the key it was given. |
| `deadline-holds` The API hangs, before and partway through its answer | pass | A structured error within the 800 ms deadline plus a 500 ms margin. Measured: hang 808 ms, stall-body 806 ms. |
| `right-retries` A 400, a 503, and a 503 with Retry-After | pass | A 400 got 1 attempt, a 503 got 3, and Retry-After: 1 was honoured, waiting 1006 ms. |
| `breaker-opens` The API keeps failing, then recovers | pass | After 3 failures, a call failed fast with no request reaching the API, and calls worked again by themselves after 400 ms. |
| `noisy-caller` One caller floods a slow API, while another keeps working | pass | Of 20 flooding calls, 3 went through and 17 were refused with overloaded. The other caller got all 3 through. |
| `errors-say-what-next` Each kind of failure, read as an agent would | pass | Each error has a code, a message and advice on retrying: rejected (no), unavailable (later), rate_limited (later), invalid_response (no), timeout (later). |
| `prove-is-safe` prove on a server whose tools all claim to be read-only, writes included | pass | 4 tools claimed to be read-only, and none was called: the API received nothing. 6 of 30 requests used. |
| `tool-cost-shown` What the tool definitions cost | pass | About 467 tokens per turn across 4 tools, as an estimate. |
| `trace-joined` One tool call, from the real agent loop to the API | pass | One trace, from the agent's call to the API, with the caller, the decision and 1 attempt. It used the real agent loop with a scripted model, since joining a trace doesn't depend on what a model says. |
| `gate-notices-change` Every tool's description is broken, and a recording is replayed | pass | Unchanged, the replay passes. With the descriptions broken, it reports them as changed and the gate fails. This catches any change, good or bad. Only a live run shows whether a real model does worse. |

---

Made with [crumple-mcp](https://github.com/jorgeortega/crumple), open source from [Latitude 10](https://latitude10.tech/platform/mcp), which also hosts MCP servers.

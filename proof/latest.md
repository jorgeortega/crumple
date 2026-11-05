# crumple-mcp prove: Crumple itself

**12 passed, 0 failed, 0 not run.**

Run 2026-11-05T14:53:35.194Z, taking 4.3 s, with crumple-mcp 0.1.0: commit 956a0b5. darwin arm64, Apple M5, 16 GB, Node 26.10.0.

Measured on one machine, with failures caused on purpose. It says nothing about production load.

## Claims

| Claim | | Result | Not checked here |
|---|---|---|---|
| C1 | Access is denied by default | pass |  |
| C2 | The model can't talk its way past a permission | partly checked | the part with a real model needs evals (Task 28) |
| C3 | The agent's token never reaches the upstream API | pass |  |
| C4 | The stored credential never leaks | pass |  |
| C5 | A write is never applied twice | pass |  |
| C6 | No call outlives its deadline | pass |  |
| C7 | Only temporary failures are retried | pass |  |
| C8 | A failing upstream stops being hit | pass |  |
| C9 | One noisy caller can't starve another | pass |  |
| C10 | Failures tell the agent what to do next | partly checked | the part where an agent recovers needs evals (Task 28) |
| C11 | Every call can be traced end to end | not run | needs the agent runner (Task 27) |
| C12 | Each run reports its tokens and cost | not run | needs the agent runner (Task 27) |
| C13 | A behaviour regression gets caught | not run | needs evals (Task 28) |
| C14 | It speaks real MCP | not run | needs Python, so it runs in npm run test:interop |
| C15 | The public demo can't run up a bill or be abused | not run | needs the hosted demo (Task 31) |
| C16 | A stranger succeeds in 60 seconds | not run | needs the demo command (Task 24) |
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
| `deadline-holds` The API hangs, before and partway through its answer | pass | A structured error within the 800 ms deadline plus a 500 ms margin. Measured: hang 804 ms, stall-body 805 ms. |
| `right-retries` A 400, a 503, and a 503 with Retry-After | pass | A 400 got 1 attempt, a 503 got 3, and Retry-After: 1 was honoured, waiting 1005 ms. |
| `breaker-opens` The API keeps failing, then recovers | pass | After 3 failures, a call failed fast with no request reaching the API, and calls worked again by themselves after 400 ms. |
| `noisy-caller` One caller floods a slow API, while another keeps working | pass | Of 20 flooding calls, 3 went through and 17 were refused with overloaded. The other caller got all 3 through. |
| `errors-say-what-next` Each kind of failure, read as an agent would | pass | Each error has a code, a message and advice on retrying: rejected (no), unavailable (later), rate_limited (later), invalid_response (no), timeout (later). |
| `prove-is-safe` prove on a server whose tools all claim to be read-only, writes included | pass | 4 tools claimed to be read-only, and none was called: the API received nothing. 6 of 30 requests used. |
| `tool-cost-shown` What the tool definitions cost | pass | About 467 tokens per turn across 4 tools, as an estimate. |

---

Made with [crumple-mcp](https://github.com/jorgeortega/crumple), open source from [Latitude 10](https://latitude10.tech/platform/mcp), which also hosts MCP servers.

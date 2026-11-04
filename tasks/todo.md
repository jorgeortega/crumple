# Tasks: Crumple

Plan: [plan.md](plan.md). Spec: [SPEC.md](../SPEC.md). C numbers are the spec's claims.

**Every code task** also needs `npm run check` passing and one local commit.
**Spec and docs tasks** are verified by the owner's read or a teach-back.
**OWNER** marks the steps that need Jorge. Sizes: XS 1 file, S 1-2, M 3-5.

## Phase 0: Setup and the riskiest question (days 1-4)

### Task 1: Create the package skeleton (M)
Set up the TypeScript package with its development tools and license.
- [x] `package.json` names `crumple-mcp`, Node 22.13 or newer, MIT, and `"private": true` until launch
- [x] LICENSE names October Moon LLC; strict `tsconfig`; a sample test passes
- [x] The work is pushed to a private GitHub repo, `jorgeortega/crumple`, as a backup
- Verify: `npm run check`; the repo shows as private
- Depends on: none. Files: `package.json`, `tsconfig.json`, `LICENSE`, `.gitignore`, `eslint.config.js`

### Task 2: Add the local gate (M)
With no CI until December, this is what stops bad commits.
- [x] `.githooks/pre-push` runs `npm run check`, and `npm run setup` turns it on
- [x] A secret scan fails on a planted fake key; an import-boundary test fails on a planted bad import
- [x] The GitHub workflow file exists, ready for December
- Verify: plant both failures, watch the gate stop them, remove them
- Depends on: 1. Files: `.githooks/pre-push`, `scripts/secret-scan.mjs`, `tests/boundaries.test.ts`, `.github/workflows/ci.yml`

### Task 3: Write the primer (S)
- [x] `docs/learn/primer.md` explains MCP, tool calling and the agent loop in plain language, using this repo's example, in about 20 minutes of reading
- [ ] **OWNER:** read it, then a short teach-back (days 1-3)
- Depends on: none. Files: `docs/learn/primer.md`

### Task 4: Test the MCP SDK on Node and Workers (S, time-boxed to one session)
The only finding that could change the design.
- [x] A throwaway server built on the official SDK answers `tools/list` and `tools/call` on Node and in `workerd`, on revision 2026-07-28
- [x] The official Python client reaches both
- [x] `docs/adr/0001-mcp-library.md` records the result. If it fails, it records the fallback and tells the owner
- Verify: run the spike; attach the output to the record
- Depends on: 1. Files: `spikes/mcp-sdk/*`, `docs/adr/0001-mcp-library.md`

### Checkpoint A
- [ ] **OWNER:** told the spike's result, and whether the plan changes

## Phase 1: Foundations and execution (days 4-7)

### Task 5: Spec `fault-api` and `telemetry`
- [x] **OWNER:** approve `SPEC-fault-api.md` and `SPEC-telemetry.md` (2026-11-04)
- Verify: both trace to the map and name their claims. Claude checks OpenTelemetry's MCP conventions at the source here
- Depends on: 4. Files: the two specs

### Task 6: Build `fault-api` normal behaviour (S)
- [x] An OpenAPI document with reads and writes on fake customers and payments
- [x] Every request's headers are logged and can be read back, which C3 relies on
- Verify: `npx vitest run src/fault-api`
- Depends on: 5. Files: `src/fault-api/*`

### Task 7: Add `fault-api` failure modes (S)
- [x] A request header selects: slow, hang, stalled body, status codes, `Retry-After`, apply-then-drop-response, malicious text, echo the credential, a huge body, non-JSON
- [x] An unknown fault gets a 400, never silently normal behaviour
- [x] Each mode has a test, and concurrent requests with different modes don't interfere
- Verify: `npx vitest run src/fault-api`
- Depends on: 6. Files: `src/fault-api/faults.ts`, its test

### Task 8: Build `telemetry` spans (M)
- [x] Nested spans with attributes, recorded to a memory sink through one small interface
- [x] `traceparent` is read and written per W3C Trace Context
- [x] Attributes are scrubbed: no bodies, arguments, keys or credentials
- Verify: `npx vitest run src/telemetry`
- Depends on: 5. Files: `src/telemetry/*`

### Task 9: Export traces and metrics (S)
- [x] Spans export as OTLP JSON, and a local viewer shows a sample trace (Jaeger, 2026-11-04)
- [x] Latency and count metrics are available from the same records
- [x] Audit events (who, what, decision, trace id), which the map lists and this task had missed
- Verify: test against a captured OTLP sample; manual check in Jaeger
- Depends on: 8. Files: `src/telemetry/otlp.ts`, its test

### Task 10: Spec `executor`
- [x] **OWNER:** approve `SPEC-executor.md`, including what's lifted from `upstream.ts` and the retry and idempotency rules
- Depends on: 7, 8. Files: `SPEC-executor.md`

### Task 11: Build the single-attempt executor with deadlines (M) — C6, C10
- [x] Lifted request building and capped reads; each call has a deadline, and cancellation stops the upstream request
- [x] Every failure maps to a structured error saying whether retrying can help, including `outcome_unknown` for a write that may have happened
- Verify: a hanging `fault-api` returns an error inside the stated margin
- Depends on: 10. Files: `src/executor/request.ts`, `call.ts`, `errors.ts`, tests

### Task 12: Add retries and idempotency (M) — C5, C7
- [x] Retries only on temporary failures, with jittered backoff, honoring `Retry-After` and the deadline
- [x] Writes retry only with an idempotency key; apply-then-drop produces exactly one effect
- [x] A write that gives up returns its key, so the agent can retry safely
- Verify: `npx vitest run src/executor`, with an injected clock
- Depends on: 11. Files: `src/executor/retry.ts`, `idempotency.ts`, tests

### Task 13: Add the circuit breaker (S) — C8
- [x] Opens on sustained failure, fails fast with zero upstream requests, tests recovery, closes
- Verify: state-table test, plus a `fault-api` test counting requests
- Depends on: 12. Files: `src/executor/breaker.ts`, its test

### Task 14: Add concurrency limits (S) — C9
- [x] Per-caller and per-upstream limits, a bounded queue, and a structured refusal when full
- Verify: a flooding caller doesn't stop a second caller's calls
- Depends on: 12. Files: `src/executor/limits.ts`, its test

### Checkpoint B
- [x] 95% branch coverage in `executor`; C5 to C10 pass at module level
- [x] Claude writes `docs/learn/fault-api.md`, `telemetry.md`, `executor.md`
- [ ] **OWNER:** read them and do three teach-backs

## Phase 2: Permissions, protocol, package (days 8-11)

### Task 15: Spec `access-control`
- [x] **OWNER:** approve `SPEC-access-control.md`, after Claude reads `keys.ts` and `jose.ts` (2026-11-04)
- Depends on: 11; can overlap Checkpoint B. Files: `SPEC-access-control.md`

### Task 16: Build API keys and the policy (M) — C1
- [x] Keys are stored hashed; a pure `decide()` is deny-by-default, tested by a table of cases
- [x] Tool listings show only what a caller may use, and calls are re-checked anyway
- Verify: `npx vitest run src/access-control`
- Depends on: 15. Files: `src/access-control/keys.ts`, `policy.ts`, `authenticate.ts`, tests

### Task 17: Add sealed credentials and JWT checks (M) — C3, C4
- [x] Lifted AES-GCM sealing; the upstream credential goes in the request last and comes out of responses and logs
- [x] The agent's token never goes upstream, proved from `fault-api`'s header log
- [x] JWTs are checked against an issuer's keys, and the protected resource metadata is produced (Task 18 serves it)
- Verify: `npx vitest run src/access-control`
- Depends on: 16, 11. Files: `src/access-control/credential.ts`, `jwt.ts`, `jwks.ts`, tests

### Task 18: Build `mcp-surface`: the first real call (M) — C1, C14
- [x] **OWNER:** approve `SPEC-mcp-surface.md` first, including older-client support (2026-11-04)
- [x] Copied converter; `tools/list` and `tools/call` run through access control into the executor
- [x] Serves the protected resource metadata when an issuer is configured, and answers 401, 403 and 503 as the specs say
- [x] The official Python SDK lists and calls a tool against it
- Verify: `npm run test:interop`
- Depends on: 4, 14, 17. Files: `src/mcp-surface/convert.ts`, `facts.ts`, `server.ts`, `results.ts`, tests, `tests/python-interop/*`

### Task 19: Add `node:sqlite` storage (S)
- [ ] Memory and SQLite pass the same test suite behind one interface
- Depends on: 18. Files: `src/store/*`, its test

### Task 20: Build `cli` config and `serve` (M)
- [ ] **OWNER:** approve `SPEC-cli.md` first
- [ ] `serve ./openapi.yaml --upstream <url>` runs with sensible defaults and prints a first key once
- [ ] Each error says what went wrong and what to do next
- Verify: run against `fault-api` by hand; `tests/cli.test.ts`
- Depends on: 18. Files: `src/cli/*`, `src/node.ts`, tests

### Task 21: Test with a real MCP client (S)
- [ ] Claude Code connects to `serve` and calls a tool; at least one more client is tried
- [ ] Exact setup steps are written down for each client that works
- Verify: a manual run, recorded in `docs/clients.md`
- Depends on: 20. Files: `docs/clients.md`

### Checkpoint C
- [ ] **Someone else could use it:** a packed tarball runs `serve` in an empty folder
- [ ] 95% branch coverage in `access-control`
- [ ] Claude writes `docs/learn/access-control.md`, `mcp-surface.md`, `cli.md`
- [ ] **OWNER:** read them and do three teach-backs

## Phase 3: Proof, agent, hosted demo (days 12-15)

### Task 22: Build `prove` against Crumple (M) — C1 to C9
- [ ] **OWNER:** approve `SPEC-prove.md` first
- [ ] Checks are data; `npm run prove` runs them all and writes `proof/latest.md` and `.json`, with commit, date and machine
- Verify: break a behaviour on purpose and confirm the report fails
- Depends on: Checkpoint C. Files: `src/prove/*`, `proof/`

### Task 23: Point `prove` at any MCP server (M) — C17, C18
- [ ] A request budget, no write calls unless named, and reports listing what didn't run
- [ ] Estimated token cost for each tool definition, labelled as an estimate
- [ ] A shareable Markdown report and badge
- Verify: test against a recording server that counts every call
- Depends on: 22. Files: `src/prove/external.ts`, `report.ts`, tests

### Task 24: Build the `demo` command (S) — C16
- [ ] Starts everything, breaks things on purpose, prints a clear result table, and exits, in 60 seconds with no key
- Verify: `tests/install/` runs it with `npx` from a packed tarball in an empty folder
- Depends on: 22. Files: `src/cli/demo.ts`, `tests/install/*`

### Task 25: Add local load runs (S) — C9
- [ ] `npm run prove:load` writes a dated report stating the machine and the commit
- Depends on: 22. Files: `src/prove/load.ts`

### Task 26: Build the agent loop with record and replay (M)
- [ ] **OWNER:** approve `SPEC-agent-runner.md` first, after Claude reads the current Claude API reference
- [ ] A minimal loop over MCP with a Claude adapter on plain `fetch`; replay needs no key or network
- Verify: a recorded run replays identically
- Depends on: Checkpoint C. Files: `src/agent-runner/*`, `scenarios/recordings/*`

### Task 27: Add tokens, cost and joined traces (S) — C11, C12
- [ ] Totals match the provider's usage in a recording, priced from a dated table
- [ ] Agent and server spans share one trace id through `_meta`
- Depends on: 26, 9. Files: `src/agent-runner/usage.ts`, `prices.ts`, `tracing.ts`, tests

### Task 28: Build `evals` and the gate (M) — C2, C10, C13
- [ ] **OWNER:** approve `SPEC-evals.md` first
- [ ] Scenarios for right tool, right arguments, recovery after failure, and injected instructions
- [ ] A deliberately broken tool description fails the gate. `eval --live` stops at `--max-usd`
- [ ] **OWNER:** okay the first live recording run, under $1
- Depends on: 27, 7. Files: `src/evals/*`, `scenarios/*`

### Task 29: Add the Workers adapter and D1 storage (M)
- [ ] **OWNER:** approve `SPEC-hosted-demo.md` first, including the Workers Paid check
- [ ] The same flows pass in `workerd`
- Verify: `npx vitest run tests/workers`
- Depends on: 18, 19. Files: `workers/*`, `src/store/d1.ts`, tests

### Task 30: Add abuse limits and the results page (M) — C15
- [ ] Shared demo keys, a rate limit, a daily cap, data that resets, no path to a paid model
- [ ] One read-only page showing a run's trace and which claims held, using the site's Terminal design tokens
- Verify: each limit triggers in tests; desktop and mobile by hand
- Depends on: 29, 22. Files: `workers/limits.ts`, `workers/page.ts`, tests

### Task 31: Deploy the demo
- [ ] **OWNER:** okay the first deploy, which adds a DNS record for `crumple.latitude10.tech`
- [ ] A stock MCP client connects to the public URL and calls a tool
- Depends on: 30, 21

### Checkpoint D
- [ ] All 18 claims pass in `npm run prove`
- [ ] Claude writes `docs/learn/prove.md`, `agent-runner.md`, `evals.md`, `hosted-demo.md`
- [ ] **OWNER:** read them and do four teach-backs

## Phase 4: Launch (days 16-20)

### Task 32: Write the README (S)
- [ ] Demo GIF first, then three steps, results table, honest limits, one Latitude 10 section
- [ ] A test fails if a README number differs from the proof report
- Depends on: Checkpoint D. Files: `README.md`, `tests/readme-numbers.test.ts`, `assets/demo.gif`

### Task 33: Add community and security files (S)
- [ ] `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`
- Files: those four

### Task 34: Write the comparison page (S)
- [ ] Claude reads the projects first; every statement about another project links to its source
- Files: `docs/comparison.md`

### Task 35: Write the case study and launch drafts (M)
- [ ] `docs/case-study.md` written from measured results, plus Show HN, r/mcp and directory drafts
- [ ] **OWNER:** review; adjust the pitch line and CV entry to match
- Files: `docs/case-study.md`, `docs/launch/*`

### Task 36: Release (owner actions)
- [ ] Final secret scan, including history, and the install test from a packed tarball
- [ ] **OWNER:** make the repo public, run `npm publish`, post the launch
- [ ] Links added to outreach messages; a link from latitude10.tech goes through its Build Gate

### Optional, if time remains
- [ ] OpenAI-compatible model adapter (first on the cut list)

## Checkpoint: Complete
- [ ] All tasks and the 10 teach-backs are done
- [ ] Repo public, package installable from npm, demo live
- [ ] The owner can explain every module without notes

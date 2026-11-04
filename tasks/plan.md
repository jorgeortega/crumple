# Implementation Plan: Crumple

Status: for the owner's review, 2026-11-04. Tasks are in [todo.md](todo.md).

## Overview

Build `crumple-mcp`, one npm package with `demo`, `prove`, `serve` and `eval`
commands, plus a hosted demo on Cloudflare, following [SPEC.md](../SPEC.md) and
[CAPABILITY-MAP.md](../CAPABILITY-MAP.md). Day 1 is 2026-11-04 and day 20 is
2026-11-23. Claude writes the code. The owner approves module specs, reads
explainers and does teach-backs, for about 5 to 8 hours across the modules.

## How the work is ordered

The riskiest unknown goes first. If the official MCP library can't run on both Node
and Workers, that changes the design, so a short test comes before anything else.

```
setup and primer
      |
SDK spike  <-- the one thing that could change the design
      |
fault-api, telemetry  (the test API, and the records everything writes)
      |
executor              (timeouts, retries, breaker, limits)
access-control        (keys, policy, sealed credentials)
      |
mcp-surface           (first real MCP call: the walking skeleton)
      |
cli: serve            (first time a stranger could use it)
      |
prove, demo           (the claims become one command)
agent-runner, evals   (real agent behaviour, tokens and cost)
      |
hosted-demo           (public URL)
      |
README, case study, launch
```

**Why it's sliced this way.** The first three phases build layers because the map's
dependencies require it, but each layer is proved against `fault-api` on its own, so
nothing waits for the end to be testable. The first end-to-end call lands in Task 18,
around day 9, and every task after it adds to something that already works.

## Architecture decisions

These are in the spec and get decision records as they're built:

- **`executor` knows nothing about MCP.** It can be tested and load-tested alone.
- **Policy is a pure function.** A table of cases tests every rule without a network.
- **The agent and `prove` use the protocol only.** They could be pointed at anyone's
  server, which also keeps Crumple honest about being real MCP.
- **Core on web-standard APIs,** with thin Node and Workers adapters.
- **Storage behind one small interface:** memory, `node:sqlite`, D1.

New in this plan:

- **`fault-api` faults are chosen per request** with a header, so tests can run in
  parallel without affecting one another.
- **`prove` checks are data:** a list of `{ claim, needs, run }` entries. `needs` says
  whether a check requires control of the upstream, which is how a report on someone
  else's server knows what it couldn't run.
- **Development tools needing approval with this plan** (none ship to users):
  `typescript`, `vitest`, `eslint` with `typescript-eslint`, `wrangler`,
  `@cloudflare/vitest-pool-workers`, and `esbuild` for bundling.

## The rhythm for each module

1. Claude writes `SPEC-<module>.md`. The owner approves it, or asks for changes.
2. Claude builds it, one task and one commit at a time, running `npm run check` first.
3. Claude writes `docs/learn/<module>.md`.
4. The owner reads it and does the teach-back. Then the module is done.

The spec approvals and teach-backs are listed as tasks, so they can't be skipped.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| The official TypeScript SDK doesn't run on Workers, or doesn't serve 2026-07-28 cleanly | High | Task 4 tests it first. Fallback: lift `app/mcp/_lib/modern.ts` |
| The owner's reviews fall behind during relocation | High | Reviews can stack. Claude keeps building the next module while waiting, but launch needs every teach-back |
| Launch gets no attention | High for popularity, low for interviews | The link goes in targeted outreach regardless. Original data in the launch post. The owner can retry with a new angle |
| A public demo gets abused | Medium | Fake data only, no paid model path, rate limit and daily cap, a check for each (C15) |
| `prove` gets pointed at servers the user doesn't own | Medium | Request budget, no write calls by default, clear docs (C17) |
| Lifted code carries a secret or Latitude 10 assumption | Medium | Secret scan in the local gate, and each lift is reviewed in its module spec |
| `node:sqlite` is still marked experimental | Low | Memory is the default store; SQLite is opt-in |
| Stock MCP clients handle API keys differently | Medium | Task 21 tests a real client. The README gives exact setup for each one tested |
| No CI catches a mistake | Medium | Pre-push hook, an install test from a packed tarball, committed proof reports |
| An interviewer asks for a live change in the code | Medium | "Where would you change this?" in every teach-back. Some roles will still test typing code, and this plan doesn't fully cover that |

## What could be built at the same time

Very little, on purpose. One person reviews everything, so more parallel work would
only build up a queue. The exception is `prove`, `agent-runner`, `evals` and the launch
drafts, which don't touch one another, so subagents could help if time runs short.

## Open questions

None block the start. Module specs will raise their own, such as whether to keep older
MCP clients and which limits the demo needs.

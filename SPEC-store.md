# Spec: `store`

Status: the owner approved adding this module and building it on 2026-11-04 ("Yes, add store"). This short spec records the decisions made while building it, for review with [its explainer](docs/learn/store.md). Module on [the map](CAPABILITY-MAP.md), depending on `access-control` and `telemetry`.

## What it is

Without it, keys and audit events disappear when the process stops, which is fine for `npx crumple-mcp demo` and useless for `serve`. It saves them, behind the interfaces those modules already defined, so nothing else changes shape.

| Saves | Interface | From |
|---|---|---|
| API keys | `KeyStore` | `access-control` |
| Audit events | `AuditSink` | `telemetry` |
| The sealed upstream credential | Its own, since `SPEC-cli.md` put it here | `cli`'s `credential set` |

Memory stays the default, because `npx` has to work with no setup. D1 was planned for Task 29, and the owner dropped it on 2026-11-06 (`SPEC-hosted-demo.md`, decision 3): the demo has no keys to save. If someone later wants Crumple on Workers with saved keys, it runs the same shared tests.

## Decisions

**`node:sqlite`, not a package.** It comes with Node, so there's no dependency to add and no native build for a stranger's install to fail on. The cost is that it's still marked experimental: it works on Node 22.13.1 with no flag (tested 2026-11-04), but prints an `ExperimentalWarning`. So it's only loaded when someone asks for a database, and a first run never shows it.

**The same tests for every backend.** One contract in `tests/helpers/store-contract.ts` runs against memory and SQLite, and any later backend runs it too. That's what stops "works in memory, breaks in production".

**The file is readable only by its owner.** It's set to `0600` before anything is written, including SQLite's extra files. It holds key hashes and who called what, so other users on the machine have no business reading it.

**Audit events are capped, 1,000,000 by default, oldest first, and counted.** A flood of bad keys would otherwise fill the disk, even at 60 events a minute. **So the log isn't append-only or tamper-proof:** anyone who can write to the file can change it. That's a real limit for a compliance use, and the honest answer there is to export events elsewhere.

**A store failure means "can't check", never "allowed".** Bad grants in a row, or a closed database, make the lookup fail, and `authenticate` turns that into a 503. If saving an audit event fails, the call goes ahead and the failure is counted, by `telemetry`'s existing rule.

**The schema has a version.** A database from a newer Crumple is refused with a message, rather than being read wrongly.

## What it won't do

- **Only one Node process at a time is the intended use.** WAL mode lets a second process read, and SQLite will serialize writers, but limits and the breaker are still per process.
- **Audit writes block.** `node:sqlite` is synchronous, so each event is a small disk write on the request's path. `prove:load` will show what that costs, and nothing here measures it yet.
- **A power cut can lose the last few audit events,** with `synchronous=NORMAL`, the usual choice with WAL.
- **No migrations yet,** since there's only version 1.

## Files

`src/store/`: `sqlite.ts`, `index.ts`, with tests alongside. `tests/helpers/store-contract.ts` is the shared contract.

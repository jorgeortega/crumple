# `store`: keeping keys and audit events

Spec: [SPEC-store.md](../../SPEC-store.md). Code: [src/store/](../../src/store/).

## The one-sentence version

It saves API keys, audit events and an optional sealed credential in one SQLite file, so they outlast the process, behind the interfaces `access-control` and `telemetry` already defined.

## The central idea: one set of tests for every backend

[store-contract.ts](../../tests/helpers/store-contract.ts) is one list of behaviours: a key is found by its hash, revoking happens once, a caller can't change a stored grant, odd text stays data. Memory and SQLite both run it, and D1 will too.

That's what stops "it worked in memory and broke in production". A new backend passes those tests or it doesn't exist, and nothing above it has to change.

## Why `node:sqlite`, and what it costs

It comes with Node, so there's no package to add and no native build to fail on a stranger's machine, which matters for `npx`. The cost is that it's still marked experimental, and prints a warning when loaded. So it only loads when someone asks for a database. Memory stays the default, and a first run never shows that warning.

## Security decisions worth saying out loud

- **The file is readable only by its owner,** set before anything is written, because SQLite's extra files copy those permissions.
- **Values are always bound, never pasted into SQL,** so a label like `'); DROP TABLE keys;--` is just a label. There's a test for exactly that.
- **A corrupt row fails closed.** Bad grants make the lookup fail, which `authenticate` turns into a 503, and never an allow.
- **No key is on disk,** only its hash.

## Honest limits

- **The audit log isn't tamper-proof.** Anyone who can write to the file can change it, and old events get dropped past a million. For compliance, export events somewhere else.
- **Audit writes block.** `node:sqlite` is synchronous, so each event is a small disk write on the request's path. Nothing has measured that yet, and `prove:load` will.
- **A power cut can lose the last few audit events,** though it can't corrupt the file.
- **One process at a time** is the intended use. Limits and the breaker are per process anyway.

## The story to tell

**Running on the oldest supported Node found something CI would have.** With CI off until December, the suite had only ever run on Node 26, while the package promises 22.13. Running it there failed one test, every time. The product was fine: my test's fake `sleep` waited for an abort event without checking whether the signal had already aborted, and on Node 22 the timing differs just enough to expose that. The real `sleep` does check. It's now one command, `npm run test:oldest-node`, on the release checklist.

## Teach-back

1. Why run the same tests against memory and SQLite, rather than testing each its own way?
2. Why SQLite that comes with Node, instead of a popular package like `better-sqlite3`? What does that cost?
3. **Where would you change this?** "We want to store keys in Postgres." Which files would you add, and which existing modules would have to change?

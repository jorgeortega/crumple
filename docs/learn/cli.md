# `cli`: the first time a stranger could use it

Spec: [SPEC-cli.md](../../SPEC-cli.md). Code: [src/cli/](../../src/cli/).

## The one-sentence version

It turns a library only tests could reach into commands someone can run: `npx crumple-mcp serve ./openapi.yaml --upstream https://api.example.com`.

## What a first run does

```
Crumple is serving 6 tools from openapi.yaml
  MCP endpoint   http://127.0.0.1:3333/mcp
  Upstream       https://api.example.com/, using CRUMPLE_UPSTREAM_CREDENTIAL

Your API key, shown once:
  crumple_...

It can read, and it can't write. To allow a write tool, add --write <tool>.
It lasts until this process stops. To keep it, add --db ./crumple.db.

Connect Claude Code:
  claude mcp add --transport http crumple http://127.0.0.1:3333/mcp --header "Authorization: Bearer crumple_..."

00:58:34  tools/call getCustomer  key_399a  ok  4 ms
00:58:34  tools/call deleteCustomer  key_399a  denied  writes_not_allowed
```

That's a real run, with the key hidden. **Every default is a safety decision you could defend:** read-only first key, localhost only, no config file, no telemetry.

## The decision to tell a story about: not bundling

I'd written that the 18 MB install "is slow for a first `npx`", and planned a bundler to fix it. I hadn't measured that. Measured: a cold install took **half a second**. Bundling would have saved 17 MB of disk, and cost a build tool, a generated licence file, and `npm audit` not seeing the SDK. So you decided against it.

**This is the best kind of story for an interview:** an assumption of mine, in writing, checked and found wrong before it cost anything. The honest other side is that a slow connection would feel it: about 6 seconds at 10 Mbit/s, which is calculated rather than measured.

## Security decisions, in the order someone would hit them

- **A credential is never a flag,** because flags end up in shell history and process lists. It comes from `CRUMPLE_UPSTREAM_CREDENTIAL`.
- **It binds to `127.0.0.1`,** and checks `Host` against local names. That's what stops DNS rebinding, where a web page reaches a local server through a name the attacker controls.
- **A misspelt flag is an error,** and so is a misspelt config field. `--wirte` quietly doing nothing would be a bad surprise in a security tool.
- **The first key can't write.** Every write is named, which is your rule from `access-control`, applied to the default.
- **The key is printed once.** Log lines come from spans, so they can't hold an argument.
- **`audit` reads a database that exists.** A misspelt path would otherwise make an empty one and report nothing to see, which looks exactly like "nothing happened".

## The best evidence so far

Real Claude Code, with every response to a payment lost on purpose. The model read `outcome_unknown`, called again with the key it was handed, and `fault-api` shows **one charge**. It's one run on one model, so it shows the design can work rather than how often it does, and `evals` will measure that. [clients.md](../clients.md) has the run. But it's the project's central claim happening with a real agent, for about half a cent.

## Sealing, and where it helps

`credential set` seals the credential into the database, and the seal key stays in `CRUMPLE_SEAL_KEY`. It protects a file that gets backed up or copied. **On one machine, with the key and the file side by side, it adds little,** so the environment variable stays the normal way. Having both set is an error rather than a silent choice.

## How it's tested

Commands take an `io` object and return an exit code, so most tests run in process and see exactly what a person would. **Then one test ignores all of that:** `npm run test:install` packs a tarball, installs it in an empty folder with no repository around it, and runs it as a separate process, with a real Ctrl-C, on Node 22.13.1 and the current Node. That's Checkpoint C, "someone else could use it".

## Honest limits

- **Claude Code works, and it's the only app tried so far.** See [clients.md](../clients.md). HTTP-only and API keys were fine there, and other clients may differ.
- **No stdio, TLS or hot reload.**
- **No library entry point.** A public API is a promise, and nobody has asked for it.
- **The key sits in your scrollback,** or in a log if the output is piped. That's the price of no setup.
- **With `--db` on Node 22, you'll see an `ExperimentalWarning`** from SQLite. Without `--db`, you won't.
- **In memory, audit events aren't kept at all.** The log lines show refusals, and `--db` is how to keep them.
- **`eval` isn't here yet.** It comes in Task 28. `demo` and `prove` are explained in [prove.md](prove.md).

## Where to look

[serve.ts](../../src/cli/serve.ts) wires everything, and contains almost no logic of its own, which is the point. [config.ts](../../src/cli/config.ts) is the strict validation. [install.run.ts](../../tests/install/install.run.ts) is the stranger's experience.

## Teach-back

1. Why is the upstream credential an environment variable and not a `--credential` flag?
2. What is DNS rebinding, and what stops it here?
3. You planned to bundle the package and then didn't. What changed your mind, and what's the best argument for the other choice?
4. Why does the install test exist, when `cli.test.ts` already tests every command?
5. **Where would you change this?** "We want `serve` to reload the tools when the OpenAPI file changes." Which file changes, what's the hard part, and what would you do about a call already in flight?

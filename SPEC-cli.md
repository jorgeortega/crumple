# Spec: `cli`

Status: draft for the owner's review, 2026-11-04. Module on [the map](CAPABILITY-MAP.md), depending on `mcp-surface`, `fault-api` and `store`. Three decisions need the owner, at the end.

## What it is

The first time a stranger could actually use this. Everything so far is a library that only tests can reach. This turns it into commands:

```bash
npx crumple-mcp serve ./openapi.yaml --upstream https://api.example.com
```

Earlier work was left for this spec: `SPEC-mcp-surface.md` left the `Host` check, `SPEC-store.md` left where a sealed credential lives, `SPEC-telemetry.md` left saving audit events, and ADR 0001 left the install size.

**Developer experience is the feature.** The main spec says a first run needs no config file, and each error says what went wrong and what to do next.

## What a first run looks like

```
$ export CRUMPLE_UPSTREAM_CREDENTIAL="Bearer sk_your_api_key"
$ npx crumple-mcp serve ./openapi.yaml --upstream https://api.example.com

Crumple is serving 12 tools from openapi.yaml
  MCP endpoint   http://127.0.0.1:3333/mcp
  Upstream       https://api.example.com, using CRUMPLE_UPSTREAM_CREDENTIAL

Your API key, shown once:
  crumple_Xk2...

It can read, and it can't write. To allow a write tool, add --write <tool>.
It lasts until this process stops. To keep it, add --db ./crumple.db.

Connect Claude Code:
  claude mcp add --transport http crumple http://127.0.0.1:3333/mcp --header "Authorization: Bearer crumple_Xk2..."

12:01:03  tools/call getCustomer     key_7f3a  ok      34 ms
12:01:09  tools/call deleteCustomer  key_7f3a  denied  writes_not_allowed
```

The log lines come from spans, so they hold no arguments, on `stderr`, and `--quiet` turns them off. That `claude mcp add` form is from `claude mcp add --help`. Whether it really connects is what Task 21 tests.

## The commands

The main spec's five, plus three small ones this spec adds, because a key needs a way to be managed and the audit log needs a way to be read.

| Command | Does | Built in |
|---|---|---|
| `serve <file or URL>` | Runs the MCP server | Task 20 |
| `fault-api` | The API that fails on command, on `127.0.0.1` | Task 20 |
| **`keys create\|list\|revoke --db <file>`** | Manages keys in a database | Task 20 |
| **`audit --db <file>`** | Prints who did what, with `--denied` and `--limit`. It's how an operator sees the attempted delete | Task 20 |
| **`credential set --db <file>`** | Seals the upstream credential into a database. Decision 3 | Task 20 |
| `demo` | The 60-second tour | Task 24 |
| `prove <url>` | The checks | Task 22 |
| `eval <folder>` | The agent evaluations | Task 28 |

Plus `--help` and `--version`. Parsing uses Node's own `parseArgs`, in strict mode, so an unknown flag is an error rather than being ignored. A misspelt `--wirte` silently doing nothing would be a bad surprise in a security tool.

### `serve`'s options

| Flag | Default | Why |
|---|---|---|
| `--upstream <url>` | The document's first server | If there's none, the error says to pass this |
| `--port <n>` | `3333` | A port in use is a clear error that suggests another |
| `--host <addr>` | `127.0.0.1` | See below |
| `--db <file>` | none, so in memory | Keeps keys and audit events |
| `--write <tool>` | none | Repeatable. Adds a write grant to the first key |
| `--include`, `--exclude <name or tag>` | everything | Repeatable. Every listed tool costs tokens on every turn |
| `--credential-header <name>` | `authorization` | Where the credential goes |
| `--credential-query <name>` | none | For an API that wants it in the query |
| `--allowed-origin`, `--allowed-host` | none | Repeatable. See below |
| `--otlp <url>` | none | Sends traces to an address you typed, and nowhere else |
| `--config <file>` | none | Below |
| `--quiet` | off | No per-call log lines |

**The document** can be a file, or a URL with a 10-second limit and a 10 MB cap, since many APIs serve their own `/openapi.json`. JSON or YAML: `yaml` reads both.

## Decisions already implied, and worth reading

**A credential value is never a flag.** It comes from the environment variable `CRUMPLE_UPSTREAM_CREDENTIAL`, because flags show up in shell history and process lists. No credential is allowed, for an open API, and it gets one line saying so. The value is sent as written, including `Bearer `.

**It binds to `127.0.0.1` by default.** MCP says a local server **SHOULD** bind only to localhost. On loopback, Crumple also checks `Host` against `localhost`, `127.0.0.1` and `[::1]`, which finishes MCP's DNS rebinding rule. `--host 0.0.0.0` works, with a warning that traffic and keys are unencrypted without a proxy in front. It turns the automatic `Host` check off, so `--allowed-host` is how to set one.

**A warning before sending a credential over plain HTTP** to anything but loopback. It's the operator's call, so it warns and doesn't refuse.

**In memory, the key changes at every start.** That's annoying on purpose: it's honest about what memory means, and the message offers `--db`. With `--db`, the first start prints a key, and later ones don't. `--write` only applies when that first key is made, and otherwise it warns and points at `keys create`.

**Keys are printed once, and only then.** Not in logs, errors or `keys list`, which shows the id, the start of the key, the label, the grants and whether it's revoked. The upstream credential is never printed, and a test checks every message.

**A config file only for what flags can't carry,** which is JWT settings and their scope map, plus limits and timeouts:

```json
{
  "jwt": { "issuer": "https://login.example.com/", "audience": "https://mcp.example.com/mcp", "jwksUri": "https://login.example.com/jwks.json", "resource": "https://mcp.example.com/mcp", "scopes": { "read": [{ "tool": "*" }] } },
  "deadlineMs": 15000
}
```

Unknown fields are errors, naming the field, because a misspelt `writes` must not quietly do nothing. There's no field for a secret. Flags override the file. Validation is written by hand and is pure, with a table of tests, because `zod` isn't a dependency of ours.

**Stopping is clean.** `Ctrl-C` stops accepting, finishes sending traces, closes the database and exits 0. A second `Ctrl-C` exits at once.

**Exit codes:** 0 for success, 1 when something failed at run time, 2 for wrong usage.

**`fault-api`** binds to `127.0.0.1` with no way to change it, as its spec says. `/_fault/*` is on, because the only reason to run this command is pointing another server at it and then asking `prove` what arrived. It prints its fake credential, which is a fake and fine to show.

**A bug to fix on the way:** `serveOnNode` has no handling for a port in use, so today the process would crash with a raw stack trace.

**What this never does,** from the main spec: no telemetry, no update checks, no nagging, and no mention of Latitude 10 at run time.

## The shape of the code

`bin.ts` is three lines. Everything else takes an `io` object (`stdout`, `stderr`, `env`, `readFile`, `fetch`), and `run(argv, io)` returns an exit code rather than calling `process.exit`, so commands can be tested without spawning anything.

Commands load their code when they run, so `serve` without `--db` never touches `node:sqlite` and a first run never shows its warning.

## How it's tested

| Test | Proves |
|---|---|
| Each error: its message says what went wrong and what to do | The main spec's rule, and a table makes it hard to skip one |
| A missing file, bad YAML, Swagger 2.0, no upstream, no tools, a port in use, a database it can't open | Those messages, one by one |
| Config validation: every field, unknown fields, wrong types | Nothing misspelt passes silently |
| `serve` against `fault-api` over real sockets, from a printed key to a tool call | The first run works |
| The first key can read, and is refused a write. With `--write`, it can make that write | The first-key rule |
| `--db`: the second start prints no key, and the first key still works | Keys survive |
| `keys create`, `list`, `revoke`, then a call with the revoked key | Key management |
| `audit` shows the attempted delete | The point of one door |
| Every message from a run contains neither the upstream credential nor, after the first print, the key | C4 at the outermost layer |
| `Host: evil.test` on loopback gets 403, and `--host 0.0.0.0` warns | DNS rebinding |
| `Ctrl-C` closes the database and exits 0 | Clean stops |
| **`tests/install/`: a packed tarball, installed in an empty folder, with no repository around it, runs `serve`** | **Checkpoint C: someone else could use it** |
| The tarball on Node 22.13.1, with no `ExperimentalWarning` in a run without `--db` | The oldest promise, and lazy loading |
| The tarball holds no tests, specs or spikes | What ships |

85% branch coverage, as the main spec sets. The install test goes in the pre-push gate if it stays under about 10 seconds, and otherwise beside `test:interop`.

## What it won't do

- **No library entry point yet.** `import { ... } from 'crumple-mcp'` isn't offered, because a public API is a promise and nobody has asked for it. `SPEC.md`'s commands are the interface.
- **No stdio.** Crumple serves HTTP. Task 21 finds out what that costs with real clients, and that may send us back here.
- **No TLS.** Use a proxy.
- **No hot reload.** A changed document needs a restart.
- **`npx` keeps the key in your terminal scrollback,** and if the output is piped, in that log. Printing it once is the price of having no setup.

## Decisions for the owner

**1. Don't bundle, and ship plain compiled files with the two allowed dependencies.** This reverses what ADR 0001 assumed. It said the 18 MB install "is slow for a first `npx`", which I hadn't measured. Now I have, on this machine and connection:

| | Bundled with esbuild | Not bundled (recommended) |
|---|---|---|
| On disk | 625 KB | 18 MB |
| Downloaded | About 180 KB | About 7.4 MB |
| Cold install, empty npm cache | Not measured, and close to nothing | **0.5 seconds** here. About 6 seconds at 10 Mbit/s, worked out rather than measured |
| Start | 0.11 s | 0.13 s |
| Works with the official client on Node 22.13.1 and 26 | Yes | Yes, as the test suite shows |
| `npm audit` sees the SDK | **No** | Yes |
| Someone can read what they installed | Harder | Yes, and for a portfolio project that counts |
| Extra work | A build tool, a generated licence file for everything inlined, and splitting the code so SQLite still loads late | `tsc` |

**The case for bundling is real:** "zero dependencies" is a good line for a README, what you publish is exactly what runs, and a slow connection feels the difference. But it doesn't change the 60-second claim (C16) on any connection I'd expect, and it costs a build tool and audit visibility. I recommend not bundling, and letting the install test tell us if that's wrong.

**2. The first key is read-only, and writes need `--write <tool>`.** It's what you already decided for grants, applied to the default. The cost is one more flag before a first write. The alternative is a first key that can do everything, which is the friendlier demo and exactly the default this project argues against.

**3. Add `credential set`, which seals the upstream credential into the database.** The environment variable stays the normal way. This is for when the database gets backed up or copied: the seal key stays in `CRUMPLE_SEAL_KEY`, away from the file. Having both set at once is an error rather than a silent choice. It's about 40 lines plus a table in `store`.

The alternative is no command, leaving sealing as code that nothing in the package uses, and then the honest thing would be to remove it. I recommend adding it, since "sealed upstream credentials" is on the map and an interviewer may ask where they actually live. **The limit stays as the spec says:** on one machine, with the key and the file side by side, sealing adds little.

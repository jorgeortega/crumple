# Spec: `prove`

Status: approved by the owner on 2026-11-05 ("Approve all three"), including the three decisions at the end, each with its recommended choice. Module on [the map](CAPABILITY-MAP.md), depending on `fault-api` and speaking to servers over MCP only. Covers Tasks 22 and 23.

## What it is

The project says "every claim is a check you can run". This is the thing you run. It has two jobs, and they're very different in what they can honestly say:

```bash
npx crumple-mcp prove --self              # all of Crumple's claims, on this machine, with failures we cause on purpose
npx crumple-mcp prove https://you/mcp     # what can be learned about your server from outside, gently
```

| | `prove --self` | `prove <url>` |
|---|---|---|
| Who it's for | Someone deciding whether to believe Crumple | Someone with their own MCP server |
| Controls the API behind the server? | Yes, so it can break things | No |
| Can test | Access, leaks, double charges, deadlines, retries, breaker, noisy callers | Access from outside, protocol behaviour, tool definitions, tools you name |
| Runs in | About 20 seconds, a target this spec sets | Seconds |

**Why not just point at the test suite?** The tests already cover these claims, and they use fake clocks and in-process calls so they're quick and exact. `prove --self` uses real sockets, real time and the real protocol, runs on a stranger's laptop with no test framework, and writes down what it measured. The tests show the code does what we meant. `prove` shows the running system does it.

## The problem this spec has to correct

`SPEC.md` says the failure checks (C5 to C9) can run against someone else's server if they point its upstream at `fault-api`, and we added the `fault-api` command partly for that. **Working through it, that's true for almost nobody.** Two things get in the way:

1. Their server's tools call *their* API's paths. `fault-api` only has customers and payments, so the tools wouldn't match.
2. `fault-api` picks a failure from a request header, and their server has no reason to send it.

It would only work for an OpenAPI gateway that you can feed `fault-api`'s document and a fixed header. So the headline "how does MY server hold up?" can't be answered from outside for failures upstream. Decision 1 is what to promise instead. The `fault-api` command is still useful for trying `serve`, as you did today.

## What already exists, so we don't compete with it

| Project | Does | What that means here |
|---|---|---|
| [`@modelcontextprotocol/conformance`](https://github.com/modelcontextprotocol/conformance) | The official suite. Checks the protocol, including OAuth resource server behaviour and message schemas | **We don't check conformance.** Reports say so and point to it |
| [`mcptokens`](https://pypi.org/project/mcptokens/), [PolicyLayer's token cost pages](https://policylayer.com/token-cost) | Count the tokens tool definitions use | C18 is expected, not a selling point. Known from search results, and I couldn't load `mcptokens`' own page, so neither gets named in the README until they've been read |

What's left for `prove` is the combination: **safe to run on a live server, says what it didn't check, and gives you something to share**. Its strongest half is `--self`, which nothing else can do, because it's about Crumple.

## The decision that matters: nothing is called unless you name it

C17 says `prove` never calls a tool that writes unless told to by name. **This spec goes further: it calls no real tool at all unless you name it.**

The obvious design is to call tools marked `readOnlyHint: true`. But that hint comes from the server being tested, and MCP's spec says clients must treat annotations as untrusted unless the server is trusted. A wrong hint on `delete_everything` would mean we deleted everything while checking how careful someone's server is.

Even sending bad arguments to an unnamed tool isn't safe: a server that doesn't validate may run it anyway.

So there's one rule, and a test holds a server with lying hints to it:

> **A hint can stop `prove`. It can never give it permission.**

| Situation | What `prove` does |
|---|---|
| A tool you didn't name | Reads its definition. Never calls it |
| A made-up tool name, random on each run | Calls it, because it can't exist |
| A tool you named | One call with your arguments, and one with a required argument missing, if it has one |
| A named tool with `--parallel` and `readOnlyHint: true` | Calls it that many times at once |
| A named tool with `--parallel`, without that hint | **Refused.** There's no flag to override this |

**What we give up:** a first run with no flags learns less. That's the right way round for a tool we hope people run on real servers.

## `prove <url>`: from outside

```bash
export CRUMPLE_PROVE_TOKEN="your key"      # optional, and never a flag
npx crumple-mcp prove https://you/mcp --call getCustomer --args '{"id":"1"}' --parallel 10 --out ./report
```

| Flag | Default | Why |
|---|---|---|
| `--call <tool>`, `--args <json>` | none | Names the one tool that may be called |
| `--parallel <n>` | none | At most 50. See the table above |
| `--max-requests <n>` | `30` | The budget, at most 500. Every request counts, and when it runs out the remaining checks become "not run" |
| `--timeout-ms <n>` | `10000` | For each request |
| `--out <folder>` | none | Writes `prove.md`, `prove.json` and `prove.svg` |

| Check | Sends | Passes when |
|---|---|---|
| `speaks-mcp` | `tools/list`, and any further pages | It answers, and the report states the protocol version |
| `tool-definitions` | Nothing more | Names are valid and unique, each has a description and an object schema. Estimates tokens (C18) |
| `refuses-no-token` | `tools/list`, no token | 401. Only runs if you gave a token |
| `refuses-bad-token` | `tools/list`, a random token | 401. Only runs if you gave a token |
| `refuses-foreign-origin` | `tools/list`, `Origin: https://prove.invalid` | 403, a MUST in the spec |
| `unknown-tool` | The made-up tool | A protocol error or `isError`, and not a 5xx or a hang |
| `malformed-request` | A body that isn't JSON | A 4xx, and not a 5xx or a hang |
| `named-tool` | Your tool | It answers. The report gives the latency |
| `bad-arguments` | Your tool, with a required argument missing | An error. MCP says servers must validate inputs |
| `parallel` | Your tool, n at once | No 5xx, hang or broken response. **A clear refusal such as a 429 is a pass**, and the report gives p50, p95 and how many were refused |

**An open server isn't a failure.** With no token given, if the server answers anyway, the report says "this answered with no credential" as a note. Some servers are public on purpose, including Latitude 10's docs server.

**Not run, always listed:** does the agent's token reach your API (C3), does a stored credential leak (C4), are writes applied twice (C5), do deadlines hold (C6), which failures get retried (C7), does it stop hitting a failing API (C8), can one caller starve another (C9). The report says why: `prove` can't see or break what's behind your server.

### The server being tested isn't trusted

It's someone else's code, or your own with a bug, and the output gets shared.

| A server could | So |
|---|---|
| Send you to another host, with your token | Redirects are never followed. A 3xx is reported |
| Hang, or never stop sending | A timeout per request and a 1 MiB read limit |
| Offer pages forever | At most 10 pages, within the budget |
| Put a Markdown link, an image or terminal codes in a tool name, to reach whoever reads the report | Names are escaped. **No other text from the server ever reaches the report or the screen**: no descriptions, no error messages |
| Tell the model to do something, in a description | There's no model here. Text is measured, never followed |

**Being polite and honest.** Requests go one at a time, apart from `--parallel`, and are never retried. The `User-Agent` says `crumple-mcp-prove`. A token is refused for plain `http://` unless it's going to this machine. Each run starts by saying:

```
Run this only on servers you own or may test. It sends at most 30 requests, and calls no tool you didn't name.
```

There's no "I own this" flag. We can't check it, so it would only be theatre. The limits are what make it gentle.

### Tokens per tool (C18)

A tool's definition goes to the model on every turn, so it costs money whether or not the tool is used. The report shows an estimate per tool and in total, largest first, on `name`, `description` and `inputSchema`:

```
estimated tokens = characters in the JSON / 4
```

It's labelled as an estimate everywhere. Anthropic's current tokenizer isn't published, and each client wraps tools differently, so an exact count isn't available here. **Task 27 compared this with Anthropic's token count on 2026-11-06:** on Claude Haiku 5.5 and Sonnet 5.5, 753 estimated and 1,206 counted for Crumple's six tools, a ratio of 0.62, and reports now say so. We don't add a dependency for a tokenizer, because that would give false precision about one provider's model. And there's no verdict such as "too many tools", because that depends on the agent.

## `prove --self`: Crumple, with failures on purpose

Each check starts its own Crumple in front of its own `fault-api`, on real ports on `127.0.0.1`, with a fault chosen in `upstreamHeaders`. Nothing is shared, so one can't disturb another.

| Claim | What it does | Passes when |
|---|---|---|
| C1 | No key, a wrong key and a key without the grant | Refused, and **`fault-api` received zero requests** |
| C2, the permission half | A read-only key calls `deleteCustomer` directly, as a stolen key could | Refused, nothing deleted, and the audit log has the attempt. The model half waits for `evals` (Task 28) |
| C3 | A normal call | The key appears nowhere in what arrived, **and the upstream credential did arrive**, so the check can't pass by seeing nothing |
| C4 | `echo-auth` | The credential isn't in the tool's output, spans, audit events or logs |
| C5 | `drop` on a payment | **Exactly one effect** in `fault-api`, and the error names the key to retry with |
| C6 | `hang` and `stall-body` | A structured error within the deadline plus 500 ms. The measured time is in the report |
| C7 | A 400, a 503, a 503 with `Retry-After` | One attempt, the configured attempts, and the wait honoured |
| C8 | Sustained 503s, then recovery | Calls fail with `circuit_open` while `fault-api`'s count stands still, then work again by themselves |
| C9 | One caller floods a slow API | A second caller still succeeds, and excess calls get `overloaded` rather than waiting forever |
| C10, the message half | Each failure above | Each error says whether retrying can help. The agent half waits for `evals` |

Short deadlines and a short breaker window keep it quick, because C16 gives `demo` 60 seconds and `demo` is built on this.

**A claim only passes when all of its parts ran.** C2 and C10 show as "partly checked" until `evals` exists. Other claims are listed as not run, with the task that brings them: C11 and C12 (Task 27), C13 (Task 28), C14 (`npm run test:interop`, which needs Python, so a stranger's `npx` run can't do it), C15 (`npm run test:workers`), C16 (Task 24), C17 and C18 (Task 23). Checkpoint D's "all 18 pass" is the last step, not this one.

### Can each check actually fail?

A check that can't fail proves nothing, and that's the main risk with a module whose job is printing "pass". So **every check has a test running it against a server that's deliberately wrong**, and the test requires it to fail.

That server is a small MCP server of about 100 lines, with the bad habits on switches: no auth, forwards the agent's token, puts the credential in its output, retries everything, no deadline, no breaker, no limits. It's written by us to be bad, and it isn't a stand-in for any real project.

A side effect: with `drop`, it really does charge twice. The owner approved showing that next to Crumple in `demo` (Task 24, 2026-11-05), so the server now lives at `src/cli/wrong-server.ts` and ships in the package.

## How it fits the map

`prove` may only depend on `fault-api`, so it can't start a Crumple itself. It doesn't need to:

```ts
export interface Check {
  id: string;
  claim?: ClaimId;
  needs: 'outside' | 'target';              // 'target' can't run on someone else's server
  run(context: CheckContext): Promise<CheckResult>;
}

/** What only a server's owner can see. --self supplies this, and <url> has none, so those checks don't run. */
export interface Target {
  url: string;
  keys: { read: string; write: string; other: string };
  upstream: { requests(): RecordedRequest[]; effects(): Effect[] };
  observed(): string;                        // every span, audit event and log line, for C4
  stop(): Promise<void>;
}
```

`src/cli/prove.ts` builds the real `Target` from `mcp-surface` and `fault-api`. That's the wiring the map already gives `cli`, so the map doesn't change. The test server plugs into the same place, which is what makes "can each check fail?" possible with no special cases.

### A hand-written client

`prove` speaks MCP through about 200 lines we write, rather than the official client.

| | Official client | Hand-written (chosen) |
|---|---|---|
| Sees status codes and headers | Hidden, and a 401 or a 403 is what's being tested | Yes |
| Can send something deliberately wrong | Not by design | Yes |
| Install | A third runtime dependency, which the main spec asks to avoid | None |
| Risk | Well tested | **Ours could be wrong on a real server** |

To reduce that risk, it's tested against Crumple on both protocols, a test server on the older one with sessions and streaming replies, and real servers (below). It tries 2026-07-28 first and falls back to `initialize` the way the spec describes, because 2026-07-28 is new and plenty of servers won't be on it yet. The old HTTP+SSE transport, which the spec deprecates, gets a clear "not supported".

## Reports

Three states, and the words matter:

| State | Means | Counted? |
|---|---|---|
| `pass` | It ran, and held | Yes |
| `fail` | It ran, and didn't hold | Yes |
| `not run` | It didn't run, with the reason | **Never.** No score hides it |

The shape, without real numbers, since those only come from a run:

```
crumple-mcp prove  https://you/mcp
  Protocol 2026-07-28, <n> tools, about <n> tokens per turn (estimate)

  pass     speaks-mcp
  pass     refuses-no-token
  FAIL     refuses-foreign-origin   answered 200, and the spec requires 403
  not run  bad-arguments            getCustomer has no required argument

  <n> passed, <n> failed, <n> not run. <n> of 30 requests used.
  Protocol conformance isn't checked here. For that: npx @modelcontextprotocol/conformance
```

- **Exit codes:** 0 when nothing failed, 1 when something did, 2 for a usage error. "Not run" doesn't fail, so it can go in CI.
- **Files:** `--out` writes Markdown and JSON from the same data. `npm run prove` runs `--self` and writes `proof/latest.md`, `.json` and `.svg` with the commit, date, OS, CPU, memory and Node version. **It leaves out the machine's name,** because this goes in a public repo. A dirty working tree is stated, and the numbers come from the run, never by hand.
- **Query strings are stripped** from the URL in a report, because that's where people put keys.

**The badge is a file, not a service.** `prove.svg` is written locally and says `3 passed · 1 failed · 7 not run`, never just "passing". A hosted badge would be a request to someone's server each time a README loads, which isn't what this package does. **The limit:** it's self-reported, so anyone could edit it. It's only as good as the JSON beside it and being able to run the command again.

**The Latitude 10 line.** One line at the end of the Markdown report, and never on the screen: *"Made with crumple-mcp, open source from Latitude 10, which also hosts MCP servers."* with a link. `SPEC.md` also plans a guide to fixing failures on latitude10.tech. A new page there has to pass Latitude 10's Build Gate, so **that guide goes in this repo's `docs/` for now**.

## How it's tested

| Test | Proves |
|---|---|
| Every check against the deliberately wrong server | Each one can fail |
| `--self` end to end, and a deliberately broken config | Task 22's "break it and the report fails" |
| A recording server counting every request (C17) | The budget holds, and with lying hints, only the named tool and the made-up one were called |
| A table of hostile servers: endless pages, redirect with a token, hang, huge reply, `<img>` and terminal codes in names | Nothing gets through to the report or the token |
| A table of report inputs, compared exactly | "Not run" is never counted, and escaping works |
| The client on 2026-07-28, on 2025-11-25 with sessions and streaming, and against a 404 | Both eras, and a clear answer for neither |
| `prove --self` from a packed tarball | It works after install, with no test framework |

Coverage: 95% of branches on the budget and the call rules, because that's C17's safety promise, and 85% for the rest.

**On real servers, before calling Task 23 done, on servers the owner owns only:** Latitude 10's keyless docs server, and its hosted MCP server. Under 30 requests each and no named tools, with results in `docs/clients.md`. Approving this spec approves those two runs. **They'd be the first real test of the hand-written client**, and I expect them to find something.

Also worth doing, though it belongs to C14: run the official conformance suite against `serve`. The permission system blocked the last `npx` download of an outside package, so that one may be yours to run.

## Honest limits

- **From outside, `prove` can't say whether your server survives a failing API.** That's the most interesting question, and it's the correction above.
- **It proves Crumple on one laptop,** not under production load or on Cloudflare. `prove:load` (Task 25) and the hosted demo add a bit, and neither makes it production-proven.
- **C2 needs a real model for the part that matters most.** Here it only shows the permission held.
- **Timing checks can flake on a very busy machine,** which is why C6 has a margin. If C6 fails on someone's overloaded laptop, the report will say so, and we won't widen the margin to hide it.
- **`--parallel` is a small burst, not a load test.** At most 50 calls tells you about obvious problems.
- **A passing report says little about security.** It checked a few things from outside. The report shouldn't be read as an audit, and its wording says so.

## Files

`src/prove/`: `client.ts`, `checks.ts` (types), `self-checks.ts`, `external.ts`, `definitions.ts` (pure, C18), `runner.ts` (budget, states, a crashing check is a `fail`), `report.ts` (pure: Markdown, JSON, SVG), `index.ts`. `src/cli/prove.ts` is the wiring and the real `Target`. `src/cli/wrong-server.ts` and `tests/helpers/recording-server.ts`. `npm run prove`. `proof/latest.md` and `.json`, committed. `docs/fixing-prove-failures.md`, then `docs/learn/prove.md`.

Task 22 is `--self`. Task 23 is `<url>`, the report's sharing parts and the real server runs.

## Decided

**1. What should `prove <url>` promise?** The main spec's "point your server at `fault-api`" barely works, for the reasons above.

- **A, chosen:** outside checks plus named tools, with `--parallel` as the honest part of "does it hold up?", and every failure check listed as not run. `SPEC.md`'s paragraph and README wording get corrected to match. What we give up: the punchy promise.
- **B, later if there's interest:** a *fault proxy*, sitting between someone's server and their real API and failing on command. It would properly answer the question for anyone's server. It's new work, and on writes it would be risky against a real API, so I'd save it until someone asks after launch.

**2. Nothing is called unless named?** Stricter than C17 as written. **Chosen: yes,** and C17's wording is updated. The alternative is calling tools marked read-only by default, which gives a richer first run and relies on the hint MCP's spec says not to trust.

**3. Local servers over stdio?** Many MCP servers run as a local process rather than a URL, and they couldn't use this as written: `npx crumple-mcp prove -- node server.js`. I haven't measured how many. It's about 60 more lines, with no dependency, and the HTTP-only checks would show as not run. **Chosen: yes, as the last slice of Task 23,** and the first thing to cut if time runs short. It widens who can try this at all, which is the point of the popularity goal.

## Verified on 2026-11-05

| Fact | Source |
|---|---|
| A server must validate `Origin`, and answer 403 when it's present and invalid | [Streamable HTTP, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) |
| How a client detects an older server and falls back to `initialize` | The same page, Backward Compatibility |
| Clients must treat tool annotations as untrusted unless the server is trusted | [Tools, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) |
| An unknown tool is a protocol error, invalid input is `isError`, and servers must validate inputs | The same page |
| The official conformance suite tests servers by URL, and covers OAuth for resource servers | [Its README](https://github.com/modelcontextprotocol/conformance) |
| Its README doesn't describe testing failure behaviour or token cost | The same page |

Not confirmed: what `mcptokens` does beyond a search summary, because its page wouldn't load. How Crumple's outside checks overlap with the conformance suite's in detail, because I read its README and not its scenarios.

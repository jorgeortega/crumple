# Spec: `mcp-surface`

Status: draft for the owner's review, 2026-11-04. Module on [the map](CAPABILITY-MAP.md), depending on `executor`,
`access-control` and `telemetry`. Two decisions need the owner, at the end.

## What it is

The part an agent actually talks to. It turns an OpenAPI document into MCP tools and serves them, and every call goes through
`access-control` and then `executor`. This is where the walking skeleton lands: the first real MCP call, end to end.

| Claim | What `mcp-surface` does for it |
|---|---|
| C14 it speaks real MCP | The official SDK serves it, and the official Python SDK, a separate implementation, lists and calls tools |
| C1 denied by default | No request reaches the upstream without a sign-in and a grant, which `fault-api` can finally count |
| C2 the model can't talk past a permission | Every call goes through one check that nothing can route around |
| C3, C4 credentials | No token is handed to the SDK, and only `executor` adds the upstream credential |
| C10 failures say what to do next | The executor's error reaches the model as a tool result it can read |
| C11 traces | Reads `traceparent` from `_meta` and joins the agent's trace |

## The decision that matters: one door for every call

**The obvious design has a hole, and the spike used it.** The usual way is to register only the tools a caller may use, once per request.
It gives a neat per-caller list, and calling a hidden tool gets "not found" from the SDK.

But the SDK answers that **before any of our code runs**. So when an injected instruction makes an agent try `delete_customer`, nothing is
recorded. The attempted delete is exactly the event C2 is about and the event an operator most wants to see.

So there's one handler for `tools/list` and one for `tools/call`, written by us:

```
POST /mcp
  |
  origin allowed?         or 403
  signed in?              or 401 / 503, before the body is read
  |
  the SDK: protocol version, headers, JSON-RPC, older clients
  |
  tools/list -> access.visible()
  tools/call -> access.authorize()     always runs, and always leaves an audit event
                  | refused: "Unknown tool"
                  v
                check the arguments    only now, so a refused caller learns nothing about the schema
                  v
                executor.call()        retries, deadline, breaker, limits
                  v
                outcome -> tool result
```

**Tested first, with a throwaway script** on 2026-11-04 (Node 26, and `workerd` through `wrangler dev`), using `McpServer`'s `.server.setRequestHandler`,
because the SDK marks the lower-level `Server` class as deprecated:

| Check | Node | `workerd` |
|---|---|---|
| The official TypeScript client lists and calls, pinned to 2026-07-28 and on its default 2025-11-25 | pass | pass |
| The official Python client negotiates 2026-07-28, lists and calls | pass | pass |
| Both clients raise a refused call as an exception with our message | pass | pass |
| A hidden tool and an unknown tool get the same answer, and both reach our audit | pass | pass |
| List results still carry `cacheScope: private` and `ttlMs: 0` | pass | pass |
| The SDK's validator refuses a bad argument when called directly | pass | pass |
| An empty token in `authInfo` is accepted, so no token goes to the SDK | pass | pass |
| A client that disconnects aborts the handler's signal | pass | **inconclusive** |
| `GET` gets 405, and an oversized body gets 413 | pass | pass |

**What this gives up:** we don't use the SDK's tool registry or its automatic argument validation. We call the same validator ourselves (`fromJsonSchema`), and
`docs/adr/0001-mcp-library.md` gets a note, since it showed the other pattern.

**A consequence:** a refusal is an exception in both official clients, not a result, so `agent-runner` has to catch it and hand it to the model.

**Not confirmed:** on Workers a disconnect may simply end the handler, which would explain the inconclusive row. The deadline holds either way, but "cancelling aborts the real request" stays a Node claim for now.

## From OpenAPI to tools

Copied from `openapi-agentify/src/openapi/convert.ts` (MIT, October Moon LLC), with its tests. It's the owner's own, and copying avoids that package's `typescript`, `zod` and `ajv`. Each
operation becomes one tool, whose input is its path, query and header parameters plus a `body`.

**Kept:** `$ref` handling (local only, so a document can't make us fetch a URL), 3.0 to 2020-12 schema conversion, cycle cutting, the 1,200-character description cap, name cleaning, and refusing
credential headers as parameters, using the list `executor` already has.

**Removed or changed:**

| In the copy | Here |
|---|---|
| `enabled`, `scope`, `price`, `x-agentify`, `x-mcp` | Gone. `access-control` decides who may use what |
| Writes imported switched off | **Every operation becomes a tool,** and writes stay invisible without a grant. Listing a tool isn't permission to use it |
| | `x-crumple-exclude: true` leaves an operation out, and `include`/`exclude` filter by name or tag, because every listed tool costs tokens on every turn (C18) |
| | Works out what the executor and policy need, below |

`deprecated` operations, cookies and non-JSON bodies are skipped, each with a warning. A schema the validator can't compile is also skipped with a warning, at start, rather than failing on the first call.

### The three facts each tool needs

Pure functions, tested by tables.

**`writes`** is `true` for anything but `GET` and `HEAD`. The policy reads it.

**`retry`**, from the approved `SPEC-executor.md`:

| Operation | Policy |
|---|---|
| `GET`, `HEAD`, or `x-crumple-safe-to-retry: true` | `safe` |
| Declares an `Idempotency-Key` header, in any capitalisation | `with_key` |
| Anything else | `never` |

**`expectsJson`** is true when a 2xx response declares JSON, so an HTML page in its place counts as `invalid_response`.

### The idempotency key argument

A `with_key` tool gets an optional `idempotencyKey` argument, even when the API marks its header required, because the executor makes one when it's missing. The name is reserved, so an API's own
parameter with that name gets renamed. Its description tells the model when to use it: only to repeat a call that came back with `outcome_unknown` and a key.

That's what lets the error "call again with idempotencyKey a1b2" work, and the evals test that a real model follows it.

## What the agent gets back

| Outcome | MCP result |
|---|---|
| Success | The response body as text |
| A failed call | `isError: true`, with the executor's error as JSON text: `code`, `message`, `retry`, and `retryAfterMs`, `idempotencyKey` or `detail` when present |
| Bad arguments | `isError: true`, with the validator's message, so the model can fix the call. Nothing is sent upstream |
| Refused or unknown tool | JSON-RPC error `-32602`, below |

MCP tells clients they **SHOULD** pass tool results to the model, so `isError` is how C10 reaches it. The result is untrusted text whichever way it arrives, and no wrapping changes that, which is why permissions don't depend on the model (C2).

## Signing in, and the rest of the wire

**Every request signs in first,** including `tools/list` and `server/discover`, before the body is read. MCP requires authorization on every HTTP request. So a stranger costs a header check and nothing else.

**No token is given to the SDK.** It gets `authInfo` with an empty `token` and the `Principal` in `extra`, so a later SDK feature can't forward what it never had.

**Origin.** MCP says servers **MUST** validate `Origin` to prevent DNS rebinding, and answer 403 when one is present and invalid. A request with an `Origin` is refused unless it's on `allowedOrigins`, which starts empty, so browsers are refused by default and
CLI clients, which send none, are unaffected. An optional `allowedHosts` adds the `Host` check, and `SPEC-cli.md` sets it for a local server.

**Protected Resource Metadata** is served at the address `access.resourceMetadata()` gives, without signing in, as RFC 9728 intends. With API keys alone it's a 404.

**Limits on the request:** a 1 MiB body, down from the SDK's 4 MiB, since tool arguments shouldn't be near that.

### What the SDK does for us

Protocol versions, `server/discover`, the `Mcp-Method` and `Mcp-Name` header checks, JSON-RPC errors, `cacheScope`, older clients, 405s and 413s. We don't touch these, and that's the point of using it.

## Traces

```
tools/call get_customer     server span, joined to the agent through _meta.traceparent
  authorize
  execute
    GET /customers/{id}     one per attempt
```

Span names and attributes follow OpenTelemetry's MCP conventions, already on the allowlist. Tool failures set `error.type=tool_error`, as the conventions say. A refused call shows `authorize` and no `execute`, which is the proof in picture form.

**A change to `access-control`:** signing in happens before the body is read, so the trace id isn't known yet, and every call would leave a second, orphaned trace. So only a **refused** sign-in writes a span, and a successful one's time goes on the server span as a new attribute, `crumple.auth_ms`. That still shows a slow fetch of an issuer's keys.

**A second change:** `scopesFor()` goes, because decision 2 leaves nothing using it.

## The interface

`cli` may only import `mcp-surface` and `fault-api`, by the map. So this module builds the executor and access control, and its `index.ts` re-exports what `cli` needs: `createKey`, the key store, credentials and the telemetry sinks.

```ts
const { tools, warnings } = convertOpenApi(document, { exclude: ['internal'] });

const surface = createMcpSurface({
  tools,
  upstream: { baseUrl: 'https://api.example.com', getCredential, headers: { 'x-fault': 'hang' } },
  access: { keys, jwt },
  telemetry,
  audit,
  path: '/mcp',
  allowedOrigins: [],
  allowedHosts: ['localhost'],
});

await surface.fetch(request);    // web-standard, so node.ts and Workers are both thin
```

It takes a parsed document. Reading files and YAML belongs to `cli`, since this module also runs on Workers.

## What it won't do

- **Tools only.** No resources, prompts, subscriptions, tasks, progress or asking the user for input. An API maps to tools, and the rest would be features nobody here has asked for.
- **No output schemas or `structuredContent`.** They'd add to what every turn costs in tokens, and the body is already JSON text.
- **A big response is costly.** The 1 MiB cap protects the server, not the budget: at a rough four characters a token, a full response is about 250,000 tokens. It's a setting, and it needs a real look in `SPEC-evals.md`.
- **No paging of the tool list,** and nothing stops a 500-tool list, which `prove` will show the cost of (C18). `exclude` is the answer for now.
- **Validators differ by runtime:** Ajv on Node and cfworker in `workerd`, chosen by the SDK. Their messages differ, so tests check that a call was refused rather than its wording, and the API behind Crumple must still validate its own input.
- **No CORS.** Browser-based clients are out until someone asks.
- **stdio isn't here.** Crumple serves HTTP. Task 21 finds out how much that matters to real clients.

## How it's tested

| Test | Proves |
|---|---|
| The copied converter's tests, plus a table for `writes`, `retry` and `expectsJson` | Conversion, and the executor gets the policy it was promised |
| `fault-api`'s own OpenAPI document converts, and its payment tool becomes `with_key` | The module's own example works |
| No key, a bad key, no grant: `fault-api` receives **zero** requests | **C1, end to end at last** |
| A hidden tool and an unknown tool: identical answers, and an audit event for both | C2, and the reason for one door |
| Arguments on a refused call aren't validated, so bad ones change nothing | A refused caller learns nothing |
| `fault-api`'s header log, through real MCP, for a key and a JWT | C3 |
| `echo-auth` through MCP: absent from the tool result, spans and audit | C4 |
| `drop` on a payment: the model gets `outcome_unknown` with a key, and a repeat with that key leaves one effect | C5 and C10 across the whole stack |
| `traceparent` in `_meta` becomes the trace's parent, and no argument appears in any span | C11, and the telemetry rule |
| `tools/list` is `cacheScope: private` | One caller's tools can't be cached for another |
| An `Origin` that isn't allowed gets 403, and none is fine | MCP's rule |
| No token reaches the SDK | The `authInfo` choice |
| Both protocol eras, by raw JSON-RPC and with the official TypeScript client as a dev tool | Decision 1 |
| `tests/python-interop/`: the Python SDK lists, calls and gets refused, run by `npm run test:interop` | **C14** |

Over real sockets through `node.ts`, not only in process, for the C1, C3 and C5 rows. `prove` repeats all of it later as the public check. `workerd` waits for Task 29.

85% branch coverage here, as the main spec sets, and the policy and the executor already sit at 95%.

**New dev tool to disclose:** `@modelcontextprotocol/client`, which never ships. It's how the test uses "the client most people get by default". `@modelcontextprotocol/server` 2.4.0, the current release, joins as the first runtime dependency, and it's one of the two the spec allows.

## Files

`src/mcp-surface/`: `index.ts`, `convert.ts` (copied), `facts.ts` (`writes`, `retry`, `expectsJson`), `server.ts`, `results.ts`, with tests alongside, and `tests/python-interop/`. Task 18 builds them: conversion, then the server, then interop.

## Decisions for the owner

**1. Keep serving older clients** (the 2025 protocol, through `legacy: 'stateless'`). The spike found that the official TypeScript client negotiates 2025-11-25 unless told otherwise, so a 2026-only server would turn away the SDK's own default. Keeping them is one setting, and the
cost is that the tests must cover two protocol eras. The alternative is a simpler claim, "2026-07-28 only", at the cost of first-run failures for anyone on an older client. I recommend keeping them, and revisiting when clients move.

**2. A refused call looks like an unknown tool, for everyone, including JWT callers.** It's a JSON-RPC `-32602`: "Unknown tool: delete_customer. It may not exist, or this caller may not be allowed to use it." That's what MCP lists for an unknown tool, and it reveals nothing while still telling a confused person where to look. The audit log holds the real reason.

This **differs from what the approved `SPEC-access-control.md` proposed,** which was a readable tool error for keys and a 403 for JWTs:

- **The 403 is a SHOULD in MCP that this wouldn't follow.** It tells a client to get a token with more scopes, and clients acting for a person **SHOULD** attempt that. So an injected instruction could lead to a sign-in screen asking the user to approve more access. I'd rather the attack stops at a refusal. A client can still request more scopes up front, from the metadata's `scopes_supported`. The README will say we don't follow this one, and why.
- **A tool error would reach the model more reliably,** since clients only **MAY** show it a protocol error, and both official clients raise it as an exception. But an agent that never saw the tool in its list has nothing to recover to. The cost is that some stock clients may show a refusal less clearly, which Task 21 will show.

I recommend this. The alternative is following MCP's 403 for JWTs, at the cost of a second code path, reading the body before signing in, and that consent screen.

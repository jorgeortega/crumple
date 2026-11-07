# `mcp-surface`: the part an agent talks to

Spec: [SPEC-mcp-surface.md](../../SPEC-mcp-surface.md). Code: [src/mcp-surface/](../../src/mcp-surface/).

## The one-sentence version

It turns an OpenAPI document into MCP tools and serves them, with every call going through one door: the permission check, then the executor.

## The central idea: one door for every call

**The obvious design has a hole, and the first spike used it.** The usual way is to register only the tools a caller may use. It gives a neat per-caller list, and calling a hidden tool gets "not found" from the SDK.

But the SDK answers that **before any of our code runs**. So when something tries `delete_customer` without permission, nothing is recorded, and that's an event an operator wants to see.

So there's one handler for `tools/call`, written here:

```
POST /mcp
  origin allowed?         or 403
  signed in?              or 401 / 503, before the body is read
  the SDK                 versions, headers, JSON-RPC, older clients
  access.authorize()      always runs, and always leaves an audit event
                            refused: "Unknown tool"
  check the arguments     only now, so a refused caller learns nothing about the schema
  executor.call()         retries, deadline, breaker, limits
  outcome -> tool result
```

**This is the story to tell.** It came from asking "what evidence does this leave?" rather than "does it refuse the call?". The usual design does refuse correctly. It just leaves no trace of the attempt.

**And tell it accurately, because I first got this wrong.** I wrote that an injected instruction would make an agent try the delete. Testing real Claude Code showed it can't: with no grant, the tool isn't listed, so the model has nothing to call. The attempt comes from something calling an unlisted tool directly, such as a script with a stolen key, or a stale tool list. Hiding the tool is what stops the injected model, and the one door is what records everyone else.

## From OpenAPI to tools

One operation becomes one tool, whose input is its parameters plus a `body`. Three facts get worked out, each a pure function with a table of tests:

| Fact | Rule | Who reads it |
|---|---|---|
| `writes` | Anything but `GET` and `HEAD` | The policy |
| `retry` | `safe`, `with_key` or `never` | The executor |
| `expectsJson` | A 2xx response declares JSON | The executor, to spot an HTML error page |

**`writes` and `retry` are separate on purpose.** A `PUT` marked safe to retry is still a write, and needs a write grant.

**Every operation becomes a tool, writes included.** Listing a tool isn't permission to use it, and writes stay invisible without a grant. That's a change from `openapi-agentify`, the code this was copied from, where the switch lived in the tool list.

**`$ref`s are local only,** so a document can't make Crumple fetch a URL.

## The idempotency key, end to end

This is the one place you can follow the whole project's main claim in one go:

1. An API declares an `Idempotency-Key` header, so the tool is `with_key`, and gets an optional `idempotencyKey` argument.
2. The executor makes a key, and sends the same one on every attempt.
3. The response is lost three times. The model gets `outcome_unknown`, with the key, and "to retry safely, call again with idempotencyKey a1b2".
4. It calls again with that key. `fault-api` shows **one effect**.

A test runs exactly this over real sockets.

## A refusal looks like an unknown tool

Everyone gets the same answer, a JSON-RPC `-32602`: "Unknown tool: delete_customer. It may not exist, or this caller may not be allowed to use it." That's what MCP lists for an unknown tool, and the audit log holds the real reason.

**We don't follow one MCP recommendation here, on purpose, and you should be able to say why.** MCP says a JWT with too few scopes SHOULD get a 403, and clients acting for a person SHOULD then try to get more access. So an injected instruction could lead to a sign-in screen asking the user to approve more. We'd rather the attack stops at a refusal. It's a SHOULD, not a MUST, and the README will say so.

## No token reaches the SDK

The SDK gets `authInfo` with an **empty** token, and the caller's identity in `extra`. A later SDK feature can't forward what it never had. That's the same idea as `access-control`'s `Principal`: make the mistake impossible rather than remember not to make it.

## Stories from building it

All real:

- **Testing the design first changed it twice.** The first script used the SDK's low-level `Server` class, which it turned out to mark as deprecated, so it moved to `McpServer`'s `.server`. And the MCP spec lists "unknown tool" as a protocol error, so a refusal stopped being a tool result. Reading the source beat assuming, both times.
- **Rerunning found a gap in my own evidence.** After changing the design, some rows in the results table still came from the old script, and the Python run had ended in a traceback I'd only half read. Rerunning everything confirmed the table, and answered a question: both official clients raise a refusal as an exception, so `agent-runner` has to catch it.
- **A bug in the copied code.** A third tool with one name came out as `same_2_3`, because the loop kept adding to the previous attempt. A new test found it.
- **14 tests failed at once, and the code was fine.** My test's instant fake `sleep` also drove the executor's deadline, so every call expired immediately. Seeing that they all failed the same way pointed at the test rather than at 14 bugs.

## Honest limits

- **Tools only.** No resources, prompts, subscriptions, or progress.
- **A big response is expensive.** The 1 MiB cap protects the server, not the budget. At a rough four characters a token, a full response is about 250,000 tokens.
- **No paging of the tool list,** and every listed tool costs tokens on every turn. `exclude` is the answer for now.
- **Some clients may show a refusal less clearly.** Both official clients raise it as an exception. Claude Code never reached that point, because the tool wasn't listed. Other clients are in `docs/clients.md`.
- **Validators differ by runtime,** Ajv on Node and cfworker on Workers, so the API behind Crumple must still validate its own input.
- **On Workers, whether a disconnect cancels the upstream call is unconfirmed.** The deadline holds either way. Cancelling is only proved on Node.
- **On Workers, it's only been run as the hosted demo.** `npm run test:workers` runs that in `workerd`, and it's live on Cloudflare. See [hosted-demo.md](hosted-demo.md).
- **Install size.** The SDK brings about 18 MB. `SPEC-cli.md` measured that and chose to keep it.

## Where to look

[server.ts](../../src/mcp-surface/server.ts) is the door, and short enough to read whole. [facts.ts](../../src/mcp-surface/facts.ts) is the three rules. [sockets.test.ts](../../src/mcp-surface/sockets.test.ts) has the claims over real sockets, and [interop.run.ts](../../tests/python-interop/interop.run.ts) is C14.

## Teach-back

1. Why not just register only the tools a caller may use? The SDK would refuse the rest correctly, so what's wrong with that?
2. A refused call gets "unknown tool", not a 403. MCP recommends the 403 for tokens with too few scopes. Why don't we follow it, and what does that cost?
3. Why does the argument check come after the permission check, and not before?
4. Follow a payment whose response is lost three times, from the agent's first call to the moment `fault-api` shows one effect.
5. **Where would you change this?** "We want tools that can return images." Which file changes, and which other module would have to change as well? (Look at what `Outcome` holds.)

# 0001: Use the official MCP SDK on both runtimes

Status: accepted, 2026-11-04. Result of Task 4. The full output is in
[spikes/mcp-sdk/results.txt](../../spikes/mcp-sdk/results.txt), and
`spikes/mcp-sdk/run-all.sh` produces it again.

## The question

Crumple's runtime is on Node and its public demo is on Cloudflare Workers. The spec
chose the official TypeScript SDK, but nothing said it worked on Workers or served
MCP revision 2026-07-28 properly. If it didn't, the fallback was to write the protocol
layer ourselves from Latitude 10's `app/mcp/_lib/modern.ts`. That was the one unknown
that could change the design, so it was tested before anything else.

## The decision

Use `@modelcontextprotocol/server` 2.x on both runtimes, through `createMcpHandler`.
The fallback isn't needed.

```ts
const handler = createMcpHandler(({ authInfo }) => buildServerFor(authInfo));

// On Workers, that's the whole adapter:
export default { fetch: (request) => handler.fetch(request, { authInfo }) };
```

## What was tested

One small server, the same file on both runtimes, with two official clients against it.

| Check | Node 22.13.1 | `workerd` |
|---|---|---|
| Official TypeScript client pinned to 2026-07-28 negotiates it | pass | pass |
| Official Python client negotiates 2026-07-28 on its own, lists and calls | pass | pass |
| A plain JSON Schema (not zod) reaches clients unchanged | pass | pass |
| A bad argument is refused by that schema, and the tool never runs | pass | pass |
| The tool list differs by caller; a hidden tool can't be called | pass | pass |
| `traceparent` in `_meta` reaches the tool | pass | pass |
| An older 2025 client, and a client on default options, still work | pass | pass |

Those results cover the requirements later modules lean on: per-caller tool lists (C1),
JSON Schema from OpenAPI (`mcp-surface`), trace context (C11) and real MCP (C14).

## What we learned

1. **The package name in the spec was wrong.** `@modelcontextprotocol/sdk` is still
   1.32.2. Version 2 is split into `@modelcontextprotocol/server` and `/client`. The
   spec and the dependency test now say so.
2. **Authentication stays ours, cleanly.** The SDK doesn't read auth headers itself. We
   verify the caller first and pass the result in as `authInfo`, which is where `access-control`
   was going to sit anyway.
3. **A fresh server per request is affordable.** That's how the SDK works, and it's what
   makes a per-caller tool list simple. Median cost per `tools/call` was 0.10 ms with 1
   tool and 0.51 ms with 1,001, in process on one laptop. The SDK loads in about 35 ms.
   These are rough numbers for spotting a problem, not results to publish.
4. **Older clients are the default, not an edge case.** The TypeScript client negotiates
   2025-11-25 unless told otherwise, so a server speaking only 2026-07-28 would turn away
   the SDK's own default client. The `legacy: 'stateless'` setting serves both from one
   factory at almost no cost. `SPEC-mcp-surface.md` should keep it, and the owner decides
   there.
5. **The first run proved less than it seemed to.** It showed 10 of 10 passing, but the
   client had silently used the older protocol and one check couldn't fail. The tell was
   a line printed underneath the results. `prove` must check which version was actually
   negotiated rather than assume it.
6. **A per-caller tool list has to stay marked private.** The changelog says list results
   carry `cacheScope`, which tells shared caches whether they may keep them. Our lists
   differ by caller, so a `public` one could show one caller's tools to another. The SDK
   sent `private` with `ttlMs: 0` in the spike. `SPEC-mcp-surface.md` should add a test.
7. **Avoid `responseMode: 'json'`.** It prints a warning on every start. The default,
   `auto`, sends plain JSON anyway unless a tool streams something first.

## What it costs

- **Install size.** The server package and `yaml` come to 18 MB: 8.1 MB is `zod`, which
  the SDK requires, and most of the 7 MB server package is source maps and duplicate
  builds. That's slow for a first `npx`. The whole Workers bundle is only 670 KiB
  (134 KiB gzipped), so publishing a single bundled file would fix it. `SPEC-cli.md`
  decides. `esbuild` is already on the approved tools list for this.
- **Less control over the wire.** The SDK decides details such as the exact error text.
  A protocol bug there is one we'd wait on, or work around.

## Still open

- **A third runtime dependency?** `prove` and `agent-runner` need an MCP client, and
  `@modelcontextprotocol/client` would be a third dependency beyond the spec's two.
  `prove` has to send deliberately malformed requests anyway, which argues for a small
  hand-written client there. `SPEC-prove.md` proposes this and the owner decides. The
  dependency test refuses the package until then.

## Not tested

- A real Cloudflare deployment. `workerd` ran locally through `wrangler dev`, and nothing
  was deployed. Task 31 covers this.
- Stock clients such as Claude Code. Task 21 covers this.
- stdio. Crumple serves HTTP only, so `serve` needs a real test with clients that prefer
  stdio.
- Host and Origin checks on a local server. The SDK exports `validateHostHeader` and
  `validateOriginHeader`, but a local server must actually use them, or a web page could
  reach it through DNS rebinding. `SPEC-cli.md` must include this.

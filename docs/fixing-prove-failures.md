# Fixing what `prove` found

Each section is a check that can fail, what it means, and what to do. A failure here means this one thing didn't hold. A clean report doesn't mean a server is secure.

## `speaks-mcp`

It couldn't list your tools over MCP.

- **Check the address.** It usually ends in `/mcp`, and a redirect isn't followed, so use the final one.
- **"The token you gave was refused":** check `CRUMPLE_PROVE_TOKEN`.
- **Old HTTP+SSE servers aren't supported.** MCP deprecated that transport. Move to Streamable HTTP.

## `tool-definitions`

A model chooses tools by reading their definitions, so a bad one causes wrong calls.

- **Give each tool a description** that says what it does and when to use it.
- **Use only letters, digits, `_`, `-` and `.` in names,** which is what MCP advises, and keep each one unique.
- **Make `inputSchema` an object schema,** even for a tool with no arguments: `{ "type": "object" }`.

## `refuses-no-token` and `refuses-bad-token`

You gave a token, so this server should need one, and it answered without a valid one.

Check every request's credential before doing anything else, and answer `401` with a `WWW-Authenticate` header. If the server is meant to be public, run `prove` without a token, and these won't run.

## `refuses-foreign-origin`

A request said it came from a website you don't know, and the server answered. MCP's spec says a server must validate `Origin` and answer `403` when it's present and invalid, to stop a website reaching a server through someone's browser ([Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)).

```ts
const origin = request.headers.get('origin');
if (origin !== null && !allowedOrigins.includes(origin)) return new Response(null, { status: 403 });
```

Clients that aren't browsers send no `Origin`, so they aren't affected.

**How much this matters depends on the server.** It's most serious for a server on `localhost`, or one that signs in with cookies, because a website can reach those from inside someone's browser. It matters less for a public server with bearer keys, since a browser won't add one by itself. It's still a MUST in the spec, and the fix is a few lines.

## `unknown-tool`

A call to a tool that can't exist either answered as if it did, or caused a `5xx`. Answer with a JSON-RPC error, code `-32602`. If a made-up name gets a success, a typo from a model will too, and the model will believe it worked.

## `malformed-request`

A body that isn't JSON caused a `5xx`, or got no error. Answer `400`. A `5xx` here usually means the parser's error isn't caught, and anyone can trigger that.

## `named-tool`

The tool you named didn't answer properly. A protocol error often means your `--args` don't match its schema, so check those first. A `5xx` or a timeout is the server's.

## `bad-arguments`

With a required argument missing, your tool ran anyway, or caused a `5xx`. MCP says servers must validate inputs. Validate against `inputSchema` before running anything, and answer with `isError: true` and a message saying what's wrong, so the model can correct itself.

## `parallel`

Some calls in a burst got a `5xx`, a hang or a broken answer. Refusing clearly is fine, and a `429` counts as a pass. What to look at:

- **Limit how many calls run at once,** and refuse the rest rather than queueing them without limit.
- **Give each upstream call a timeout.** A hang under load is usually a call nobody limited.
- **Look for shared state** that a burst could corrupt, such as one connection or a counter.

## What this can't tell you

`prove` can't see behind your server, so it can't say whether a failing API is handled well: whether writes apply twice, deadlines hold, or the agent's token reaches your API. Those need control of the API, which is what `prove --self` has on Crumple. You could test the same things on your own server by making your API fail on purpose.

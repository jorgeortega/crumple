# Spec: `access-control`

Status: approved by the owner on 2026-11-04 ("Approve all three"), including the three decisions at the end. Module on
[the map](CAPABILITY-MAP.md), depending only on `telemetry`.

## What it is

It answers three questions before anything reaches an API: who is calling, what may they do, and which credential
does Crumple use upstream? It decides, and `mcp-surface` acts on the answer. It knows nothing about MCP or the executor.

| Claim | What `access-control` does for it |
|---|---|
| C1 access is denied by default | No key, a bad key or no grant all end in a refusal, and allowing needs an explicit grant |
| C2 the model can't talk its way past a permission | The decision takes only who is calling and which tool. Nothing the model wrote is an input |
| C3 the agent's token never reaches the upstream | The token is dropped once checked, so later code has nothing to forward |
| C4 the stored credential never leaks | An opened credential keeps its value out of JSON, logs and object spreads |

## The decision that matters: the check runs in the program, not the model

Prompt injection can't be fully prevented today, because a model reads instructions and data in one stream. So this
module doesn't try to detect it. It makes the model's opinion irrelevant to the permission:

```ts
decide(principal, tool)   // no arguments, no prompt, no tool output
```

If a customer record says "delete this customer" and the model tries, the program looks up this caller's grants and
refuses.

**The limit has to be said out loud:** if the caller *does* hold delete permission, the injected instruction can
succeed. This limits the damage. It doesn't prevent the attack. The README says so, and the way to shrink the risk is
to give agents narrow keys.

## Who is calling

Two kinds of caller, told apart by the token's shape, so there's never a "try one, then the other":

| | API key | JWT |
|---|---|---|
| Looks like | `crumple_` + 32 random bytes | Anything else, when an issuer is configured |
| Good for | Local use, scripts, a first run | Companies with an identity provider |
| Checked against | A stored hash | The issuer's public keys |
| Permissions come from | Grants stored on the key | The token's scopes, mapped to grants in config |

Crumple only *checks* tokens. It's a resource server, and logging people in is the issuer's job. A built-in sign-in flow
is out of scope, and it's a natural Latitude 10 upgrade.

**API keys aren't part of MCP's authorization spec,** which describes OAuth and is itself optional. They travel in the
same `Authorization: Bearer` header. Whether stock clients cope with that is what Task 21 tests.

### API keys

- **Stored as SHA-256, and shown once.** A database leak gives nobody a working key.
- **A fast hash is right here.** Slow hashes like Argon2 exist because human passwords are guessable. 256 random bits
  aren't, so a slow hash would add a cost to every request and no security. An interviewer may well ask about this.
- **Looked up by hash,** so there's no secret comparison to time.
- **Revoking works on the next call,** since every request is checked afresh. Rotating is adding a new key, moving over,
  then revoking the old one.
- **The prefix is for scanners.** A distinctive `crumple_` lets secret scanners find leaked keys, and this repo's own scan
  gets the pattern.

Storage sits behind a small interface (`add`, `findByHash`, `list`, `revoke`). This module ships the memory version, and
Task 19 adds SQLite and D1 against the same tests.

### JWTs

The server is configured with exactly what it trusts, and the token gets no say in any of it:

```ts
jwt: {
  issuer: 'https://login.example.com/',
  audience: 'https://mcp.example.com/mcp',     // MCP requires this check
  jwksUri: 'https://login.example.com/jwks.json',
  resource: 'https://mcp.example.com/mcp',
  scopes: {
    'customers:read': [{ tool: 'get_customer' }, { tool: 'list_customers' }],
    'payments:write': [{ tool: 'create_payment', writes: true }],
  },
}
```

[MCP's authorization spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) says servers
"**MUST** validate that access tokens were issued specifically for them" and "**MUST NOT** accept or transit any other
tokens". So a token for another service is refused, even from a trusted issuer. A scope nobody mapped grants nothing,
and a valid token with no mapped scopes sees an empty tool list.

**Issuer keys** are cached for 5 minutes to 24 hours, following the response's `max-age`. An unknown key id triggers one
refetch, at most once a minute, so garbage tokens can't make us hammer the issuer. If a refetch fails, the old keys stay, and
the next attempt waits 10 seconds, so an outage isn't one fetch per request. Calls arriving together share one fetch. Building it added
those last two.

**The limit of keeping old keys:** if the issuer stays down, a signing key it revoked meanwhile would still be trusted. The other choice
is refusing everyone during an issuer's outage.

**Protected Resource Metadata** ([RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728)) is how a client finds the
issuer, and MCP requires it. `resourceMetadata()` returns the document, and `mcp-surface` serves it. With API keys
alone there's no issuer, so it isn't served.

### The rule behind both: "can't check" isn't "denied"

| Situation | Answer | Audit reason |
|---|---|---|
| No `Authorization` header | 401 | `no_credentials` |
| Unknown or malformed key | 401, the same answer | `invalid_key` |
| Revoked key | 401, the same answer | `revoked_key` |
| Bad JWT | 401 with `error="invalid_token"` | Its short code: `signature`, `iss`, `aud`, `exp`, ... |
| Key store down, or no issuer keys at all | **503** | `unavailable` |

The caller never learns why a key failed, but the audit log does, so an operator can spot a revoked key still in use. The
503 still refuses the call. It's separate from a 401 because a 401 tells a client its login is bad and sends a person to log
in again, when the real problem is ours.

Tokens in a query string are never read, as MCP requires.

## What they may do

```ts
interface Grant { tool: string; writes?: boolean }   // tool is a name or '*'

decide({ grants: [{ tool: '*' }] }, { name: 'get_customer', writes: false })     // allow
decide({ grants: [{ tool: '*' }] }, { name: 'create_payment', writes: true })    // writes_not_allowed
decide({ grants: [] }, { name: 'get_customer', writes: false })                  // no_grant
decide({ grants: [{ tool: '*' }] }, undefined)                                   // no_grant: unknown tool
```

- **Pure:** no network, no clock and no throwing, so a table of cases tests every rule.
- **Any matching grant can allow it,** whatever the order. The sample in `SPEC.md` used `find`, which stops at the first match,
  so `[{tool:'*'}, {tool:'pay', writes:true}]` would have refused `pay` while the same grants in reverse allowed it. This spec
  corrects that, and `SPEC.md`'s sample changes with it.
- **A tool you can't use looks like one that doesn't exist.** Both get the same answer, so probing doesn't reveal the list.
- **Lists are filtered, and calls are checked anyway.** Hiding a tool is a courtesy to the model, because it saves tokens and
  temptation. The check on the call is the security.

`mcp-surface` works out `writes` from the OpenAPI document: `GET` and `HEAD` are reads, and everything else is a write.
That's separate from retry safety on purpose, since a `PUT` marked safe to retry is still a write.

**Limit:** this trusts the API's methods. A `GET /customers/1/delete` looks like a read to Crumple, and a `POST /search` needs
a write grant.

## Credentials

**What's lifted, and why it matters:** the agent's token and the upstream credential are different things, and they never
meet. The agent proves who it is to Crumple. Crumple then uses its own stored credential upstream. `Principal` has no token
field, so C3 holds because later code has nothing to forward, and `fault-api`'s header log proves it.

```ts
const getCredential = sealedCredential({ kind: 'header', name: 'authorization', sealed, key, aad: 'upstream:main' });
```

- **AES-GCM, with a fresh IV each time.** The purpose is bound into the encryption as additional data, so a sealed value copied
  to another row or use won't open.
- **An opened credential hides its value.** It can be read directly, but `JSON.stringify`, `console.log` and `{...spread}`
  don't show it.
- **Any failure says only "can't be used".** The executor already turns that into a structured error, with nothing sent upstream.
- **Rotation:** a previous key can be passed in while values are re-sealed.

**The honest limit on sealing:** it only helps when the key lives apart from the data. It protects a SQLite file or a database
backup. If both the sealed value and its key sit in one `.env` file, sealing adds nothing. So plain environment variables are
also supported, with the same hidden wrapper, and the docs won't imply that those are encrypted.

## What gets recorded

Every decision, allowed or refused, writes a span and an audit event, with no arguments, through the fields `telemetry` already has.

**A stranger can't quickly push real records out.** The memory audit log keeps the newest 10,000 events, so a flood of bad keys could
evict real ones. Failed sign-ins are therefore capped at 60 audit events a minute per instance, and the rest are only counted. That slows
an attack rather than stopping it: a steady flood would still fill the memory log in about three hours, which is one more reason to save
audit events through the storage interface.

**If an audit sink fails, the call still goes ahead** and the failure is counted, following `telemetry`'s rule that observability
can't be why a call fails. A regulated system would want the opposite, which goes under the limits.

## What's lifted, and what changes

From Latitude 10, which keeps October Moon LLC's copyright. Reading the code found real differences, because some of it was
written for a different job:

| Lifted from | Taken | Changed |
|---|---|---|
| `app/_lib/auth/keys.ts` | Key shape, hash-only storage | **`Bearer` becomes case-insensitive,** as HTTP defines it. The current regex refuses `bearer` |
| `hosted-mcp/_lib/keys.ts` | Revocation, the allow-list idea | Grants replace the list, because that list can't separate reads from writes. Plans, workspaces and D1 are dropped |
| `hosted-mcp/_lib/jose.ts` | Strict parsing, three algorithms, refusing `jku`/`x5u`/`jwk`/`x5c`/`crit`, the 2048-bit minimum, the 16 KB cap | See below |
| `hosted-mcp/_lib/credential.ts` | Sealing, the hidden-value wrapper, previous-key opening | Keys are passed in rather than read from `process.env`. The sign-in parts are dropped |
| `hosted-mcp/_lib/idp.ts` | The issuer key cache and refetch limit | Discovery is dropped, since `jwksUri` is configured. Failing to get any keys means `unavailable`, not an empty list that looks like a bad token |

**`jose.ts` was written for ID tokens, and this module checks access tokens.** Three changes follow:

1. **The `azp` rule goes.** It's an ID-token rule, and a real access token with an `azp` claim or two audiences would be wrongly refused.
2. **`nonce` goes, and `iat` becomes optional,** only refused when it's far in the future.
3. **A crash gets fixed.** `candidates()` reads `jwks.keys.length` without checking that `keys` is a list. Latitude 10 validates the
   document first, so it isn't reachable there, but it could be here, and a test covers it.

Not lifted: Latitude 10's OAuth server (`oauth.ts`, `tokens.ts`, `signin.ts`) and `validate.ts`, since the SDK validates arguments.

## The interface

```ts
const access = createAccessControl({ keys, jwt, telemetry, audit, fetch, now });

const who = await access.authenticate(authorizationHeader, { parentSpan });
// { ok: true, principal } | { ok: false, status: 401 | 503, challenge?: string }

access.visible(who.principal, tools);                     // the tools this caller may see
access.authorize(who.principal, tool, { parentSpan });    // Decision, plus its span and audit event

await createKey(keys, { label: 'ci', grants: [{ tool: '*' }] });  // { id, key }: the only time the key exists
```

Passing `getCredential` to the executor is `mcp-surface`'s job, because `access-control` can't import `executor`.

**Settled in `SPEC-mcp-surface.md`:** how a "no grant" refusal looks on the wire. It's the same "unknown tool" error for every caller, which
replaces the proposal first made here (a tool error for keys, a 403 for JWTs). So `scopesFor()`, which that needed, is gone, and only a refused sign-in writes its own span.

## What it won't do

- **No sign-in flow or opaque tokens.** Only JWTs get checked, and there's no token introspection.
- **No key expiry.** Rotation is manual, and it's a fair next step.
- **No limit on failed sign-ins.** `executor`'s limits apply to known callers, so a flood from strangers needs a proxy in front.
  The hosted demo gets its own limits in its spec.
- **Not all of [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068).** That profile requires checking for `typ: at+jwt`, but MCP doesn't
  require the profile and, as far as I recall, not every issuer sets it (unverified). So it's a setting, off by default, and the audience
  check is what stops an ID token being used as an access token.
- **No fail-closed audit,** as above.
- **Not yet tried against a real identity provider.** Tests sign their own tokens, the JWT claim is only as good as that, and the docs will say so.

## How it's tested

No network and no real clock. Keys are generated in each test, and tokens are signed by a software issuer.

| Test | Proves |
|---|---|
| `decide()`: a table of callers, grants and tools, including every grant order | C1, and that order doesn't matter |
| No key, bad key, revoked key: 401 with one identical answer, and the audit log still tells them apart | C1 |
| The same call with hostile text in the arguments and record gets the same refusal | C2 at module level. The full check waits for `evals` |
| Lists are filtered, and a hidden tool called directly is refused | C1 |
| With `fault-api`, its header log never holds the agent's key or token | C3 |
| An opened credential, through `JSON.stringify`, `util.inspect` and a spread | C4 |
| A sealed value under the wrong key, wrong purpose or with one flipped byte won't open | Sealing |
| JWTs: `alg: none`, HS256, wrong issuer, wrong audience, expired, `jku` in the header, duplicate claims, a weak key | RFC 8725's known attacks |
| A real-shaped access token with `azp` and two audiences passes | The change from `jose.ts` |
| Store down, or no issuer keys: 503, never 401 and never allowed | Failing closed |
| 1,000 bad keys don't evict a real audit event | The cap |

95% branch coverage, as the main spec requires. C1's "zero requests reach `fault-api`" gets its end-to-end check once `mcp-surface` exists.

## Files

`src/access-control/`: `index.ts`, `policy.ts` (`decide`), `keys.ts`, `authenticate.ts`, `jwt.ts` (lifted), `jwks.ts`, `credential.ts`
(lifted), with tests alongside. Task 16 builds the first group, and Task 17 the rest.

Heads-up, not part of this approval: storage in Task 19 needs a `src/store` folder, which isn't on the map, and the boundary test refuses
unknown folders. Adding it is a map change, so I'll ask then.

## Decided

The owner approved all three on 2026-11-04.

**1. `*` means read-only, and every write must be granted by name with `writes: true`.** Even `{ tool: 'create_payment' }` alone is refused.
The alternative is that naming a tool allows it. Mine costs some extra typing and one confusing refusal, which its message explains, and in
return a broad grant can never delete anything. I recommend it.

**2. Permissions stop at the tool, with no rules about arguments.** "May call `create_payment`" can't become "up to $100" or "only their own
customers". The alternative is a small rules language, which is a large addition and easy to get subtly wrong. I recommend leaving it out and
saying so in the README. An interviewer will likely ask, and the honest answer is that the API behind Crumple still has to enforce those.

**3. JWT callers appear in traces as a hash, such as `jwt_9f2c41d07ab3e165`, never by `sub`.** A `sub` is often an email address, and
`telemetry`'s rule is no customer data. The cost is that finding a person's calls takes one step: hash their `sub` first, which `callerId(issuer, sub)` does.
The alternative is readable logs that hold personal data. I recommend the hash.

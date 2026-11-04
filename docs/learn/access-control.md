# `access-control`: who is calling, and may they do this?

Spec: [SPEC-access-control.md](../../SPEC-access-control.md). Code: [src/access-control/](../../src/access-control/).

## The one-sentence version

Before anything reaches an API, it works out who is calling and whether they may use this tool, and it never lets what the model
said change the answer.

## The central idea

Prompt injection can't be fully prevented today, because a model reads instructions and data in one stream. So this module doesn't try
to spot it. It makes the model's opinion irrelevant:

```ts
decide(principal, tool)   // no arguments, no prompt, no tool output
```

A customer record says "delete this customer". The model believes it and asks for `delete_customer`. The program looks up this caller's
grants, and refuses. There's nowhere for the record's text to go in.

**Say the limit before an interviewer does:** if the caller really does hold delete permission, the attack can still succeed. This limits the
damage. It doesn't prevent the attack. So give agents narrow keys.

## Two tokens that never meet

This is the picture to draw on a whiteboard:

```
agent  --its key or token-->  Crumple  --its own stored credential-->  your API
```

The agent proves who it is to Crumple. Crumple then uses a different credential upstream. `Principal` has no token field, so later code has
nothing to forward. That's C3, and `fault-api`'s header log proves it, because it records what really arrived rather than what the code meant to send.

## Who is calling

| | API key | JWT |
|---|---|---|
| Looks like | `crumple_` + 32 random bytes | Anything else, when an issuer is configured |
| Checked against | A stored hash | The issuer's public keys |
| Permissions come from | Grants stored on the key | The token's scopes, mapped in config |

The token's shape picks the path, so there's never a "try one, then the other".

**"Why SHA-256 and not Argon2?"** It's a likely question. Slow hashes exist because human passwords can be guessed. 256 random bits can't, so a slow hash adds
a cost to every request and no security.

**"Can't check" isn't "denied".** A store that's down, or an issuer with no reachable keys, gets a 503. It's still a refusal. But a 401 tells a client its login is bad and sends a
person to log in again, over a problem that's ours.

**All key failures look the same** to the caller: missing, wrong and revoked. The audit log keeps the real reason, so an operator can spot a revoked key still in use.

## What they may do

```ts
{ tool: '*' }                                // every read, and never a write
{ tool: 'create_payment', writes: true }     // this one write
{ tool: 'create_payment' }                   // refused: a write needs writes: true
```

You chose this: a broad grant can never delete anything. And a tool you can't use looks exactly like one that doesn't exist, so probing doesn't reveal the list.

Lists are filtered **and** calls are re-checked. Hiding a tool is a courtesy to the model, which saves tokens and temptation. The check on the call is the security.

## Sealing, and when it doesn't help

The upstream credential is sealed with AES-GCM. Its purpose is bound into the encryption, so a sealed value copied to another row won't open. Once opened, its value is
readable but not enumerable, so `JSON.stringify`, `console.log` and `{...spread}` don't show it.

**The honest limit:** sealing only helps when the key lives apart from the data. It protects a SQLite file or a database backup. If the sealed value and its key share one `.env` file, it adds nothing. So plain
environment variables are supported too, and nothing here should imply they're encrypted.

## Stories from building it

All real. They're good answers to "tell me about a bug":

- **Code written for one job, reused for another.** Latitude 10's JWT checker was written for ID tokens. One of its rules would have refused real access tokens that carry an `azp` claim. Reading it before lifting it found that.
- **A sample in our own spec depended on order.** The first `decide()` stopped at the first matching grant, so `[{tool:'*'}, {tool:'pay', writes:true}]` refused `pay` while the reverse order allowed it. Now every grant is considered.
- **A scope named `__proto__`.** A plain object lookup finds JavaScript's built-in prototype and then crashes. A token could have sent that scope, so the map is a `Map`.
- **An overclaim, caught while writing a test.** The spec said a stranger "can't" push real events out of the audit log. With a cap of 60 a minute, a steady flood still would, in about three hours. The spec now says "can't quickly".

## Honest limits

- **Permissions stop at the tool.** "May call `create_payment`" can't become "up to $100". You chose this, and the API behind Crumple still has to enforce those rules.
- **It trusts the API's methods.** A `GET /customers/1/delete` looks like a read.
- **No real identity provider yet.** Tests sign their own tokens, so the JWT path has never met a real one.
- **No limit on failed sign-ins,** and no key expiry. A flood from strangers needs a proxy in front.
- **If an audit sink fails, the call still goes ahead,** and it's counted. A regulated system would want the opposite.
- **If an issuer stays down, its old keys stay trusted,** including one it revoked meanwhile.
- **C1 and C2 aren't finished here.** "Zero requests reach `fault-api`" needs `mcp-surface`, and the real model test needs `evals`.

## Where to look

Start with [policy.ts](../../src/access-control/policy.ts), which is short and pure. [authenticate.ts](../../src/access-control/authenticate.ts) is the flow. [jwt.ts](../../src/access-control/jwt.ts) is lifted and worth skimming for the attacks it refuses, listed in its [test](../../src/access-control/jwt.test.ts). [upstream.test.ts](../../src/access-control/upstream.test.ts) proves C3.

## Teach-back

1. A customer record says "delete this customer". Walk through what happens if the caller lacks delete permission, and if the caller has it.
2. Your API key and the credential for the upstream API: why are they different, and how do you prove the first never reaches the API?
3. Why SHA-256 for API keys, when everyone says to use a slow hash for passwords?
4. The key store is down. Why answer 503 rather than 401, when both refuse the call?
5. **Where would you change this?** "We want a key that can only make payments up to $100." Which module would change, what would have to change about `decide()`'s inputs, and what does that do to the claim that the model can't talk its way past a permission?

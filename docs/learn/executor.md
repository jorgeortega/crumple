# `executor`: the crumple zone itself

Spec: [SPEC-executor.md](../../SPEC-executor.md). Code: [src/executor/](../../src/executor/).

## The one-sentence version

One tool call goes in, one honest outcome comes out, and everything that can go wrong in between is bounded: time, retries,
concurrency and damage.

It knows nothing about MCP, so it can be tested alone. This is the module a senior engineer will read first.

## The central idea

**Retrying a read is free. Retrying a write can charge someone twice.** So whether to retry depends on what failed **and** what the operation is:

| Policy | Which operations | Retried? |
|---|---|---|
| `safe` | `GET`, `HEAD`, or marked safe | Yes |
| `with_key` | Declares an `Idempotency-Key` | Yes, with the same key every time |
| `never` | Every other write | No. One attempt, always |

`classify()` holds this as one pure table with no network and no clock, so a test can check every failure against every policy.

## The part to point an interviewer at

Picture a charge. The API applies it, then the connection drops before the reply arrives. **Nobody can tell "it never happened" from "it
happened and I didn't hear".** Most tools report "failed" here, and an agent told "failed" tries again. That's the double charge.

So there's a third answer, `outcome_unknown`, with a next step:

- **It has a key:** "To retry safely, call again with idempotencyKey a1b2." Crumple hands over the key, because a new key on the agent's retry would mean a
  second charge.
- **It has no key:** "Read the record to find out before trying again."

**Crumple can't make an unsafe API safe.** It can only refuse to guess, and say so. That's the claim the project stands on: *it never applies a write twice,
and when it can't be sure, it says so.*

## How a call runs

```
build the request       a bad argument costs nothing
caller slot, upstream slot    or `overloaded`
  breaker allows it?    or `circuit_open`, with zero upstream requests
  one attempt           the credential goes on last
  classify()            done, or...
  wait                  Retry-After or jittered backoff, if it fits the deadline
```

**One deadline covers everything:** the queue, every attempt, the backoff and reading the body. Default 30 seconds, with each attempt limited to 10, so one hang can't
spend the whole budget. It doesn't trust the thing that's late: if a library ignores cancellation, the deadline still holds, and a test proves that.

**Backoff has random jitter.** Without it, every client that failed at the same moment retries at the same moment, hitting a struggling API together.

**The circuit breaker** stops calling an upstream that's failing, then lets one probe test for recovery. Only timeouts, lost connections and 5xx count. **4xx don't,** because otherwise one
agent's bad arguments could cut every other agent off from a healthy API.

**Concurrency limits** are what deliver "one noisy caller can't starve another". A flooding caller fills its own 10 slots and leaves the rest free. Past a bounded queue, calls are refused at once,
because a queue with no limit is just a slower outage.

## Stories from building it

All real, and each one found by a test. They're good answers to "tell me about a bug":

- **A success could open the breaker.** Four failures then a success reached the minimum call count with a high failure rate, so a *successful* call tripped it. Only a failure should be able to.
- **The credential leaked in one form.** A credential stored as `Bearer abc` was removed from responses, but an API echoing just `abc` got through. It now removes the token alone too.
- **A queued call was sent as it expired.** A call that waited out its whole deadline was still sent at that instant. For a write, that's a charge nobody will wait to hear about. Now it isn't sent.
- **The coverage gate refused a commit** at 94.66% against a 95% bar. The right response was to test the real behaviour that was missed, not to lower the bar.

## Honest limits

- **Writes with no key get no retries,** so some failures a retry would have rescued come back to the agent. You chose this on purpose.
- **Not fair scheduling.** It's first come, first served at the upstream, so hundreds of well-behaved callers could still queue behind one another.
- **No retry budget.** Google's SRE book suggests capping retries as a share of traffic. Here the attempt limit and breaker cover most of it.
- **Redaction has a limit.** It catches a credential echoed as sent or URL-encoded, not one an API hashes.
- **Limits and the breaker are per instance on Workers,** and exact only within one Node process.
- **These results are from one laptop:** the module's tests use a fake clock, and `prove` runs the same claims over real sockets. Nothing here is proven in production.

## Where to look

Start with [errors.ts](../../src/executor/errors.ts) for the table, then [call.ts](../../src/executor/call.ts) for how it fits together. [breaker.ts](../../src/executor/breaker.ts) is short and pure. [request.ts](../../src/executor/request.ts) is lifted from Latitude 10.

## Teach-back

1. A charge request times out. Walk through what Crumple does with a key, and without one. Why doesn't it just retry?
2. Why don't `PUT` and `DELETE` get retried by default, when the RFC says they're safe to repeat?
3. Why don't 4xx responses count against the circuit breaker? What would go wrong if they did?
4. What's the point of jitter? Describe what happens without it.
5. **Where would you change this?** "One API returns a 409 when it's temporarily locked, and retrying works." Which function changes, and why isn't it in `call.ts`?

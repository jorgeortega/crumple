# `prove`: every claim is a check you can run

Spec: [SPEC-prove.md](../../SPEC-prove.md). Code: [src/prove/](../../src/prove/). Latest result: [proof/latest.md](../../proof/latest.md).

## The one-sentence version

It turns "this handles failure" into a command anyone can run, which causes the failures on purpose and writes down what happened, including what it didn't check.

## Two jobs, and why they're different

```bash
npx crumple-mcp prove --self              # Crumple, with failures we cause
npx crumple-mcp prove https://you/mcp     # your server, from outside
```

`--self` controls the API behind the server, so it can lose a response and then count how many charges really happened. From outside you can't do that: you can't make someone's API hang, and you can't see what reached it.

**Say this before an interviewer does.** The original plan said people could test failures on their own server by pointing it at `fault-api`. Working it through showed that's true for almost nobody, because their tools call their own API's paths. So the report lists those checks as not run and says why. A smaller promise that's true beats a bigger one that gets found out.

## The central idea: can this check fail?

A module whose job is printing "pass" has one big risk: a check that can't print anything else. So there are two defences.

**A server that's wrong on purpose.** About 100 lines: no auth, forwards the agent's token, retries writes with no key, no deadline, no breaker. Every check must fail against it, for the reason it exists.

**Controls inside the checks.** C3 says the agent's key never reaches the API. If nothing reached the API at all, the key wouldn't be there either, and the check would pass by seeing nothing. So it also requires the stored credential to have arrived. Most checks have a line like "so this shows nothing".

This caught one of mine. C6 first passed at 613 ms against an 800 ms deadline, which looks fine until you ask why it wasn't nearer 800. The per-attempt timeout was stopping it, so the deadline was never tested. Now the attempt timeout is far longer, and it reports about 805 ms.

## The rule that makes it safe

> A hint can stop `prove`. It can never give it permission.

The obvious design calls tools marked `readOnlyHint: true`. But that hint comes from the server being tested, and MCP's spec says not to trust it. A wrong hint on a delete tool would mean deleting real data while checking how careful someone's server is.

So no real tool is called unless you typed its name. The hint can only reduce what happens: `--parallel` refuses a tool that doesn't claim to be read-only. C17 tests this on every `--self` run, with a real Crumple whose tools all claim to be read-only, writes included, and `fault-api` must receive nothing.

**What we gave up:** a first run with no flags learns less.

## The server being tested isn't trusted

Its text ends up in a report that gets shared, so a server could try to put a link, an image or terminal codes in front of a reader, through a tool's name.

Only our own sentences and escaped tool names reach a report. Descriptions and error messages never do. Redirects aren't followed, because following one would carry the token to wherever the server chose. Reads are capped at 1 MiB and timed, and pages stop at 10.

## Three states, and the words matter

| State | Means | Counted? |
|---|---|---|
| pass | It ran, and held | Yes |
| fail | It ran, and didn't hold | Yes |
| not run | It didn't run, with the reason | **Never** |

A claim with a part checked elsewhere says "partly checked". The badge says `13 passed · 0 failed · 0 not run` and never just "passing". It's a file, so anyone could edit it, and it's only as good as being able to run the command again.

## Why a hand-written client

The official client hides status codes, and a 401 or a 403 is often what's being tested. It also can't send something deliberately wrong. And it would be a third runtime dependency.

**The risk is that ours could be wrong on a real server.** So it's tested on both eras of the protocol, over HTTP and stdio, against the official SDK's server. The first real run was against Latitude 10's docs server, and it connected on 2026-07-28 first time.

## The demo: `prove --self`, with a reason to care

```bash
npx crumple-mcp demo
```

A list of passes doesn't show why any of it matters, so `demo` opens with the one failure anyone understands: a payment goes through, its response is lost, and the retry charges again.

| | Agent is told | Charges |
|---|---|---|
| Plain retry loop | succeeded | 2 |
| Crumple | succeeded | 1 |

**The agent is told "succeeded" both times.** That's the part worth saying out loud. Nothing looks wrong to the agent or in its logs, and the customer paid twice. Crumple avoids it by sending the same idempotency key on each attempt, so the API knows it's the same payment.

**Nothing on that screen is typed in.** Both rows are measured on each run. If the plain loop stopped charging twice, `demo` would say the comparison shows nothing and exit 1. The trace underneath is Crumple's own, showing `POST /payments` losing its connection and then being retried.

**The obvious objection is that we wrote the losing side.** We did, and the output says so. That's why it's one comparison of a very common mistake and not ten rows of us beating a server we made bad. For the same reason, the output also says how many claims this run doesn't check.

**It's a real cost:** about 100 lines of deliberately bad code now ship in the package, because `demo` starts that server. It isn't exported, it's only ever started on `127.0.0.1`, and the tests use the same copy.

## Load runs: numbers with their limits attached

```bash
npm run prove:load       # writes proof/load-<date>.md and .json
npx crumple-mcp prove --load
```

It takes about half a minute and measures three things. The latest result is in `proof/`.

| Question | How | Why this way |
|---|---|---|
| What does Crumple add to one call? | The same read, directly and through Crumple, taking turns | Turns stop one side getting a warmer process |
| How many calls per second? | 1, 10 and 50 callers, each calling again when the last call ends, limits raised | It measures the path, and the raised limits are stated |
| Does a noisy caller starve another? (C9) | 100 callers flood a 200 ms API while one more keeps working, **default limits** | The defaults are what someone actually gets |

**Say this first, before anyone asks.** The program making the calls, Crumple and the API all share one Node process and one thread, and the API does no real work. So calls per second isn't Crumple's limit and isn't a production number. Added latency is the useful one, since a real API's time comes on top. Nothing here says anything about Cloudflare.

**How to read the noisy caller result.** A flooding caller gets its 10 slots, and 10 slots on a 200 ms API is about 50 calls a second, so about 250 in 5 seconds. The report shows 260, which you can check on the back of an envelope, and that's a good sign the limit is doing what it says. Everything past that was refused with `overloaded`.

**It can fail.** It exits 1 if calls fail, if nothing is refused, if the other caller loses a call, or if the API saw fewer calls than were made. Each has a test. A server with no limits fails it, so the run isn't only a printer of numbers.

**A number I didn't believe.** A call across two local HTTP hops came back in 0.2 ms, which looked too good, and a cache or a shortcut would look exactly like that. So I counted: 500 calls, and 500 reached the API. It's real, because the API does almost nothing and the laptop is fast. That count is now part of every run, and a mismatch reports that the times show nothing.

**Not measured:** writes, `--db`, memory, a long soak, or more than one process.

## Stories from building it

All real, and good answers to "tell me about a bug":

- **It found a bug in the code it was testing, on its first run.** When a caller leaves before the answer is ready, the Node adapter's `pipeline` threw, as an unhandled rejection, which stops a Node process. It showed up as a stray test error. **Be precise about this one:** the deliberately wrong server hit it, and I couldn't trigger it through `serve` on a tool call. It was still a real bug, and it's fixed with a test.
- **It found a real problem on a real server.** Its first outside run was on Latitude 10's docs server, which answered a request from an unknown website where MCP requires a 403. That's a true finding on the owner's own code, though low risk there, because those routes use bearer keys and not cookies. It was fixed and deployed the same day, and the rerun got a 403. [`docs/clients.md`](../clients.md) has both runs.
- **A check that blamed the wrong thing.** C5 said "0 effects" when the real problem was my test sending the wrong arguments. So a check now says "this shows nothing" when nothing was applied, instead of reporting it as the failure it was looking for.
- **The check was right, and I wasn't.** Twice, a failure was my test's fake server genuinely doing the wrong thing, accepting any token and answering for a tool that can't exist. The fix was the fake server, not the check.

## Honest limits

- **From outside, it can't say whether your server survives a failing API.** That's the most interesting question.
- **It proves Crumple on one laptop,** not under production load or on Cloudflare.
- **C2's part with a real model waits for `evals`.** Here it only shows the permission held.
- **The token estimate is rough:** characters divided by 4. Task 27 compares it with a real run.
- **`--parallel` is at most 50 calls,** which is a burst and not a load test.
- **Tools using `x-mcp-header` can't be named yet.** The report says so rather than sending a wrong request.
- **Timing checks could flake on a very busy machine.** C6 has a 500 ms margin, and if it fails on someone's overloaded laptop, the report will say so.

## Where to look

Start with [self-checks.ts](../../src/prove/self-checks.ts), which reads like the claims. [external.ts](../../src/prove/external.ts) holds the safety rule. [client.ts](../../src/mcp-client/client.ts) is the hand-written client. [wrong-server.ts](../../src/cli/wrong-server.ts) is short and worth reading, because its comment lists mistakes a first version could easily make.

## Teach-back

1. Why can't `prove https://you/mcp` tell someone whether their server applies a write twice? What would it need?
2. A server marks `delete_everything` as `readOnlyHint: true`. What does `prove` do with that tool, with no flags, and with `--call delete_everything --parallel 10`? Why?
3. C3 checks that the agent's key isn't in what reached the API. Why does it also check that the stored credential arrived?
4. How do you know a check in here can actually fail? Give two separate reasons.
5. In `demo`, the agent is told "succeeded" in both rows. Why is that worse than an error, and what does Crumple send that the plain loop doesn't?
6. Someone reads "4,000 calls a second" in the load report and calls that Crumple's capacity. What do you tell them, and which number in that report would you quote instead?
7. **Where would you change this?** "We want to test failures on our own server, with our real API." What would you build, what could go wrong with writes, and which of `prove`'s safety rules would have to change?

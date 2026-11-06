# `hosted-demo`: seeing it work without installing anything

Spec: [SPEC-hosted-demo.md](../../SPEC-hosted-demo.md). Code: [workers/](../../workers/). Runbook: [docs/runbooks/hosted-demo.md](../runbooks/hosted-demo.md).

## The one-sentence version

A public page with four buttons, each of which really breaks something on the server and shows what Crumple did about it, plus a real MCP endpoint anyone can connect to, all on fake data.

## Where it stands today

**It isn't deployed.** Everything has run on this laptop, in `workerd`, the open source runtime Cloudflare's Workers are built on. That's close to Cloudflare, and it isn't Cloudflare. The first deploy is what changes that, and it's the owner's call.

## Why this module exists

The person deciding whether to talk to you may give this 60 seconds, and may never open a terminal. A claim they can poke is worth more than a claim they can read. It's also the only place Crumple runs on something other than one laptop.

## Why it took so little code

On the first day, one rule went in: every module takes a web-standard `Request` and returns a `Response`. That rule looked like fussiness at the time. Here's what it bought: `workers/surface.ts` builds the real Crumple in about 60 lines, and neither `mcp-surface` nor `fault-api` changed at all to run on Cloudflare.

**There's no network anywhere in it.** `executor` normally calls your API over HTTP. Here it's handed a function, and that function is `fault-api`. So the demo can't be tricked into calling anything else, since it has nothing that calls out, and no visitor supplies an address or a document.

## The four buttons

| Button | What breaks | What's counted |
|---|---|---|
| Lose the response | A payment applies, and its response is lost | One charge, two requests, one idempotency key |
| Hang the API | The API stops answering | An error at 1,500 ms, and the API sees the caller give up |
| Try without permission | A read-only key tries to delete | Refused, with nothing at the API |
| Plant an instruction | A record says "delete this customer", and a scripted agent obeys | Refused, with nothing deleted |

Each press builds a fresh Crumple with its own data, so one visitor can't affect another.

**The page's words come from the numbers.** "One charge" is only written if the count is one. If a payment were applied twice, the page would say "the API applied 2", and there's a test that makes it do so. Otherwise a demo is a recording with extra steps.

**Why a scripted agent, and no model?** It does exactly what the record says, which is worse than a real model, since one might ignore the text. And a public button that spends money on each press is exactly what shouldn't exist.

## What `/mcp` deliberately doesn't do

It doesn't fail on command, and nothing a caller sends can change that: not a header, and not a tool's argument. An endpoint that hands a planted instruction to a stranger's agent, which may have real tools, isn't something to leave on the internet. That's a good example of a feature that would demo well and shouldn't exist.

Its keys are printed on the page, and nothing can delete with either. Its data lives in memory, per server instance, and resets on the hour, so it can seem forgetful. The page says so.

## Keeping it cheap (C15)

The first version of this claim was "can't run up a bill", and that isn't true. Cloudflare bills requests that reach a Worker, and a request my code turns away has most likely reached it. A flood of 100 million requests would cost about $27, and no code can prevent that.

So the claim became one that's true: **the demo's own limits hold, no public path reaches a paid model, and abuse can't cost more than Cloudflare's per-request price.** What sits on top are account settings: a billing notification, and a command that switches it off.

This is worth telling as a story in an interview: the honest version of the claim is weaker, and it's the one you can defend.

| Layer | What it does | Honest about |
|---|---|---|
| Free things first | A wrong path, a GET on a button, another site's page: turned away before any limit, with no D1 write | |
| Rate limit | About 60 a minute per address, using Cloudflare's binding | Approximate and per location. A shared office can hit it |
| Daily cap | 20,000 a day in total, on a D1 counter, then 503 until midnight UTC | The page stays up, because static files never reach the Worker |
| Static page | Cloudflare doesn't bill requests to static files | |
| No paid model | The map forbids the import, a test enforces the map, and another searches the built bundle for `api.anthropic.com` | |

**Why does the cap fail closed and the rate limit fail open?** If D1 is down, the cap can't be checked, so it can't be promised, and closed costs nothing. If the rate limiter is down, only fairness is lost, and the cap still limits the cost. Same question, different answers, because they protect different things.

**Why one atomic statement?** Reading the count and then writing it lets two servers read the same number. `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` is one statement, so they can't.

**Why does a closed instance remember?** Otherwise a flood past the cap costs a D1 write for every request. It's a small saving on a small bill, for two lines of code.

## Why D1 holds one number

The plan had keys and audit events in D1, to show the store's tests are portable. Working it through, the keys are public and fixed, and nobody would read a shared audit log of fake calls. The owner chose to drop it (revision 5 of the map). Building something because it makes a nice line in an interview, when the product doesn't use it, is how a small project stops being small.

## How it's tested

**`npm run test:workers` starts a real `wrangler dev`.** Cloudflare's test tool for this needs Vitest 4, and everything else here is on 5. So rather than downgrade, the tests talk to Cloudflare's runtime over real sockets: `prove` against `/mcp`, every fault, every button, the cap against real local D1, and the rate limit against the real binding. It's slower, so it stays out of the pre-push gate.

The logic also runs on Node with an injected clock, for what's awkward in a real runtime: midnight, and the hourly reset.

**A surprise it found:** a stream that breaks partway looks different over `wrangler dev`'s socket, where its own layer answers with an error. A caller doesn't get the payment back either way, so the test checks that instead of how the failure looks. The demo isn't affected, because its `fault-api` has no socket in between.

## Honest limits

- **A demo, not a load test.** A button shows one run.
- **Local numbers aren't Cloudflare's.** The claims table comes from a laptop, and the page says so.
- **A trace can read 0 ms.** Cloudflare's clock only moves between waits, as a defence against timing attacks, so computing shows as nothing. Waits are real.
- **"Cancelling aborts the real call" stays a Node claim** for callers over a real connection. Inside the Worker, a deadline does abort `fault-api`, because that's a function call.
- **Some clients won't connect.** A key in a header works for Claude Code. Clients that insist on OAuth, or that connect from a web page, may not.

## Where to look

[limits.ts](../../workers/limits.ts) is short and has the reasoning. [try.ts](../../workers/try.ts) has the four buttons. [surface.ts](../../workers/surface.ts) shows how little it takes to run the real thing here. [wrangler.toml](../../workers/wrangler.toml) is what would be deployed.

## Teach-back

1. Why doesn't `/mcp` offer the failures the buttons do?
2. "Can your demo run up my bill?" What do you say, in one sentence, and why isn't it "no"?
3. Why does the daily cap fail closed and the rate limit fail open?
4. Two servers get a request at the same moment, with one left under the cap. How many are served, and why?
5. Why was almost no existing code changed to run this on Cloudflare?
6. **Where would you change this?** "We want saved keys and per-customer limits." What gets added, and which of today's choices stop being right?

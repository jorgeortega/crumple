# Spec: `hosted-demo`

Status: approved by the owner on 2026-11-06 ("Approve all four": option A on all four decisions below). Module on [the map](CAPABILITY-MAP.md). Covers Tasks 29 to 31.

## What it is

A public address where someone can see Crumple working without installing anything:

```
https://crumple.latitude10.tech           a page: break something, watch what happens
https://crumple.latitude10.tech/mcp       a real MCP endpoint, with a shared demo key
```

It's for the person the main spec calls the hiring manager or founder, who gives this 60 seconds and may never open a terminal. It's also the only place Crumple runs on something other than one laptop, and the main spec says launch waits for it.

**Everything behind it is fake:** `fault-api`'s made-up customers, a fake credential, and keys printed on the page. There's nothing to steal, and no model anywhere.

## What a visitor can do

**1. Press a button and watch a failure, live.** Each button runs one fixed scenario on the server, through the real Crumple code, and shows what the API saw and Crumple's own trace:

| Button | What breaks | What it shows |
|---|---|---|
| Lose the response | A payment applies, and its response is lost | **One charge,** and the retry in the trace |
| Hang the API | The API stops answering | A clear error at the deadline, with the time |
| Try without permission | A read-only key tries to delete | Refused, and nothing reached the API |
| Plant an instruction | A record says "delete this customer", and a scripted agent obeys | Refused, and nothing deleted |

No model is involved, and each run gets its own fresh `fault-api`, so one visitor can't affect another.

**2. Connect a real MCP client.** The page prints a shared key and a command:

```bash
claude mcp add --transport http crumple https://crumple.latitude10.tech/mcp --header "Authorization: Bearer <the read key on the page>"
```

There's a read key and a key that can also charge, both for fake data. Nothing can delete from here, so that stays the refused example.

**3. See which claims held,** from the committed `proof/latest.json`, labelled with its date, commit and machine. **Those numbers come from a laptop, and the page says so.** Only the button results are measured on Cloudflare, and they only describe that one run.

**Left out on purpose:** failures over `/mcp`. A stock client can't choose a fault, and an endpoint that hands a planted instruction to a stranger's agent, which may have real tools, isn't something to leave on the internet. `crumple-mcp serve` does that locally, where it's your own agent.

## How it's built

```
Visitor --> Cloudflare --> static page (free, never reaches the Worker)
                       --> Worker: rate limit --> daily cap --> /mcp or /try/<scenario>
                                                                   |
                                  real mcp-surface + executor + access-control
                                                                   |
                                                     fault-api, in the same process
```

This is what the web-standard rule from the first day was for. `mcp-surface` and `fault-api` both already take a `Request` and return a `Response`, so the Worker is a thin file. **There's no outbound network at all:** Crumple's upstream is a function call into `fault-api`. No user-supplied address or document exists, so it can't be used to reach anything else.

| Piece | Where | Note |
|---|---|---|
| Page and proof JSON | Static assets | Cloudflare's pricing says requests to these are free and unlimited, so flooding the page costs nothing |
| Keys | Fixed, in code | They're public, so storing them would add nothing |
| Fake data for `/mcp` | Memory, per instance | Reset every hour by the clock |
| Daily counter | One D1 table | The only thing that has to be shared between instances |
| Traces | Memory, one run | Returned to the visitor who asked, then gone |

**Writes can seem to vanish on `/mcp`,** because two instances don't share memory, and data resets hourly. For fake data on a demo that's fine, and the page says so. It also means "one charge" is shown by the buttons, which use one fresh instance per run, and not by `/mcp`.

## Keeping it cheap and hard to abuse (C15)

| Layer | Limit | Honest about |
|---|---|---|
| Rate limit | 60 requests a minute, per IP, using Cloudflare's rate limiting binding | **Approximate and per location,** by Cloudflare's docs. They also advise against IP keys, since many people can share one. There's no other identity here, so a shared office could get a 429 |
| Daily cap | 20,000 requests a day in total, on a D1 counter. After that, `/mcp` and the buttons answer 503 until midnight UTC, and the page still works | Exact, because D1's update is atomic. Each instance remembers it's closed, so a flood past the cap doesn't keep writing to D1 |
| Each call | Deadline, retry and concurrency limits, as on Node | Per instance. Everyone shares a key, so one heavy user can crowd out others in that instance |
| No paid model | Workers can't import `agent-runner`, by the map, with a test. A test also searches the built bundle for `api.anthropic.com`. No key is bound | |
| Data | Reset hourly, capped by `fault-api`'s own limits | |

**Normal cost, if the account is already on Workers Paid:** nothing new. At the cap every day, that's 600,000 requests a month, about 6% of the 10 million included, shared with Latitude 10's own Worker.

### What C15 can honestly say

The main spec says "can't run up a bill". **That isn't completely true, and I'd rather say so now.** Cloudflare's pricing bills requests that reach a Worker, so a request my code rejects most likely still counts, although the page doesn't say so outright. At $0.30 per extra million, a flood of 100 million requests would cost about $27. Nothing in the code can prevent that, and it's past your $25 a month.

So C15 becomes:

> The demo's own limits hold, no public path reaches a paid model, and abuse can't cost more than Cloudflare's per-request price.

What sits on top, all yours, since they're account settings:
- **A billing notification** in Cloudflare, which is the one I'd insist on.
- **A way to switch it off:** deleting the Worker, written down in the runbook.
- **A WAF rate limit rule** would stop a flood sooner. Cloudflare's Free plan gets one rule, by IP, over 10 seconds, and I don't know if your zone has used it. The docs I read don't say whether a blocked request counts towards Worker billing, so I can't promise it saves money.

## The page

One static HTML file, with the Terminal tokens from Latitude 10's design doc copied in, so it looks related without sharing code. In order: one sentence, the four buttons, what happened, how to connect, the claims table, then limits and credit.

No cookies, analytics or third-party scripts, and a strict CSP. Everything returned is put in the page as text, never HTML. Checked by hand at desktop and mobile widths.

**The GitHub link appears once the repo is public.** Until then the page credits Latitude 10 only, so nobody gets a 404.

**Nothing is stored about visitors.** The IP is only the rate limit's key, and Workers Logs stays off.

## How it gets tested

**A change from the main spec:** it names `@cloudflare/vitest-pool-workers`, and the current version needs Vitest 4 while we're on 5. Rather than downgrade every test, `npm run test:workers` starts a real `wrangler dev`, which runs Cloudflare's own `workerd` locally, and tests it over real sockets. That's how the earlier spike worked. It's slower, so like `test:install` it stays out of the pre-push gate.

**What the tests found:** over a socket, `wrangler dev`'s own layer sees `drop`'s broken stream and answers with an error of its own, where Node's socket simply breaks. A caller doesn't get the payment back either way, and that's what `tests/workers/fault-api.run.ts` checks. The demo isn't affected, since its `fault-api` is a function call, and `tests/workers/try.run.ts` tests that path. How real Cloudflare treats a broken stream over a socket stays untested, and nothing here depends on it.

| Test | What it shows |
|---|---|
| `prove` against the local Worker | The same outside checks anyone can run, on Cloudflare's runtime |
| `fault-api`'s test flows in `workerd` | **The promise from its spec:** `drop`, `hang` and the rest behave the same there. The lost-response path differs most between runtimes |
| Each button, in `workerd` | One charge, the deadline, the refusal, with real numbers in the trace |
| Past the daily cap | 503, a closed instance stops writing, and it opens again the next day, with an injected clock |
| Past the rate limit | 429. Tested with a fake, and in `workerd` if the binding enforces limits locally. **I don't know that it does** |
| Data reset | Gone after the hour, with an injected clock |
| The built bundle | No `api.anthropic.com`, and no outbound `fetch` during a run |
| A planted foreign `Origin` | Refused on `/mcp` and the buttons |

**After the first deploy,** with your okay: `prove` against the public address, and a stock client calling a tool, both recorded in `docs/clients.md`. That's Task 31's check, and the first time anything here is measured somewhere real.

## Boundaries

**Ask first:** the first deploy, any deploy that changes a limit, and raising a limit.

**Never:**
- A real credential or real data, or a model call from any public path.
- Presenting a laptop's number as Cloudflare's, or a demo run as production load.
- User-supplied addresses, documents or faults.
- A planted instruction delivered over `/mcp`.
- Linking from latitude10.tech without asking, since that goes through Latitude 10's Build Gate. This spec doesn't touch that repo.

## Honest limits

- **It's a demo, not a load test.** A button shows one run.
- **Memory per instance,** as above. `/mcp` can seem forgetful.
- **Not everything is the same as Node.** The earlier spike couldn't confirm that a caller leaving aborts the real request on Workers, so "cancelling aborts the upstream call" stays a Node claim. The validators also differ, so error wording can too.
- **Rate limits are approximate.** One visitor can get more than 60 a minute, and an office can get fewer.
- **Hosted clients may not connect.** A key in a header works for Claude Code. Clients that insist on OAuth, or connect from a browser on another site, may not work, and Crumple has no OAuth sign-in server, by the main spec.
- **A trace's times can read 0 ms on Cloudflare,** because its clock only moves between waits. The times in a trace are real for waits, and the page says so.
- **`Checkpoint D` needs rewording.** It says "all 18 claims pass in `npm run prove`", but C14, C15 and C16 run under their own commands. I'll make the proof report say where each ran, as a later step, and I won't count anything that didn't run.

## Slices

**Task 29**
1. The Worker, `/mcp` on `wrangler dev`, the `test:workers` harness, and `prove` against it.
2. `fault-api`'s flows and the scripted scenarios in `workerd`.

**Task 30**
3. The rate limit, the daily cap and the hourly reset. C15.
4. `/try/<scenario>`.
5. The page, then checking it by hand at both widths.
6. `docs/learn/hosted-demo.md` and the runbook, including how to switch it off.

**Task 31**
7. **Yours:** the checks below, and your okay on the deploy. Then I deploy, run `prove` against it and connect a stock client.

Slices 1 to 6 change nothing on Cloudflare, and spend nothing.

**What I need you to check before slice 7:**
- This uses the same Cloudflare account as Latitude 10. That account looks to be on Workers Paid, because Latitude 10's runbook says its `LOADER` binding needs it, but only you can confirm. If so, this adds no new charge.
- A billing notification is set.

## Decisions for the owner

**1. Which address?**

- **A, recommended: `crumple.latitude10.tech`,** the main spec's default. It looks real, and it's what could bring Latitude 10 conversations. It adds a DNS record to your zone, and Cloudflare makes that when the Worker's custom domain is added. **I checked the obvious risk:** Latitude 10's session cookies in the code I searched set no `Domain`, so browsers don't send them to a subdomain. And this page shows no user content, so it's a poor place to launch anything from.
- **B: a `workers.dev` address.** Completely apart from your domain, and no DNS change. It looks more like a throwaway, and it does nothing for Latitude 10.

**2. Buttons or a read-only page?** Task 30 says "one read-only page". I'm proposing more.

- **A, recommended: the four live buttons.** It's the difference between reading a claim and watching it happen, for someone with 60 seconds. It adds one small public route with no input, under the same limits.
- **B: read-only.** The trace and claims come from a saved run. Less to go wrong, and it's a page of text claiming things, with nothing a stranger can poke.

**3. Less storage than the map says.** The map and main spec say keys and audit events go in D1 on the demo. Working it through, the keys are public and fixed, and nobody would read a shared audit log of fake calls.

- **A, recommended: D1 holds only the daily counter.** `src/store/d1.ts` isn't built, `hosted-demo` stops depending on `store`, and the map moves to revision 5. If someone later wants Crumple on Workers with saved keys, that's the time to build it.
- **B: as written.** The store's shared tests also run against D1, which shows they really are portable, and that's a nice line in an interview. It's work and moving parts that the demo doesn't use.

**4. The limits and C15's wording.**

- **A, recommended: 60 a minute, 20,000 a day, and C15 reworded as above,** so the claim is one that's true.
- **B: tighter,** such as 5,000 a day. Cheaper in a flood only if it's flooded below the cap, and if launch day goes well, people would hit a closed demo at the worst moment.

## Verified on 2026-11-05

| Fact | Source |
|---|---|
| Workers Paid is at least $5 a month, with 10M requests and 30M CPU ms included, then $0.30 per million requests. Free is 100,000 requests a day and 10 ms of CPU per invocation | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Requests to static assets are free and unlimited, and "only requests that hit a Worker will count" | The same page |
| D1 Paid includes 50M rows written a month, then $1 per million. Free is 100,000 a day | The same page |
| The rate limiting binding is per location and approximate, with a period of 10 or 60 seconds, and the docs advise against IP keys | [Rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) |
| A custom domain creates its DNS record, and can't use a hostname that already has a CNAME | [Custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) |
| WAF rate limiting on Free is one rule, by IP, over 10 seconds | [Rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/) |
| `@cloudflare/vitest-pool-workers` 0.23.0 needs Vitest ^4.1 | `npm view` |
| Latitude 10's cookies set no `Domain` in what I searched | Its repo's auth, admin, dashboard and SSO code, by search, not a full audit |

**Checked while building, 2026-11-06:**

| Fact | How |
|---|---|
| The binding enforces limits under `wrangler dev` | `tests/workers/limits.run.ts`: the 61st request is the first 429. Locally only, since Cloudflare's own counting is approximate and per location |
| The counter is exact against D1 locally, and an instance that's closed stops writing | The same file, reading the local D1 database directly |
| `Date.now()` "does not advance during code execution" on Cloudflare, so a span that's only computing shows 0 ms there. Waits show their real time | [Security model](https://developers.cloudflare.com/workers/reference/security-model/). The page says so under each trace |
| `namespace_id` is yours to choose and unique to the account, and two bindings sharing one share counters | [Rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). Latitude 10's `wrangler.toml` has no `ratelimits`, but `latitude10-demo-apis`, on the same account, uses `1001`, found just before the first deploy. This Worker uses `2001` |

**Checked on Cloudflare, after the first deploy, 2026-11-06:**

| Fact | How |
|---|---|
| The binding enforces the limit, roughly | 150 requests from one address, 5 at a time: 46 got through, then 104 got a 429 with `retry-after: 60`. It had seen 18 requests the minute before, which would fit a counter that weighs the last window, but that's a guess. The next minute's request got through |
| The page stays up while an address is limited | It answered 200 while `/mcp` and the buttons answered 429 |
| The daily counter is exact at this small scale, and counts only what reaches the buttons and `/mcp` | It read 73, equal to the requests I sent that weren't turned away first. Free refusals and 429s didn't count. One address, one location |
| The rules work over the real network | Unknown path 404, unknown button 404, `GET` on a button 405, foreign Origin 403 on a button and on `/mcp`, and the page's headers include the strict CSP |
| Each button held | One charge from two requests. A 1,500 ms deadline, with the answer at 1,585 ms from this laptop. Two refusals, with nothing deleted |
| **The zone's Web Analytics was adding a script to the page,** for requests that look like a browser. The CSP blocked it, so it never ran, but the page promises no analytics | Found in the browser's console. [Web Analytics FAQ](https://developers.cloudflare.com/web-analytics/faq/): `no-transform` stops the injection. With it in `_headers`, a browser-like request gets the repo's file byte for byte, and `/page.js` is the only script. Latitude 10's own hosts keep their analytics |
| A stock client works | Claude Code connected with the page's command and called a tool. See `docs/clients.md` |
| D1 is in EEUR | Cloudflare picked it from where the database was created. It only holds a day and a count, but a US visitor's request waits for a write there |

**Not confirmed:**
- Whether the rate limiting binding costs anything. Neither [its page](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) nor [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) mentions a charge, or which plans have it. That's an absence, not a statement that it's free. If it does cost something, the fallback is the per-instance limits the main spec describes.
- Whether a WAF-blocked request counts towards Worker billing. The pricing page only says "Only requests that hit a Worker will count".
- How the D1 counter behaves under load across regions. It was exact for 73 requests from one place, which says nothing about many places at once.
- That a request the Worker turns away still counts. I'm assuming it does, which is the expensive reading.

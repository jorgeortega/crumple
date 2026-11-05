# Spec: `agent-runner`

Status: approved by the owner on 2026-11-05 ("Approve all three"), including the three decisions at the end, each with its recommended choice. Module on [the map](CAPABILITY-MAP.md), depending on `telemetry` and `mcp-client`. Covers Tasks 26 and 27.

## What it is

A small agent loop: give it a task and an MCP server, and it asks a real model what to do, calls the tools the model picks, sends the results back, and repeats until the model finishes. It writes down what happened, what it used and what it cost.

```
task --> [ model ] --tool_use--> [ MCP server: Crumple ] --> your API
             ^                          |
             +------- tool_result ------+
```

**It's a measuring instrument, not a product.** Nobody should build their agent on it. It exists because four of the project's claims can't be shown any other way:

| Claim | Why it needs this |
|---|---|
| C12: each run reports its tokens and cost | An MCP server never sees tokens. They belong to the model call |
| C11: every call can be traced end to end | Needs an agent that sends `traceparent`. [Claude Code didn't](docs/clients.md) in our runs |
| C2, C10, C13: the parts with a real model (through `evals`, Task 28) | "The model recovered from the error" needs a model |
| C18: the tool cost estimate | Needs a real number to compare it with |

This is also where your requirement "tracks token consumption, latency and execution costs" gets met, and what "includes automated agent evaluations" runs on.

**Why write a loop rather than use a framework or the SDK's tool runner?** Three reasons you can repeat to people:

1. **We need to see everything:** every usage number, every refusal, every byte sent. A helper that hides any of that defeats the point.
2. **Replay has to sit exactly between the loop and the model,** which is easiest when we own both sides of that line.
3. **The package promises two runtime dependencies.** The approved main spec says plain `fetch` with no provider SDKs. Anthropic's own reference recommends its SDK for most projects, and the cost of not using it is real: error handling, retries and keeping up with API changes are ours. Pinning the API version keeps that cost small.

## One run

```ts
const run = await runAgent({
  task: 'Charge customer cus_1 $50.',
  mcp: { url, token },
  model: claude({ model: 'claude-haiku-5-5', apiKey }),   // or a replay
  limits: { maxTurns: 10, maxToolCalls: 30, deadlineMs: 120_000, maxUsd: 0.25 },
  telemetry,
});
```

Inside the module, not a public API: the package has no library entry point. `evals` and one script call it.

**What comes back,** which is what `evals` will score:

```ts
{
  stopped: 'done',            // see the table below
  text: 'The payment went through...',
  toolCalls: [{ name, args, outcome: 'ok' | 'tool_error' | 'refused' | 'unreachable', ms }],
  turns: 3,
  usage: { input: 2810, output: 412, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0.000487,          // or null if it can't be known. Never 0 for "unknown"
  traceId: '4bf92f35...',
}
```

## The loop, and how it ends

1. List the tools over MCP. If that fails, stop before spending anything.
2. Send the task and the tools to the model.
3. Read `stop_reason`, and act on the table below.
4. Run every tool the model asked for at once, and return all the results **in one message, in the order asked**. Anthropic's docs say splitting them teaches the model to stop calling tools in parallel.
5. Back to 2.

**History is only ever added to.** The assistant's content goes back exactly as it came, thinking blocks included. On current models, editing an earlier turn invalidates them.

| What the model said | What the loop does | `stopped` |
|---|---|---|
| `end_turn` | Finish | `done` |
| `tool_use` | Run the tools and continue | |
| `max_tokens` | Stop, and **run no tools from that turn**, because its arguments may be cut off | `max_tokens` |
| `refusal` | Stop, and keep its category | `model_refused` |
| Anything else | Stop and name it. We use no server tools, so `pause_turn` shouldn't happen | `unexpected_stop` |

And from the limits and failures: `max_turns`, `max_tool_calls`, `deadline`, `max_usd`, `model_error`, `mcp_unavailable`, `no_price`, `stale`. **A loop that can spend money always has a way out.**

### Two different things are called a refusal

This one is easy to mix up, and worth saying clearly in an interview:

| | Who refuses | How it arrives | What we do |
|---|---|---|---|
| **The server** | Crumple: no grant, unknown tool | A protocol error. Official MCP clients raise it as an exception | Hand it to the model as a `tool_result` with `is_error: true`, so it can react |
| **The model** | Claude's safety checks | HTTP 200 with `stop_reason: "refusal"`. An exception handler never sees it | End the run, and say so |

Missing either one is a real bug. Treating the first as a crash means the model never learns it was refused. Not checking the second means reading an answer that isn't there.

A tool that's slow, broken or unreachable also becomes `is_error: true`. The model decides what to do next, and that's exactly what C10 wants to watch.

## The Claude adapter

A plain `fetch` to `POST https://api.anthropic.com/v1/messages`.

| Setting | Value | Why |
|---|---|---|
| `anthropic-version` | `2026-10-21`, pinned | The newest version. On it, `temperature`, `top_p` and `top_k` are errors, so we never send them |
| `max_tokens` | 8,000 | High enough for thinking plus an answer, and low enough for the cost cap to mean something |
| `output_config.effort` | `medium`, stated | Each model has its own default, and a measurement shouldn't depend on that |
| `thinking` | Not sent | Current models default to adaptive. Thinking text comes back empty, and the blocks are still passed along |
| `tool_choice` | `auto` | Forcing a tool is a 400 on Opus 5.5 and Sonnet 5.5, and the point is to see what the model chooses |
| Streaming | No | One JSON answer is simpler to record, and 8,000 tokens fits in an ordinary request |
| Prompt caching | Off | Runs are a few turns with a prompt near the minimum cacheable size, so it would add little. The cost code still handles its fields, because C12 has to be right if that changes |
| Refusal fallback | Off | Anthropic's reference suggests turning it on for Opus and Sonnet. Here, a model quietly swapped mid-run would ruin the measurement. Haiku 5.5 has none anyway |

**Retries:** on 408, 409, 429, 5xx and a lost connection, up to 3 attempts, honouring `Retry-After`, within the deadline. Never on other 4xx. A retry can cost money when the response was lost, which the budget below allows for.

**Tool names:** Claude accepts `^[a-zA-Z0-9_-]{1,128}$`, and MCP also allows dots and more. A tool that doesn't fit is left out, and the run's notes say so, rather than renamed behind the model's back. Tools are sorted by name, so requests are stable.

**Tool results:** text is capped at 100 KB, and a cut result says it was cut. Other content types become a short note. Tool output is untrusted text: it goes to the model because that's the job, and the loop never acts on it.

## Money: a cap that actually holds

Each live run has a `maxUsd`, default $0.25. Spending is only known after a call, so a check on what's been spent could overshoot by a full call. So before **each attempt**, including retries, it works out the worst case:

```
spent so far
+ (characters in this request + the last prompt's tokens + 1,000) x input price
+ max_tokens x output price
```

That input figure is deliberately too high. A character is usually less than a token, but replayed thinking counts as input even when its text comes back empty, and using tools adds a hidden system prompt.

If that's over the cap, the run stops with `max_usd` and makes no call. A response that was lost counts at that same worst case, since we can't know what it cost, and the run's cost is reported as "at most". **Tests hold this to a scripted model that always uses its whole allowance.**

**Live runs refuse a model that isn't in the price table,** because a cap needs a price.

### The price table

`prices.ts`, with the date it was read and the source, and a test that fails when it's over 90 days old, so a stale price can't sit there unnoticed.

| Per million tokens | Input | Output | Cache read | 5-min cache write |
|---|---|---|---|---|
| Claude Haiku 5.5, prompt up to 100K | $0.10 | $0.50 | $0.01 | $0.125 |
| Claude Haiku 5.5, prompt over 100K | $0.50 | $2.50 | $0.05 | $0.625 |
| Claude Sonnet 5.5 | $2 | $10 | $0.10 | $2.50 |
| Claude Opus 5.5 | $4 | $20 | $0.20 | $5 |

Haiku's two rows are a trap for anyone adding up totals: **the rate depends on each request's prompt length, counting cached tokens.** So cost is worked out per call and then summed, never from run totals. `input_tokens` also excludes cached tokens, so C12 has to add the three input fields together.

## Record and replay

Live runs cost money and give different answers each time. A check anyone can run for free has to be neither.

```
live:    loop --> Claude adapter --> Anthropic
record:  loop --> recorder --> Claude adapter --> Anthropic   (saves each exchange)
replay:  loop --> replayer                                    (no key, no network)
```

**Only the model is replayed. The tools really run:** the loop calls a real Crumple in front of a real `fault-api`, over real sockets, each time. So a replay still catches a server that behaves differently.

**A request has to match its recording, byte for byte.** Anything else is reported as `stale`, naming which turn and which message differ, and is never quietly accepted.

| A replay can tell you | It can't tell you |
|---|---|
| The server still gives the model exactly what it gave before | What the model would do with something new |
| A tool's description, schema or error text changed | Whether that change is better or worse for a model |
| The totals still add up | Anything about today's models. It's the model from the recording's date |

That first row gives C13 a free gate: a broken tool description shows up as `stale`. A live run is what shows how a model reacts. `evals` decides how to use both.

**How byte for byte can work,** given that Crumple makes up a fresh idempotency key each time and a model might quote one back: a recording runs against a Crumple with a seeded `newKey`. The executor already accepts one, and `mcp-surface` already passes its upstream options along, so only the code starting that Crumple changes. Same seed, same keys, same bytes. `fault-api` numbers its records in order, and its clock can be injected too.

**A recording** is one readable JSON file in `scenarios/recordings/`: the date, model, API version, commit, and each request and raw response. Keys are never in it, because they travel in headers and those aren't recorded. Only `fault-api`'s fake data appears in it, and the secret scan covers these files.

## Traces (Task 27)

```
invoke_agent                         agent-runner
  chat claude-haiku-5-5              tokens live here (C12)
  tools/call createPayment           client span
    tools/call createPayment         server span in Crumple: the join (C11)
      authorize, execute, POST /payments ...
```

`traceparent` goes in the MCP request's `_meta`, which `mcp-surface` already reads. The attribute names already exist in `telemetry`. **No prompts, tool arguments or model text go in spans,** by the rule you approved. Recordings hold those, and only when someone asks for one.

**We don't send `traceparent` to Anthropic.** It would only help someone with a trace destination set up on their account, and sending less is the better default.

## Comparing C18's estimate with the truth (Task 27)

`prove` estimates a tool's cost as characters divided by 4. [Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting) is free and accepts tools, so one script counts the same request with and without the tools. The docs call that count an estimate too, but a far better one.

Separately, using any tool at all adds a fixed system prompt, 286 tokens on Haiku 5.5, Sonnet 5.5 and Opus 5.5 with `auto`, and our estimate doesn't include it. The result goes in `docs/learn/agent-runner.md`, and if our estimate is off by a lot, `prove`'s report says by how much.

## Boundaries

**Always:**
- The API key comes from `ANTHROPIC_API_KEY` only. It's never a flag, and never appears in output, errors, spans or recordings. A test checks each.
- `redirect: 'error'` on model calls, so a key can't follow a redirect anywhere.
- The base URL can't come from the environment. Tests pass one in code. Otherwise a stray `.env` could send the key to another host.
- A non-zero spend shows up in the result, including a run that failed.

**Ask first:** any live run (see decision 3), and each one that could cost over $1.

**Never:**
- A model call from a public path. The Workers entry can't import the adapter, and a test checks the import graph.
- A fake or hand-edited number in a recording that's presented as real. Test fixtures with a scripted model live in `tests/`, and they're labelled as fixtures.
- Prices typed anywhere but `prices.ts`.

## How it gets tested

| Test | What it shows |
|---|---|
| A scripted fake of the Messages API on a real socket, in `tests/helpers/` | Every stop reason, 429 with `Retry-After`, 500, 529, a lost response, a hang, invalid JSON, all with no key |
| The loop against a real Crumple and `fault-api` | Parallel calls return in one message, in order. A server refusal reaches the model as `is_error` |
| A fake that always spends its whole allowance | **The cap holds,** including across retries, on every model in the table |
| A table of `usage` objects | Cost per call, both Haiku rows, the cached fields, and `null` rather than 0 |
| Change one byte of a recording, and one tool description | Replay says `stale`, naming the turn |
| A real recording, replayed twice | **The Task 26 check:** identical requests and identical results |
| A planted key | Absent from output, errors, spans and the recording |
| Spans from a replay | Agent and server spans share one trace id (C11). This needs a replay, not a real model |

95% branch coverage on `src/agent-runner/`, since a mistake here spends real money.

Replays go in `npm run check`, because they need no key or network beyond localhost. Live runs never do.

## Slices

**Task 26**
1. The shared MCP client (decision 2), with no change in behaviour, adding `_meta` to a call.
2. The loop against the scripted fake: stop reasons, parallel calls, limits.
3. The Claude adapter: request shape, retries, errors.
4. The money: prices, per-call cost and the cap.
5. Record and replay, with a recording of the scripted fake.
6. **Yours:** one command for the first real recording (decision 3).

**Task 27**
7. Totals against the real recording (C12).
8. Joined traces (C11).
9. The estimate comparison (C18), then `docs/learn/agent-runner.md`.

`src/agent-runner/`: `loop.ts`, `claude.ts`, `recording.ts`, `usage.ts`, `prices.ts`, `tracing.ts`, `index.ts`. `tests/helpers/fake-claude.ts`, `scripts/record.mjs`, `scenarios/recordings/`.

## Honest limits

- **Not a production agent:** no memory, no compaction, no streaming, no sub-agents. It's a loop for measuring.
- **Claude only for now.** The main spec calls an OpenAI-compatible adapter "second", and I'm leaving it until someone asks, since adding it needs another price table, another error model and a key to test with. The loop only sees a small interface, so it can be added later.
- **Claude's own API only,** not Bedrock, Vertex or Foundry, and an API key only, not `ant auth login` profiles.
- **Recordings age.** A replay says nothing about today's models.
- **One run on one model proves little.** That's still true with this. `evals` has to run scenarios more than once, and say how many.
- **Prices change.** Costs are as of the date in the table, and the test only makes sure someone looks.

## Decided

The owner chose the recommended option in all three: Haiku 5.5 as the default, a shared `mcp-client` module (map revision 4), and a first real recording capped at $0.10, run by the owner once slices 1 to 5 are done.

**1. The default model.** The main spec says Claude Haiku 5.5, "confirmed in this spec". Anthropic's reference makes Opus 5.5 its general default, so I'm asking rather than assuming. Anyone can choose another model per run.

- **A, recommended: Haiku 5.5.** At $0.10 / $0.50 it's 40 times cheaper than Opus 5.5 at $4 / $20, so evals can run often, and strangers can afford `eval --live`. It's also the harder test: a weaker model leans more on good tool descriptions and clear errors, which is what Crumple claims to provide.
- **B: Opus 5.5.** Better judgement, and closer to what people often run for agents. It makes C2 and C10 easier to pass, and costs more each time.

**2. How does the agent speak MCP?** `prove` has a hand-written client that's already tested on both protocol eras. The map doesn't allow `agent-runner` to use it, and adding a module is yours to approve.

- **A, recommended: move it to a small shared module, `mcp-client`,** used by both, as map revision 4. One client, and its tests move with it. `prove` and `agent-runner` still don't depend on each other.
- **B: let `agent-runner` import from `prove`.** No new module, but it ties two things together that have no reason to know about each other.
- **C: use the official client.** It's what real agents run, and it's a third runtime dependency for everyone who installs this, breaking the promise of two.

**3. The first real recording.** Task 26's check needs one, and any spending needs your okay. You'd run one command with your own key, because I shouldn't handle it:

```bash
ANTHROPIC_API_KEY=... npm run record -- first-payment
```

It's one scenario with a cap of **$0.10**. **My estimate, not a measurement:** about 3 turns at about 1,000 input tokens each and 500 output tokens altogether comes to under a tenth of a cent on Haiku 5.5, and about 2 cents on Opus 5.5.

- **A, recommended: yes, once slices 1 to 5 are done.**
- **B: wait until Task 28.** Task 26 then rests on a scripted recording, and it isn't really finished until the real one exists, because a fake can't show that our idea of the API matches the real one.

## Verified on 2026-11-05

| Fact | Source |
|---|---|
| Prices in the table, and Haiku's rate depending on each request's prompt length, cached tokens included | [Pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| Tool names must match `^[a-zA-Z0-9_-]{1,128}$`, and forced `tool_choice` is a 400 on Opus 5.5 and Sonnet 5.5 | [Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) |
| Token counting is free, accepts tools, and returns an estimate | [Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting) |
| The 286-token tool system prompt with `auto` | [Tool use overview](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview) |

From the Claude API reference bundled with Claude Code, cached 2026-10-06, and not rechecked live: API version `2026-10-21` and its removal of sampling parameters, stop reasons and `stop_details`, which errors can be retried, parallel results going in one message, Haiku 5.5 having no server-side refusal fallback, the two usage fields, and preserved thinking. The real recording is the check on these.

Not confirmed: that a run's prompt really stays near the cache minimum (512 tokens), so "caching would add little" is a judgement until the first recording shows the numbers. And that a real run's requests are stable enough for byte-for-byte matching. **That's the riskiest idea here,** and it's why replay comes before the real recording.

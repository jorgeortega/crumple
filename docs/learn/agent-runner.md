# `agent-runner`: a small agent, built to measure things

Spec: [SPEC-agent-runner.md](../../SPEC-agent-runner.md). Code: [src/agent-runner/](../../src/agent-runner/).

## The one-sentence version

Give it a task and an MCP server, and it asks a real model what to do, calls the tools the model picks, sends back the results and repeats, writing down what happened, what it used and what it cost.

## Where it stands today

**No real model has run through this yet.** Everything so far is tested with scripted models and a fake of the API. The first real recording was put off on 2026-11-05, so:

| | Status |
|---|---|
| The loop, the cap, replay, joined traces | Built and tested, with scripted models |
| C11, traces across agent and server | Passes, and `prove --self` and `demo` check it |
| C12, tokens and cost against real usage | **Not run.** The arithmetic is tested. Whether it matches a real bill needs a real run |
| That our idea of the API matches the API | **Unknown** until the first real run |

Say this if asked. Don't let a passing test suite sound like a real run.

## What it's for

It's a measuring instrument, not a product, and nobody should build on it. It exists because an MCP server never sees token counts, since they belong to the model call. And "the model recovered from that error" needs a model.

## The loop

```
ask the model --> it asks for tools --> run them all --> send back every result, together --> repeat
```

About 250 lines, and most of them decide how it ends. Three rules are worth knowing:

- **History is only added to.** The assistant's reply goes back exactly as it came, because on current models, editing an earlier turn invalidates its thinking blocks.
- **Parallel calls run at once, and their results go back in one message.** Anthropic's docs say that splitting them teaches the model to stop calling tools in parallel.
- **Nothing from a turn cut off by `max_tokens` gets run,** because the arguments may be cut off too.

The system prompt says almost nothing, on purpose. C10 asks whether Crumple's error messages tell an agent what to do next, and a prompt coaching the model would make that look truer than it is.

## Two different refusals

The most useful thing here to explain to someone:

| | Who refuses | How it arrives | What we do |
|---|---|---|---|
| **The server** | Crumple: no grant, unknown tool | A protocol error, which official MCP clients raise as an exception | Hand it to the model as `is_error: true`, so it can react |
| **The model** | Claude's safety checks | **HTTP 200,** with `stop_reason: "refusal"` | End the run, and say so |

Treat the first as a crash, and the model never learns it was refused. Forget to check the second, and you read an answer that isn't there, because nothing looked like an error.

## A cap that actually holds

The obvious cap checks what's been spent, and it overshoots by a whole call, because a call's cost is only known afterwards. So before **each attempt**, retries included, it works out the worst that attempt could cost, and refuses if that would pass the limit:

```
spent so far
+ (characters in the request + last prompt's tokens + 1,000) x input price
+ max_tokens x output price
```

The input figure is deliberately too high, because a hidden system prompt and replayed thinking don't show up in the characters.

**What about a lost answer?** It may have been billed, and we can't know. So it counts at that same worst case, and the run's cost says "at most".

**How do we know it works?** I broke it on purpose, changing it to check only what had been spent. Six tests failed, including the one against a model that always spends its whole allowance.

## Why cost is worked out per call

Haiku 5.5 has two rates, and which one applies depends on **each request's** prompt length, cached tokens included. Two calls of 60,000 tokens both pay the lower rate, while one call of 120,000 pays the higher. Add up a run and then price the total, and you get the wrong answer. There's a test for exactly that.

Also, `input_tokens` leaves out cached tokens, so the prompt's length is three fields added together.

## Record and replay

Live runs cost money and answer differently each time. A check anyone can run for free has to be neither.

**Only the model is frozen.** The tools really run, against a real Crumple, each time. So a replay still catches a server that behaves differently.

**Each request has to match its recording byte for byte,** or the run stops as `stale`, saying which turn and message differ.

| A replay can tell you | It can't tell you |
|---|---|
| The server still gives the model exactly what it gave before | What a model would do with something new |
| A tool's description or an error's text changed | Whether that change is better or worse |

**The clever bit is seeded keys.** Crumple makes up a fresh idempotency key each time, and a model may quote one back, which would break byte-for-byte matching. So a recording runs against a Crumple whose keys are seeded: same seed, same keys, same bytes. A test turns the seed off and confirms the replay goes stale, so we know this is doing the work.

**The risk:** that's only shown with a scripted model. A real run could turn up something else that varies.

## Traces

```
invoke_agent                         agent-runner
  chat claude-haiku-5-5              tokens live here
  tools/call getCustomer             the agent's span
    tools/call getCustomer           Crumple's span, under it: the join
      authorize, execute, GET /customers/{id}
```

The join is one field: `traceparent`, in the `_meta` of the MCP call. Claude Code didn't send it in our runs, so its calls each start a new trace. Ours does, so one trace runs from the agent's decision to the HTTP request.

`prove --self` checks this with the real loop and a scripted model, because joining a trace doesn't depend on what a model says. No key, and nothing spent.

**No prompts, arguments or model text go in spans.** A test checks with strict telemetry. Recordings do hold those, and only when someone asks for one.

We don't send `traceparent` to Anthropic. It would only help someone with a trace destination set up, and sending less is the better default.

## Choices someone might question

- **Plain `fetch`, not Anthropic's SDK.** Anthropic recommends the SDK for most projects. We chose `fetch` to keep the package's two runtime dependencies and to see everything. The cost is that retries, errors and keeping up with API changes are ours. Pinning the API version keeps that small.
- **Haiku 5.5 by default.** It's 40 times cheaper than Opus 5.5, so evals can run often. It's also a harder test, since a weaker model leans more on good tool descriptions.
- **No refusal fallback.** Anthropic suggests it for Opus and Sonnet. Here, a model swapped mid-run would ruin the measurement.
- **Claude only.** An OpenAI-compatible adapter waits until someone asks.

## Honest limits

- **Not run against a real model yet,** as above.
- **Not a production agent:** no memory, no compaction, no streaming.
- **Recordings age.** A replay says nothing about today's models.
- **One run on one model proves little.** `evals` has to run scenarios more than once, and say how many.
- **The price table goes stale.** A test fails after 90 days, so someone has to look.

## Where to look

[loop.ts](../../src/agent-runner/loop.ts) reads top to bottom. [usage.ts](../../src/agent-runner/usage.ts) is the cap. [recording.ts](../../src/agent-runner/recording.ts) is short. [scenario.ts](../../src/cli/scenario.ts) ties them to a real Crumple.

## Teach-back

1. Why does C12 need our own agent, when C18 doesn't?
2. A model's reply comes back as HTTP 200 with no text. What happened, and why would a `try/catch` not notice?
3. Why does a cap that checks what's been spent overshoot, and how does this one avoid it? What happens when an answer is lost?
4. A replay reports `stale` after someone improves a tool's description. Is that a failure? What can you find out from a replay, and what do you need a live run for?
5. Why would a replay break without seeded keys?
6. **Where would you change this?** "We want to add GPT." What changes, what stays the same, and what about the price table and the two refusals?

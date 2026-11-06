# Case study: building a crumple zone for AI agents

Crumple is a small MCP runtime that sits between agents and an API, plus a command that checks its claims by breaking that API on purpose. This is what got decided, what was measured and what turned out wrong.

**Who did what.** Jorge Ortega directed the project: the scope, the claims, each module's boundaries and every trade-off, in short specs approved before any code. [Claude Code](https://claude.com/claude-code), an AI coding agent, wrote the code. The specs are in the repo, so the decisions can be checked.

## The problem

Turning an API into MCP tools is solved. What happens next isn't, because an agent is a bad caller in ways a normal program isn't:

- It retries a payment because a response got lost.
- It reads whatever the API returns, including text someone planted.
- It runs many calls at once, and can't tell "try later" from "never" unless something says so.
- When it does damage, someone has to work out what happened.

And anyone can write "production-ready" in a README. So the design goal was narrower than "a good gateway": every claim has to be a check that can fail.

## The result in one table

A payment goes through, then its response is lost:

<!-- generated:demo -->
```
                     Agent is told   Charges
  Plain retry loop   succeeded       2
  Crumple            succeeded       1
```
<!-- /generated -->

The losing side is a server written for this demo to make this mistake, not a real project. Both are told it worked, and only one customer paid once.

## The decisions that mattered

**Retries depend on the operation, and a 503 doesn't earn a keyless write a retry.** A 503 usually means nothing happened, and "usually" is the wrong standard for money. This costs something: some writes a retry would have rescued come back as `outcome_unknown` instead. A wrong answer here charges someone twice, while the cost of being careful is a question the agent has to answer. The whole rule is [one pure function](../src/executor/errors.ts).

**Errors are written for a model to read.** Each failure has a code and one of four pieces of advice: no, later, repeat with this key, or look first. The real test was whether a model would act on them. In the live run, with a system prompt saying nothing about errors, it called again with the key it was given, and the API saw one payment, in every run of that scenario. The tool's description and the error did that by themselves.

**The permission check can't see the prompt.** The decision is [a pure function of who's calling and which tool](../src/access-control/policy.ts), with no arguments, prompt or tool output as input. So nothing the model read can change the answer. It's the one defence against prompt injection here that doesn't depend on the model behaving, and the proof uses a scripted agent that always obeys the planted text. It doesn't prevent an injection: if the key has the grant, the injected call can succeed. It limits the damage.

**The checker can't import what it checks.** `prove` and the agent runner only reach a server over MCP, enforced by [a test on module boundaries](../tests/boundaries.test.ts). They use a small hand-written client, because the official one hides the status codes that are often the thing being tested.

**A check must be able to fail.** A tool whose job is printing "pass" is dangerous. So [a server that's wrong on purpose](../src/cli/wrong-server.ts) has every bad habit built in, and each check has a test that runs it there and requires it to fail.

**Eval thresholds were written before any result existed.** Moving them after seeing a score is how evals end up lying. Scenarios are graded by what actually reached the API, never by what the model said.

**Replay and live answer different questions.** A replay plays a real model's kept answers against today's server, free, and flags any difference, which makes it a gate for every commit. Only a live run can say whether a model does worse, so a replay never reports a pass rate.

## What was measured

All of this ran on one laptop, with failures caused on purpose. **It says nothing about production load.**

**Claims:**

<!-- generated:claims-headline -->
**18 of 18 claims passed**, at commit `f952fff` on 2026-11-06 (darwin arm64, Apple M5, 16 GB, Node 26.10.0).
<!-- /generated -->

**Agent evaluations:**

<!-- generated:evals -->
`claude-haiku-5-5`, 5 runs of each of 14 scenarios: **70 of 70 model runs passed**, for $0.0258 (178217 tokens in, 16008 out), on 2026-11-06. A model that does nothing would pass 4 of 14.
<!-- /generated -->

A perfect score is a sign the scenarios are easy, not that the system is excellent. The cheapest model passed them all, so this can notice a clear drop, and can't tell a good model from a better one.

**Load:**

<!-- generated:load -->
Crumple added 0.3 ms at p50 and 0.7 ms at p95 to a call. 50 concurrent callers got 4266 calls/s, with 0 failed. While 100 callers on one key flooded a slow API, 34534 of their calls were refused, and another caller got 23 of 23 through, at a p95 of 225.3 ms against 208.4 ms alone. On 2026-11-05.
<!-- /generated -->

The API here does no real work and everything shares one Node process, so these aren't Crumple's limits. The added latency is the useful number.

## What turned out wrong

These are the most useful part, so they get the most honest telling.

**The original plan for `prove` couldn't work.** It said people could test failure behaviour on their own server by pointing it at the fake API. Working it through showed that's true for almost nobody, because their tools call their own API's paths. So `prove <url>` became outside checks plus tools you name, and `prove --self` proves Crumple. The result is a less impressive feature, and [the limits are written down](../README.md#what-it-doesnt-do).

**Its first real target had a real bug.** Pointed at Latitude 10's own MCP servers, `prove` found they answered requests from a website they didn't know, where the MCP spec says to refuse them. That was fixed there, and the checks now pass.

**The token estimate runs low.** Characters divided by 4 is the usual rule of thumb. Compared with Anthropic's own count, it came out well short. [The explainer](learn/prove.md) has the numbers. A tool definition costs more than the estimate suggests, on every turn.

**The grader can't see what the model said.** It grades records. One run of the lost payment said flatly that the payment was created once, others said it should have been and suggested checking, and they scored the same. It took a person reading transcripts to notice. A model can do the right thing and describe it wrongly.

**The injection result is weaker than it looks.** A model ignored the planted instruction in all five runs, with a key that could have obeyed. But the instruction is one crude sentence, the delete tool's description says to use it only when clearly asked, and it's one model. So that scenario is an observation that never fails the gate, and the claim rests on the permission check instead.

**The documentation had mistakes too.** Following the README's own commands by hand found a missing `--upstream` flag, and a separate review against the code found four more statements that were wrong or unsupported. Tests now generate and check the numbers, but the prose is only as good as its last read.

## What it doesn't show

It isn't production-proven. One process means limits and the circuit breaker live in memory, so several copies give you several sets of limits. Permissions stop at the tool, so "up to this amount" is still your API's job. It can't make an unsafe API safe: if a write has no idempotency key and its response is lost, nobody can know what happened. Only one stock client, Claude Code, has been tried. [The full list](../README.md#what-it-doesnt-do) is longer.

## Try it

```bash
npx crumple-mcp demo
```

Or use [the hosted demo](https://crumple.latitude10.tech), with nothing to install.

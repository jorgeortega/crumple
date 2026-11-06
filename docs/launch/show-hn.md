# Show HN draft

The owner posts this, and only once the repo is public, the package is on npm and the demo shows the latest claims. Check the [Show HN guidelines](https://news.ycombinator.com/showhn.html) first. Stay around for the comments, and answer the hard ones plainly.

## Title

Show HN: Crumple – an MCP runtime where every claim is a check you can run

## URL

https://github.com/jorgeortega/crumple

## First comment

Agents are bad API callers in specific ways. They retry a payment because a response got lost, they read whatever an API returns, and they can't tell "try later" from "never" unless something says so.

Crumple sits between an agent and your API. You give it an OpenAPI document and it serves MCP tools, with permissions, deadlines, retries, a circuit breaker and traces in one place that isn't the model.

Plenty of projects claim that sort of thing, so this one is built around a command that breaks an API on purpose and counts what happened:

    npx crumple-mcp demo

<!-- generated:demo -->
```
                     Agent is told   Charges
  Plain retry loop   succeeded       2
  Crumple            succeeded       1
```
<!-- /generated -->

The losing side is a server I had written to make that mistake, not a real project. There's also a hosted demo with nothing to install: https://crumple.latitude10.tech

Some things you should know:

- It isn't production-proven. Every number is from one laptop, with failures caused on purpose. It's one process, and it isn't a replacement for agentgateway, LiteLLM or Kong. There's a comparison page that says when to use those instead.
- It limits what a prompt injection can do, and doesn't prevent one. If the key has the grant, the injected call can succeed.
- I directed this and Claude Code wrote the code. Each module started as a short spec I approved, and those are in the repo. I'm saying so because you'd want to know, and because it's a fair reason to look harder at the tests.
- The evals are easy. The cheapest model passes them all, so they show the mechanism and not how agents do on real work.

The part I'd most like criticised is the retry policy: a write with no idempotency key gets one attempt, even after a 503. That costs some writes a retry would have rescued. What would you do differently?

It's MIT licensed and sends no telemetry. It's from Latitude 10, my company, which also hosts MCP servers, but Crumple doesn't need it.

# r/mcp draft

The owner posts this, the same day as Show HN. Read the subreddit's current rules first, since they weren't checked for this draft.

## Title

Testing what an MCP server does when things break: a demo that charges a customer twice on purpose, then doesn't

## Post

The happy path is the easy part of an MCP server. The harder question is what happens when a response gets lost halfway through a payment, or a tool's output tells the agent to delete something.

Crumple is a runtime that serves your OpenAPI document as MCP tools, with a test harness that breaks the API behind it and counts what happened.

    npx crumple-mcp demo

<!-- generated:demo -->
```
                     Agent is told   Charges
  Plain retry loop   succeeded       2
  Crumple            succeeded       1
```
<!-- /generated -->

(The plain loop is a server I had written to make that mistake, not anyone's project.)

Two parts might be useful even if you never run the runtime:

**`prove` checks a server you own, from outside.** It looks at whether it speaks MCP, how it treats a bad token, what its errors look like, and what your tool definitions cost on every turn. It calls no tool you didn't name, and writes a report and a badge saying how many checks passed, failed and didn't run.

    npx crumple-mcp prove https://you.example/mcp --out proof

Only point it at servers you own. Its first real target was my own company's server, and it found a bug: the server answered requests from websites it didn't know, where the spec says to refuse them.

**The errors are written for a model.** Each has a code and one of four pieces of advice. In the live evals, a model that lost a payment's response called again with the idempotency key it was given and ended with one payment, with nothing about errors in its system prompt.

Limits, so nobody's surprised: it isn't production-proven, it's one process, only Claude Code has been tried as a stock client, and from outside `prove` can't see most failure behaviour. I directed it and Claude Code wrote the code, and the specs are in the repo.

Repo: https://github.com/jorgeortega/crumple

Hosted demo, on fake data, with a public MCP endpoint you can connect to: https://crumple.latitude10.tech

I'd especially like to hear from anyone who tries `prove` on their server and thinks a check is wrong.

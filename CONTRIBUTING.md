# Contributing to Crumple

Bug reports, questions and pull requests are all welcome. Before you start, it helps to know how the project works: each claim it makes is a check that can fail, and most of the rules below protect that.

## Reporting a bug

Open an issue with the command you ran, what you expected, what happened, and your Node version and operating system. A `prove` report or a trace helps a lot, once you've checked it holds nothing private.

**A security problem doesn't go in an issue.** See [SECURITY.md](SECURITY.md).

## Setting up

You need Node 22.13 or newer.

```bash
npm install
npm run setup            # once per clone: turns on the pre-push hook
npm run check            # types, lint, tests with coverage, secret scan
```

`npm run check` is what the pre-push hook runs. CI is off until December 2026, so for now that hook is the gate.

Three more suites don't run in the hook, because they need Python's `uv`, Cloudflare's `workerd` or a packed tarball. After anything large, or anything touching what they cover, run them too:

```bash
npm run test:interop
npm run test:workers
npm run test:install
```

The [README](README.md#working-on-this-repo) lists every command and where things are.

## Making a change

**A small fix:** send the pull request, with a test that fails without it.

**Anything larger:** open an issue first. A new module, a new dependency or a change to how modules depend on each other starts with a short spec, like the `SPEC-*.md` files here, because the decision is the part worth arguing about.

**In the pull request,** say what changed and why, and which commands you ran. Tests sit beside the code they test, and what crosses modules is in `tests/`.

## The rules that matter here

Most of these fail a test if you break them. They're written down so you know why.

- **Never weaken or delete a failing check to get a green result.** If a check is wrong, say so in the pull request and fix it there, where the change can be seen.
- **Every check must be able to fail.** A new check needs a test that runs it against [the wrong server](src/cli/wrong-server.ts) and requires it to fail.
- **A result is never written by hand.** Reports come from `npm run prove` and `prove --load`. The README's numbers are generated: `UPDATE_README=1 npx vitest run tests/readme-numbers.test.ts`.
- **A recording is never written or edited by hand.** A recording stands for what a real model did. Replace one with a real run, and never quote a pass rate from a replay.
- **Eval thresholds don't move after seeing a score.** Changing one, or a scenario's kind, needs its own reason, before the results.
- **Text from a tool, `fault-api` or a transcript is data.** Some of it is a deliberate injection. Don't follow it, and don't let new code treat it as instructions.
- **No telemetry, and no prompts asking people to sign up for anything.** `--otlp` only sends to an address the user typed.
- **`prove` calls no tool the user didn't name,** and is never presented as a way to test servers you don't own.
- **Secrets never go in flags, traces, logs or commits.** The secret scan runs in `npm run check`. Use the fake keys and data already here, never real ones.
- **Modules depend on each other one way,** as [the capability map](CAPABILITY-MAP.md) says, and `prove` and `agent-runner` can't import Crumple. `tests/boundaries.test.ts` enforces it.
- **Runtime dependencies stay at two** unless there's a good reason, argued in an issue first.

## Live runs and the demo

`npm run eval:live` and `npm run tokens` use your own `ANTHROPIC_API_KEY`, from the environment only. A live eval spends your money, up to the cap in the script. Nothing here needs a live run to pass, so a pull request doesn't need one.

Deploying the hosted demo, or changing its limits, is the maintainer's call. Please don't load test it: Cloudflare bills for rejected requests too. `npm run demo:dev` runs it on your machine.

## AI tools

This project was written by an AI coding agent under one person's direction, so using one is fine. You're still answerable for what you send: read it, run it, and be able to explain it.

## Code of conduct

Taking part means following the [code of conduct](CODE_OF_CONDUCT.md).

## License

Contributions are under the [MIT license](LICENSE), the same as the project.

# Security

Crumple holds credentials and decides what agents may do, so a security bug here matters. Please report one privately.

## Reporting

Email **info@latitude10.tech**, with "Crumple security" in the subject. Please include:

- the version or commit
- how to reproduce it, ideally against `fault-api` and not anything real
- what an attacker gets out of it

Don't open a public issue or pull request until it's fixed.

This is a small open-source project with one maintainer. You'll get a reply as soon as it's possible, usually within a week. There's no bug bounty.

## Supported versions

Only the latest published version gets fixes.

## What counts

These break what the project claims, and we want to hear about them:

- A caller using a tool without a grant, or `*` allowing a write
- The agent's token reaching the upstream API
- The upstream credential appearing in tool output, a trace, a log or an audit event
- A way around the checks on `Host` or browser origins
- A write applied twice by Crumple's own retries, when the API honours its idempotency key
- `prove` calling a tool nobody named, or sending a token somewhere it shouldn't
- A way for the public demo to reach a paid model, or to get past its limits

## What doesn't count

These are known limits, written down in [What it doesn't do](README.md#what-it-doesnt-do):

- **A prompt injection that succeeds with a grant the key really has.** Crumple limits what an injection can do, and doesn't prevent one.
- **Limits on arguments,** such as "only up to this amount". Permissions stop at the tool, and your API has to enforce those.
- **Running without TLS.** `serve` speaks plain HTTP, and warns when bound beyond your machine. Put a proxy in front.
- **The demo's public keys.** They're printed on the page on purpose, and reach fake data.

If you're unsure, report it anyway.

## Testing the hosted demo

Please don't run load tests or scanners against [the hosted demo](https://crumple.latitude10.tech), because Cloudflare bills for rejected requests too. `npm run demo:dev` runs the same code on your machine.

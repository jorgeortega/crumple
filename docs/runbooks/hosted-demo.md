# Runbook: the hosted demo

Spec: [SPEC-hosted-demo.md](../../SPEC-hosted-demo.md). Code: [workers/](../../workers/).

Run every command from the repo's root. **Deploying, and changing a limit, are the owner's call.**

## Run it locally

Nothing here touches Cloudflare or needs an account.

```bash
npm run demo:dev
```

That's `http://localhost:8787`, on Cloudflare's own runtime with a local D1 database.

```bash
npm run test:workers
```

## Before the first deploy

The owner checks these. Only they can.

1. **The account.** This goes on the same Cloudflare account as Latitude 10, and that account is on Workers Paid. If it's on Free, the limits are 100,000 requests a day and 10 ms of CPU per request, and a run may not fit.
2. **A billing notification** in Cloudflare's dashboard. The code can't cap Cloudflare's own bill: a flood of 100 million requests would cost about $27.
3. **The name.** `crumple.latitude10.tech` has no existing CNAME, because a custom domain can't use one.
4. **The rate limit's namespace.** `2001` in `workers/wrangler.toml` must not be used by another Worker on the account, or they'd share counters. `1001` is taken by `latitude10-demo-apis`.
5. **The binding's cost.** Cloudflare's pages don't mention one, and don't say it's free. Check the dashboard after deploying.

## The first deploy

After `npm run check` and `npm run test:workers` pass:

```bash
npx wrangler whoami
```

```bash
npx wrangler d1 create crumple-demo
```

Put the id it prints in `database_id` in `workers/wrangler.toml`.

```bash
npx wrangler d1 migrations apply DB --remote --config workers/wrangler.toml
```

```bash
npx wrangler deploy --config workers/wrangler.toml
```

Then, with the printed read key, check it from outside and record the result in [docs/clients.md](../clients.md):

```bash
CRUMPLE_PROVE_TOKEN=crumple_public-demo-read-key-fake-data-nothing-else node dist/cli/bin.js prove https://crumple.latitude10.tech/mcp
```

Connect a stock client with the command on the page, and call a tool.

**Check that Cloudflare didn't edit the page.** The zone's Web Analytics adds a script to pages on every subdomain, but only for requests that look like a browser, so a plain `curl` won't show it. The page promises no analytics, so `_headers` sets `no-transform` to stop it. This must print one line, for `/page.js`. Run on `latitude10.tech`, which has the script, it also finds `cloudflareinsights`:

```bash
curl -sS -H "User-Agent: Mozilla/5.0 (Macintosh) Chrome/140.0.0.0" -H "Accept: text/html" https://crumple.latitude10.tech/ | grep -o '<script[^>]*src="[^"]*"'
```

**If your own machine can't find the name right after the first deploy,** it's probably a cached "no such name" from looking it up before the record existed. That lasts up to 30 minutes.

## Switch it off

The fastest way to stop all of it, including any bill from a flood:

```bash
npx wrangler delete --config workers/wrangler.toml
```

That removes the Worker, and with it the page, `/mcp` and the buttons. Check afterwards that `crumple.latitude10.tech` is gone from the zone's DNS records. To remove the counter as well:

```bash
npx wrangler d1 delete crumple-demo
```

To bring it back, go through the first deploy again.

## If the demo says it's closed

`/mcp` and the buttons answer 503 after 20,000 requests in a UTC day, and the page stays up. It opens again at midnight UTC. That's the limit working, so don't raise it without the owner.

To see today's count:

```bash
npx wrangler d1 execute DB --remote --config workers/wrangler.toml --command "SELECT day, count FROM daily_requests ORDER BY day DESC LIMIT 7"
```

If every request gets a 503 that says the limit couldn't be checked, D1 is failing. It stays closed on purpose, because a cap that can't be checked can't be promised.

## Changing a limit

The limits are in `workers/wrangler.toml` and `RATE_PER_MINUTE` and `DAILY_CAP` in `workers/limits.ts`, and the page states them too. A test keeps the first two equal. Any change needs the owner's okay, as does the deploy after it.

## When the repo goes public

Add the GitHub link to the page's footer, and remove the check for it in `workers/page.test.ts`.

import { createLimits, type DailyCounter, type RateLimiter } from './limits.js';
import { createDemoSurface, type DemoSurface } from './surface.js';
import { isScenario, runScenario, type RunOptions } from './try.js';

// The Worker's one job: decide what a request may do. The page is a static asset and never gets here.
// Anything that can be turned away for free is turned away before the limits, so it costs no D1 write.

const HOUR_MS = 3_600_000;
const TRY_PREFIX = '/try/';

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });

export interface DemoOptions {
  rate: RateLimiter;
  counter: DailyCounter;
  cap?: number;
  now?: () => number;
  /** For tests. */
  run?: RunOptions;
}

export interface Demo {
  fetch(request: Request): Promise<Response>;
}

export function createDemo(options: DemoOptions): Demo {
  const { rate, counter, cap, now = () => Date.now(), run } = options;
  const limits = createLimits({ rate, counter, now, ...(cap === undefined ? {} : { cap }) });

  // Memory, per instance, and thrown away on the hour by the clock. That's the whole of the reset.
  let current: { hour: number; demo: Promise<DemoSurface> } | undefined;
  function sharedSurface(): Promise<DemoSurface> {
    const hour = Math.floor(now() / HOUR_MS);
    if (current?.hour !== hour) current = { hour, demo: createDemoSurface() };
    return current.demo;
  }

  async function serveMcp(request: Request): Promise<Response> {
    // Every web page is refused here, ours too: the page doesn't use this.
    if (request.headers.has('origin')) return json(403, { error: 'This origin isn\'t allowed.' });
    const stop = await limits.check(request);
    return stop ?? (await sharedSurface()).surface.fetch(request);
  }

  async function serveTry(request: Request, url: URL, name: string): Promise<Response> {
    if (!isScenario(name)) return json(404, { error: 'There is no such button.' });
    if (request.method !== 'POST') return json(405, { error: 'Press the button: this takes a POST.' }, { allow: 'POST' });
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== url.origin) return json(403, { error: 'This origin isn\'t allowed.' });
    const stop = await limits.check(request);
    return stop ?? json(200, await runScenario(name, run));
  }

  return {
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/mcp') return serveMcp(request);
      if (url.pathname.startsWith(TRY_PREFIX)) return serveTry(request, url, url.pathname.slice(TRY_PREFIX.length));
      return Promise.resolve(json(404, { error: 'Not found. The MCP endpoint is /mcp.' }));
    },
  };
}

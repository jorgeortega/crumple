import { createDemo, type Demo } from './demo.js';
import { d1Counter, DAILY_CAP, type D1Like, type RateLimiter } from './limits.js';

// The few lines that read Cloudflare's bindings. Everything else can run and be tested without them.

interface Env {
  DB: D1Like;
  RATE_LIMIT: RateLimiter;
  DAILY_CAP?: string;
}

const capFrom = (value: string | undefined): number => {
  const cap = Number(value);
  return Number.isInteger(cap) && cap > 0 ? cap : DAILY_CAP;
};

// Kept for the life of the instance, because an instance that's closed for the day has to remember it.
let demo: Demo | undefined;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    demo ??= createDemo({ rate: env.RATE_LIMIT, counter: d1Counter(env.DB), cap: capFrom(env.DAILY_CAP) });
    return demo.fetch(request);
  },
};

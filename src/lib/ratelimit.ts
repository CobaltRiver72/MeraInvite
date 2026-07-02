// Distributed rate limiting via Upstash Redis. In-memory limits do NOT work on
// serverless (each invocation is isolated) — use a shared store.
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const limiters: Record<string, Ratelimit> = {
  checkout:      new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, "1 m"), prefix: "rl:checkout" }),
  checkoutEmail: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(3, "1 h"),  prefix: "rl:ckemail" }), // anti email-bomb / card-testing
  status:        new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(60, "1 m"), prefix: "rl:status" }),
  render:        new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, "1 m"),  prefix: "rl:render" }),
  download:      new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, "1 m"), prefix: "rl:download" }),
};

export async function limit(bucket: keyof typeof limiters, key: string) {
  const { success } = await limiters[bucket].limit(key);
  return success;
}

// Best-effort client IP behind Cloudflare/Vercel.
export function clientIp(req: Request) {
  const h = req.headers;
  return (
    h.get("cf-connecting-ip") ||
    h.get("x-real-ip") ||
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "0.0.0.0"
  );
}

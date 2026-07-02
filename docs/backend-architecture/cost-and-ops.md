# Cost & Ops — keeping the run cost near-zero

The architecture is deliberately shaped so that **traffic is cheap and only purchases cost compute.** Where the money goes and how it's kept low:

## The compute-cost design

- **Free designs render in the browser** (`html2canvas`) → **$0 server cost** for the high-volume "free" crowd. The server is never invoked to make a free card.
- **Premium renders happen once, then cache.** `/api/render` uses **Satori + resvg-js** (pure JS + Rust-WASM, ~50–200 ms, ~tens of MB RAM) instead of headless Chrome (5–15 s cold start, 0.5–1 GB RAM). The result is cached in private R2 keyed by a text hash, so re-downloads and identical re-renders cost nothing. Editing text busts the cache and renders again — rate-limited to 5/min.
- **No headless Chrome** means we stay well inside a 1024 MB / short-duration function and avoid the biggest serverless cost trap.

## Why there's no database-connection bill or bottleneck

- All DB access goes through **`@supabase/supabase-js` (PostgREST over HTTPS)** — it does **not** open a Postgres socket per serverless invocation, so 200 concurrent functions ≠ 200 DB connections. No Supavisor pooler needed at this stage. (Only adopt a pooler/port 6543 if you later switch to a direct-connection ORM like Prisma/Drizzle.)

## Bandwidth — the other usual killer

- **Cloudflare R2 has zero egress fees**, so heavy free-download traffic doesn't generate per-GB bandwidth bills (the classic S3 surprise).
- **Cloudflare CDN in front of static/catalog pages** serves most pageviews from cache → fewer Vercel function invocations → lower compute bill, and faster Core Web Vitals.

## Per-service cost posture (at 1K–5K sales/mo)

| Service | Free/cheap tier covers us? | Notes |
|---|---|---|
| Vercel | Hobby/Pro | Only purchases + webhooks hit functions; pages are cached. |
| Supabase | Free → Pro ($25) when rows/storage grow | REST access, no pooler cost. |
| Cloudflare R2 | Pennies for storage, **$0 egress** | Two buckets: public + private. |
| Cloudflare CDN/WAF/Turnstile | Free–$20 | WAF + Turnstile included; offload rate-limiting here to spare Upstash calls. |
| Upstash Redis | Free (10k cmds/day) → pay-per-use | Only checkout/render/download hit it. Coarse limiting at Cloudflare reduces calls. |
| Stripe / Razorpay | Per-transaction % only | No fixed cost. Card-testing (blocked by Turnstile) would otherwise rack up auth fees. |
| Resend | Free 3k emails/mo | Receipts + download links. |

Net: until you're at real volume, the stack runs at roughly **the cost of a Supabase Pro seat plus payment fees** — most months are within free tiers.

## Operational guardrails

- Pin the render function to **Node runtime, `maxDuration = 30`, 1024 MB** (default is fine for Satori; do not raise memory unless profiling shows you need it — memory drives cost).
- Set **Vercel spend limits / budget alerts** and a Cloudflare rate-limit rule on `/api/*` as the outer wall.
- Monitor: webhook failure rate, count of `pending` orders older than 1h (failed payments or webhook gaps), render p95 latency, Upstash command count.
- Keep preview deployments on **test** payment keys so a leaked preview can't move real money.
- Rotate keys on any exposure; `gitleaks` pre-commit prevents the common accident.

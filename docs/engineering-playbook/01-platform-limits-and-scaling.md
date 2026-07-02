# 01 · Platform Limits & Scaling

> Verified against current docs (Vercel, Supabase, Stripe) on 2026-06. Numbers change — re-check before relying on a hard limit.

## TL;DR — the fears vs reality
- **"10-second timeout"** → outdated. With **Vercel Fluid Compute** enabled, function `maxDuration` is **300s default on every plan**, configurable up to **800s on Pro/Enterprise**. Our render (Satori+resvg ~50–200 ms) and crons sit far inside this.
- **"1 MB response limit"** → the real cap is **4.5 MB for the request *and* response body** of a Vercel Function (`413 FUNCTION_PAYLOAD_TOO_LARGE`). We never push files through a function — premium files are delivered via a **signed R2 URL redirect**, so the 4.5 MB cap never bites. Keep it that way: functions return JSON/redirects, never file bytes.
- **Memory:** Hobby 2 GB / 1 vCPU; Pro/Ent up to 4 GB / 2 vCPU. resvg on a 3000×4000 PNG fits in 2 GB.
- **Concurrency:** auto-scales to **30,000** (Hobby/Pro). **1000 users/hour is trivial** — that's ~0.3 req/s average, low hundreds at peak. No scaling concern.
- **File descriptors:** 1,024 per instance shared — another reason to use pooling and not open raw DB sockets per request.

## Verdict on hosting: stay on Vercel + Cloudflare + Supabase
For our workload (static/SSR pages, short API calls, a sub-second render, webhooks, light crons) **Vercel serverless is the right home** — no Railway/Render worker needed yet. Add a separate long-running worker **only if** we later need jobs that run for many minutes continuously or need a durable queue; at that point use **Upstash QStash** (managed queue + scheduled HTTP) or **Vercel Workflows** (durable, pause/resume) rather than standing up a VM.

## The one Vercel gotcha that affects us: Cron frequency by plan
| Plan | Min cron interval | Precision |
|---|---|---|
| Hobby | **once per day** | hourly (±59 min) |
| Pro | **once per minute** | per-minute |

Our `reconcile` (every 5 min) and `send-emails` (every 1 min) crons **require Pro** (~$20/mo). Options:
1. **Upgrade to Vercel Pro** (simplest; also unlocks 800s duration + 4 GB).
2. Or keep Hobby and drive the two cron endpoints from an **external scheduler** — **Upstash QStash schedules**, **GitHub Actions** (`schedule:`), or cron-job.org — each hitting `/api/cron/*` with the `Authorization: Bearer <CRON_SECRET>` header.

**Recommendation:** go **Pro** before launch — it removes the cron limit, raises duration/memory, and is cheap relative to the value.

## Database connections & pooling (Supabase)
- We use **`@supabase/supabase-js` (PostgREST over HTTPS)** for app traffic → **no Postgres sockets per request**; PostgREST pools server-side. So serverless concurrency does **not** exhaust DB connections. This is why we don't need a pooler today.
- **If we ever add a direct-connection ORM** (Prisma / Drizzle / `postgres.js`) for complex queries, connect through **Supavisor transaction mode on port `6543`**, **disable prepared statements**, and keep a **small pool** (e.g. `connection_limit=1` per serverless instance). Ports: direct `5432` (IPv6), session pooler `5432`, transaction pooler `6543`.
- Pool size is shared across modes; total backend connections must stay under the compute tier's max. Watch usage in Supabase → Observability → Database Connections.
- **Migrations / `pg_dump` / admin tools** use the **direct** connection (`5432`), not the transaction pooler.

## Payments: use Stripe **hosted Checkout** (revise our PaymentIntent approach)
Stripe's **hosted full-page Checkout** (Checkout Sessions API) is the recommended, lowest-complexity, lowest-maintenance option and it offloads **PCI scope + SCA/3DS + wallets (Apple/Google Pay) + Link + local methods**. For a tiny team this is strictly better than hand-building PaymentIntent + Elements.
- Flow becomes: server creates a **Checkout Session** (with our `order_token`/`attempt_key` in `metadata` + `client_reference_id`), redirect the customer to Stripe, truth comes from the **`checkout.session.completed`** webhook. Everything else in the resilience plan (idempotency, reconcile, outbox) stays the same; reconcile lists Checkout Sessions instead of PaymentIntents.
- Use **Stripe Billing/Customer Portal** only if/when we add subscriptions (B2B tier later) — not needed for one-time purchases.
- **India:** Stripe has limited India support; keep **Razorpay** for India with its **hosted Standard Checkout / Payment Links** (same idea — don't hand-roll the card form).

## Scaling targets & headroom (1000 users/hour)
- Pages: served from **Cloudflare CDN / Vercel ISR cache** → near-zero function load for browsing.
- Render: only premium buyers hit `/api/render`, once, then cached in R2. At 1000 users/hr even a 100% premium conversion = ~1000 renders/hr ≈ 0.3/s — trivial.
- Webhooks/checkout: a few req/s peak — far under 30k concurrency.
- DB: PostgREST pooled; reads are indexed (see DB doc). No bottleneck at this scale.

## Action checklist
- [ ] Enable **Fluid Compute** on the Vercel project.
- [ ] Upgrade to **Vercel Pro** (cron + duration + memory) before launch — or wire QStash/GitHub Actions to the cron endpoints.
- [ ] Set `maxDuration` per heavy route (`render` = 30s is plenty; default 300s otherwise).
- [ ] Confirm **no function ever returns file bytes** (>4.5 MB) — always signed R2 redirect.
- [ ] Switch Stripe integration to **hosted Checkout Sessions**; keep Razorpay hosted checkout.
- [ ] Keep app DB access on **supabase-js**; if adding an ORM, use **transaction pooler 6543 + no prepared statements + tiny pool**.
- [ ] Add **Sentry** (error monitoring) and Vercel spend alerts.
- [ ] Pin function regions near the Supabase region to cut latency.

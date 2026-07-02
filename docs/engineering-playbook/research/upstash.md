# Research notes — Upstash (Redis Ratelimit + QStash)

> Written from established knowledge (live fetch timed out this pass). Confirm at the cited docs.

Docs: Ratelimit https://upstash.com/docs/redis/sdks/ratelimit-ts/overview · QStash https://upstash.com/docs/qstash/overall/getstarted · QStash schedules https://upstash.com/docs/qstash/features/schedules · QStash signatures https://upstash.com/docs/qstash/features/security

## Redis Ratelimit (already in use)
- `@upstash/ratelimit` + `@upstash/redis` over **REST** → serverless-safe (no socket). This is why in-memory limits don't work on Vercel but Upstash does.
- Algorithms: `fixedWindow`, **`slidingWindow`** (we use this), `tokenBucket`. Per-key (`limit(key)`); we key by IP / email / token.
- **`ephemeralCache`** option: caches limit decisions in function memory to cut Redis calls (cost + latency) under bursts — enable it.
- Has `analytics` + multi-region option. Free tier is generous (commands/day quota — verify current number on the pricing page). Our limiter set: checkout 10/min IP, checkoutEmail 3/hr, render 5/min, download 30/min, status 60/min.

## QStash (queue + scheduler) — solves crons + background jobs
- **HTTP-based message queue**: you `publish` a message to one of your endpoint URLs; QStash delivers it with **automatic retries + backoff**, delays, and **dead-letter** handling. No worker server to run.
- **Schedules**: cron-like schedules that POST to a URL → **drive our `/api/cron/*` without needing Vercel Pro** (alternative to Vercel Cron on Hobby).
- **Background jobs**: offload heavy/async work (e.g. batch renders, the email outbox) by publishing to a worker route; QStash retries on failure — more robust than a best-effort cron loop.
- **Security**: verify the **`Upstash-Signature`** header with the current + next signing keys on every QStash-invoked route (same idea as our `CRON_SECRET` but cryptographic).

## Decision
- **Keep Upstash for rate limiting** (already integrated).
- **Use QStash if we stay on Vercel Hobby** (to run the 1- and 5-minute crons) or when we add real background-job processing with retries. If we go Vercel Pro, native Cron covers the schedules and QStash becomes optional (use it only for retried background work).

## Action items
- [ ] Enable `ephemeralCache` on limiters.
- [ ] If Hobby: create QStash **schedules** → `/api/cron/reconcile` (*/5), `/api/cron/send-emails` (*/1); verify `Upstash-Signature` in those routes.
- [ ] Consider QStash for the email outbox + any future batch render (retries/backoff for free).

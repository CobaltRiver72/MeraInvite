# Research notes — Vercel (read 2026-06)

Sources:
- Functions limits: https://vercel.com/docs/functions/limitations (last_updated 2026-05-14)
- Max duration / fluid compute: https://vercel.com/docs/functions/configuring-functions/duration · https://vercel.com/docs/fluid-compute
- Cron usage & pricing: https://vercel.com/docs/cron-jobs/usage-and-pricing (last_updated 2026-03-04)
- Workflows (unlimited duration): https://vercel.com/docs/workflows
- 4.5MB bypass guide: https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions

## Function limits (Node.js runtime) — verbatim
| Feature | Value |
|---|---|
| **Max memory** | Hobby **2 GB / 1 vCPU**; Pro/Ent up to **4 GB / 2 vCPU** |
| **Max duration (with Fluid Compute)** | Hobby **300s** (max 300s); Pro/Ent **300s default, up to 800s** |
| **Edge runtime** | must start responding in 25s; can stream up to 300s |
| **Bundle size** | 250 MB uncompressed (after gzip) |
| **Concurrency** | auto-scales to **30,000** (Hobby/Pro), 100k+ (Ent) |
| **Request/response body** | **4.5 MB** max → `413 FUNCTION_PAYLOAD_TOO_LARGE` |
| **File descriptors** | **1,024 shared** across concurrent executions (incl. runtime) |
| Timeout error | `504 FUNCTION_INVOCATION_TIMEOUT` |
| Cost (Pro) | active **CPU time** + provisioned memory time; **I/O wait (DB, AI, Stripe) is NOT billed CPU** |

## Cron limits — verbatim
| Plan | Min interval | Precision | # crons |
|---|---|---|---|
| Hobby | **once per day** | hourly ±59 min | 100 |
| Pro / Ent | **once per minute** | per-minute | 100 |
Hobby deployment **fails** if a cron expression runs more than once/day.

## What this means for MeraInvite
- **The "10s timeout / 1MB" fear is wrong.** With Fluid Compute we get 300s (→800s Pro), 2–4 GB RAM, 30k concurrency. Our render (~50–200 ms) and crons are nowhere near limits. 1000 users/hr ≈ trivial.
- **The only hard constraint that touches us: the 4.5 MB body cap.** A 3000×4000 PNG exceeds it. → **never return file bytes from a function**; always hand back a **signed R2 URL redirect**. (Already our design.) Same for uploads: admin art upload should go to R2 via presigned PUT, not through a function body.
- **Crons need Pro.** Our `reconcile` (*/5) and `send-emails` (*/1) will **fail to deploy on Hobby**. → Upgrade to **Pro** (also unlocks 800s + 4 GB), or trigger `/api/cron/*` from an external scheduler (QStash / GitHub Actions `schedule:` / cron-job.org) with the `Authorization: Bearer <CRON_SECRET>` header.
- **Billing favors us:** I/O wait isn't billed CPU, so webhook/checkout calls that mostly wait on Stripe/Supabase are cheap.
- **File descriptors 1,024 shared** → don't open raw DB sockets per request (we use supabase-js/PostgREST → fine); close any sockets/HTTP you open.
- **Set `maxDuration` per route** (render = 30s; default 300s otherwise). Enable **Fluid Compute** in project settings.
- For any future job needing minutes–months of stateful execution → **Vercel Workflows**, not a hand-rolled long function.

## Action items
- [ ] Enable Fluid Compute.
- [ ] Vercel **Pro** before launch (crons + 800s + 4 GB) — or external scheduler for crons.
- [ ] Assert no function returns >4.5 MB (signed R2 redirects only; presigned PUT for uploads).
- [ ] `export const maxDuration` on render/cron routes.
- [ ] Pin function region near Supabase region.

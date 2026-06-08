# 00 · Engineering Playbook — Master Index & Checklist

> The single index for building MeraInvite correctly: fast, scalable, secure, compliant. Each doc below is focused and checklist-driven so a human **or** an AI agent can pick up any piece and know exactly what "done" means. Verified against live Vercel/Supabase/Stripe docs, 2026-06.

## Documents
1. **[01 · Platform Limits & Scaling](01-platform-limits-and-scaling.md)** — Vercel/Supabase/Stripe real limits, the 10s/1MB myths, background jobs, 1000 users/hr.
2. **[02 · Security, Auth & RLS](02-security-auth-rls.md)** — authN vs authZ, RLS policies, IDOR, proxy API routes, secrets, never-trust-client, rate-limit matrix.
3. **[03 · Database Design](03-database-design.md)** — normalized schema, IDs, indexes, migrations, backups, query optimization, pooling.
4. **[04 · Caching](04-caching.md)** — browser / CDN / ISR / app layers mapped to routes.
5. **[05 · CI/CD & Environments](05-cicd-and-environments.md)** — branches, staging, preview URLs, CI checks, deploy checklist, rollbacks.
6. **[06 · Legal & Privacy](06-legal-and-privacy.md)** — GDPR/CCPA/DPDP/AU/CA, required pages, delete-my-data, consent.
7. **[07 · On-Page SEO, Headers & Schema](07-onpage-seo-headers-schema.md)** — HTTP headers, schema.org JSON-LD, on-page SEO, layering.
8. **[08 · Code Hygiene & Dependencies](08-code-hygiene-and-dependencies.md)** — naming, no-fluff, dependency gate, per-unit review checklist.

## Decisions made / revised in this research pass
- **Stay on Vercel + Cloudflare + Supabase.** Fluid Compute gives 300s (up to 800s) duration, 2–4 GB RAM, 30k concurrency — the "10s timeout / 1 MB" fears are outdated. No Railway/worker needed for our workload. Real cap = **4.5 MB function payload** → always deliver files via signed R2 URLs, never through a function.
- **Upgrade to Vercel Pro before launch** — Hobby crons run **once/day only**; Pro allows the 1- and 5-minute crons we need (or drive `/api/cron/*` from QStash/GitHub Actions).
- **Switch to Stripe hosted Checkout (Checkout Sessions)** instead of hand-built PaymentIntent+Elements — offloads PCI/SCA/wallets, less code; truth = `checkout.session.completed` webhook. Keep Razorpay hosted checkout for India.
- **App DB access stays on supabase-js (PostgREST)** — no socket pooling needed. Only an ORM later would require Supavisor transaction mode (port 6543, prepared statements off, tiny pool).
- **Add Sentry** (errors) + **keep Upstash** (rate limit + optional cache/QStash). PITR backups on before revenue.

## Master pre-launch checklist (the gate)
**Security & access**
- [ ] RLS enabled + default-deny on every table; anon can't read sensitive tables (tested with anon key).
- [ ] Owner-scoped CRUD policies on user-owned tables (when accounts ship).
- [ ] Opaque tokens / UUIDs everywhere user-facing; ownership re-checked server-side on every request.
- [ ] Client holds only publishable/anon keys; secrets only in Vercel env; gitleaks pre-commit; `.env*` gitignored.
- [ ] Client never calls external APIs directly — only our `/api/*` proxy.
- [ ] Price from DB; payment truth from webhook; all logic + validation server-side (zod).
- [ ] Rate limits per the matrix; Turnstile on checkout; Cloudflare WAF on; security headers + CSP verified.

**Payments & resilience**
- [ ] Stripe hosted Checkout + Razorpay hosted checkout live (test keys on preview).
- [ ] Idempotent checkout (attemptKey reuse); already-paid short-circuit.
- [ ] Webhook signature verified on raw body; `process_payment` atomic + idempotent; email via outbox.
- [ ] Reconcile cron (bounded, bulk, attempt-cap, expire+cancel, duplicate auto-refund); send-emails cron.
- [ ] Delete-on-revoke clears R2 renders; signed URLs short-lived.

**Data & performance**
- [ ] Normalized schema; indexes for every real filter/join; migrations in git + tested on preview DB.
- [ ] PITR backups on; restore runbook written; statement timeout set.
- [ ] Collection pages on ISR; Cloudflare caches static + bypasses `/api/*`; thumbnails optimized/lazy.
- [ ] Core Web Vitals green.

**SEO & schema**
- [ ] JSON-LD (CollectionPage+WebApplication+FAQPage+Breadcrumb; Product+Offer on premium) validated.
- [ ] H1 + keyword H2s + captions + alt text; titles/meta; canonical; sitemap + robots; GSC verified.

**Ship process**
- [ ] main=prod, dev=staging, per-branch previews; live keys only in Production.
- [ ] CI: types + lint + tests + gitleaks + audit required to merge; branch protection on main.
- [ ] Deploy checklist + Vercel Instant Rollback practiced.

**Legal**
- [ ] Privacy, Terms, Refund, Cookie, Contact pages live + footer-linked; lawyer-reviewed.
- [ ] Consent banner (decline-by-default, GPC); delete-my-data + export flows; retention/purge job; processor DPAs accepted.

## How to use this
Pick the doc for the area you're building, work its checklist, tick items in the project blueprint tracker. Nothing ships to `main` until the master checklist above is green for the touched areas.

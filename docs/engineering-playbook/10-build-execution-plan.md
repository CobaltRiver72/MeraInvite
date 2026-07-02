# 10 · Build Execution Plan — how to actually start

> Decision: **not one full prompt.** Build in **small vertical slices**, each on its **own branch** driven by **one scoped agent**, reviewed on its **preview URL**, merged `feature → dev (staging) → main (prod)**. This gives reviewable diffs, isolated blast radius, and per-piece rollback.

## Why not one big prompt
- Context overflow → the agent forgets earlier decisions mid-build.
- One unreviewable mega-diff → you can't actually verify it's safe (and this app handles money + customer data).
- Early errors compound; you can't roll back "the checkout part" without nuking everything.
- No staging/preview checkpoint to catch problems.

## Tooling split
- **Claude Code (in the repo)** = the coding agents on each branch.
- **Cowork (here)** = planning, content/SEO, copy, reviewing diffs, decisions.
- **You (human)** = add secrets in Vercel/Supabase, review every PR diff, approve merges. **Agents never touch production secrets and never merge their own PRs.**

## How to run an agent per task (the contract)
Give each agent a tight brief, not "build the app":
```
You are building ONE module on branch <feat/x>.
Read: engineering-playbook/<the relevant docs> + backend-architecture/<relevant files>.
Scope: ONLY these files/paths: <list>. Do not touch other modules or any secret.
Goal + acceptance criteria: <bullets>.
Constraints: zod-validate inputs; secrets server-only; RLS/ownership enforced; no fluff/extra abstractions; meaningful names.
Deliver: working code + tests for the acceptance criteria. Open a PR. DO NOT merge.
```
- **Parallelize only independent modules** (e.g. design-system ∥ infra; legal ∥ analytics). The dependent chain (data → catalog → editor → payments) must be **sequential**.
- One branch = one agent = one PR = one reviewable thing.

## Build order (MVP → production)

### Phase 0 — Foundation (do first; you + 1–2 agents)
- **`chore/scaffold`** — Next.js App Router app, design tokens, lint/types, CI (tsc+eslint+gitleaks+audit), `.gitignore`, `env.ts`, Sentry, folder structure from doc 08. *Done when:* builds, deploys a preview, env validation throws on missing secret.
- **`chore/infra`** (mostly you) — create Supabase project + run `migrations/0001`; create R2 public+private buckets; Cloudflare (DNS/WAF/Turnstile/cache); Stripe+Razorpay **test** accounts + webhook endpoints; Upstash; add all secrets to **Vercel env**. *Done when:* migrations applied to a preview DB; verified anon key can't read `orders`/`entitlements`/`design_assets`.

### Phase 1 — Data + read paths (the SEO money pages)
- **`feat/design-system`** — Nav, Footer, DesignCard, Grid, FilterChips, CurrencyToggle, FAQ (from the orange prototypes). ∥ with infra.
- **`feat/catalog`** — collection page on **ISR** reading `designs` from Supabase; JSON-LD (CollectionPage+WebApplication+FAQPage+Breadcrumb); sitemap/robots. *Done when:* SSR HTML has schema + keyword captions + 25–40 grid; Lighthouse green.
- **`feat/home-hubs`** — homepage + culture hub pages.

### Phase 2 — Editor + free download (no money yet)
- **`feat/editor`** — editor page, %-positioned text engine, ResizeObserver scaling, **html2canvas** free download, public R2 backgrounds. *Done when:* a free design downloads HD client-side and preview == output.
- **`feat/admin-calibration`** — admin-gated drag-to-position tool that saves `text_fields`. *Done when:* a new design's text config is saved + renders correctly.

### Phase 3 — Payments + delivery (the core; sequential)
- **`feat/checkout-stripe`** — hosted **Checkout Sessions**, idempotent `/api/checkout`, already-paid short-circuit.
- **`feat/checkout-razorpay`** — Razorpay hosted checkout + DB-side order reuse.
- **`feat/webhooks`** — Stripe/Razorpay webhooks → `process_payment` (atomic, idempotent) + email outbox.
- **`feat/render-deliver`** — `/api/render` (Satori+resvg, cache-by-hash), `/api/download/[token]`, `/api/orders/[token]/status`, signed URLs, delete-on-revoke.
- **`feat/resilience-crons`** — reconcile + send-emails crons; localStorage resume + TTL. *Phase done when:* full premium purchase → render → download → email works on **test keys**, and the payment-resilience checklist passes (offline mid-pay, double-click, replayed webhook, missed-webhook reconcile).

### Phase 4 — Hardening + compliance + launch
- **`feat/security-pass`** — rate limits on every endpoint, headers/CSP verified (securityheaders.com), RLS audit, Turnstile, secret scan, adversarial test matrix (doc 09).
- **`feat/legal`** — privacy/terms/refund/cookie pages, consent banner (decline-default + GPC), **delete-my-data** flow, retention/purge job.
- **`feat/analytics`** — PostHog funnel + channel pixels.
- **`chore/launch`** — real artwork + 2 beachhead collections (25–40 each), Pinterest seed, GSC verify, final QA on staging.

## Branch / PR / rollback flow (every slice)
`feat/x` → push → **Vercel preview URL** + CI gate → **review the diff** + test on preview (test keys, preview DB) → merge to **`dev`** (staging) → QA on staging URL → merge **`dev` → `main`** (production). Broken prod → **Vercel Instant Rollback**; DB changes → additive/backward-compatible, PITR if needed.

## So, concretely, start like this
1. Approve this plan + the stack (doc 00) and pick the brand/domain.
2. Run **Phase 0** (`chore/scaffold` then `chore/infra`) — you add the secrets, an agent scaffolds.
3. Then march the phases above, **one branch/agent at a time** (parallel only where marked ∥), reviewing each PR.
4. Track progress in `project-blueprint.html` (the tracker) — each branch maps to tracker items.

## Definition of "MVP shippable"
Phases 0–3 + `feat/security-pass` + `feat/legal` + one beachhead collection populated. Phase 4 polish + the second collection + analytics can follow fast. Everything else (more ceremonies, cultures, accounts, B2B) is post-launch.

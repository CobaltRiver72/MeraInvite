# 08 · Code Hygiene, Naming & Dependencies

> "No fluff." AI (and humans) tend to generate backup functions, speculative helpers, and abstractions nobody uses. Every file, function, and dependency must earn its place.

## Naming — meaningful, not generic
- Names say **what it is / does** at a glance. `verifyTurnstile`, `process_payment`, `deletePrivatePrefix` — not `handler`, `utils`, `helper2`, `doStuff`, `data`, `temp`.
- Files named for their role: `app/api/checkout/route.ts`, `lib/turnstile.ts`, `lib/ratelimit.ts`. No `misc.ts`, `index.ts` dumping grounds.
- DB: snake_case tables/columns that describe content (`order_token`, `is_premium`, `rendered_key`). Booleans read as questions (`is_premium`, `revoked`).
- Components: PascalCase for what they render (`DesignCard`, `CurrencyToggle`, `EditorCanvas`), not `Box`, `Wrapper2`.
- A reader should understand a line **without scrolling** to a definition.

## No fluff rule (delete on sight)
- **No abstraction before the 3rd use.** Don't wrap a one-liner in a "helper." Inline until duplication is real.
- **No speculative/backup functions** ("might need later"), no dead code, no commented-out blocks — git is the history.
- **One way to do a thing.** No parallel implementations of the same logic.
- **No extra components/pages** that aren't wired to a real route/use.
- Each module exports only what's used. Remove unused exports/imports (lint catches them).
- Prefer the platform/std lib + the deps we already have over adding a new one.

## Dependencies — keep the list short and safe
Our intended runtime deps (from `package.json`): `next, react, react-dom, @supabase/supabase-js, stripe, razorpay, zod, satori, @resvg/resvg-js, @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, @upstash/ratelimit, @upstash/redis, resend`. Dev: `typescript, @types/*, eslint`. **That's the whole surface — keep it that way.**

Before adding **any** dependency, it must pass this gate:
- [ ] Can we do it with the std lib / a dep we already have? If yes, don't add it.
- [ ] Is it actively maintained (recent releases, open issues triaged), reasonably popular, and from a trustworthy author?
- [ ] Bundle/serverless size impact acceptable? (functions cap 250 MB; check on bundle.js.org).
- [ ] License compatible (MIT/Apache/BSD)?
- [ ] No known vulns (`npm audit`)?
- [ ] Pin the version; commit the **lockfile**; let **Dependabot** propose updates.
Avoid: big kitchen-sink libraries for one function, abandoned packages, anything that needs native build steps incompatible with Vercel.

## File/folder structure (lean)
```
src/
  app/                 routes (pages + /api route handlers)
    api/checkout/route.ts
    api/webhooks/{stripe,razorpay}/route.ts
    api/render/route.ts
    api/download/[token]/route.ts
    api/orders/[token]/status/route.ts
    api/cron/{reconcile,send-emails}/route.ts
  lib/                 small, single-purpose server modules
    env.ts supabase.ts r2.ts ratelimit.ts turnstile.ts email.ts cron.ts fonts.ts
  components/          UI (DesignCard, EditorCanvas, …)
supabase/              schema_and_rls.sql, migrations/
```
No `utils/` junk drawer, no premature `services/`, `managers/`, `factories/`.

## Per-unit review checklist (apply to every function / route / query / component)
- [ ] **Name** describes it; no generic placeholder.
- [ ] **Single responsibility** — does one thing.
- [ ] **Inputs validated** (zod) at the boundary; types correct (`tsc` clean).
- [ ] **AuthN + authZ/ownership** enforced server-side (for routes that touch data).
- [ ] **Errors handled** — generic message to client, real error to logs (Sentry); no secret/stack leakage.
- [ ] **No secret** reachable from the client; no `NEXT_PUBLIC_` on secrets.
- [ ] **Rate-limited** if public/abuseable.
- [ ] **Idempotent** if it mutates money/state.
- [ ] **Indexed** if it's a DB query on a filter/join column.
- [ ] **Cached** appropriately, or explicitly `no-store`.
- [ ] **No dead code / unused exports**; lint passes.
- [ ] **Tested** where logic is non-trivial (pricing, entitlement, idempotency).

## Checklist
- [ ] ESLint rule for no-unused-vars/imports on in CI.
- [ ] Dependency gate applied to every new package; lockfile committed; Dependabot on.
- [ ] No `utils`/`helpers` dumping grounds; modules single-purpose.
- [ ] Code review rejects speculative abstractions and generic names.

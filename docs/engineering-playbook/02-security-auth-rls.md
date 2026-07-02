# 02 · Security, Authentication, Authorization & RLS

> The rule behind every line here: **the client is hostile and untrusted.** Anything the browser can reach, an attacker can reach, inspect, and replay. Trust is established **server-side only**.

## Authentication ≠ Authorization
- **Authentication (authN) = "who are you?"** — proving identity (a session, a token).
- **Authorization (authZ) = "what are you allowed to do/see?"** — permissions on a specific resource.
They are separate. A valid login does **not** mean access to a row. Every data access must answer *both*: are you authenticated, **and** do you own / are you permitted this exact resource?

## Our identity model (today vs later)
- **Guest-first (now):** no accounts for buyers. Identity for a purchase = an **opaque 256-bit `order_token`** + the email we deliver to. Sensitive tables are **server-only** (no anon access at all). The API enforces ownership by token.
- **Optional accounts (later):** Supabase Auth **magic-link/OTP** (no passwords stored → no credential-stuffing surface). Then add **owner-scoped RLS** keyed to `auth.uid()` / email.
- **Admin:** server-side **email allowlist** + Cloudflare Access in front of `/admin`; never a client-side `isAdmin` flag as the only gate.

## Row Level Security (RLS) — the database wall
**Mandate: RLS `ENABLE`d on every table, default-deny.** A table with RLS on and no matching policy returns nothing to `anon`/`authenticated`. Only the **`service_role`** key (server-only) bypasses RLS.

> Without RLS, anyone with the public anon key + a table name can `select *` and get **every row**. RLS makes "we forgot to add a check" fail **closed**, not open.

### Our policy posture
| Table | Policy |
|---|---|
| `designs`, `collections`, `cultures`, `occasion_types` | `SELECT` to `anon` — but only **safe columns** (no private asset paths). |
| `design_assets`, `orders`, `entitlements`, `processed_events`, `pending_emails` | **No anon/authenticated policy** → service-role only. |

### Owner-scoped policy patterns (for when accounts exist)
Every table holding user-owned data needs **select / insert / update / delete** policies — not just select:
```sql
alter table public.user_downloads enable row level security;

create policy "own rows: select" on public.user_downloads
  for select to authenticated using (auth.uid() = user_id);
create policy "own rows: insert" on public.user_downloads
  for insert to authenticated with check (auth.uid() = user_id);
create policy "own rows: update" on public.user_downloads
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows: delete" on public.user_downloads
  for delete to authenticated using (auth.uid() = user_id);
```
Rules: **enable RLS on every table**; default-deny; owner check (`auth.uid() = user_id`) on *each* verb; `with check` on insert/update to stop a user writing rows owned by someone else; never rely on a `where` clause in app code as the only guard.

## IDOR — "what if someone has the API id and just queries it?"
This is the #1 way these apps leak data. Defenses, layered:
1. **Opaque, unguessable handles** for anything user-facing: the download/status path uses a **256-bit random `order_token`**, not a sequential id. Guessing is infeasible.
2. **UUID primary keys** internally (not auto-increment integers) so ids aren't enumerable.
3. **Ownership re-check on every request**, even server-side: `/api/download/[token]` re-verifies the order is `paid` + entitlement not `revoked` *before* minting a signed URL. The service role bypasses RLS, so the **API must enforce ownership itself** in the query (`.eq('order_token', token)`), never "fetch by id from the URL and return it."
4. **RLS** as the second wall when accounts exist (a stolen/forged session still only sees its own rows).
5. **Signed, short-lived file URLs** (10 min) so even a leaked link expires; delete-on-revoke kills it sooner.

## Proxy API routes — the client never calls an external API directly
**Pattern:** Browser → **our `/api/*`** → external service (Stripe/Razorpay/Resend/R2). Secrets live only on the server; the browser never sees a secret key and never talks to Stripe/Razorpay/Supabase-admin directly.
- The browser only ever holds **publishable/anon** keys (`NEXT_PUBLIC_*`) which are safe by design.
- Every state-changing or secret-using call is a server Route Handler that: validates input → checks auth/ownership → calls the external API with the **server-only secret** → returns a minimal result.
- Never put a third-party secret in a client component, a `NEXT_PUBLIC_` var, or a response body.

## Never trust the client
- **Price comes from the DB** by `designId` — the client-sent price is ignored. (Stops "pay $0.01".)
- **Payment "success" comes only from the signed webhook**, never a `?paid=true` redirect.
- **Business logic runs server-side.** Anything in the browser bundle can be read and edited; assume it. Free-vs-premium gating, entitlement, render permission = server decisions.
- **All inputs validated server-side with zod** (and again client-side for UX, never *instead*). Reject unknown fields; bound string lengths and array sizes.
- **No SQL string-building.** Use supabase-js / parameterized queries only; RLS is the backstop.
- **Output minimalism.** Endpoints return the least data needed (e.g. status returns only `pending|paid`, never email/amount).

## Secrets & git hygiene
- **Server-only secrets** never get a `NEXT_PUBLIC_` prefix and are never imported into client components. `env.ts` validates them at boot and throws if referenced in the browser.
- All real values live in **Vercel env vars** (and local `.env.local`, gitignored). **Nothing secret in code or git.**
- `.gitignore` blocks `.env*` (except `.env.example`), keys, creds; add a **gitleaks** pre-commit hook. If a secret is ever committed → **rotate it** (scrubbing history isn't enough).

## Rate limiting — where and why
| Endpoint type | Limit (start) | Why |
|---|---|---|
| `/api/checkout` | 10/min per IP + 3/hr per email + **Turnstile** | card-testing, email-bomb, abuse |
| Auth (magic-link request, later) | 5/min per IP + per-email | brute-force / enumeration |
| `/api/render` | 5/min per token | compute abuse |
| `/api/download/[token]` | 30/min per IP | link hammering |
| `/api/orders/[token]/status` | 60/min per IP | polling, scraping |
| Public data endpoints / SSR APIs | Cloudflare WAF rate rules | bot scraping of the catalog |
| Webhooks | none (signature-authed), but verify path/signature | — |
Distributed limiter = **Upstash Redis** (in-memory limits don't work on serverless). Cloudflare WAF is the coarse outer wall; Upstash is the per-key inner wall.

## Defense-in-depth summary (every request passes through)
Cloudflare WAF/bot → Turnstile (checkout) → Upstash rate limit → zod validation → authN (token/session) → authZ/ownership check → RLS (DB) → minimal output. Break any one and the others still hold.

## Checklist
- [ ] RLS **enabled on every table**; verified anon cannot read `orders`/`entitlements`/`design_assets`/`pending_emails` (test with the anon key directly).
- [ ] Owner-scoped select/insert/update/delete policies on every user-owned table (when accounts ship).
- [ ] No table is publicly readable beyond intended safe columns.
- [ ] All user-facing handles are **opaque tokens / UUIDs**, never sequential ids.
- [ ] Every API re-checks **ownership** server-side, even with service role.
- [ ] Client holds only `NEXT_PUBLIC_` publishable/anon keys; **no secret reachable from the browser/inspect/network/git**.
- [ ] Client never calls Stripe/Razorpay/Supabase-admin directly — only our `/api/*` proxy.
- [ ] Price from DB; payment truth from webhook; logic server-side.
- [ ] zod on every input; parameterized queries only.
- [ ] Rate limits on the matrix above; Turnstile on checkout.
- [ ] gitleaks pre-commit; secrets only in Vercel env; rotate on exposure.
- [ ] Security headers + CSP (already in `middleware.ts` / `next.config.mjs`); `Referrer-Policy: no-referrer` on token routes.

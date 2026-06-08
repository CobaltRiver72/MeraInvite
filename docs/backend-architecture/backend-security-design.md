# Backend & Security Design — Freemium Invitation Maker

> Stack: **Next.js (App Router) on Vercel + Cloudflare in front · Supabase (Postgres + Auth) · Cloudflare R2 · Stripe + Razorpay · Resend**.
> Model: transactional digital goods, **guest checkout**, free + premium designs. This doc is the source of truth for what runs where, how money and files are protected, and how an attacker is kept out. Starter files referenced live in `./starter/`.

---

## 0. The one security principle that drives everything

**The browser is hostile. Anything the client can reach, an attacker can reach.** So:

1. **Premium artwork and final high-res files never reach the client until payment is verified server-side.** Not "hidden with CSS", not "behind a React check" — physically not sent.
2. **Payment is only ever trusted from a signed webhook**, never from the browser saying "I paid".
3. **Every secret lives in the server environment**, never in the bundle, never in git.

Everything below is an application of these three.

---

## 1. Where code runs — the render boundary

| Layer | What | Why there |
|---|---|---|
| **Static / SSR (server-rendered HTML)** | Homepage, ceremony **collection pages**, design captions, FAQ, blog. | SEO — content must be in the initial HTML (per the SERP-consensus doc). Built at build-time (SSG) or cached SSR; revalidated on a schedule. |
| **Client components** | The **editor** (live text overlay, ResizeObserver), filter chips, currency toggle, cart UI. | Interactive, no secrets, operates only on **free** backgrounds + the user's own text. |
| **Server (Route Handlers / serverless functions)** | `/api/*` — checkout, webhooks, gated download, **premium render**, admin. | Holds secrets, talks to Stripe/Razorpay/Supabase service role/R2 private bucket. |
| **Never on client** | Stripe secret key, Razorpay key secret, Supabase **service_role** key, R2 credentials, Resend key, webhook secrets, premium background URLs. | Compromise = full takeover / free premium files / financial fraud. |

Rule of thumb: if a value is prefixed `NEXT_PUBLIC_` it is **public forever** — only the Stripe/Razorpay *publishable* keys and the Supabase *anon* key and the site URL go there. Nothing else.

---

## 2. Data model & Supabase (RLS is the wall)

Tables (full SQL in `starter/supabase/schema_and_rls.sql`):

- **`designs`** — catalog. Public-readable, but only **safe columns**: `id, slug, name, collection, is_premium, price_usd, price_inr, preview_url, text_fields, lang, tags`. The **clean high-res `master_key`** (path in the *private* R2 bucket) is **not** in this table's public view — it lives in a separate `design_assets` table with **no anon access**.
- **`orders`** — one row per checkout: `id, order_token, design_id, email, amount, currency, provider, provider_ref, status('pending'|'paid'|'failed'|'refunded'), created_at`. **No anon read/write at all.**
- **`entitlements`** — what an order unlocks: `order_id, design_id, granted_at`. Written **only** by the webhook (service role). No anon access.
- **`processed_events`** — webhook idempotency: `provider, event_id` unique. Service role only.

**Row Level Security is ON for every table.** Default-deny. Policies:

- `designs`: `SELECT` allowed to `anon` — but the table physically excludes the master asset path, so reading it leaks nothing valuable.
- `design_assets`, `orders`, `entitlements`, `processed_events`: **no policies for `anon`/`authenticated`** → only the **service_role** key (server-only) can touch them. RLS makes "forgot to add a check" fail closed.

Two Supabase clients (see `starter/src/lib/supabase.ts`):
- **Browser/SSR client** → uses the **anon** key, subject to RLS. Safe to expose.
- **Admin client** → uses **service_role** key, **bypasses RLS**, imported only inside `/api/*` server code. If this key ever ships to the browser, it's game over — it's gitignored and only set in Vercel server env.

---

## 3. Premium-file protection (the core of the business)

Free and premium are protected differently because the threat differs.

**Free designs** — clean, no watermark (per the no-rug-pull rules). Background PNG served from the **public** R2 bucket via Cloudflare CDN. Editing + flatten happens client-side (`html2canvas`). Nothing to steal that you weren't giving away.

**Premium designs** — the clean high-res background is the product, so it must never hit the browser pre-payment:

1. **Public preview only.** The catalog/editor shows a **downscaled and/or watermarked** preview (`preview_url`, public bucket). The user can type and see their text positioned, but the preview is low-res / marked.
2. **Clean master stays private.** The print-resolution background lives in a **private R2 bucket**, path stored in `design_assets` (no anon access).
3. **Payment unlocks a server render.** After the webhook marks the order `paid` and writes an `entitlement`, the final file is produced by a **server-side render** (`/api/render`, Satori or headless-Chrome) that composes the *private* clean background + the user's saved text at full resolution. The clean background is never sent to the client — only the finished, flattened result.
4. **Delivery via short-lived signed URL.** The result is uploaded to private R2 and handed back as a **presigned URL valid for ~10 minutes** (see `starter/src/lib/r2.ts`). The link in the email is to `/api/download/[token]`, which re-checks entitlement on every hit and *then* mints a fresh signed URL.

Result: no entitlement → no clean asset, no render, no link. Guessing URLs fails (random tokens + signed, expiring R2 URLs).

---

## 4. Auth & login

**Guests buy without accounts** (higher conversion for one-time purchases). Identity for a purchase = the **order token** (opaque 256-bit random) + the email we send the link to. No password, no session needed to buy or download.

- **Optional accounts (later):** Supabase Auth **magic link / OTP** only — no passwords to leak. Gives a "my downloads" page that lists past `entitlements` for that email. Cookie-based session, `HttpOnly`, `Secure`, `SameSite=Lax`.
- **Admin (the design calibration tool + uploads):** separate, locked down. Supabase Auth with a hard allowlist of admin emails enforced **server-side** on every admin route; admin pages are `noindex` and ideally behind Cloudflare Access (Zero-Trust) so they're not even reachable publicly. Never a client-side `isAdmin` flag as the only gate.

Password rule: we store **none**. That removes the entire credential-breach class.

---

## 5. Payments — trust only the webhook

Flow (both providers, see `starter/src/app/api/checkout` + `.../webhooks`):

1. Browser calls **`POST /api/checkout`** with `{ designId }` only — **never a price**. The server looks up the price from the `designs` table (client-supplied prices are ignored — prevents price tampering). Server creates a Stripe PaymentIntent / Razorpay Order, creates a `pending` order row with a random `order_token`, returns the client secret / order id.
2. User pays on the provider's hosted/embedded form. Card data **never touches our server** (PCI scope minimized).
3. Provider calls our **webhook** (`/api/webhooks/stripe`, `/api/webhooks/razorpay`).
   - **Verify signature on the raw body** (`stripe.webhooks.constructEvent`; Razorpay HMAC-SHA256 over raw body). Unverified → `400`, do nothing.
   - **Idempotency:** insert `event_id` into `processed_events`; if it already exists, ack and stop (providers retry).
   - On success: mark order `paid`, write `entitlement`. **This is the only place `paid` is ever set.**
4. Browser polls `GET /api/orders/[token]/status` (or listens) and, once `paid`, calls render/download. The browser saying "success" is never trusted — only the DB state set by the webhook.

Key protections: server-authoritative pricing, raw-body signature verification, idempotency, amount/currency re-checked against the order before granting. Refund/chargeback webhooks flip status to `refunded` and revoke the entitlement.

---

## 6. API surface

All under `/api`. Default runtime Node (webhooks/render need it); reads can be edge. Every row's rules are enforced — see code in `starter/`.

| Endpoint | Method | Auth | Input validation | Rate limit | Notes |
|---|---|---|---|---|---|
| `/api/checkout` | POST | none (guest) | zod: `designId` (uuid) only | 10/min/IP | Price from DB, not client. Creates pending order. |
| `/api/webhooks/stripe` | POST | **signature** | raw body + sig | none (provider) | Idempotent. Sets `paid`. |
| `/api/webhooks/razorpay` | POST | **signature** (HMAC) | raw body + sig | none (provider) | Idempotent. Sets `paid`. |
| `/api/orders/[token]/status` | GET | order token | token format | 60/min/IP | Returns `pending/paid` only. No PII. |
| `/api/render` | POST | entitlement check | `orderToken`, `text` (zod) | 5/min/IP | Server-composites private master + text. Premium only. |
| `/api/download/[token]` | GET | entitlement check | token format | 30/min/IP | Re-checks entitlement, returns fresh signed R2 URL. |
| `/api/admin/*` | * | admin allowlist + Cloudflare Access | zod | strict | Calibration, uploads, design CRUD. `noindex`. |

Cross-cutting on every handler: **zod-validate all input**, **never echo internal errors** to the client (log server-side, return a generic message), set `Cache-Control: no-store` on anything dynamic/authenticated.

---

## 7. Sessions, tokens & requests

- **Order tokens:** 256-bit `crypto.randomBytes(32)` hex, stored in DB, unguessable, scoped to one order. Used for status + download. Not a session.
- **Download links:** the email link → `/api/download/[token]`; server re-validates entitlement then returns a **10-min presigned R2 URL**. Links are not permanent and can't be shared into free downloads after expiry.
- **Auth sessions (optional accounts):** Supabase cookies, `HttpOnly + Secure + SameSite=Lax`, short-lived access token + rotating refresh. No JWT in `localStorage`.
- **CSRF:** purchase/render endpoints are **token-bearing, not cookie-authed**, so they're not CSRF-able. For any *cookie*-authenticated action (account pages), use `SameSite=Lax` + a double-submit/Origin check. Webhooks are exempt (signature-authed) but verify the `Origin`/path is the webhook only.
- **CORS:** APIs are same-origin; do **not** add `Access-Control-Allow-Origin: *`. Lock to the site origin.

---

## 8. Request-level security (closing the doors)

- **Input validation:** every API body/param parsed with **zod**; reject unknown fields. No raw `req.body` into queries.
- **SQL injection:** use the Supabase client / parameterized queries only — never string-concatenate SQL. RLS is a second wall.
- **Rate limiting:** **Upstash Redis** (`@upstash/ratelimit`) keyed by IP (+ token where relevant). In-memory limits don't work on serverless (each invocation is cold) — use Upstash. See `starter/src/lib/ratelimit.ts`. Cloudflare WAF rate-limits as the outer layer.
- **Bot / abuse:** Cloudflare Bot Fight + WAF managed rules; **Turnstile** (Cloudflare's CAPTCHA) on `/api/checkout` if abuse appears. Never auto-solve CAPTCHAs.
- **Security headers / CSP:** set in `next.config.mjs` + `middleware.ts` — `Content-Security-Policy` (allow self + Stripe/Razorpay/R2/Resend domains only), `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` (or `frame-ancestors 'none'`), `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` locked down.
- **File uploads (admin):** validate MIME + magic bytes, cap size, store in R2 (never executed), randomize filenames, strip EXIF.
- **Dependencies:** `npm audit` in CI, Dependabot, pin versions, minimal deps. Don't run untrusted code.
- **Error handling:** generic client messages; full errors to server logs only. No stack traces, no SQL, no key fragments in responses.
- **Logging/monitoring:** structured logs (no secrets/PII beyond email), Vercel + Sentry for exceptions, alert on webhook failures and spikes in `pending` orders.

---

## 9. Secrets & git hygiene (no important file reaches git)

- **`.gitignore`** (in `starter/`) excludes: `.env*` (except `.env.example`), `.vercel`, service-account JSON, `*.pem`, R2 creds, `node_modules`, build output, local Supabase volumes. **Verify with `git status` before the first push.**
- **`.env.example`** (in `starter/`) lists every key with placeholder values and a comment marking server-only vs `NEXT_PUBLIC_`. Real values live **only** in Vercel project env vars (and your local `.env.local`, gitignored).
- **Env validation:** `starter/src/lib/env.ts` parses `process.env` with zod at boot — the app refuses to start if a required secret is missing or a server-only secret is accidentally referenced client-side.
- **Key separation:** publishable/anon keys → `NEXT_PUBLIC_`. Secret/service keys → server-only names. If a secret leaks, **rotate immediately** (Stripe, Razorpay, Supabase service role, R2, Resend all support rotation).
- **If a secret was ever committed:** rotating the key is mandatory — scrubbing git history is not enough, assume it's burned.
- **Pre-commit:** add `gitleaks` or `git-secrets` to block accidental secret commits.

---

## 10. Hosting & network config

- **Vercel:** secrets in Project → Environment Variables (Production/Preview/Dev separate). Webhook + render routes pinned to a **Node runtime** and a region near your DB. Preview deployments use **test** keys only.
- **Cloudflare (in front):** CDN + cache **static/catalog** pages aggressively; **never cache** `/api/*` (set bypass). WAF managed ruleset on, rate-limiting rules, Bot Fight Mode, HTTPS-only + HSTS, TLS 1.2+. Optionally Cloudflare Access in front of `/admin`.
- **R2:** two buckets — **public** (free backgrounds, previews) behind CDN; **private** (premium masters, rendered outputs) reachable only via server-minted **presigned URLs**. No public listing. No egress fees keeps free downloads cheap.
- **Supabase:** restrict the service role to server; enable Postgres SSL; turn on Supabase's own rate limits and (if available) network restrictions; daily backups.
- **Email (Resend):** SPF/DKIM/DMARC on the sending domain so download emails land and can't be spoofed.

---

## 11. Threat model — attack → mitigation

| Attack | Mitigation |
|---|---|
| Grab premium file for free | Clean master in private bucket; server render only post-entitlement; short-lived signed URLs; preview is low-res/watermarked. |
| "I paid" spoof from browser | `paid` set only by signature-verified webhook; browser claims ignored. |
| Price tampering (pay $0.01) | Price read from DB by `designId`; client price ignored. |
| Replay / duplicate webhook | `processed_events` idempotency table. |
| Forged webhook | Raw-body signature (Stripe) / HMAC (Razorpay) verification; reject on mismatch. |
| Guess download/order URLs | 256-bit random tokens + signed expiring R2 URLs + per-hit entitlement check. |
| Leaked secret key | Gitignore + env validation + Vercel-only storage + gitleaks; rotate on any exposure. |
| Direct DB access via anon key | RLS default-deny; sensitive tables have no anon policy; service role server-only. |
| SQLi | Parameterized Supabase queries + zod validation + RLS. |
| XSS in user text on cards | Render text as text (no `dangerouslySetInnerHTML`); CSP; sanitize any rich input. |
| Credential stuffing | No passwords stored (magic-link only). |
| DDoS / scraping / card testing | Cloudflare WAF + rate limits + Upstash limits + Turnstile on checkout if needed. |
| Clickjacking | `frame-ancestors 'none'` / `X-Frame-Options: DENY`. |
| Admin takeover | Server-side email allowlist + Cloudflare Access + `noindex`. |

---

## 12. Pre-launch security checklist

- [ ] `git status` shows **no** `.env*` (except `.env.example`), keys, or creds tracked.
- [ ] `gitleaks` / pre-commit hook installed.
- [ ] RLS **enabled** on every table; verified anon cannot read `orders`/`entitlements`/`design_assets` (test with the anon key).
- [ ] Stripe + Razorpay webhooks verify signature on **raw body**; tested with the providers' CLIs.
- [ ] Webhook idempotency proven (send same event twice → one entitlement).
- [ ] Checkout ignores client-supplied price (test by tampering).
- [ ] Premium master never returned to client pre-payment (inspect network tab on the editor).
- [ ] Download/render require a valid entitlement (test with a `pending` token → denied).
- [ ] Signed R2 URLs expire (test an old link → 403).
- [ ] Security headers + CSP present (scan with securityheaders.com).
- [ ] Rate limits active on checkout/render/download.
- [ ] Cloudflare: `/api/*` cache bypass, WAF on, HSTS on, admin behind Access.
- [ ] Preview deploys use **test** payment keys; prod uses live keys.
- [ ] Generic error responses (no stack traces / SQL / keys leaked).
- [ ] SPF/DKIM/DMARC set for the email domain.
- [ ] Backups on; key-rotation runbook written.

---

## 13. What NOT to do (common ways people get burned)

- ❌ Put the Supabase **service_role** key or Stripe **secret** key in a `NEXT_PUBLIC_` var or any client component.
- ❌ Trust a `?paid=true` redirect or client message to unlock files.
- ❌ Send the clean premium background to the browser and "hide" it.
- ❌ Accept the price from the client.
- ❌ Skip webhook signature verification "for now."
- ❌ Use `localStorage` for tokens/keys (the brief already bans browser storage in the editor anyway).
- ❌ Rely on in-memory rate limits on serverless.
- ❌ Commit `.env.local`, a Supabase service JSON, or R2 creds — and assume "private repo" makes it safe (it doesn't; rotate if exposed).
- ❌ Build a faceted/filter URL that dumps the full DB, or an admin route gated only by a client-side flag.

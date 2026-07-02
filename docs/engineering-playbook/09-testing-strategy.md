# 09 · Testing Strategy ("test every field, every way")

> Goal: prove the money, access, and data paths are correct and unbreakable before launch. Test pyramid + an adversarial matrix.

## Tooling
- **Unit/integration:** Vitest.
- **E2E:** Playwright (against a preview URL).
- **DB/RLS:** local Supabase (`supabase start`) + pgTAP (or scripted anon-key probes).
- **Payments:** **Stripe CLI** (`stripe listen --forward-to`, `stripe trigger checkout.session.completed`) + Stripe **test cards** (success, 3DS-required, declines); **Razorpay test mode**.
- **CI:** GitHub Actions runs the lot on every PR (see doc 05).

## Layer 1 — Unit (pure logic, fast, many)
- Price resolution = **from DB by designId**; client price ignored.
- zod schemas: valid / empty / missing / wrong-type / boundary / malformed for **every field** (see matrix).
- Idempotency: same `attemptKey` → reuse path chosen.
- Signature verifiers: Stripe `constructEvent` good vs tampered; Razorpay HMAC good vs bad (timing-safe).
- Entitlement decision; currency/amount mapping (paise vs cents).

## Layer 2 — Integration (API routes + test DB)
- `/api/checkout`: creates one `pending` order; **same attemptKey twice → one order, reused payment**; already-paid email+design → short-circuit to download, **no charge**; free design → 400.
- Webhook → `process_payment`: grants once; **replay same event → still one entitlement**; amount mismatch → no grant; refund → revoke + R2 delete called.
- `/api/render`: denies unless `paid` + entitled; caches by text hash (2nd call no re-render).
- `/api/download/[token]`: denies `pending`/revoked; returns signed URL only when entitled.
- `/api/orders/[token]/status`: returns **only** coarse status (no PII).
- `/api/cron/*`: rejects without `CRON_SECRET`; reconcile fulfils a missed payment, expires after 3, refunds a duplicate.

## Layer 3 — DB / RLS (the data wall)
- With the **anon key**, attempt `select *` on `orders`, `entitlements`, `design_assets`, `processed_events`, `pending_emails` → **0 rows / denied**.
- `designs`/`collections` → only safe columns, only `active` rows.
- Accounts phase: user A cannot read/update/delete user B's rows; `UPDATE` blocked without a `SELECT` policy; `with check` blocks writing a row owned by someone else.
- `service_role` bypasses (server only).

## Layer 4 — E2E (Playwright, real flows)
- Catalog → filter → editor → **free** download (no server charge).
- Premium → editor → **Stripe test checkout** → webhook via Stripe CLI → status flips `paid` → render → download → email queued.
- **Resilience:** kill network after pay → reconnect → page resumes from `localStorage` token + status poll → download. Double-click Pay → **one** charge. Reload checkout → same intent/session.
- Razorpay test-mode equivalent.

## Adversarial / security matrix (must all fail safely)
- **IDOR:** call download/status/render with someone else's token / a random token → 403/404, never data.
- **Price tampering:** post a different price/amount → ignored (DB price wins).
- **Forged webhook:** bad/again-used signature → 400, no grant.
- **Replay:** same webhook event twice → idempotent (one entitlement).
- **Rate limits:** exceed each endpoint's limit → 429; Turnstile-less checkout → 403.
- **Injection:** `' OR 1=1 --`, `<script>`, `${}`, huge/Unicode/emoji in every text field → stored/escaped as text, no SQL/JS execution (card text renders as text in Satori; no `dangerouslySetInnerHTML`).
- **Oversized payload:** >4.5 MB body → 413 handled; >max text length/array → zod 400.
- **Secret leak probe:** inspect bundle + network → no secret/service key; `/api/*` never returns secrets or stack traces.

## "Every field, every way" — per-input checklist
For **each** input (designId, provider, email, attemptKey, turnstileToken, token, text[]): test **valid · empty · missing · wrong type · boundary (max len / max array) · malformed (non-UUID, bad email) · injection (SQL/XSS) · unicode/emoji · oversized**. Reject unknown fields.

## CI gate (blocks merge)
- [ ] `tsc --noEmit`, eslint, **Vitest unit + integration**, RLS probes, **Playwright smoke** on preview, gitleaks, `npm audit`, build green.

## Pre-launch sign-off
- [ ] All four layers pass; adversarial matrix all fail-safe; payment resilience checklist (doc in backend-architecture) green with Stripe CLI + Razorpay test mode.

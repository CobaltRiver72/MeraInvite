# Payment Resilience & Idempotency — Finalized Spec

> Hardened specification for payment processing, webhook handling, reconciliation, and delivery. **Status: implemented in `./starter/`.** This is the source of truth.

## 1. Core principles
1. **Server-to-server authority.** Stripe/Razorpay webhooks are the primary truth. The browser is never trusted for payment completion.
2. **At-most-once charging.** Double-charges prevented at the DB *and* gateway levels.
3. **Eventually-consistent fulfilment.** If a user pays, they get their download (email + browser resume) even if the browser crashes, WiFi drops, or our webhook endpoint is down.

## 2. Hardened scenarios & mechanisms

### A. Idempotent checkout (DB-driven gateway reuse) — `api/checkout/route.ts`
- Browser generates a unique **`attemptKey` (UUID)** once per checkout attempt.
- **DB-side reuse (primary):** before calling a gateway, `/api/checkout` looks up an existing `pending` order by `attempt_key` and reuses the stored provider order id / re-fetched `clientSecret` instead of creating a new payment. Unique index on `attempt_key` also catches concurrent races.
- **Gateway-side locks (secondary):** Stripe `Idempotency-Key: attemptKey`; Razorpay `receipt = attemptKey` (+ optional dashboard "block duplicate receipt" toggle).

### B. Already-paid short-circuit — `api/checkout/route.ts`
Before charging, check `entitlements` for a paid, non-revoked entitlement matching `email + designId`. If found → return `{ alreadyPaid, orderToken }` and route to download. No second charge.

### C. Asynchronous webhook processing (outbox) — webhooks + `process_payment` RPC
1. Webhook verifies the raw signature.
2. In **one Postgres transaction** (`process_payment`): insert `processed_events` (idempotency) → set order `paid` → insert `entitlements` → **enqueue the email row in `pending_emails`**.
3. Return `200 OK` immediately — email never blocks the webhook.
4. `GET /api/cron/send-emails` (~every minute) drains `pending_emails` via Resend with backoff (`attempts` capped at 5), marking `sent`/`failed`.

### D. Durable delivery & localStorage lifecycle — client + `api/orders/[token]/status`
1. **Durable link:** the queued email is the cross-device recovery channel (email required for premium).
2. **Persistence:** browser stores `orderToken` in `localStorage` at checkout start.
3. **Resumption:** on load/recovery the page reads the token, calls `GET /api/orders/[token]/status`, and if `paid` triggers render+download.
4. **Shared-device protection:** token cleared on successful download **and** auto-expired after a **2-hour TTL**. (We keep `localStorage`, not `sessionStorage`, because the durable channel is email and sessionStorage can't survive a tab close.)

### E. Reconciliation cron (backstop) — `api/cron/reconcile/route.ts` (~every 5 min)
1. **Bounded window:** only `pending` orders aged **3 min – 2 h**.
2. **Attempt limiting:** increment `reconciliation_attempts`; after **3** → `expired` + cancel the Stripe PaymentIntent.
3. **Bulk queries:** `stripe.paymentIntents.list({created})` once (not per-order retrieve) to avoid 429s; match in memory. Razorpay via bounded `orders.fetchPayments`.
4. **Duplicate remediation:** if multiple distinct `paid` orders share `email + design` within 15 min → auto-refund the extras, revoke their entitlements, alert.

### F. R2 cache invalidation on revocation — webhooks + `r2.deletePrivatePrefix`
On refund/revoke, list-and-delete the whole **`rendered/${order.id}/`** prefix (we cache by text hash, so an order can have several renders). Once deleted, any outstanding presigned URL returns `404`.

## 3. Schema additions (in `supabase/schema_and_rls.sql`)
- `orders`: `attempt_key uuid` (unique partial index), `reconciliation_attempts int default 0`, `expires_at timestamptz`.
- `pending_emails` table (outbox) + drain index + RLS (service-role only).
- `process_payment` RPC now also enqueues the download email.

## 4. New env
- `CRON_SECRET` (server) — cron routes require `Authorization: Bearer <CRON_SECRET>`. Vercel Cron sends it automatically; schedules in `vercel.json` (reconcile `*/5`, send-emails `* * * * *`).
- **Note:** sub-daily Vercel Cron needs a Pro plan; otherwise point an external scheduler (QStash / GitHub Actions / cron-job.org) at the two endpoints with the same header.

## 5. Verification checklist
- [ ] Same `attemptKey` retried → one PaymentIntent, one order (Stripe + Razorpay).
- [ ] Already-paid email+design → routed to download, not charged.
- [ ] Force a query error in the entitlements insert → whole `process_payment` rolls back (atomic).
- [ ] Kill network after pay → webhook still grants, email arrives, page resumes.
- [ ] Disable webhook, pay → reconcile fulfils within minutes.
- [ ] Replay webhook twice → one entitlement.
- [ ] Stale pending → `expired` + intent cancelled after 3 attempts.
- [ ] Refund → R2 `rendered/{order.id}/` deleted; presigned URL 404s.
- [ ] Two genuine charges → reconcile auto-refunds duplicate + revokes.
- [ ] localStorage cleared after download; expires after 2h.

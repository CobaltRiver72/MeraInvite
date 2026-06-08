# Research notes — Razorpay (India)

> ⚠️ Razorpay's docs couldn't be machine-read this pass (web_fetch timed out; the domain is blocked in the Chrome tool). These notes are from established knowledge — **confirm against the live docs below before implementing**, especially the two items flagged ⚠️.

Canonical docs to open & verify:
- Orders API: https://razorpay.com/docs/api/orders/
- Standard Checkout: https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/
- Payment Links (fully hosted): https://razorpay.com/docs/payments/payment-links/
- Webhooks: https://razorpay.com/docs/webhooks/
- Verify signature: https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/build-integration/#verify-payment-signature
- Refunds: https://razorpay.com/docs/api/refunds/

## Integration shape (mirror Stripe's hosted approach)
Don't hand-build a card form. Two hosted-ish options:
- **Standard Checkout** (`checkout.js` modal): server creates an **Order**, client opens Razorpay Checkout with `order_id`; on success Razorpay returns `razorpay_payment_id`, `razorpay_order_id`, `razorpay_signature`.
- **Payment Links / Payment Pages**: fully Razorpay-hosted URL — least code, good for India.
Either way, **the webhook is the source of truth**, not the client callback.

## Orders API
- Amounts in **paise** (₹199 → `19900`), `currency: "INR"`.
- `receipt` = merchant reference, **≤ 40 chars** (we set `receipt = attemptKey.slice(0,40)`).
- `notes` = key/value metadata (put `order_token`, `design_id`).
- `payment_capture`: prefer **auto-capture** so funds capture on success (avoid authorized-but-uncaptured limbo).

## Webhooks
- Signature header: **`X-Razorpay-Signature`** = **HMAC-SHA256(rawBody, webhookSecret)** (hex). Verify over the **raw body** (our handler does this with `crypto.timingSafeEqual`). SDK helper: `validateWebhookSignature(body, signature, secret)`.
- Events we use: **`payment.captured`** (grant), **`order.paid`**, **`refund.processed`** / `refund.created` (revoke). Configure these in the Razorpay dashboard with the webhook secret.
- Return 2xx fast; Razorpay retries failed deliveries → our idempotency (`processed_events`) handles replays.

## Idempotency ⚠️ (verify)
- ⚠️ The standard **Orders/Payments API has no universal `Idempotency-Key` header** like Stripe (idempotency keys exist mainly for **RazorpayX/Payouts**). Do **not** rely on a header for the payment Orders API.
- ⚠️ The **`receipt`** field is **not** unique by default — a dashboard setting **"block multiple orders with same receipt_id"** makes it reject duplicates (it errors; it does **not** return the existing order).
- **Therefore our primary idempotency is DB-side reuse** (look up the pending order by `attempt_key`/`receipt` and reuse its `razorpay_order_id`) — already implemented in `/api/checkout`. Treat `receipt` + the dashboard toggle as a secondary guard.

## Refunds
- `POST /v1/payments/:id/refund` (full or partial). Fires `refund.processed` → our `revoke_payment` + R2 delete.

## Action items
- [ ] Confirm the three ⚠️ facts in the live docs/dashboard before launch.
- [ ] Use Standard Checkout (order_id) **or** Payment Links; webhook = truth.
- [ ] Enable the "block duplicate receipt_id" dashboard toggle; keep DB-side reuse as primary idempotency.
- [ ] Configure webhook events (payment.captured, refund.processed) + secret.
- [ ] Auto-capture on; amounts in paise; `receipt = attemptKey`.
- [ ] Test with Razorpay test mode keys on preview.

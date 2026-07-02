# Research notes — Stripe (read 2026-06)

Sources:
- Checkout overview: https://docs.stripe.com/payments/checkout
- Hosted Checkout quickstart: https://docs.stripe.com/checkout/quickstart
- Fulfillment: https://docs.stripe.com/checkout/fulfillment
- Webhooks: https://docs.stripe.com/webhooks
- Idempotent requests: https://docs.stripe.com/api/idempotent_requests
- Refunds: https://docs.stripe.com/refunds · Test mode: https://docs.stripe.com/test-mode

## Use **hosted Checkout** (decision)
Three UIs on the **Checkout Sessions API**: hosted full-page (recommended, lowest complexity), embedded form, or Elements. **Pick hosted full-page** — Stripe hosts the payment page, handling cards, **Apple/Google Pay, Link, dynamic + local payment methods, SCA/3DS, surcharging, tax** with the least code and minimal PCI scope. Strictly better than hand-building PaymentIntent + Elements for a small team.

**Flow:** server creates a Checkout Session → redirect customer to the Stripe URL → fulfill on the **`checkout.session.completed`** webhook. Put our `order_token` in `client_reference_id` and `metadata`; verify `payment_status === "paid"` before granting. (Async methods also fire `checkout.session.async_payment_succeeded`.)

## Webhooks
- Endpoint receives a POST with the **`Stripe-Signature`** header. Verify with `stripe.webhooks.constructEvent(rawBody, sig, endpointSecret)` over the **raw body** (no JSON parse first). Default signature **tolerance 300s**.
- **Retries:** Stripe retries failed deliveries with exponential backoff for **up to 3 days** (live) — so our idempotent `process_payment` must tolerate replays (it does, via `processed_events`).
- Return **2xx fast**; do slow work async (our outbox pattern). Non-2xx → Stripe retries.
- Each endpoint has its own **signing secret** (`whsec_…`), server-only.

## Idempotency (verbatim facts)
- All **POST** requests accept an `Idempotency-Key` (SDK: `{ idempotencyKey }`). **Up to 255 chars**; Stripe recommends **V4 UUID**. (Our `attemptKey` UUID fits.)
- Stripe **saves the first response (status + body) and returns the same result** for repeats — including 500s — so a retried checkout-session create won't double-create.
- Keys may be **pruned after 24h**; reuse after pruning creates a new request. Stripe **compares params** and errors if a reused key has different params (prevents misuse).
- Don't use sensitive data as keys.

## Refunds & disputes
- `stripe.refunds.create({ payment_intent })` (or by charge). Refunds fire `charge.refunded` / `refund.updated` webhooks → our `revoke_payment` + R2 delete. Disputes/chargebacks fire `charge.dispute.*`.

## India note
- Stripe India support is limited (esp. for India-domiciled businesses / domestic cards). **Keep Razorpay for India**; use Stripe for US/UK/CA/AU/EU diaspora. Stripe **Adaptive Pricing** can show local currency for international buyers.

## Impact on our code (revision)
- Replace the PaymentIntent + Elements path with **Checkout Sessions**: `/api/checkout` creates a session (amount/price from DB, `client_reference_id = order_token`, `metadata.attempt_key`, `idempotencyKey = attemptKey`) and returns the session `url`; client redirects.
- Webhook switches from `payment_intent.succeeded` → **`checkout.session.completed`** (read `client_reference_id`, `amount_total`, `currency`, `payment_status`). `process_payment` logic unchanged.
- Reconcile cron lists **Checkout Sessions** (`stripe.checkout.sessions.list`) instead of PaymentIntents, filtering by `created`.
- Customer/Billing Portal: not needed for one-time goods; revisit only for a future B2B subscription.

## Action items
- [ ] Switch `/api/checkout` (Stripe branch) to Checkout Sessions + `idempotencyKey`.
- [ ] Switch Stripe webhook to `checkout.session.completed` (+ `async_payment_succeeded`), verify `payment_status==="paid"` and amount.
- [ ] Reconcile via `checkout.sessions.list`.
- [ ] Test with **Stripe CLI** (`stripe listen`, `stripe trigger checkout.session.completed`) on preview (test keys).

# Research notes — Sentry + Resend

> Written from established knowledge (live fetch not completed this pass). Confirm at the cited docs.

## Sentry (error + performance monitoring)
Docs: https://docs.sentry.io/platforms/javascript/guides/nextjs/
- Install with the wizard: `npx @sentry/wizard@latest -i nextjs` → adds `@sentry/nextjs`, `instrumentation.ts` + `instrumentation-client.ts`, and the Next config wrapper.
- Captures **unhandled errors, traces (performance), and optional Session Replay** across client/server/edge. Tag **environment** (production vs preview) so staging noise is separated.
- **Source map upload** in CI (via the Sentry build plugin + auth token) → readable stack traces. Keep the auth token server/CI-only.
- **PII:** leave `sendDefaultPii` off; scrub emails/tokens before sending. Set a sensible `tracesSampleRate` (e.g. 0.1–0.2) to control cost.
- Use the **tunnel route** option so ad-blockers don't drop error reports.
- Wire **alerts** on: webhook failures, spikes in `pending` orders, 5xx on `/api/*`, reconcile errors.

Why we want it: with serverless + payments, silent failures are the danger. Sentry is the eyes on `process_payment`, webhooks, render, and crons.

## Resend (transactional email)
Docs: https://resend.com/docs · domains https://resend.com/docs/dashboard/domains/introduction · idempotency https://resend.com/docs/api-reference/introduction
- Send via REST (`POST https://api.resend.com/emails`, `Authorization: Bearer <RESEND_API_KEY>`), server-only. Our `lib/email.ts` does this; the outbox cron drains `pending_emails`.
- **Domain auth is mandatory for deliverability:** add **SPF + DKIM** DNS records Resend provides, and set a **DMARC** policy on the sending domain — otherwise download/receipt emails land in spam or get spoofed.
- **Idempotency:** Resend's send API accepts an **`Idempotency-Key`** → key each send by `pending_emails.id` so an outbox retry can't double-send the same download email.
- React Email for templates; **delivery/bounce/complaint webhooks** to mark emails and stop retrying dead addresses; honor a suppression list.
- Watch the plan's **send rate + monthly quota** (free tier is limited — verify current numbers); transactional (download/receipt) vs marketing (opt-in + unsubscribe) kept separate.

## Action items
- [ ] Add Sentry (wizard), env tagging, source maps in CI, PII scrubbing, alerts on payment/webhook/cron failures.
- [ ] Resend: verify sending domain (SPF/DKIM) + DMARC; use **Idempotency-Key = pending_emails.id** in the outbox sender; add bounce webhook + suppression.

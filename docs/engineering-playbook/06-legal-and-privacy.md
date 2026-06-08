# 06 · Legal, Privacy & Compliance

> Not legal advice — have a lawyer review before launch. This is the engineering + content checklist to be defensible across our markets: **US (CCPA/CPRA), Canada (PIPEDA), EU/EEA + UK (GDPR/UK-GDPR), India (DPDP Act 2023), Australia (Privacy Act / APPs).**

## What data we actually handle (map it honestly)
| Data | Where | Why | Retention |
|---|---|---|---|
| Email (optional, for delivery/receipt) | Supabase `orders`, Resend | send download link + receipt | delete on request; auto-purge old guest orders (e.g. 12–24 mo) |
| Invitation **text the user types** (names, date, venue) | transiently in render; in `orders`/render cache | produce the card | delete with the order; purge cache on refund |
| Payment info (card) | **Stripe / Razorpay only — never our servers** | take payment | held by processor (PCI) |
| Order/payment metadata (amount, status, provider ref) | Supabase `orders` | fulfilment, accounting, refunds | accounting-retention period |
| Analytics (pageviews, funnel events) | PostHog / GA4 | improve product | per analytics config; anonymize where possible |
| IP / rate-limit keys | Upstash, Cloudflare logs | security/abuse | short TTL |
We are a **data controller**; Stripe, Razorpay, Supabase, Resend, Cloudflare, PostHog are **processors** — sign/accept their **DPAs**.

## Required pages (build these)
1. **Privacy Policy** — what we collect, why, legal basis (consent/contract/legitimate interest), who we share with (the processors above), international transfers, retention, user rights, contact, how to delete data.
2. **Terms of Service** — license to use designs (personal/non-commercial use of downloads; we retain IP in the artwork), acceptable use, **digital-goods refund terms**, **liability limitation & disclaimer of warranties**, **dispute resolution / governing law**, account/guest terms, changes to terms.
3. **Refund Policy** — one-time digital goods; state the policy clearly (our resilience plan = generous refunds for failed delivery/double charge).
4. **Cookie / Tracking notice + consent banner** — needed for GDPR/ePrivacy: load non-essential analytics/pixels **only after consent**; default to declined; essential cookies (session, security) exempt.
5. **Contact / data-request page** — email + a "Delete my data" path.

## User-rights mechanisms to implement
- **Access / export:** on request, return the data tied to an email (orders, text inputs). A simple admin-run query is fine at first; document the SLA (e.g. 30 days — GDPR).
- **Deletion ("right to erasure" / CCPA delete / DPDP erasure):** a **"Delete my data"** flow — verify the requester owns the email (magic-link confirm), then delete/anonymize their `orders`, `pending_emails`, render cache (R2), and remove from Resend/analytics. Keep only what law requires (e.g. tax records — anonymized).
- **Opt-out:** CCPA/CPRA "Do Not Sell or Share My Personal Information" — we don't sell data; still provide an opt-out of analytics/ad pixels. Honor **Global Privacy Control (GPC)** signals.
- **Consent withdrawal:** cookie banner lets users change/withdraw consent anytime.
- **Marketing email:** only with opt-in; every marketing email has unsubscribe (transactional download/receipt emails are exempt).

## Per-region notes
- **GDPR/UK:** lawful basis, DPA with processors, data-transfer mechanism (SCCs) since data leaves the EU, 30-day response to rights requests, breach notification (72h).
- **CCPA/CPRA (California):** disclosures, opt-out of sale/share, GPC, no discrimination for exercising rights.
- **India DPDP Act 2023:** notice + consent, ability to withdraw consent, grievance/contact, data-deletion on request.
- **Australia (APPs):** privacy policy, collection notice, access/correction, overseas-disclosure note.
- **Canada (PIPEDA):** consent, purpose limitation, access, accountability contact.

## Engineering hooks for compliance
- [ ] Cookie-consent component gating non-essential scripts (analytics/pixels load only post-consent; GPC respected).
- [ ] "Delete my data" endpoint/flow (email-verified) that purges DB rows + R2 renders + Resend + analytics id.
- [ ] Data-retention job: auto-purge old guest orders/render cache after N months.
- [ ] Footer links: Privacy · Terms · Refund · Cookie settings · Contact, on every page.
- [ ] Record consent (timestamp + version) for auditability.
- [ ] Accept/sign processor DPAs (Stripe, Razorpay, Supabase, Resend, Cloudflare, PostHog).
- [ ] Lawyer review of all policy pages before launch; set `governing law` / dispute venue intentionally.

## Checklist
- [ ] Privacy Policy, Terms, Refund Policy, Cookie notice, Contact pages live and linked in footer.
- [ ] Consent banner (decline-by-default) + GPC honored.
- [ ] Delete-my-data + data-export flows working and documented (with SLA).
- [ ] Retention/auto-purge implemented.
- [ ] DPAs accepted; data-transfer mechanism noted; processors listed in policy.
- [ ] Marketing opt-in + unsubscribe; transactional emails separated.
- [ ] Lawyer-reviewed.

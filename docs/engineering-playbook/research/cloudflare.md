# Research notes — Cloudflare (R2 · WAF · Turnstile · Cache · DNS)

> Written from established knowledge (live fetch not completed this pass). Confirm at the cited docs.

Docs: R2 https://developers.cloudflare.com/r2/ · presigned URLs https://developers.cloudflare.com/r2/api/s3/presigned-urls/ · WAF https://developers.cloudflare.com/waf/ · rate limiting https://developers.cloudflare.com/waf/rate-limiting-rules/ · Turnstile https://developers.cloudflare.com/turnstile/ · Cache rules https://developers.cloudflare.com/cache/

## R2 (storage) — why we chose it
- **S3-compatible** API → use `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (already in our `lib/r2.ts`). Endpoint `https://<account>.r2.cloudflarestorage.com`.
- **Zero egress fees** — the reason heavy free-download traffic stays cheap.
- **Two buckets:** `public` (free backgrounds + previews) served via a Cloudflare custom domain/CDN with long cache; `private` (premium masters + rendered outputs) reachable **only via short-lived presigned URLs** our server mints.
- **Uploads** (admin art): use **presigned PUT** so big files go browser→R2 directly (never through a 4.5 MB Vercel function). Set bucket **CORS** to allow the PUT from our origin.
- **Lifecycle rules** to auto-expire old rendered outputs (complements our delete-on-revoke + retention job).

## WAF & rate limiting (outer wall)
- Turn on **Managed Rules** + **Bot Fight / Super Bot Fight Mode**.
- **Rate-limiting rules** by IP + path as the coarse outer limit (e.g. cap `/api/*` bursts) — Upstash is the fine inner limiter. (Rate-limiting rule capabilities vary by plan; verify your plan's allowance.)
- HTTPS-only, **HSTS**, TLS ≥1.2, SSL mode **Full (strict)**.
- Optionally **Cloudflare Access** in front of `/admin` (Zero-Trust) so it isn't publicly reachable.

## Turnstile (bot gate on checkout)
- Free CAPTCHA-alternative. Client renders the widget (site key, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`); server verifies the token at **`https://challenges.cloudflare.com/turnstile/v0/siteverify`** with the **secret key** (our `lib/turnstile.ts`). Already wired into `/api/checkout`.

## Cache rules (speed)
- **Cache** static assets + SSR/ISR HTML aggressively at the edge; honor Vercel's `s-maxage`/`stale-while-revalidate`.
- **Bypass cache for `/api/*`** and any token route (never cache authenticated/dynamic responses).
- Enable **Tiered Cache** for better hit ratios; long TTL + `immutable` on fingerprinted assets and R2 public images.

## Action items
- [ ] Create R2 public + private buckets; CORS on public/private for presigned PUT; custom domain on public bucket.
- [ ] WAF managed rules + bot mode on; rate-limit rule on `/api/*`; HSTS; SSL Full(strict).
- [ ] Turnstile widget on checkout (already server-verified).
- [ ] Cache rules: cache pages/assets, **bypass `/api/*`**; Tiered Cache on.
- [ ] (optional) Cloudflare Access on `/admin`.

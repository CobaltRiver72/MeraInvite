# 04 · Caching (make everything "super fast")

> Four layers, each with a clear job. The principle: **serve from the edge whenever the data isn't user-specific; never cache anything private or authenticated.**

## Layer 1 — Browser cache (static assets)
- Fingerprinted JS/CSS/fonts/images → `Cache-Control: public, max-age=31536000, immutable` (Next.js does this for `/_next/static`).
- HTML of catalog/collection pages → short cache + revalidate (see ISR).
- **Never** cache `/api/*` or anything with a token — already enforced with `Cache-Control: no-store` in `middleware.ts`.

## Layer 2 — CDN edge cache (Cloudflare + Vercel)
- **Static & SEO pages** (home, culture hubs, collection pages, blog) are the bulk of traffic → cache aggressively at the edge so they're served without invoking a function. This is the single biggest speed + cost win.
- **Images** (R2 public bucket: previews, free backgrounds) served through Cloudflare CDN with long TTL + descriptive filenames (also feeds the Images SERP pack).
- Set Cloudflare to **bypass cache for `/api/*`** (never cache dynamic/authenticated responses).

## Layer 3 — ISR / server render cache (Next.js)
- Collection & catalog pages: **Incremental Static Regeneration** — pre-rendered HTML, revalidated on a schedule (e.g. `revalidate: 3600`) or **on-demand** when a design is added/edited (call `revalidatePath('/sukhmani-sahib-path-invitations')` from the admin save). Result: SEO-ready static HTML, fresh within minutes of a catalog change, ~0 function cost per view.
- Homepage popular grid: ISR with a longer revalidate.
- Editor / checkout / download: **dynamic, never cached** (per-user).

## Layer 4 — Application data cache (Upstash Redis)
Use sparingly, only for hot reads that aren't already CDN-cached:
- Cache the **designs payload for a collection** (id, name, price, preview_url, text config) under a key like `collection:<slug>`; bust on design insert/update. Saves a DB round-trip on cache-miss page renders and on API reads.
- Cache currency/region lookups, FX display values, feature flags.
- **Do not** cache anything tied to a specific order/user/entitlement.
- We already run Upstash for rate limiting, so there's no new dependency.

## What to cache vs never cache
| Cache hard (edge/ISR) | Never cache |
|---|---|
| Home, hubs, collection/catalog HTML | `/api/checkout`, `/api/render`, `/api/download`, `/api/orders/*` |
| Public design previews / free backgrounds (R2 public) | Premium masters & rendered outputs (R2 **private**, signed URLs only) |
| Blog, FAQ, static copy | Anything with `order_token`, email, or entitlement |

## Per-request speed checklist
- [ ] Collection/catalog pages on **ISR** (static HTML, on-demand revalidate from admin).
- [ ] Cloudflare caches static + pages; **bypasses `/api/*`**.
- [ ] R2 public assets behind CDN, long TTL, lazy-loaded, responsive `srcset`, descriptive alt/filenames.
- [ ] Upstash caches hot collection payloads; busted on write.
- [ ] `no-store` on every dynamic/authenticated route (done in middleware).
- [ ] Fonts subset + `font-display: swap`; preconnect to font host.
- [ ] Images optimized (WebP/AVIF, correct dimensions) — biggest LCP lever on a thumbnail-heavy catalog.
- [ ] Measure with Lighthouse / Core Web Vitals; target good LCP/CLS (also a ranking factor).

# 07 · On-Page SEO, HTTP Headers & Schema (structured data)

> Two meanings of "schema": **HTTP headers** + **schema.org structured data** + **on-page SEO** for a transactional, niche invitation catalog. (DB schema is doc 03.)

## HTTP headers (every response)
**Security headers** (set in `middleware.ts` / `next.config.mjs`):
- `Content-Security-Policy` — allow self + only Stripe/Razorpay/R2/Cloudflare/fonts; `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`.
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin` (and **`no-referrer`** on token routes: download/render/success)
- `Permissions-Policy` — disable camera/mic/geo.
**Caching headers**:
- Static assets → `public, max-age=31536000, immutable`.
- ISR pages → framework-managed `s-maxage` + `stale-while-revalidate`.
- Every `/api/*` and token route → `Cache-Control: no-store`.
**Webhook routes** read the **raw body** (no parsing) for signature verification.
Verify with securityheaders.com before launch.

## Schema.org structured data (JSON-LD) — match the SERP
The collection page is a catalog + tool + FAQ at once, so emit all three (already in `catalog.html`):
- **`CollectionPage`** — page identity.
- **`WebApplication`** (`applicationCategory: "DesignApplication"`, free offer) — declares the editor/tool nature. This is what the fading incumbent lacked.
- **`FAQPage`** — wraps the on-page FAQ.
- **`BreadcrumbList`** — culture → ceremony path.
Premium design / editor page:
- **`Product`** + **`Offer`** (price, currency by region, availability) → drives the price + shopping rich result.
- **`AggregateRating`** once reviews exist → ★ stars in the SERP (collect ratings from day one).
Site-wide: **`Organization`** + **`WebSite`** (+ `SearchAction` if we add site search). Validate with Google's **Rich Results Test**.

## On-page SEO for this site type (transactional + visual)
Google ranks makers/collections/product pages here — **not blog posts**. So the collection page must:
- One keyword **`<h1>`** ("Sukhmani Sahib Path Invitation Cards"); short intro.
- **Keyword-rich `<h2>`s** per modifier (In Punjabi / In Hindi / New Home / Birthday / Kirtan), each above a cluster of matching designs.
- **25–40 designs**, each card with a **keyword caption** + **descriptive `alt` text + filename** (feeds the Images pack & Pinterest).
- Supporting copy + **FAQ** + a **short demo video** (earns the Video SERP feature) below the grid.
- Unique `<title>` + meta description with "Free" (matches the dominant intent).
- **Canonical** tag per collection; filters stay client-side (no faceted URLs).
- Internal links: culture hub ↔ collections ↔ related collections.
- Fast **Core Web Vitals** (LCP/CLS) — ranking factor and the catalog is image-heavy, so optimize/lazy-load thumbnails.
- `sitemap.xml` + `robots.txt`; submit to Google Search Console.
- Pinterest-optimized 3:4 images; seed Pinterest day one (owns 2–3 SERP slots).

## "Layering" (defense + performance, recap)
Request path, each layer doing one job: **Cloudflare (cache/WAF/bot) → Vercel edge (headers/ISR) → Route Handler (validate → authN → authZ/ownership → rate limit) → Supabase (RLS) → R2 (private, signed URLs)**. Break one, the rest still hold; cache as high up as possible for speed.

## Checklist
- [ ] Security headers + CSP present; `no-referrer` on token routes; verified on securityheaders.com.
- [ ] `no-store` on all dynamic/API/token routes; long immutable cache on static.
- [ ] JSON-LD: CollectionPage + WebApplication + FAQPage + BreadcrumbList on collections; Product+Offer(+AggregateRating) on premium; Organization+WebSite site-wide. Validated in Rich Results Test.
- [ ] H1 + keyword H2s + keyword captions + alt text + filenames.
- [ ] Unique titles/meta with "Free"; canonical tags; client-side filters only.
- [ ] sitemap.xml + robots.txt; GSC verified.
- [ ] Core Web Vitals green; thumbnails optimized + lazy-loaded.

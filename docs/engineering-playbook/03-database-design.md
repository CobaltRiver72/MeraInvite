# 03 · Database Design

> Postgres on Supabase. Properly normalized, indexed, related, migrated, backed up. The goal: correct first, then fast — no "two random columns" tables.

## Entities & relationships (normalized)
```
cultures (1) ─────< occasion_types (1) ─────< collections (1) ─────< designs (1) ─< design_assets (1:1, private master)
                                                                          │
orders (1) ─< entitlements                          designs (1) ─────────┘  (a design belongs to one collection)
   │  └─< pending_emails
   └── references designs
processed_events  (provider,event_id) unique        (later) users (1) ─< user_downloads >─ (1) designs
```
- **cultures** → Sikh, Hindu, Muslim, Secular/US.
- **occasion_types** → Sukhmani Path, Akhand Path, Griha Pravesh… (FK `culture_id`).
- **collections** → one row per ranking page (FK `occasion_type_id`, `culture_id`).
- **designs** → catalog item (FK `collection_id`).
- **design_assets** → 1:1 with designs, holds the **private** master path (separate table so RLS can lock it).
- **orders / entitlements / pending_emails / processed_events** → transactional (see schema_and_rls.sql).
Third normal form: no repeating groups, no derived data stored, every non-key column depends on the key. Culture/occasion are **lookups by FK**, not free-text repeated on every design.

## Primary keys & IDs
- **PK = `uuid` (`gen_random_uuid()`)** on every table — non-enumerable, safe to expose internally, no IDOR-by-incrementing.
- **Public handles** (download/status) = a separate **256-bit random `order_token`**, never the PK.
- **Natural unique keys** where they exist: `designs.slug`, `collections.slug`, `processed_events(provider,event_id)`, `orders.attempt_key`.
- Never expose sequential integers in URLs or APIs.

## Indexes (match them to real query patterns)
Index the columns we actually filter/sort/join on:
- `designs(collection_id)` — catalog page load. Plus `designs(slug)` unique.
- `designs` filter helpers: GIN index on `tags` if we filter by tag in SQL (`create index … using gin (tags)`); `(is_premium)`, `(lang)` if used in WHERE.
- `collections(slug)` unique; `(culture_id)`, `(occasion_type_id)`.
- `orders(order_token)` unique; `orders(provider_ref)`; `orders(attempt_key)` unique partial; `orders(status, created_at)` for the reconcile sweep; `orders(email, design_id)` for already-paid lookup.
- `entitlements(order_id, design_id)` unique; `entitlements(order_id)`.
- `pending_emails(status, attempts)` for the drain query.
Rule: **add an index when a query filters/sorts/joins on a column at scale; don't index everything** (writes pay for every index). Verify with `explain analyze` and Supabase's **index_advisor** / Database Advisors.

## Migrations (version-controlled, reproducible)
- Use the **Supabase CLI**: every schema change is a timestamped SQL file in `supabase/migrations/`, committed to git. **No clicking changes in the dashboard for prod.**
- Flow: `supabase migration new <name>` → edit SQL → test on a **branch/preview DB** → `supabase db push` via CI on merge.
- Migrations are **forward-only + idempotent where possible** (`if not exists`, `create or replace`). Keep a paired notes line on destructive changes.
- Seed data (cultures, occasion_types, a few designs) in a `seed.sql` for local/preview.

## Backups & recovery
- Supabase provides **automated daily backups** (retention by plan); **Point-in-Time Recovery (PITR)** is available on paid plans — enable it before real revenue.
- Before any risky migration: take a manual backup / snapshot.
- Keep migrations in git = schema is reproducible even without a backup; data is what backups protect.
- Document a one-page **restore runbook** (where backups are, how to PITR, who has access).

## Query optimization
- **Select only needed columns** (never `select *` on hot paths) — also avoids leaking columns.
- Filter on indexed columns; avoid functions on indexed columns in WHERE (kills index use).
- Use `explain (analyze, buffers)` on the catalog query and the reconcile sweep; watch for seq scans on big tables.
- Enable **`pg_stat_statements`** (Supabase has it) to find slow/frequent queries.
- Paginate large lists (catalog uses keyset/limit, not OFFSET on huge sets).
- Keep `text_fields` JSON small; don't query *inside* it on hot paths — it's render config, read whole.

## Connection handling (recap from doc 01)
- App traffic via **supabase-js (PostgREST)** → no socket-per-request, server-side pooled.
- Any direct-connection ORM → **Supavisor transaction mode, port 6543, prepared statements OFF, tiny pool**.
- Migrations/admin → **direct connection 5432**.
- Set sensible **statement timeouts** (Supabase → Database → timeouts) so a runaway query can't pin a connection.

## Checklist
- [ ] Every table: `uuid` PK, RLS enabled, sensible FKs with `on delete` behavior chosen deliberately.
- [ ] Lookups normalized (culture/occasion via FK, not repeated text).
- [ ] Indexes created for each real filter/sort/join; verified with `explain analyze`; ran index_advisor.
- [ ] All schema changes are committed **migration files** (Supabase CLI), tested on a preview DB.
- [ ] Daily backups on; **PITR enabled** before launch; restore runbook written.
- [ ] No `select *` on hot paths; pagination in place; `pg_stat_statements` enabled.
- [ ] Statement timeout configured; connection method correct per workload.

# Research notes — Supabase (read 2026-06)

Sources:
- Connecting / pooling: https://supabase.com/docs/guides/database/connecting-to-postgres (mod 2026-05-15)
- Row Level Security: https://supabase.com/docs/guides/database/postgres/row-level-security (mod 2026-06-01)
- Supavisor: https://supabase.com/docs/guides/database/supavisor
- Query optimization / advisors: https://supabase.com/docs/guides/database/query-optimization · /database-advisors
- Timeouts: https://supabase.com/docs/guides/database/postgres/timeouts
- Backups/PITR: https://supabase.com/docs/guides/platform/backups

## Connections & pooling
- **Direct** `5432` (IPv6) — persistent servers, migrations, `pg_dump`.
- **Supavisor session mode** `5432` — persistent + needs IPv4.
- **Supavisor transaction mode** `6543` — **serverless/edge** (our case if we use a direct driver). **Transaction mode does NOT support prepared statements** → disable them in the driver.
- **supabase-js (PostgREST over HTTPS)** = no per-request PG socket; PostgREST pools server-side. **This is what we use for app traffic → no pooler config needed.**
- Pool size is shared across session+transaction ports; total backend conns must stay under the compute tier max. Monitor: Dashboard → Observability → Database Connections. Set a **statement timeout** so runaway queries don't pin connections.

## RLS — rules & gotchas (verbatim-grounded)
- **Must enable RLS on every table in an exposed schema** (`public`). Once enabled + no policy → **nothing readable via the API with the anon key**. Table Editor auto-enables; raw SQL does **not** → enable manually.
- A policy is an implicit `WHERE`. `using` = which rows are visible (SELECT/DELETE/UPDATE-read); `with check` = which rows may be written (INSERT/UPDATE-write).
- **`auth.uid()` returns null when unauthenticated** → `null = user_id` is false (silently denies). Write `using (auth.uid() is not null and auth.uid() = user_id)` to be explicit.
- **`UPDATE` needs a matching `SELECT` policy** to work as expected.
- **Authorization data → `app_metadata` (raw_app_meta_data), NEVER `user_metadata`** — users can edit their own `user_metadata`. JWT isn't always fresh until refreshed.
- **service_role bypasses RLS** — server-only, never in the browser. (If the client lib is init'd with a service key but a user is signed in, it still adheres to that user's RLS.)
- **Views bypass RLS** unless created `with (security_invoker = true)` (PG15+); otherwise revoke anon/authenticated or hide in an unexposed schema.

## RLS performance (do these — benchmarks show 90–99%+ gains)
1. **Index every column used in a policy** (e.g. `user_id`).
2. **Wrap functions in a subquery**: `(select auth.uid()) = user_id` (not `auth.uid() = user_id`) → `initPlan` caches per-statement. Same for `security definer` helpers.
3. **Always add an explicit filter in the query too** (`.eq('user_id', userId)`) even though the policy enforces it — Postgres builds a better plan.
4. **Always specify `TO authenticated`** (or `anon`) so the policy doesn't run for the wrong role.
5. For role/permission checks, use a **`security definer` helper** in a private schema to avoid RLS penalties on join tables; minimize joins (use `IN`/`ANY` over a subquery, not a join to the source table).
6. Auto-enable RLS on new tables via a DDL **event trigger** (doc has the function) so we can't forget.

## Our posture (recap, now grounded)
- Sensitive tables (`orders`, `entitlements`, `design_assets`, `processed_events`, `pending_emails`) → **RLS on, no anon/authenticated policy** → service-role only.
- Public-read tables (`designs`, `collections`, …) → `for select to anon using (active = true)`, safe columns only.
- Accounts phase → owner-scoped policies per the patterns above, indexed + wrapped + `TO authenticated`.

## Backups & limits
- Automated **daily backups**; **PITR** on paid plans → enable before revenue. Migrations in git = reproducible schema.
- `pg_stat_statements`, `index_advisor`, Database Advisors available for query tuning.

## Action items
- [ ] App access stays on supabase-js; only add transaction-pooler (6543, prepared stmts off, tiny pool) if we adopt a direct-connection ORM.
- [ ] RLS enabled on every table (+ auto-enable event trigger); verified anon can't read sensitive tables.
- [ ] Owner policies (accounts phase): indexed, `(select auth.uid())`, `TO authenticated`, app_metadata for authz.
- [ ] Statement timeout set; PITR on; advisors run before launch.

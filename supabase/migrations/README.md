# Supabase migrations

**These migration files are the canonical schema** — they supersede the earlier flat `../schema_and_rls.sql` draft (kept only for reference). Production schema changes happen **only** through versioned migration files committed here, never by clicking in the dashboard.

## Files
- `0001_init.sql` — normalized schema (cultures → occasion_types → collections → designs → design_assets; orders/entitlements/processed_events/pending_emails) + indexes + RLS + payment RPCs.
- `0002_accounts_rls.sql` — optional accounts phase (Supabase Auth): `customers`, `user_downloads`, owner-scoped CRUD policies. Apply only when adding magic-link accounts.

## Workflow
```bash
supabase migration new <name>     # creates a timestamped .sql here
# edit the SQL
supabase db reset                 # apply all migrations to LOCAL db + seed
supabase db push                  # apply to the linked (preview/prod) db  [CI on merge]
```
- Test every migration on a **preview/branch DB** before prod (see playbook 05).
- **Forward-only + idempotent where possible** (`if not exists`, `create or replace`).
- **Additive/backward-compatible** when shipping with code that depends on it; never drop a column in the same release as code that still reads it.
- Destructive change → take a backup / have PITR; write a documented down path.
- Naming: `NNNN_short_snake_case.sql`, sequential. Seed data (cultures/occasion_types/sample designs) in `seed.sql`.

## Pre-apply checklist
- [ ] RLS enabled on any new table (default-deny); policies indexed + `(select auth.uid())` + `TO authenticated`.
- [ ] New filter/join columns indexed.
- [ ] Tested on preview DB; reversible/forward-only confirmed.
- [ ] Backup/PITR before destructive prod changes.

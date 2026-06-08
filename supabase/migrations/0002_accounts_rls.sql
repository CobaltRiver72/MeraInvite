-- =============================================================================
-- 0002_accounts_rls — OPTIONAL accounts phase (magic-link "my downloads").
-- Apply only when we add Supabase Auth. Demonstrates correct owner-scoped RLS
-- (select/insert/update/delete), indexed + (select auth.uid()) + TO authenticated.
-- =============================================================================

-- A customer profile keyed to the Supabase auth user.
create table public.customers (
  id         uuid primary key references auth.users(id) on delete cascade, -- = auth.uid()
  email      text not null,
  created_at timestamptz not null default now()
);

-- "My downloads": links a signed-in user to entitlements they own (by email match
-- at claim time). user_id is the ownership column every policy checks.
create table public.user_downloads (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  order_id    uuid not null references public.orders(id) on delete cascade,
  design_id   uuid not null references public.designs(id) on delete restrict,
  created_at  timestamptz not null default now(),
  unique (user_id, order_id)
);
-- Index the ownership column used by every policy (RLS perf rule).
create index user_downloads_user_idx on public.user_downloads(user_id);

alter table public.customers      enable row level security;
alter table public.user_downloads enable row level security;

-- customers: a user sees/edits ONLY their own profile row.
create policy "customers_select" on public.customers
  for select to authenticated using ((select auth.uid()) = id);
create policy "customers_insert" on public.customers
  for insert to authenticated with check ((select auth.uid()) = id);
create policy "customers_update" on public.customers
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy "customers_delete" on public.customers
  for delete to authenticated using ((select auth.uid()) = id);

-- user_downloads: full owner-scoped CRUD. (UPDATE requires a SELECT policy too.)
create policy "user_downloads_select" on public.user_downloads
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "user_downloads_insert" on public.user_downloads
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "user_downloads_update" on public.user_downloads
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "user_downloads_delete" on public.user_downloads
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Notes:
--  * Use app_metadata (NOT user_metadata) for any role/authz claim — users can edit user_metadata.
--  * (select auth.uid()) is wrapped so Postgres caches it per-statement (initPlan) — big perf win.
--  * Always pair the policy with an explicit .eq('user_id', uid) in the query for a better plan.
--  * orders/entitlements stay server-only; this layer is just the read-side "my downloads".

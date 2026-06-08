-- =============================================================================
-- 0001_init — canonical normalized schema (supersedes the earlier flat
-- schema_and_rls.sql draft). Run via: supabase migration new / db push.
-- Conventions: uuid PKs, snake_case, FKs with explicit on delete, RLS on every
-- table (default-deny), indexes matched to real query patterns.
-- =============================================================================
create extension if not exists "pgcrypto";

-- ---------- lookups (normalized; no repeated culture/occasion text) ----------
create table public.cultures (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique,
  created_at timestamptz not null default now()
);

create table public.occasion_types (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique,
  culture_id uuid not null references public.cultures(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index occasion_types_culture_idx on public.occasion_types(culture_id);

create table public.collections (             -- one row = one ranking page
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique,
  h1               text not null,
  title_tag        text not null,
  intro_md         text,
  faq              jsonb not null default '[]',
  occasion_type_id uuid not null references public.occasion_types(id) on delete restrict,
  culture_id       uuid not null references public.cultures(id) on delete restrict,
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);
create index collections_occasion_idx on public.collections(occasion_type_id);
create index collections_culture_idx  on public.collections(culture_id);

-- ---------- catalog ----------
create table public.designs (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name          text not null,                       -- keyword caption
  collection_id uuid not null references public.collections(id) on delete cascade,
  is_premium    boolean not null default false,
  price_usd     integer not null default 0,          -- cents
  price_inr     integer not null default 0,          -- paise
  preview_url   text not null,                        -- PUBLIC bucket (premium = low-res/watermarked)
  text_fields   jsonb not null default '[]',          -- render config (read whole, don't query inside on hot paths)
  width         integer not null default 3000,
  height        integer not null default 4000,
  lang          text,
  tags          text[] not null default '{}',
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index designs_collection_idx on public.designs(collection_id);
create index designs_active_idx     on public.designs(collection_id, active);
create index designs_tags_gin       on public.designs using gin (tags);

create table public.design_assets (             -- 1:1, private master path (separate so RLS locks it)
  design_id  uuid primary key references public.designs(id) on delete cascade,
  master_key text not null                       -- key in PRIVATE R2 bucket
);

-- ---------- transactional ----------
create table public.orders (
  id                       uuid primary key default gen_random_uuid(),
  order_token              text not null unique,      -- 256-bit random; public handle (NOT the PK)
  attempt_key              uuid,                       -- idempotency (one per checkout attempt)
  design_id                uuid not null references public.designs(id) on delete restrict,
  email                    text,
  amount                   integer not null,           -- minor units, copied from designs at creation
  currency                 text not null,
  provider                 text not null check (provider in ('stripe','razorpay')),
  provider_ref             text,                       -- Checkout Session / Razorpay order id
  status                   text not null default 'pending'
                             check (status in ('pending','paid','failed','refunded','expired')),
  rendered_key             text,                       -- latest render path (set by /api/render)
  reconciliation_attempts  integer not null default 0,
  expires_at               timestamptz,
  paid_at                  timestamptz,
  created_at               timestamptz not null default now()
);
create unique index orders_attempt_key_uidx on public.orders(attempt_key) where attempt_key is not null;
create index orders_provider_ref_idx on public.orders(provider_ref);
create index orders_status_created_idx on public.orders(status, created_at);   -- reconcile sweep
create index orders_email_design_idx   on public.orders(email, design_id);     -- already-paid lookup

create table public.entitlements (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders(id) on delete cascade,
  design_id  uuid not null references public.designs(id) on delete restrict,
  revoked    boolean not null default false,
  granted_at timestamptz not null default now(),
  unique (order_id, design_id)
);
create index entitlements_order_idx on public.entitlements(order_id);

create table public.processed_events (           -- webhook idempotency
  provider text not null,
  event_id text not null,
  seen_at  timestamptz not null default now(),
  primary key (provider, event_id)
);

create table public.pending_emails (             -- outbox (webhook never blocks on email)
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid references public.orders(id) on delete cascade,
  to_email        text not null,
  subject         text not null,
  body            text not null,                  -- {{DOWNLOAD_URL}} placeholder
  status          text not null default 'pending' check (status in ('pending','processing','sent','failed')),
  attempts        integer not null default 0,
  last_attempt_at timestamptz,
  created_at      timestamptz not null default now()
);
create index pending_emails_drain_idx on public.pending_emails(status, attempts);

-- =============================================================================
-- RLS — enable on every table; public-read only on safe catalog tables.
-- =============================================================================
alter table public.cultures          enable row level security;
alter table public.occasion_types    enable row level security;
alter table public.collections       enable row level security;
alter table public.designs           enable row level security;
alter table public.design_assets     enable row level security;
alter table public.orders            enable row level security;
alter table public.entitlements      enable row level security;
alter table public.processed_events  enable row level security;
alter table public.pending_emails    enable row level security;

create policy "cultures_read"       on public.cultures       for select to anon, authenticated using (true);
create policy "occasion_types_read" on public.occasion_types for select to anon, authenticated using (true);
create policy "collections_read"    on public.collections    for select to anon, authenticated using (active = true);
create policy "designs_read"        on public.designs        for select to anon, authenticated using (active = true);
-- design_assets / orders / entitlements / processed_events / pending_emails:
-- NO policies => service-role only (server). Default-deny for anon/authenticated.

-- =============================================================================
-- Atomic payment RPCs (service-role only). One transaction = idempotency +
-- mark paid + entitlement + outbox email. Mirrors payment-resilience-plan.
-- =============================================================================
create or replace function public.process_payment(
  p_provider text, p_event_id text, p_provider_ref text, p_amount integer, p_currency text
) returns text as $$
declare v_order public.orders%rowtype;
begin
  begin
    insert into public.processed_events(provider, event_id) values (p_provider, p_event_id);
  exception when unique_violation then return 'duplicate'; end;

  select * into v_order from public.orders where provider_ref = p_provider_ref for update;
  if not found then return 'order_not_found'; end if;
  if v_order.status = 'paid' then return 'already_paid'; end if;
  if v_order.amount <> p_amount or lower(v_order.currency) <> lower(p_currency) then return 'amount_mismatch'; end if;

  update public.orders set status = 'paid', paid_at = now() where id = v_order.id;
  insert into public.entitlements(order_id, design_id) values (v_order.id, v_order.design_id)
    on conflict (order_id, design_id) do nothing;
  if v_order.email is not null then
    insert into public.pending_emails(order_id, to_email, subject, body)
    values (v_order.id, v_order.email, 'Your invitation is ready to download',
            'Your premium invitation is ready. Download: {{DOWNLOAD_URL}}');
  end if;
  return 'ok';
end; $$ language plpgsql security definer;

create or replace function public.revoke_payment(
  p_provider text, p_event_id text, p_provider_ref text
) returns text as $$
declare v_order public.orders%rowtype;
begin
  begin
    insert into public.processed_events(provider, event_id) values (p_provider, p_event_id);
  exception when unique_violation then return 'duplicate'; end;
  select * into v_order from public.orders where provider_ref = p_provider_ref;
  if not found then return 'order_not_found'; end if;
  update public.orders set status = 'refunded' where id = v_order.id;
  update public.entitlements set revoked = true where order_id = v_order.id;
  return 'ok';
end; $$ language plpgsql security definer;

revoke all on function public.process_payment(text,text,text,integer,text) from public, anon, authenticated;
revoke all on function public.revoke_payment(text,text,text)            from public, anon, authenticated;

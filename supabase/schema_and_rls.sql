-- =============================================================================
--  Supabase schema + Row Level Security
--  Run in Supabase SQL editor. RLS is default-DENY: a table with RLS on and no
--  matching policy is unreadable/unwritable by anon/authenticated. Only the
--  service_role key (server-only) bypasses RLS.
-- =============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- designs : public catalog. Safe columns ONLY. No clean master path here.
-- ---------------------------------------------------------------------------
create table if not exists public.designs (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,
  name          text not null,                 -- keyword caption
  collection    text not null,                 -- e.g. 'sukhmani-sahib-path'
  is_premium    boolean not null default false,
  price_usd     integer not null default 0,    -- cents
  price_inr     integer not null default 0,    -- paise
  preview_url   text not null,                 -- PUBLIC bucket (free: clean; premium: low-res/watermarked)
  text_fields   jsonb not null default '[]',   -- [{id,label,xPct,yPct,fontFamily,fontSizePct,color,textAlign,maxWidthPct}]
  width         integer not null default 3000,
  height        integer not null default 4000,
  lang          text,
  tags          text[] not null default '{}',
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- design_assets : the CLEAN high-res master path (private R2). NO anon access.
-- ---------------------------------------------------------------------------
create table if not exists public.design_assets (
  design_id   uuid primary key references public.designs(id) on delete cascade,
  master_key  text not null      -- object key in the PRIVATE R2 bucket
);

-- ---------------------------------------------------------------------------
-- orders : one per checkout. NO anon access at all.
-- ---------------------------------------------------------------------------
create table if not exists public.orders (
  id            uuid primary key default gen_random_uuid(),
  order_token   text unique not null,          -- 256-bit random, used by client for status/download
  design_id     uuid not null references public.designs(id),
  email         text,
  amount        integer not null,              -- minor units, copied from designs at creation
  currency      text not null,                 -- 'usd' | 'inr'
  provider      text not null,                 -- 'stripe' | 'razorpay'
  provider_ref  text,                          -- PaymentIntent id / Razorpay order id
  status        text not null default 'pending'
                check (status in ('pending','paid','failed','refunded')),
  created_at    timestamptz not null default now(),
  paid_at       timestamptz
);
create index if not exists orders_token_idx on public.orders(order_token);
create index if not exists orders_ref_idx   on public.orders(provider_ref);

-- ---------------------------------------------------------------------------
-- entitlements : what an order unlocks. Written ONLY by webhook (service role).
-- ---------------------------------------------------------------------------
create table if not exists public.entitlements (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders(id) on delete cascade,
  design_id   uuid not null references public.designs(id),
  granted_at  timestamptz not null default now(),
  revoked     boolean not null default false,
  unique(order_id, design_id)
);

-- ---------------------------------------------------------------------------
-- processed_events : webhook idempotency. Service role only.
-- ---------------------------------------------------------------------------
create table if not exists public.processed_events (
  provider   text not null,
  event_id   text not null,
  seen_at    timestamptz not null default now(),
  primary key (provider, event_id)
);

-- =============================================================================
--  RLS
-- =============================================================================
alter table public.designs          enable row level security;
alter table public.design_assets    enable row level security;
alter table public.orders           enable row level security;
alter table public.entitlements     enable row level security;
alter table public.processed_events enable row level security;

-- designs: anyone may READ active designs. (No insert/update/delete for anon.)
drop policy if exists "designs_public_read" on public.designs;
create policy "designs_public_read"
  on public.designs for select
  to anon, authenticated
  using (active = true);

-- design_assets / orders / entitlements / processed_events:
-- NO policies created => anon & authenticated get nothing. Only service_role
-- (server) can read/write, because service_role bypasses RLS.

-- (Optional, later) If you add magic-link accounts and a "my downloads" page,
-- add a narrow policy joining entitlements -> orders.email = auth.jwt()->>'email'.
-- Keep it READ-only and email-scoped. Until then, leave closed.

-- ---------------------------------------------------------------------------
-- pointer to the latest rendered file for an order (set by /api/render)
-- + payment-resilience columns (idempotency, reconciliation, expiry)
-- ---------------------------------------------------------------------------
alter table public.orders add column if not exists rendered_key text;
alter table public.orders add column if not exists attempt_key uuid;
alter table public.orders add column if not exists reconciliation_attempts integer not null default 0;
alter table public.orders add column if not exists expires_at timestamptz;
create unique index if not exists orders_attempt_key_uidx on public.orders(attempt_key) where attempt_key is not null;

-- ---------------------------------------------------------------------------
-- pending_emails : outbox so webhooks never block on email delivery.
-- Written inside process_payment; drained by the send-emails cron. No anon.
-- ---------------------------------------------------------------------------
create table if not exists public.pending_emails (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid references public.orders(id) on delete cascade,
  to_email        text not null,
  subject         text not null,
  body            text not null,           -- may contain {{DOWNLOAD_URL}} placeholder
  status          text not null default 'pending' check (status in ('pending','processing','sent','failed')),
  attempts        integer not null default 0,
  last_attempt_at timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists pending_emails_drain_idx on public.pending_emails(status, attempts);
alter table public.pending_emails enable row level security;  -- no policies => service-role only

-- =============================================================================
--  Atomic payment processing (called ONLY by the webhook via service role).
--  Whole function = one transaction: idempotency + mark paid + grant entitlement
--  either all commit or all roll back. Fixes the non-atomic webhook gap.
-- =============================================================================
create or replace function public.process_payment(
  p_provider     text,
  p_event_id     text,
  p_provider_ref text,
  p_amount       integer,
  p_currency     text
) returns text as $$
declare
  v_order public.orders%rowtype;
begin
  -- idempotency: a duplicate webhook delivery stops here
  begin
    insert into public.processed_events(provider, event_id) values (p_provider, p_event_id);
  exception when unique_violation then
    return 'duplicate';
  end;

  select * into v_order from public.orders where provider_ref = p_provider_ref for update;
  if not found then return 'order_not_found'; end if;
  if v_order.status = 'paid' then return 'already_paid'; end if;
  -- re-verify the money against our own record before granting anything
  if v_order.amount <> p_amount or lower(v_order.currency) <> lower(p_currency) then
    return 'amount_mismatch';
  end if;

  update public.orders set status = 'paid', paid_at = now() where id = v_order.id;
  insert into public.entitlements(order_id, design_id)
    values (v_order.id, v_order.design_id)
    on conflict (order_id, design_id) do nothing;

  -- Outbox: enqueue the download email in the SAME transaction (only if we have one).
  -- The send-emails cron replaces {{DOWNLOAD_URL}} with SITE_URL + /api/download/<token>.
  if v_order.email is not null then
    insert into public.pending_emails(order_id, to_email, subject, body)
    values (v_order.id, v_order.email,
            'Your invitation is ready to download',
            'Thank you! Your premium invitation is ready. Download it here: {{DOWNLOAD_URL}} (link is re-issued each visit and is private to you).');
  end if;

  return 'ok';
end;
$$ language plpgsql security definer;

create or replace function public.revoke_payment(
  p_provider text, p_event_id text, p_provider_ref text
) returns text as $$
declare v_order public.orders%rowtype;
begin
  begin
    insert into public.processed_events(provider, event_id) values (p_provider, p_event_id);
  exception when unique_violation then
    return 'duplicate';
  end;
  select * into v_order from public.orders where provider_ref = p_provider_ref;
  if not found then return 'order_not_found'; end if;
  update public.orders set status = 'refunded' where id = v_order.id;
  update public.entitlements set revoked = true where order_id = v_order.id;
  return 'ok';
end;
$$ language plpgsql security definer;

-- Only the server (service_role) may execute these; anon/authenticated cannot.
revoke all on function public.process_payment(text,text,text,integer,text) from public, anon, authenticated;
revoke all on function public.revoke_payment(text,text,text)            from public, anon, authenticated;

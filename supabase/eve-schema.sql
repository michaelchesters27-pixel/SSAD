-- EVE Market Pulse Engine
-- Run this once in Supabase SQL Editor before deploying Netlify.

create extension if not exists pgcrypto;

create table if not exists public.eve_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  changed_by text
);

create table if not exists public.eve_markets (
  id bigserial primary key,
  symbol text not null unique,
  display_name text not null,
  asset_class text not null check (asset_class in ('forex', 'metal', 'crypto')),
  enabled boolean not null default true,
  scan_priority int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.eve_scan_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  mode text not null default 'starting',
  scanner_enabled boolean not null default true,
  source text not null default 'scheduled',
  markets_requested int not null default 0,
  markets_scanned int not null default 0,
  markets_open int not null default 0,
  top_symbol text,
  notes text,
  errors jsonb not null default '[]'::jsonb
);

create table if not exists public.eve_market_scores (
  id bigserial primary key,
  scan_id uuid not null references public.eve_scan_runs(id) on delete cascade,
  symbol text not null,
  display_name text not null,
  asset_class text not null check (asset_class in ('forex', 'metal', 'crypto')),
  is_open boolean not null default false,
  is_stale boolean not null default false,
  rank int,
  bias text not null,
  bias_score numeric not null default 0,
  score numeric not null default 0,
  status text not null,
  reason text,
  h1_score numeric,
  m15_score numeric,
  m5_score numeric,
  momentum_score numeric,
  volatility_score numeric,
  cleanliness_score numeric,
  session_score numeric,
  latest_candle_at timestamptz,
  latest_price numeric,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists eve_scan_runs_started_at_idx
  on public.eve_scan_runs(started_at desc);

create index if not exists eve_market_scores_scan_id_idx
  on public.eve_market_scores(scan_id);

create index if not exists eve_market_scores_symbol_created_idx
  on public.eve_market_scores(symbol, created_at desc);

alter table public.eve_market_scores
  add column if not exists latest_price numeric;

create table if not exists public.eve_price_alarms (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  target_price numeric not null,
  trigger_direction text not null check (trigger_direction in ('above', 'below')),
  label text,
  is_active boolean not null default true,
  is_triggered boolean not null default false,
  triggered_at timestamptz,
  acknowledged_at timestamptz,
  last_checked_price numeric,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists eve_price_alarms_symbol_active_idx
  on public.eve_price_alarms(symbol, is_active, is_triggered);

create index if not exists eve_price_alarms_triggered_idx
  on public.eve_price_alarms(is_triggered, acknowledged_at, created_at desc);

insert into public.eve_settings (key, value, updated_at, changed_by)
values ('scanner_enabled', 'true'::jsonb, now(), 'setup')
on conflict (key) do update set value = excluded.value, updated_at = now(), changed_by = 'setup';

insert into public.eve_markets (symbol, display_name, asset_class, enabled, scan_priority)
values
  ('XAU/USD', 'Gold', 'metal', true, 1),
  ('XAG/USD', 'Silver', 'metal', true, 2),
  ('EUR/USD', 'Euro / Dollar', 'forex', true, 3),
  ('GBP/USD', 'Pound / Dollar', 'forex', true, 4),
  ('USD/JPY', 'Dollar / Yen', 'forex', true, 5),
  ('AUD/USD', 'Aussie / Dollar', 'forex', true, 6),
  ('USD/CAD', 'Dollar / Cad', 'forex', true, 7),
  ('EUR/JPY', 'Euro / Yen', 'forex', true, 8),
  ('GBP/JPY', 'Pound / Yen', 'forex', true, 9),
  ('BTC/USD', 'Bitcoin', 'crypto', true, 10),
  ('ETH/USD', 'Ethereum', 'crypto', true, 11),
  ('SOL/USD', 'Solana', 'crypto', true, 12)
on conflict (symbol) do update set
  display_name = excluded.display_name,
  asset_class = excluded.asset_class,
  enabled = excluded.enabled,
  scan_priority = excluded.scan_priority,
  updated_at = now();

-- Keep direct browser access closed. Netlify functions use the service role key.
alter table public.eve_settings enable row level security;
alter table public.eve_markets enable row level security;
alter table public.eve_scan_runs enable row level security;
alter table public.eve_market_scores enable row level security;
alter table public.eve_price_alarms enable row level security;

-- Service role bypasses RLS automatically, so no public policies are needed.

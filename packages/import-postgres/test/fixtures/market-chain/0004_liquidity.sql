-- Kommentar mit Umlauten: äöü, and a long explanation before the statements.
alter table public.pair_snapshots
  add column if not exists stock_a numeric not null default 0,
  add column if not exists stock_b numeric not null default 0;

alter table public.asset_rates rename column rate to reference_rate;

alter table public.asset_rates
  add column if not exists traded_volume numeric not null default 0,
  add column if not exists low_ratio numeric,
  add column if not exists high_ratio numeric;

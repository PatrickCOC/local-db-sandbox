alter table public.asset_rates
  add column if not exists input_volume numeric not null default 0,
  add column if not exists output_volume numeric not null default 0;

alter table public.asset_rates drop column if exists traded_volume;

-- Synthetic chain with the shape of a Supabase project's migrations: tables,
-- row level security, policies, a scheduled job, renames, and a seed row.
-- It belongs to no application.
create table if not exists public.assets (
  id text primary key,
  label text not null,
  image_url text
);

create table if not exists public.asset_rates (
  from_asset text not null references public.assets(id) on delete cascade,
  to_asset text not null references public.assets(id) on delete cascade,
  rate numeric not null,
  updated_at timestamptz not null default now(),
  primary key (from_asset, to_asset)
);

alter table public.assets enable row level security;
alter table public.asset_rates enable row level security;

create policy "Public read access to assets"
  on public.assets for select to anon using (true);

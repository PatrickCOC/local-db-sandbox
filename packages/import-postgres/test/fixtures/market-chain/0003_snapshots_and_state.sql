create table if not exists public.pair_snapshots (
  hour_ts timestamptz not null,
  item_a text not null,
  item_b text not null,
  volume_a numeric not null,
  volume_b numeric not null,
  primary key (hour_ts, item_a, item_b)
);

create table if not exists public.job_state (
  id int primary key default 1,
  cursor_id bigint,
  updated_at timestamptz not null default now(),
  constraint job_state_singleton check (id = 1)
);

insert into public.job_state (id, cursor_id) values (1, null) on conflict (id) do nothing;

alter table public.pair_snapshots enable row level security;
alter table public.job_state enable row level security;

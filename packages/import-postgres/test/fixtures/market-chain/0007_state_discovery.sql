alter table public.job_state
  add column if not exists label_found_at timestamptz,
  add column if not exists label_source text;

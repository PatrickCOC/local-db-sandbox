alter table public.job_state add column if not exists label text;

create policy "Public read access to job_state"
  on public.job_state for select to anon using (true);

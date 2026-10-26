create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Calls a function every 20 minutes. The URL and key come from the vault.
select cron.schedule(
  'refresh-every-20-min',
  '*/20 * * * *',
  $$ select net.http_post(url := 'https://example.invalid/refresh', body := '{}'::jsonb); $$
);

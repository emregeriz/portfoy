-- =====================================================================
-- Günlük otomatik fiyat güncellemesi (isteğe bağlı)
--
-- Edge Function kurulduktan SONRA çalıştır. Elle güncellemek yeterliyse
-- bu dosyayı hiç çalıştırmadan da uygulama çalışır — dashboard'daki
-- "↻ Fiyatları güncelle" düğmesi aynı işi yapar.
--
-- ÖNCE: Dashboard → Database → Extensions → pg_cron ve pg_net'i aç.
-- =====================================================================

-- ---------------------------------------------------------------- 1
-- Service role anahtarını Vault'a koy (SQL metninde açıkta durmasın).
-- <SERVICE_ROLE_KEY> yerine Settings → API Keys → service_role değerini yaz.
select vault.create_secret('<SERVICE_ROLE_KEY>', 'service_role_key');

-- ---------------------------------------------------------------- 2
-- Hafta içi 19:00 TR (16:00 UTC) — TCMB 15:30'da, fonlar akşam yayınlanır.
select cron.schedule(
  'fetch-prices-daily',
  '0 16 * * 1-5',
  $cron$
  select net.http_post(
    url     := 'https://wihfycgxdvazhgnnprhz.supabase.co/functions/v1/fetch-prices',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
      )
    ),
    body    := '{}'::jsonb
  );
  $cron$
);

-- ---------------------------------------------------------------- 3
-- Kontrol / bakım
--   select * from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 10;
--   select cron.unschedule('fetch-prices-daily');

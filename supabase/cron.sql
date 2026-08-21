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
--
-- DİKKAT: Buraya Supabase'in **service_role** anahtarı girer —
-- Settings → API Keys → service_role. Resend ya da başka bir servisin
-- anahtarı DEĞİL. Cron, Edge Function'ı bu anahtarla çağırıp kimlik
-- doğrulamasından geçiyor; yanlış anahtar 401 verir ve hatırlatma hiç
-- çalışmaz. Resend anahtarı Edge Function secret'ında duruyor, buraya
-- yazılmaz.
--
-- Çalıştırmadan önce aşağıdaki yer tutucuyu gerçek değerle değiştir,
-- çalıştırdıktan sonra dosyaya geri koy — bu dosya depoya gidiyor.
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

-- ---------------------------------------------------------------- 2b
-- Halka arz sabah çekimi — hafta içi 10:01 TR (07:01 UTC)
--
-- Yeni halka arzın ilk işlem günü seansla birlikte açılır; akşamki çekimi
-- beklemeden değeri görmek için sabah bir tur daha atılır. Uygulamada bir
-- arza "ilk işlem günü" tarihi girdiysen, o sabah fiyatı hazır bulursun.
select cron.schedule(
  'fetch-prices-morning',
  '1 7 * * 1-5',
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

-- ---------------------------------------------------------------- 4
-- Borç & fatura hatırlatma maili — her sabah 08:00 TR (05:00 UTC)
-- Vadesi bugün ya da yarın olan ödemeleri tek mailde toplar.
select cron.schedule(
  'debt-reminders-daily',
  '0 5 * * *',
  $cron$
  select net.http_post(
    url     := 'https://wihfycgxdvazhgnnprhz.supabase.co/functions/v1/debt-reminders',
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

-- ---------------------------------------------------------------- 5
-- Serbest hatırlatıcılar — 15 dakikada bir; saati gelenler gönderilir
select cron.schedule(
  'custom-reminders-quarterly',
  '*/15 * * * *',
  $cron$
  select net.http_post(
    url     := 'https://wihfycgxdvazhgnnprhz.supabase.co/functions/v1/custom-reminders',
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

-- ---------------------------------------------------------------- 5
-- halkarz.com arz takvimi — günde 3 kez (09:30 / 13:30 / 19:30 TR)
--
-- Önce supabase/halkarz.sql çalıştırılmış ve fetch-halkarz fonksiyonu
-- deploy edilmiş olmalı. Arayüzdeki "Yenile" düğmesi aynı işi elle yapar.
select cron.schedule(
  'fetch-halkarz-daily',
  '30 6,10,16 * * *',
  $cron$
  select net.http_post(
    url     := 'https://wihfycgxdvazhgnnprhz.supabase.co/functions/v1/fetch-halkarz',
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

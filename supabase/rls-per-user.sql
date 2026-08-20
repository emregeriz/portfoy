-- =====================================================================
-- Kullanıcı izolasyonu — herkes yalnızca kendi verisini görür
--
-- Kurulumda okuma politikası "giriş yapan herkes okur" (using true)
-- şeklindeydi; veri yalnızca uygulama tarafında filtreleniyordu. Bu dosya
-- filtreyi veritabanına taşır: artık başka bir kullanıcının hesapları,
-- işlemleri, arzları, borçları görünmez — uygulama ne sorarsa sorsun.
--
-- Yazma politikaları (insert/update/delete = auth.uid() = user_id) zaten
-- kişiye özeldi, onlara dokunulmuyor.
--
-- Edge Function'lar service_role ile bağlandığı için RLS'i baypas eder;
-- hatırlatma mailleri ve fiyat çekimi bu değişiklikten etkilenmez.
-- =====================================================================

-- ---------------------------------------------------------------- 1
-- user_id taşıyan tablolar: yalnızca kendi satırların
do $do$
declare t text;
begin
  foreach t in array array[
    'accounts', 'snapshots', 'positions', 'liabilities', 'receivables',
    'transactions', 'ipos', 'ipo_entries', 'ipo_participations',
    'account_ledger', 'trades', 'takip_entries', 'takip_items',
    'gelir_gider', 'reminders', 'user_mail_keys'
  ]
  loop
    -- Tablo yoksa (eski kurulum) atla
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists read_all_authenticated on public.%I;', t);
    execute format('drop policy if exists read_own on public.%I;', t);
    execute format(
      'create policy read_own on public.%I for select to authenticated using (auth.uid() = user_id);', t
    );
  end loop;
end $do$;

-- ---------------------------------------------------------------- 2
-- assets: ortak sembol kataloğu + kendi eklediklerin
--
-- user_id NULL olan satırlar herkese açık katalogdur (fiyat otomasyonu
-- bunları kullanır). Kendi eklediğin semboller yalnızca sana görünür.
alter table public.assets enable row level security;
drop policy if exists read_all_authenticated on public.assets;
drop policy if exists read_own on public.assets;
create policy read_own on public.assets for select to authenticated
  using (user_id is null or auth.uid() = user_id);

-- ---------------------------------------------------------------- 3
-- profiles: yalnızca kendi profilin (id = auth.uid())
alter table public.profiles enable row level security;
drop policy if exists read_all_authenticated on public.profiles;
drop policy if exists read_own on public.profiles;
create policy read_own on public.profiles for select to authenticated
  using (auth.uid() = id);

-- ---------------------------------------------------------------- 4
-- asset_prices ve fx_rates piyasa verisidir, kişiye özel değildir —
-- okuma herkese açık kalır. (Yazma yalnızca Edge Function'da.)

-- ---------------------------------------------------------------- 5
-- Kontrol: hepsi "auth.uid() = user_id" olmalı
--   select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid)
--   from pg_policy p join pg_class c on c.oid = p.polrelid
--   where p.polcmd = 'r' order by 1;

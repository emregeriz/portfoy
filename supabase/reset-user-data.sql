-- =====================================================================
-- SIFIRLAMA — yalnızca emregeriz@hotmail.com kullanıcısının verisi
-- Diğer profiller (admin, alperbuber800) etkilenmez.
-- DİKKAT: Geri alınamaz. Supabase SQL Editor'de çalıştır.
-- =====================================================================

-- ---------- ADIM 1: ÖNİZLEME (önce bunu tek başına çalıştır) ---------
-- Ne silineceğini gösterir, hiçbir şeyi silmez.
with u as (select id from auth.users where email = 'emregeriz@hotmail.com')
select 'accounts' as tablo, count(*) from public.accounts       where user_id = (select id from u)
union all select 'assets',              count(*) from public.assets             where user_id = (select id from u)
union all select 'snapshots',           count(*) from public.snapshots          where user_id = (select id from u)
union all select 'positions',           count(*) from public.positions          where user_id = (select id from u)
union all select 'liabilities',         count(*) from public.liabilities        where user_id = (select id from u)
union all select 'receivables',         count(*) from public.receivables        where user_id = (select id from u)
union all select 'transactions',        count(*) from public.transactions       where user_id = (select id from u)
union all select 'ipo_participations',  count(*) from public.ipo_participations where user_id = (select id from u)
union all select 'ipos',                count(*) from public.ipos               where user_id = (select id from u)
union all select 'ipo_entries',         count(*) from public.ipo_entries        where user_id = (select id from u)
union all select 'account_ledger',      count(*) from public.account_ledger     where user_id = (select id from u)
union all select 'takip_entries',       count(*) from public.takip_entries      where user_id = (select id from u)
union all select 'takip_items',         count(*) from public.takip_items        where user_id = (select id from u)
union all select 'gelir_gider',         count(*) from public.gelir_gider        where user_id = (select id from u)
union all select 'reminders',           count(*) from public.reminders          where user_id = (select id from u)
order by 1;


-- ---------- ADIM 2: SİLME (önizlemeyi onayladıktan sonra) ------------
do $$
declare
  uid uuid;
  n   int;
begin
  select id into uid from auth.users where email = 'emregeriz@hotmail.com';
  if uid is null then
    raise exception 'Kullanıcı bulunamadı: emregeriz@hotmail.com — hiçbir şey silinmedi.';
  end if;
  raise notice 'Hedef kullanıcı: %', uid;

  -- Çocuk kayıtlar önce (FK sırası)
  delete from public.positions          where user_id = uid; get diagnostics n = row_count; raise notice 'positions: %', n;
  delete from public.liabilities        where user_id = uid; get diagnostics n = row_count; raise notice 'liabilities: %', n;
  delete from public.receivables        where user_id = uid; get diagnostics n = row_count; raise notice 'receivables: %', n;
  delete from public.transactions       where user_id = uid; get diagnostics n = row_count; raise notice 'transactions: %', n;
  delete from public.ipo_participations where user_id = uid; get diagnostics n = row_count; raise notice 'ipo_participations: %', n;
  delete from public.ipo_entries        where user_id = uid; get diagnostics n = row_count; raise notice 'ipo_entries: %', n;
  delete from public.account_ledger     where user_id = uid; get diagnostics n = row_count; raise notice 'account_ledger: %', n;
  delete from public.ipos               where user_id = uid; get diagnostics n = row_count; raise notice 'ipos: %', n;
  delete from public.snapshots          where user_id = uid; get diagnostics n = row_count; raise notice 'snapshots: %', n;
  delete from public.takip_entries      where user_id = uid; get diagnostics n = row_count; raise notice 'takip_entries: %', n;
  delete from public.takip_items        where user_id = uid; get diagnostics n = row_count; raise notice 'takip_items: %', n;
  delete from public.gelir_gider        where user_id = uid; get diagnostics n = row_count; raise notice 'gelir_gider: %', n;
  delete from public.reminders          where user_id = uid; get diagnostics n = row_count; raise notice 'reminders: %', n;

  -- Tanımlar
  delete from public.accounts           where user_id = uid; get diagnostics n = row_count; raise notice 'accounts: %', n;
  -- Yalnızca bu kullanıcıya ait varlıklar; user_id NULL olan ortak semboller korunur
  delete from public.assets             where user_id = uid; get diagnostics n = row_count; raise notice 'assets: %', n;

  raise notice 'Bitti — kullanıcı hesabı ve giriş bilgileri korundu.';
end $$;


-- ---------- ADIM 3: DOĞRULAMA ----------------------------------------
-- ADIM 1'deki önizlemeyi tekrar çalıştır; tüm sayılar 0 olmalı.

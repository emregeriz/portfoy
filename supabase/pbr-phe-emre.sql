-- =====================================================================
-- Emre hesabının kapanmış fon pozisyonları — PBR ve PHE
--
-- Kaynak: aracı kurumun emir detayı ekranları. Her satır bir gerçekleşen
-- emir: gerçekleşme tarihi, pay adedi ve gerçekleşen birim fiyat. Tutar
-- ekranda yazan "Toplam" ile birebir aynı (pay × fiyat).
--
-- Bu dosya tek başına yeter: gereken tax_rate kolonunu da açar. PHE hisse
-- senedi yoğun fon olduğu için stopajı 0'a çekilir, PBR değişken fon olduğu
-- için varsayılan orandan (%17,5) vergilenir.
--
-- Tekrar çalıştırılabilir: aynı hesaptaki PBR/PHE işlemleri silinip
-- yeniden yazılır. Nakit defterine (account_ledger) dokunulmaz — iki
-- pozisyon da kapandığı için parası zaten hesapta.
-- =====================================================================
-- Kalem bazlı stopaj kolonu — fon-stopaj.sql çalıştırılmadıysa burada açılır
alter table public.assets
  add column if not exists tax_rate numeric;

do $seed$
declare
  acc uuid;
  accname text;
  uid uuid;
  pbr uuid;
  phe uuid;
begin
  select a.id, a.user_id, a.name into acc, uid, accname
  from public.accounts a
  where a.name ilike '%emre%'
  order by a.is_active desc, a.created_at
  limit 1;

  if uid is null then
    select p.id into uid from public.profiles p where p.display_name ilike '%emre%' limit 1;
  end if;

  if uid is null then
    raise exception 'Adında "emre" geçen hesap ya da profil yok. Önce Hesaplar sayfasından hesabı ekle.';
  end if;

  -- Semboller ortak katalogda tutulur (user_id = null)
  select id into pbr from public.assets where upper(symbol) = 'PBR' and user_id is null;
  if pbr is null then
    insert into public.assets (symbol, name, kind, user_id, tax_rate)
    values ('PBR', 'Pusula Portföy Birinci Değişken Fon', 'fon', null, null)
    returning id into pbr;
  else
    -- Oranına dokunulmaz; elle değiştirilmişse öyle kalsın
    update public.assets set kind = 'fon', name = coalesce(name, 'Pusula Portföy Birinci Değişken Fon')
    where id = pbr;
  end if;

  select id into phe from public.assets where upper(symbol) = 'PHE' and user_id is null;
  if phe is null then
    insert into public.assets (symbol, name, kind, user_id, tax_rate)
    values ('PHE', 'Pusula Portföy Hisse Senedi Fonu', 'fon', null, 0)
    returning id into phe;
  else
    -- Hisse senedi yoğun fon: stopaj yok
    update public.assets
    set kind = 'fon', name = coalesce(name, 'Pusula Portföy Hisse Senedi Fonu'), tax_rate = 0
    where id = phe;
  end if;

  delete from public.trades
  where asset_id in (pbr, phe)
    and user_id = uid
    and account_id is not distinct from acc;

  insert into public.trades
    (user_id, account_id, asset_id, side, trade_date, quantity, unit_price, amount, note)
  values
    -- Pusula Portföy Birinci Değişken Fon (stopajlı)
    (uid, acc, pbr, 'alis',  '2026-03-10',  8015, 3.246684, 26022.17226,  'emir detayından'),
    (uid, acc, pbr, 'alis',  '2026-03-26',  5766, 3.468293, 19998.177438, 'emir detayından'),
    (uid, acc, pbr, 'satis', '2026-04-22', 13781, 3.731,    51416.911,    'emir detayından'),
    (uid, acc, pbr, 'alis',  '2026-04-28', 12863, 3.887048, 49999.098424, 'emir detayından'),
    (uid, acc, pbr, 'alis',  '2026-06-29',  3930, 5.088827, 19999.09011,  'emir detayından'),
    (uid, acc, pbr, 'satis', '2026-08-03', 16793, 5.411567, 90876.444631, 'emir detayından'),
    -- Pusula Portföy Hisse Senedi Fonu (stopajsız)
    (uid, acc, phe, 'alis',  '2026-03-10', 11064, 2.351917, 26021.609688, 'emir detayından'),
    (uid, acc, phe, 'alis',  '2026-03-27',  7805, 2.562147, 19997.557335, 'emir detayından'),
    (uid, acc, phe, 'satis', '2026-04-22', 18869, 2.828791, 53376.457379, 'emir detayından'),
    (uid, acc, phe, 'alis',  '2026-04-28', 17506, 2.856028, 49997.626168, 'emir detayından'),
    (uid, acc, phe, 'satis', '2026-08-03', 17506, 3.818508, 66846.801048, 'emir detayından');

  raise notice 'PBR + PHE: 11 işlem yazıldı. Hesap: %', coalesce(accname, 'seçilmedi (hesapsız yazıldı)');
end $seed$;

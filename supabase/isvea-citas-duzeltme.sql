-- =====================================================================
-- Defter düzeltmesi — hesabı yanlış yazılmış / çift girilmiş iki kayıt
-- Supabase SQL Editor'de tek seferde çalıştır. Bir kez çalışması yeter.
--
-- 1) CITAS — Nablam hesabındaki 25.08 satışı trades tablosuna ELLE
--    girilmiş, ama aynı satış Halka Arz modülünde de duruyor
--    (ipo_entries: 32 lot @ 114,70). ipoTrades.ts arz paylarını zaten
--    sanal işleme çeviriyor; elle girilen satır gerçekleşen kârı ve
--    nakdi çift sayıyor, ayrıca alışı olmadığı için hesapta −32 adet
--    "eksik alım" bırakıyor. Nakit hareketi trade_id'ye bağlı olduğu
--    için satırla birlikte kendiliğinden siliniyor.
--
-- 2) ISVEA — 10.07'de beş hesaba 47'şer lot alış girilmiş, ama satışların
--    biri Garanti BBVA'da: o hesapta hiç alış yok, Annem'de ise hiç satış
--    yok. Sembol toplamı 235−235=0 çıktığı için ISVEA günlük kâr
--    listesinden tamamen düşüyordu. Eksik olan Garanti BBVA alışıdır;
--    diğer dördüyle aynı gün ve aynı arz fiyatından girilir. Annem'in
--    47 lotu böylece açık pozisyon olarak görünür.
--    İçe aktarılan alışlar nakde işlenmez (bkz. trade-cash.sql), bu
--    yüzden account_ledger'a satır yazılmaz.
-- =====================================================================

begin;

delete from public.trades
where user_id   = '257baf6f-3d32-4448-a5bb-107e1202e8da'
  and asset_id  = (select id from public.assets where symbol = 'CITAS')
  and side      = 'satis'
  and trade_date = date '2026-08-25'
  and quantity  = 32
  and unit_price = 114.7;

insert into public.trades
  (user_id, account_id, asset_id, side, trade_date, quantity, unit_price, amount, currency, fx_rate, note)
select '257baf6f-3d32-4448-a5bb-107e1202e8da',
       acc.id,
       ast.id,
       'alis',
       date '2026-07-10',
       47,
       20.9,
       982.3,
       'TRY',
       1,
       'Ekstre görselinden içe aktarıldı'
from public.accounts acc,
     public.assets ast
where acc.user_id = '257baf6f-3d32-4448-a5bb-107e1202e8da'
  and acc.name    = 'Garanti BBVA'
  and ast.symbol  = 'ISVEA'
  -- İki kez çalıştırılırsa ikinci alışı eklemesin
  and not exists (
    select 1 from public.trades t
    where t.user_id = acc.user_id
      and t.account_id = acc.id
      and t.asset_id = ast.id
      and t.side = 'alis'
  );

commit;

-- Doğrulama: her iki sembol de hesap bazında sıfırın altına düşmemeli
select a.symbol,
       acc.name as hesap,
       sum(case when t.side = 'alis' then t.quantity else -t.quantity end) as net_adet
from public.trades t
join public.assets a on a.id = t.asset_id
left join public.accounts acc on acc.id = t.account_id
where t.user_id = '257baf6f-3d32-4448-a5bb-107e1202e8da'
  and a.symbol in ('ISVEA', 'CITAS')
group by a.symbol, acc.name
having sum(case when t.side = 'alis' then t.quantity else -t.quantity end) <> 0
order by a.symbol, acc.name;

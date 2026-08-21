-- =====================================================================
-- Alım/satım ↔ hesap nakiti bağı (halka arz hesapları)
--
-- Halka arz hesabında yapılan satış, tutarı hesabın nakit defterine
-- yazar (+); alış nakitten düşer (−). Böylece hisse satınca para
-- kaybolmaz: hesap bakiyesinde ve toplam varlıkta nakit olarak durur,
-- "Para aktar" ile çekilince azalır.
--
-- Hareket trade kaydına bağlıdır: işlem silinince para hareketi de
-- kendiliğinden gider (on delete cascade), düzenlenince güncellenir.
--
-- Kurulum: SQL Editor'de bir kez çalıştır. Sondaki backfill, geçmişte
-- yapılmış (henüz nakde yazılmamış) satışların parasını da hesaba işler.
-- =====================================================================

-- 1) Hareketi işlem kaydına bağlayan kolon
alter table public.account_ledger
  add column if not exists trade_id uuid references public.trades(id) on delete cascade;

-- Bir işlemin tek bir nakit hareketi olur (upsert bunun üstünden çalışır)
create unique index if not exists account_ledger_trade_uidx
  on public.account_ledger(trade_id);

-- 2) Yeni tür: 'alim' — hisse/fon alışının nakitten düşmesi (−)
alter table public.account_ledger
  drop constraint if exists account_ledger_kind_check;
alter table public.account_ledger
  add constraint account_ledger_kind_check
  check (kind in ('giris','iade','satis','transfer','cikis','cekim','nema','borc','tahsil','alim','diger'));

-- 3) Backfill — halka arz hesaplarındaki mevcut satışların parası
-- (bugüne kadar hiçbir yere yazılmamıştı). Alışlar bilerek işlenmez:
-- içe aktarılan pozisyonların parası geçmişte zaten yatırılmıştı.
insert into public.account_ledger (user_id, account_id, trade_id, kind, amount, date, note)
select t.user_id,
       t.account_id,
       t.id,
       'satis',
       t.amount_try,
       t.trade_date,
       coalesce(a.symbol, 'hisse') || ' satışı'
from public.trades t
join public.accounts acc on acc.id = t.account_id and acc.is_ipo
left join public.assets a on a.id = t.asset_id
where t.side = 'satis'
  and not exists (select 1 from public.account_ledger l where l.trade_id = t.id);

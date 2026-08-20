-- =====================================================================
-- Nakit hareketleri + nemalandırma
--
-- Hesaplardaki para zaten `account_ledger` üzerinde tutuluyordu (halka
-- arz iadeleri, satış gelirleri, aktarımlar). Bu dosya aynı deftere
-- elle nakit giriş/çıkışı ve günlük nema (faiz) geliri ekler.
--
-- schema.sql ve ipo.sql sonrası bir kez çalıştır.
-- =====================================================================

-- ---------------------------------------------------------------- 1
-- Hesap bazlı nemalandırma ayarı
--   nema_rate  : yıllık brüt oran, YÜZDE olarak (Midas için 34.5)
--                0 ise o hesaba faiz işlemez
--   nema_start : nemalandırmanın başladığı gün; boşsa hesabın ilk
--                para hareketinden itibaren işler
alter table public.accounts
  add column if not exists nema_rate  numeric not null default 0,
  add column if not exists nema_start date;

-- ---------------------------------------------------------------- 2
-- Hareket türlerine "giris" (elle para yatırma) ve "nema" (günlük faiz)
-- eklenir. Eski türler korunur.
alter table public.account_ledger
  drop constraint if exists account_ledger_kind_check;
alter table public.account_ledger
  add constraint account_ledger_kind_check
  check (kind in ('giris','iade','satis','transfer','cikis','cekim','nema','diger'));

-- ---------------------------------------------------------------- 3
-- Bir hesaba aynı gün için ikinci nema satırı yazılamaz.
-- Uygulama faizi tarayıcıdan işlediği için iki sekme aynı anda açıksa
-- bu indeks çift kaydı engeller.
create unique index if not exists account_ledger_nema_uniq
  on public.account_ledger(account_id, date)
  where kind = 'nema';

create index if not exists account_ledger_kind_date_idx
  on public.account_ledger(kind, date desc);

-- ---------------------------------------------------------------- 4
-- Nema dökümü — hangi hesap, hangi gün, ne kadar kazandırdı
create or replace view public.v_nema_daily
with (security_invoker = on) as
select l.user_id,
       l.account_id,
       a.name as account_name,
       l.date,
       l.amount
from public.account_ledger l
join public.accounts a on a.id = l.account_id
where l.kind = 'nema';

-- ---------------------------------------------------------------- 5
-- Bakiye görünümüne kullanıcı kırılımı
--
-- Defter "giriş yapan herkes okur" politikasıyla açık olduğu için görünüm
-- kullanıcı ayrımı yapmadan toplarsa, uygulama başkasının bakiyesini de
-- kendi nakdine ekliyordu. user_id kolonu eklenerek sorgular kendi
-- satırlarına daraltılabiliyor. (Kolon sona eklendiği için `create or
-- replace` mevcut görünümü bozmadan günceller.)
create or replace view public.v_account_balances
with (security_invoker = on) as
select account_id,
       sum(amount) as balance,
       max(date)   as last_move,
       user_id
from public.account_ledger
group by account_id, user_id;

-- ---------------------------------------------------------------- 6
-- Örnek: Midas hesabına %34,5 nemalandırma tanımla
--   update public.accounts set nema_rate = 34.5 where name ilike '%midas%';

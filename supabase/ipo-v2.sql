-- =====================================================================
-- Halka arz akışı — sürüm 2
--
-- Değişen mantık:
--   • Hesaplar ikiye ayrılır: kendi yatırım hesapların ve halka arz için
--     kullandığın hesaplar (accounts.is_ipo). Halka Arz sayfası yalnızca
--     ikincileri listeler.
--   • Arzı açarken "her hesaptan kaç lot" bir kez girilir (ipos.default_lot);
--     hesabın kutusunu işaretlemek o lotu doğrudan o hesaba yazar.
--   • Satış hesap bazlı olur: bir hesabı satıp diğerini elde tutabilirsin
--     (ipo_entries.sold_lot / sold_price / sold_date).
--
-- ipo.sql ve cash.sql sonrası bir kez çalıştır.
-- =====================================================================

-- ---------------------------------------------------------------- 1
-- Halka arz hesabı işareti
alter table public.accounts
  add column if not exists is_ipo boolean not null default false;

create index if not exists accounts_ipo_idx on public.accounts(user_id) where is_ipo;

-- ---------------------------------------------------------------- 2
-- Arz: hesap başına varsayılan talep + işlem görmeye başlama günü
alter table public.ipos
  add column if not exists default_lot       numeric,   -- her hesaptan istenen lot
  add column if not exists trade_start_date  date;      -- borsada işlem görmeye başladığı gün

-- ---------------------------------------------------------------- 3
-- Katılım: hesap bazlı satış durumu
alter table public.ipo_entries
  add column if not exists sold_lot   numeric not null default 0,
  add column if not exists sold_price numeric,
  add column if not exists sold_date  date;

-- ---------------------------------------------------------------- 4
-- Katılım görünümü — tutarlar arzın lot fiyatından türetilir,
-- satış bilgisi ve gerçekleşen kâr da burada hesaplanır.
drop view if exists public.v_ipo_entries;
create view public.v_ipo_entries
with (security_invoker = on) as
select e.id,
       e.user_id,
       e.ipo_id,
       e.account_id,
       a.name        as account_name,
       e.requested_lot,
       e.participated,
       e.allocated_lot,
       e.sold_lot,
       e.sold_price,
       e.sold_date,
       i.name        as ipo_name,
       i.bist_code,
       i.status,
       i.lot_price,
       e.requested_lot * coalesce(i.lot_price, 0)                      as requested_amount,
       e.allocated_lot * coalesce(i.lot_price, 0)                      as cost,
       greatest(e.requested_lot - e.allocated_lot, 0)
         * coalesce(i.lot_price, 0)                                    as refund,
       e.sold_lot * coalesce(e.sold_price, 0)                          as proceeds,
       -- Gerçekleşen kâr: satılan lotun satış geliri eksi o lotun maliyeti
       e.sold_lot * (coalesce(e.sold_price, 0) - coalesce(i.lot_price, 0)) as realized_profit,
       greatest(e.allocated_lot - e.sold_lot, 0)                        as open_lot
from public.ipo_entries e
join public.ipos i     on i.id = e.ipo_id
join public.accounts a on a.id = e.account_id;

-- ---------------------------------------------------------------- 5
-- Hesap bazlı halka arz özeti — hangi hesaptan ne kadar kazandım
create or replace view public.v_ipo_account_summary
with (security_invoker = on) as
select e.user_id,
       e.account_id,
       a.name as account_name,
       count(*) filter (where e.participated)              as ipo_count,
       sum(e.allocated_lot)                                as total_lot,
       sum(e.allocated_lot * coalesce(i.lot_price, 0))     as total_cost,
       sum(e.sold_lot * coalesce(e.sold_price, 0))         as total_proceeds,
       sum(e.sold_lot * (coalesce(e.sold_price, 0)
                         - coalesce(i.lot_price, 0)))      as realized_profit
from public.ipo_entries e
join public.ipos i     on i.id = e.ipo_id
join public.accounts a on a.id = e.account_id
where e.participated
group by e.user_id, e.account_id, a.name;

-- ---------------------------------------------------------------- 6
-- Geçiş: eski kayıtlarda default_lot boşsa ilk katılımın lotundan doldur
update public.ipos i
set default_lot = sub.lot
from (
  select ipo_id, max(requested_lot) as lot
  from public.ipo_entries
  where participated
  group by ipo_id
) sub
where sub.ipo_id = i.id and i.default_lot is null and sub.lot > 0;

-- ---------------------------------------------------------------- 7
-- Geçiş: arzın tamamı satılmışsa hesap satırlarını da satılmış say
update public.ipo_entries e
set sold_lot   = e.allocated_lot,
    sold_price = i.sold_price,
    sold_date  = i.sold_date
from public.ipos i
where i.id = e.ipo_id
  and i.status = 'satildi'
  and i.sold_price is not null
  and e.sold_lot = 0
  and e.allocated_lot > 0;

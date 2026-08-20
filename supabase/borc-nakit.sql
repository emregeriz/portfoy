-- =====================================================================
-- Kullanıcıya özel menü + borç verme akışının nakde bağlanması
--
--   1. profiles.nav_hidden — üst menüde hangi sayfaların gizleneceği.
--      Kullanıcı bazlı; biri Takip'i kullanırken diğerinin menüsünde
--      görünmesin diye.
--
--   2. Borç verme artık Gelir/Gider sayfasından yapılır ve **paraya
--      dokunur**: verdiğin tutar seçtiğin hesabın bakiyesinden düşer,
--      geri aldığında seçtiğin hesaba eklenir. İki hareket de
--      account_ledger'a yazılır ve alacak kaydına bağlanır.
--
-- cash.sql ve ipo-v2.sql sonrası çalıştır.
-- =====================================================================

-- ---------------------------------------------------------------- 1
-- Menüde gizlenecek sayfa anahtarları (Layout'taki NAV key'leri)
alter table public.profiles
  add column if not exists nav_hidden text[] not null default '{}';

-- ---------------------------------------------------------------- 2
-- Alacak: parayı hangi hesaptan verdim, hangi hesaba geri aldım
alter table public.receivables
  add column if not exists account_id           uuid references public.accounts(id) on delete set null,
  add column if not exists collected_account_id uuid references public.accounts(id) on delete set null;

-- ---------------------------------------------------------------- 3
-- Defter: borç verme (-) ve tahsilat (+) türleri
--   borc   : birine borç verdim, para hesaptan çıktı        (-)
--   tahsil : verdiğim borcu geri aldım, para hesaba girdi   (+)
alter table public.account_ledger
  drop constraint if exists account_ledger_kind_check;
alter table public.account_ledger
  add constraint account_ledger_kind_check
  check (kind in ('giris','iade','satis','transfer','cikis','cekim','nema','borc','tahsil','diger'));

-- Hareketi alacak kaydına bağlar; kayıt silinince hareketler de gider
alter table public.account_ledger
  add column if not exists receivable_id uuid references public.receivables(id) on delete cascade;

create index if not exists account_ledger_receivable_idx
  on public.account_ledger(receivable_id);

-- ---------------------------------------------------------------- 4
-- Açık alacak özeti — kime ne kadar borç verdim, hangi hesaptan
create or replace view public.v_open_receivables
with (security_invoker = on) as
select r.id,
       r.user_id,
       r.person,
       r.amount * coalesce(r.fx_rate, 1) as amount_try,
       r.given_date,
       r.expected_date,
       r.account_id,
       a.name as account_name,
       r.note
from public.receivables r
left join public.accounts a on a.id = r.account_id
where not r.is_collected;

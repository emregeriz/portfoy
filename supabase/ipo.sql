-- =====================================================================
-- Halka arz takibi — arz / hesap katılımı / para hareketleri
-- schema.sql sonrası bir kez çalıştır.
-- =====================================================================

-- ---------------------------------------------------------------- 1
-- Arzın kendisi
create table if not exists public.ipos (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  name          text not null,
  bist_code     text,                       -- borsa kodu; fiyat otomasyonu bunu kullanır
  ipo_date      date,
  lot_price     numeric,                    -- halka arz fiyatı (1 lot)
  status        text not null default 'talep_verildi'
                check (status in ('talep_verildi','dagitildi','islemde','satildi','iptal')),
  manual_price  numeric,                    -- elle ezilen güncel fiyat
  sold_date     date,
  sold_price    numeric,
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists ipos_user_idx on public.ipos(user_id, ipo_date desc);

-- ---------------------------------------------------------------- 2
-- Arz × hesap: hangi hesaptan kaç lot istendi, kaç lot düştü
create table if not exists public.ipo_entries (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  ipo_id        uuid not null references public.ipos(id) on delete cascade,
  account_id    uuid not null references public.accounts(id) on delete cascade,
  requested_lot numeric not null default 0,
  participated  boolean not null default false,   -- bu hesaptan katıldım
  allocated_lot numeric not null default 0,
  created_at    timestamptz not null default now(),
  unique (ipo_id, account_id)
);
create index if not exists ipo_entries_ipo_idx on public.ipo_entries(ipo_id);

-- ---------------------------------------------------------------- 3
-- Hesaplardaki para hareketleri
--   iade     : dağıtım sonrası geri yatan tutar              (+)
--   satis    : hisse satışından gelen tutar                  (+)
--   transfer : hesaplar arası aktarma — çift kayıt, biri (-)
--              biri (+), transfer_id ile eşleşir. Para hâlâ
--              sende olduğu için toplam değişmez.
--   cikis    : para sistemden tamamen çıktı                  (-)
--   cekim    : eski tekil çekim kaydı (geriye dönük uyumluluk)
create table if not exists public.account_ledger (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  account_id  uuid not null references public.accounts(id) on delete cascade,
  ipo_id      uuid references public.ipos(id) on delete set null,
  kind        text not null check (kind in ('iade','satis','transfer','cikis','cekim','diger')),
  amount      numeric not null,              -- + giriş, - çıkış
  date        date not null default current_date,
  transfer_id uuid,                          -- aktarım çiftini eşleştirir
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists account_ledger_transfer_idx on public.account_ledger(transfer_id);
create index if not exists account_ledger_account_idx on public.account_ledger(account_id);
create index if not exists account_ledger_ipo_idx on public.account_ledger(ipo_id);

-- ---------------------------------------------------------------- 4
-- RLS: giriş yapan herkes okur, sadece kendi satırını yazar
do $do$
declare t text;
begin
  foreach t in array array['ipos','ipo_entries','account_ledger']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists read_all_authenticated on public.%I;', t);
    execute format('drop policy if exists insert_own on public.%I;', t);
    execute format('drop policy if exists update_own on public.%I;', t);
    execute format('drop policy if exists delete_own on public.%I;', t);
    execute format('create policy read_all_authenticated on public.%I for select to authenticated using (true);', t);
    execute format('create policy insert_own on public.%I for insert to authenticated with check (auth.uid() = user_id);', t);
    execute format('create policy update_own on public.%I for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);', t);
    execute format('create policy delete_own on public.%I for delete to authenticated using (auth.uid() = user_id);', t);
  end loop;
end $do$;

-- ---------------------------------------------------------------- 5
-- Hesap bakiyesi: iade + satış - çekim
create or replace view public.v_account_balances
with (security_invoker = on) as
-- Hesap tek bir kullanıcıya ait olduğu için account_id yeterli;
-- kullanıcı kırılımı gerektiğinde accounts tablosuyla birleştirilir.
select account_id,
       sum(amount) as balance,
       max(date)   as last_move
from public.account_ledger
group by account_id;

-- ---------------------------------------------------------------- 6
-- Katılım detayı — tutarlar arzın lot fiyatından türetilir
create or replace view public.v_ipo_entries
with (security_invoker = on) as
select e.id,
       e.user_id,
       e.ipo_id,
       e.account_id,
       e.requested_lot,
       e.participated,
       e.allocated_lot,
       i.name       as ipo_name,
       i.status,
       i.lot_price,
       e.requested_lot * coalesce(i.lot_price, 0)                     as requested_amount,
       e.allocated_lot * coalesce(i.lot_price, 0)                     as cost,
       greatest(e.requested_lot - e.allocated_lot, 0)
         * coalesce(i.lot_price, 0)                                   as refund
from public.ipo_entries e
join public.ipos i on i.id = e.ipo_id;

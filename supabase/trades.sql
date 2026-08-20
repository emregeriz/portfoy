-- =====================================================================
-- Alım / Satım kayıtları — her işlem ayrı satır, üst üste yazmaz.
-- Snapshot'lar "o gün portföyüm neydi" fotoğrafıdır; bu tablo ise
-- "neyi ne zaman kaçtan aldım/sattım" defteridir. İkisi bağımsızdır.
-- Supabase SQL Editor'de tek seferde çalıştır.
-- =====================================================================

create table if not exists public.trades (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  account_id  uuid references public.accounts(id) on delete set null,
  asset_id    uuid references public.assets(id) on delete set null,
  side        text not null default 'alis' check (side in ('alis','satis')),
  trade_date  date not null,
  quantity    numeric not null check (quantity > 0),
  unit_price  numeric not null check (unit_price >= 0),
  -- Gerçekleşen toplam tutar. Adet × birim fiyattan küsurat farkı
  -- olabildiği için ayrı tutulur (emir 50.000 iken gerçekleşen 49.999,69).
  amount      numeric not null check (amount >= 0),
  currency    text not null default 'TRY',
  fx_rate     numeric not null default 1,
  amount_try  numeric generated always as (amount * coalesce(fx_rate, 1)) stored,
  note        text,
  created_at  timestamptz not null default now()
);

create index if not exists trades_user_date_idx
  on public.trades(user_id, trade_date, created_at);
create index if not exists trades_asset_idx on public.trades(asset_id);

alter table public.trades enable row level security;

drop policy if exists read_all_authenticated on public.trades;
drop policy if exists insert_own on public.trades;
drop policy if exists update_own on public.trades;
drop policy if exists delete_own on public.trades;

create policy read_all_authenticated on public.trades
  for select to authenticated using (true);
create policy insert_own on public.trades
  for insert to authenticated with check (auth.uid() = user_id);
create policy update_own on public.trades
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy delete_own on public.trades
  for delete to authenticated using (auth.uid() = user_id);

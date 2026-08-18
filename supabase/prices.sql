-- =====================================================================
-- Fiyat otomasyonu — schema.sql çalıştırıldıktan SONRA bir kez çalıştır
-- =====================================================================

-- ---------------------------------------------------------------- 1
-- Varlıklara dış kaynak eşlemesi
--   price_ref  : kaynaktaki kimlik (CoinGecko id, Yahoo sembolü, fon kodu…)
--                boşsa symbol'den türetilir
--   auto_price : false ise otomasyon bu varlığa dokunmaz (elle giriş)
alter table public.assets
  add column if not exists price_ref  text,
  add column if not exists auto_price boolean not null default true;

-- ---------------------------------------------------------------- 2
-- Günlük fiyat geçmişi
create table if not exists public.asset_prices (
  id         uuid primary key default gen_random_uuid(),
  asset_id   uuid not null references public.assets(id) on delete cascade,
  date       date not null,
  price      numeric not null,
  currency   text not null default 'TRY',
  source     text,
  fetched_at timestamptz not null default now(),
  unique (asset_id, date)
);
create index if not exists asset_prices_asset_date_idx
  on public.asset_prices(asset_id, date desc);

-- ---------------------------------------------------------------- 3
-- RLS: giriş yapan herkes okur; yazma yalnızca Edge Function'a ait
-- (service_role RLS'i baypas eder, bu yüzden insert/update politikası yok)
alter table public.asset_prices enable row level security;
drop policy if exists read_all_authenticated on public.asset_prices;
create policy read_all_authenticated
  on public.asset_prices for select to authenticated using (true);

-- ---------------------------------------------------------------- 4
-- "En son fiyat" görünümleri — uygulama bunları okur
create or replace view public.v_latest_prices
with (security_invoker = on) as
select distinct on (asset_id)
       asset_id, date, price, currency, source
from public.asset_prices
order by asset_id, date desc;

create or replace view public.v_latest_fx
with (security_invoker = on) as
select distinct on (currency)
       currency, date, rate_try
from public.fx_rates
order by currency, date desc;

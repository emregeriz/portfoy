-- =====================================================================
-- Borsa eklentileri: sermaye artırımı / bölünme, temettü, otomatik arz
--
-- schema.sql, trades.sql, ipo-v2.sql ve rls-per-user.sql sonrası çalıştır.
-- =====================================================================

-- ---------------------------------------------------------------- 1
-- Şirket işlemleri — bedelsiz, bölünme, birleşme
--
-- Bunlar olmadan portföy sessizce yanlış çıkıyordu: %100 bedelsiz veren
-- bir kâğıtta eldeki adet ikiye katlanır, birim maliyet yarılanır. Alım
-- satım defteri bunu bilmediği için uygulama %50 zarar gösteriyordu.
--
-- ratio = ADET ÇARPANI. İşlem tarihinden ÖNCEKİ alışların adedi bununla
-- çarpılır, birim fiyatı bölünür; toplam maliyet değişmez.
--   %100 bedelsiz          → 2
--   %50 bedelsiz           → 1.5
--   1 lot 5 lot olacak     → 5
--   5 lot 1 lota inecek    → 0.2
create table if not exists public.corporate_actions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  asset_id    uuid not null references public.assets(id) on delete cascade,
  action_date date not null,
  kind        text not null default 'bedelsiz'
              check (kind in ('bedelsiz', 'bolunme', 'birlesme')),
  ratio       numeric not null check (ratio > 0),
  note        text,
  created_at  timestamptz not null default now(),
  -- Aynı kâğıda aynı gün aynı işlem iki kez girilmesin
  unique (user_id, asset_id, action_date, kind)
);
create index if not exists corporate_actions_user_idx
  on public.corporate_actions(user_id, asset_id, action_date);

-- ---------------------------------------------------------------- 2
-- Temettü
--
-- Hisse getirisinin ciddi bir kısmı buradan gelir; kaydı tutulmazsa
-- gerçek getiri olduğundan düşük görünür. Stopaj ayrı tutulur, net tutar
-- türetilir — yıl sonu beyanında brüt/stopaj ayrımı gerekiyor.
create table if not exists public.dividends (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  asset_id        uuid not null references public.assets(id) on delete cascade,
  account_id      uuid references public.accounts(id) on delete set null,
  pay_date        date not null,
  /** Ödemenin yapıldığı lot adedi — bilgi amaçlı, hesaba girmez */
  quantity        numeric,
  /** Lot başına brüt temettü */
  gross_per_share numeric,
  gross_amount    numeric not null default 0,
  tax_amount      numeric not null default 0,
  net_amount      numeric generated always as (gross_amount - tax_amount) stored,
  note            text,
  created_at      timestamptz not null default now()
);
create index if not exists dividends_user_idx on public.dividends(user_id, pay_date desc);

-- Temettü nakit defterine de işlensin: hesaba para girer
alter table public.account_ledger drop constraint if exists account_ledger_kind_check;
alter table public.account_ledger add constraint account_ledger_kind_check
  check (kind in ('giris','iade','satis','transfer','cikis','cekim','nema',
                  'borc','tahsil','alim','temettu','diger'));

alter table public.account_ledger
  add column if not exists dividend_id uuid references public.dividends(id) on delete cascade;
create unique index if not exists account_ledger_dividend_idx
  on public.account_ledger(dividend_id) where dividend_id is not null;

-- ---------------------------------------------------------------- 3
-- Arz takviminden otomatik açılan arzlar
--
-- feed_slug: ipo_feed kaydına bağ; aynı arz aynı kullanıcıya iki kez
-- açılmasın diye. source: 'takvim' otomatik açılanı işaretler, kullanıcı
-- listede hangisini kendi girdiğini ayırt edebilsin.
alter table public.ipos
  add column if not exists feed_slug text,
  add column if not exists source text not null default 'manuel';

do $do$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ipos_source_check'
  ) then
    alter table public.ipos add constraint ipos_source_check
      check (source in ('manuel', 'takvim'));
  end if;
end $do$;

-- Kısmi indeks ON CONFLICT ile çalışmıyor (PostgREST predicate yazamıyor),
-- bu yüzden tam indeks. feed_slug NULL olan satırlar Postgres varsayılanında
-- birbiriyle çatışmaz; elle girilen arzlar etkilenmez.
create unique index if not exists ipos_feed_slug_idx
  on public.ipos(user_id, feed_slug);

-- ---------------------------------------------------------------- 4
-- RLS — rls-per-user.sql ile aynı desen: yalnızca kendi satırların
do $do$
declare t text;
begin
  foreach t in array array['corporate_actions', 'dividends']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists read_own on public.%I;', t);
    execute format('drop policy if exists insert_own on public.%I;', t);
    execute format('drop policy if exists update_own on public.%I;', t);
    execute format('drop policy if exists delete_own on public.%I;', t);
    execute format(
      'create policy read_own on public.%I for select to authenticated using (auth.uid() = user_id);', t);
    execute format(
      'create policy insert_own on public.%I for insert to authenticated with check (auth.uid() = user_id);', t);
    execute format(
      'create policy update_own on public.%I for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);', t);
    execute format(
      'create policy delete_own on public.%I for delete to authenticated using (auth.uid() = user_id);', t);
  end loop;
end $do$;

-- ---------------------------------------------------------------- 5
-- Kontrol
--   select * from public.corporate_actions order by action_date desc;
--   select * from public.dividends order by pay_date desc;
--   select name, bist_code, source, feed_slug from public.ipos where source = 'takvim';

-- ---------------------------------------------------------------- 6
-- Fon içeriği (Fonoloji)
--
-- Fon "fon" olarak görünüyor ama içinde hisse, tahvil, döviz var. Bu
-- tablo olmadan dağılım grafiği gerçek maruziyeti gizliyor: 500 bin TL'lik
-- hisse fonu, portföyde "fon" diye duruyor.
--
-- Haftada bir tazelenir; TEFAS içerik verisini zaten ayda bir yayımlıyor,
-- daha sık çekmenin anlamı yok.
--
-- Piyasa verisi olduğu için okuma herkese açık, yazma yalnızca
-- service_role'da (asset_prices ile aynı desen).
create table if not exists public.fund_breakdown (
  code        text primary key,
  name        text,
  /** {stock: 79.18, government_bond: 0, gold: 0, cash: 0, other: 20.82} */
  allocation  jsonb,
  /** Fonun içindeki kalemler — [{name, weight}] */
  holdings    jsonb,
  /** Verinin ait olduğu tarih (fon içeriği aylık yayımlanıyor) */
  as_of       date,
  fetched_at  timestamptz not null default now()
);

alter table public.fund_breakdown enable row level security;
drop policy if exists read_all_authenticated on public.fund_breakdown;
create policy read_all_authenticated on public.fund_breakdown
  for select to authenticated using (true);
-- Yazma politikası bilerek yok: yalnızca Edge Function yazar.

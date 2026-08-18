-- =====================================================================
-- Portföy & Varlık Takip — Supabase şeması
-- Supabase SQL Editor'de tek seferde çalıştır.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- 3.1
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null,
  base_currency text not null default 'TRY',
  color         text default '#4f8cff',
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------- 3.2
create table if not exists public.accounts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  name       text not null,
  type       text not null default 'banka'
             check (type in ('banka','aracikurum','nakit','kripto','diger')),
  currency   text not null default 'TRY',
  is_active  boolean not null default true,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists accounts_user_idx on public.accounts(user_id);

-- ---------------------------------------------------------------- 3.3
create table if not exists public.assets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.profiles(id) on delete set null,
  symbol     text not null,
  name       text,
  kind       text not null default 'hisse'
             check (kind in ('hisse','fon','doviz','altin','mevduat','kripto','diger')),
  created_at timestamptz not null default now()
);
create index if not exists assets_symbol_idx on public.assets(symbol);

-- ---------------------------------------------------------------- 3.4
create table if not exists public.snapshots (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  snapshot_date date not null,
  note          text,
  created_at    timestamptz not null default now(),
  unique (user_id, snapshot_date)
);
create index if not exists snapshots_user_date_idx on public.snapshots(user_id, snapshot_date desc);

-- ---------------------------------------------------------------- 3.5
create table if not exists public.positions (
  id          uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.snapshots(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  account_id  uuid references public.accounts(id) on delete set null,
  asset_id    uuid references public.assets(id) on delete set null,
  quantity    numeric,
  unit_price  numeric,
  amount      numeric not null,
  currency    text not null default 'TRY',
  fx_rate     numeric not null default 1,
  amount_try  numeric generated always as (amount * coalesce(fx_rate, 1)) stored,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists positions_snapshot_idx on public.positions(snapshot_id);
create index if not exists positions_user_idx on public.positions(user_id);

-- ---------------------------------------------------------------- 3.6
create table if not exists public.liabilities (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  snapshot_id  uuid references public.snapshots(id) on delete cascade,
  title        text not null,
  type         text not null default 'kredi_karti'
               check (type in ('kredi_karti','kredi','kisisel_borc','diger')),
  counterparty text,
  amount       numeric not null default 0,
  currency     text not null default 'TRY',
  fx_rate      numeric not null default 1,
  due_date     date,
  is_settled   boolean not null default false,
  note         text,
  created_at   timestamptz not null default now()
);
create index if not exists liabilities_user_idx on public.liabilities(user_id);
create index if not exists liabilities_snapshot_idx on public.liabilities(snapshot_id);

-- ---------------------------------------------------------------- 3.7
create table if not exists public.receivables (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  person         text not null,
  amount         numeric not null default 0,
  currency       text not null default 'TRY',
  fx_rate        numeric not null default 1,
  given_date     date not null default current_date,
  expected_date  date,
  is_collected   boolean not null default false,
  collected_date date,
  note           text,
  created_at     timestamptz not null default now()
);
create index if not exists receivables_user_idx on public.receivables(user_id);

-- ---------------------------------------------------------------- 3.8
create table if not exists public.transactions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  account_id uuid references public.accounts(id) on delete set null,
  date       date not null default current_date,
  direction  text not null default 'gider' check (direction in ('gelir','gider')),
  category   text not null default 'diger'
             check (category in ('fatura','seyahat','market','kira','maas','kk_odeme','diger')),
  title      text not null,
  amount     numeric not null default 0,
  currency   text not null default 'TRY',
  fx_rate    numeric not null default 1,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists transactions_user_date_idx on public.transactions(user_id, date desc);

-- ---------------------------------------------------------------- 3.9
create table if not exists public.ipo_participations (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  ipo_name         text not null,
  ipo_date         date,
  account_owner    text,
  broker           text,
  requested_amount numeric,
  allocated_lot    numeric,
  cost_price       numeric,
  total_cost       numeric generated always as (coalesce(allocated_lot,0) * coalesce(cost_price,0)) stored,
  status           text not null default 'talep_verildi'
                   check (status in ('talep_verildi','dagitildi','satildi','iptal')),
  sold_date        date,
  sold_price       numeric,
  profit           numeric generated always as
                   ((coalesce(sold_price,0) - coalesce(cost_price,0)) * coalesce(allocated_lot,0)) stored,
  shared_with      text,
  note             text,
  created_at       timestamptz not null default now()
);
create index if not exists ipo_user_idx on public.ipo_participations(user_id);

-- --------------------------------------------------------------- 3.10
create table if not exists public.fx_rates (
  id       uuid primary key default gen_random_uuid(),
  date     date not null,
  currency text not null,
  rate_try numeric not null,
  unique (date, currency)
);

-- =====================================================================
-- 4. Row Level Security — herkes okur, sadece kendi satırını yazar
-- =====================================================================

do $do$
declare t text;
begin
  foreach t in array array[
    'profiles','accounts','assets','snapshots','positions',
    'liabilities','receivables','transactions','ipo_participations','fx_rates'
  ]
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists read_all_authenticated on public.%I;', t);
    execute format('drop policy if exists insert_own on public.%I;', t);
    execute format('drop policy if exists update_own on public.%I;', t);
    execute format('drop policy if exists delete_own on public.%I;', t);
    execute format('create policy read_all_authenticated on public.%I for select to authenticated using (true);', t);
  end loop;
end $do$;

-- Yazma politikaları: user_id kolonu olan tablolar
do $do$
declare t text;
begin
  foreach t in array array[
    'accounts','snapshots','positions','liabilities',
    'receivables','transactions','ipo_participations'
  ]
  loop
    execute format('create policy insert_own on public.%I for insert to authenticated with check (auth.uid() = user_id);', t);
    execute format('create policy update_own on public.%I for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);', t);
    execute format('create policy delete_own on public.%I for delete to authenticated using (auth.uid() = user_id);', t);
  end loop;
end $do$;

-- profiles: sadece kendi profilini günceller
create policy update_own on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- assets & fx_rates: ortak katalog, giriş yapan herkes yazabilir
create policy insert_own on public.assets for insert to authenticated with check (true);
create policy update_own on public.assets for update to authenticated using (true) with check (true);
create policy delete_own on public.assets for delete to authenticated
  using (user_id is null or auth.uid() = user_id);

create policy insert_own on public.fx_rates for insert to authenticated with check (true);
create policy update_own on public.fx_rates for update to authenticated using (true) with check (true);

-- =====================================================================
-- 5. View'lar
-- =====================================================================

create or replace view public.v_snapshot_totals
with (security_invoker = on) as
select s.id,
       s.user_id,
       s.snapshot_date,
       coalesce(sum(p.amount_try), 0) as total_assets_try
from public.snapshots s
left join public.positions p on p.snapshot_id = s.id
group by s.id, s.user_id, s.snapshot_date;

create or replace view public.v_net_worth
with (security_invoker = on) as
select t.id as snapshot_id,
       t.user_id,
       t.snapshot_date,
       t.total_assets_try,
       coalesce(l.total_liabilities, 0) as total_liabilities_try,
       t.total_assets_try - coalesce(l.total_liabilities, 0) as net_worth_try
from public.v_snapshot_totals t
left join (
  select snapshot_id, sum(amount * coalesce(fx_rate, 1)) as total_liabilities
  from public.liabilities
  where not is_settled and snapshot_id is not null
  group by snapshot_id
) l on l.snapshot_id = t.id;

-- =====================================================================
-- 6. Yeni auth kullanıcısı için otomatik profil satırı
-- =====================================================================

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $fn$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
